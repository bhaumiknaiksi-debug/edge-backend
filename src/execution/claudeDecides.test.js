'use strict';
// Claude decision mode (sandbox only): request format, strict answer validation, executor gates,
// model exits, once-per-candle cadence and results split by source and days-to-expiry.
const assert=require('node:assert/strict');
const express=require('express');
const E=require('./sandboxEngine');
const {createClaudeAdvisor,buildSnapshot,validate}=require('./claudeAdvisor');
const {createSandboxService}=require('./sandboxService');
const {memoryStore}=require('./sandboxTestHelpers');
const BASE=Date.parse('2026-10-28T10:00:20+05:30');
const KEY='NSE_FO|777';
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});
const answer=x=>reply({content:[{type:'text',text:JSON.stringify(x)}],stop_reason:'end_turn'});

function analysis({at=BASE,spot=23010,strategy='LONG_CALL',tier='B',spread=false}={}){
  const type=strategy==='LONG_CALL'?'CE':'PE';
  const legs={buyLeg:{instrumentKey:KEY,contractId:'NIFTY 03 NOV 23000 '+type,strike:23000,type,delta:0.5,bid:99.95,ask:100},legDelta:0.5};
  if(spread)legs.sellLeg={instrumentKey:'NSE_FO|888',strike:23100,type};
  return {timestamp:new Date(at).toISOString(),expiry:'2026-11-03',spot,market:{phase:'OPEN',features:{trend30mPct:0.2,optionFlow:{aggregate:{label:'BULLISH_FLOW'}}}},
    decision:{strategy:'WAIT',regime:{direction:'BULLISH',label:'Bullish',score:2},orchestration:{status:'WAIT',executionAllowed:false},
      signalTier:{tier:'C',researchOnly:true,executionAllowed:false},risk:{status:'UNAVAILABLE'},position:{status:'UNAVAILABLE'},
      researchCandidatePlans:{plans:{[tier]:{available:true,strategy,legs}}}}};
}
const meta=()=>({instrumentKey:KEY,underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-03',session:'2026-10-28',lotSize:65,tickSizeRupees:0.05});
const quote=(at=BASE)=>({instrumentKey:KEY,bid:99.95,ask:100,receivedAt:at});
const buy=(o={})=>({action:'BUY',tier:'B',stopUnderlying:23000,confidence:0.62,reason:'Held OR high on rising flow',decidedAt:new Date(BASE).toISOString(),bucket:'2026-10-28|120',instrumentKey:KEY,...o});
function armed(){
  const s=E.initialState();
  E.configurePolicy(s,{requestId:'policy-claude-000001',dailyGoal:1000,dailyLoss:500,perTradeRisk:500,entryMode:'CLAUDE_DECIDES_V1'},BASE);
  E.recover(s,'boot');E.reconcile(s,[],[],BASE);E.control(s,'ARM','arm-request-000001',BASE);return s;
}
const plan=(s,r)=>E.planEntry(s,r,quote(),meta(),BASE);

(async()=>{
  // --- request format and strict parsing ---
  let seen;
  const advisor=createClaudeAdvisor({apiKey:'test-key',now:()=>BASE,request:async(url,options)=>{seen={url,options,body:JSON.parse(options.body)};
    return answer({action:'buy',tier:'b',stopUnderlying:23000,confidence:1.4,reason:'x'.repeat(300)});}});
  const d=await advisor.decide({spot:23010});
  assert.equal(seen.url,'https://api.anthropic.com/v1/messages');assert.equal(seen.options.redirect,'error');
  assert.equal(seen.options.headers['x-api-key'],'test-key');assert.equal(seen.options.headers['anthropic-version'],'2026-10-21');
  assert.equal(seen.body.model,'claude-sonnet-5-5');assert.equal(seen.body.output_config.format.type,'json_schema');
  assert.equal(seen.body.output_config.format.schema.additionalProperties,false);assert.ok(!('tool_choice' in seen.body),'forced tool use is rejected by current models');
  assert.equal(d.action,'BUY');assert.equal(d.tier,'B');assert.equal(d.confidence,1,'confidence is clamped');assert.equal(d.reason.length,200);
  const declined=await createClaudeAdvisor({apiKey:'k',request:async()=>reply({content:[],stop_reason:'end_turn',stop_details:{type:'refusal'}})}).decide({});
  assert.equal(declined.action,'SKIP');assert.equal(declined.declined,true,'a refusal never becomes a trade');
  await assert.rejects(createClaudeAdvisor({apiKey:'k',request:async()=>reply({error:{message:'secret detail'}},401)}).decide({}),/MODEL_HTTP_401/);
  await assert.rejects(createClaudeAdvisor({apiKey:'k',request:async()=>reply({content:[{type:'text',text:'not json'}]})}).decide({}),/MODEL_OUTPUT_INVALID/);
  await assert.rejects(createClaudeAdvisor({apiKey:'k',request:async()=>{throw Error('dns');}}).decide({}),/MODEL_UNREACHABLE/);
  assert.throws(()=>validate({action:'BUY',tier:'NONE',stopUnderlying:23000,confidence:0.5,reason:'r'}),/MODEL_OUTPUT_INVALID/);
  assert.throws(()=>validate({action:'BUY',tier:'A',stopUnderlying:0,confidence:0.5,reason:'r'}),/MODEL_OUTPUT_INVALID/);
  assert.throws(()=>validate({action:'SELL_EVERYTHING',tier:'A',stopUnderlying:1,confidence:0.5,reason:'r'}),/MODEL_OUTPUT_INVALID/);
  assert.deepEqual(validate({action:'exit',tier:'C',stopUnderlying:5,confidence:0.4,reason:'done'}),{action:'EXIT',tier:'NONE',stopUnderlying:0,confidence:0.4,reason:'done'});
  let calls=0;const capped=createClaudeAdvisor({apiKey:'k',now:()=>BASE,request:async()=>{calls++;return answer({action:'SKIP',tier:'NONE',stopUnderlying:0,confidence:0.5,reason:'r'});}});
  for(let i=0;i<90;i++)await capped.decide({});await assert.rejects(capped.decide({}),/MODEL_DAILY_CALL_LIMIT/);assert.equal(calls,90,'hard daily cap on paid calls');

  // --- snapshot is compact and never carries credentials or instrument keys ---
  const snap=buildSnapshot(analysis(),armed(),{now:BASE,expiryBucket:'OTHER_DAYS'});
  const text=JSON.stringify(snap);assert.ok(text.length<4000);assert.ok(!text.includes('NSE_FO|'));assert.equal(snap.candidates.B.buy.strike,23000);
  assert.equal(snap.limits.perTradeRiskRupees,500);assert.equal(snap.timeIST,'10:00');assert.equal(snap.expiryBucket,'OTHER_DAYS');

  // --- executor gates on a model decision ---
  {
    const s=armed();assert.equal(plan(s,{...analysis(),claudeDecision:buy()}),'QUEUED');
    const t=Object.values(s.trades)[0];
    assert.equal(t.entrySource,'CLAUDE_DECIDES');assert.equal(t.tier,'B');assert.equal(t.expiryBucket,'OTHER_DAYS');assert.equal(t.ruleVersion,'CLAUDE_DECIDES_V1');
    assert.equal(t.stop,95);assert.equal(t.target,107.5);assert.equal(t.anchor.reason,'Held OR high on rising flow');
  }
  assert.equal(plan(armed(),analysis()),'NO_MODEL_DECISION','no decision, no trade');
  for(const [label,r,expected] of [
    ['skip',{...analysis(),claudeDecision:buy({action:'SKIP'})},'MODEL_SKIPPED'],
    ['exit is not an entry',{...analysis(),claudeDecision:buy({action:'EXIT'})},'NO_MODEL_BUY'],
    ['stale decision',{...analysis(),claudeDecision:buy({decidedAt:new Date(BASE-120000).toISOString()})},'MODEL_DECISION_STALE'],
    ['card changed since the decision',{...analysis(),claudeDecision:buy({instrumentKey:'NSE_FO|999'})},'MODEL_CANDIDATE_CHANGED'],
    ['card not offered',{...analysis(),claudeDecision:buy({tier:'A'})},'MODEL_CANDIDATE_UNAVAILABLE'],
    ['spreads are never traded',{...analysis({spread:true}),claudeDecision:buy()},'MODEL_CANDIDATE_UNAVAILABLE'],
    ['stop on the wrong side',{...analysis(),claudeDecision:buy({stopUnderlying:23020})},'MODEL_STOP_INVALID'],
    ['stop absurdly far',{...analysis(),claudeDecision:buy({stopUnderlying:22700})},'MODEL_STOP_INVALID'],
    ['risk above budget',{...analysis(),claudeDecision:buy({stopUnderlying:22980})},'RISK_LIMIT'],
  ])assert.equal(plan(armed(),r),expected,label);
  // the model cannot exceed one entry per decision, nor the daily trade count, nor size beyond one lot
  {
    const s=armed();assert.equal(plan(s,{...analysis(),claudeDecision:buy()}),'QUEUED');
    assert.equal(plan(s,{...analysis(),claudeDecision:buy()}),'EXPOSURE_ALREADY_EXISTS');
    assert.equal(Object.values(s.orders)[0].quantity,65);
  }
  // model EXIT only applies to an open trade from today
  {
    const s=armed();assert.equal(E.requestModelExit(s,'missing',BASE),false);
    plan(s,{...analysis(),claudeDecision:buy()});const t=Object.values(s.trades)[0];
    assert.equal(E.requestModelExit(s,t.id,BASE),true);assert.equal(t.exitReason,'MODEL_EXIT');
  }

  // --- service end to end: once per candle, entry, broker stop, model exit, closed trade in the summary ---
  const store=memoryStore(),rows=[];let now=BASE,ctx=analysis(),next={action:'BUY',tier:'B',stopUnderlying:23000,confidence:0.6,reason:'breakout held'},decisions=0;
  const fakeAdvisor={model:'claude-sonnet-5-5',async decide(snapshot){decisions++;assert.ok(snapshot.candidates.B);return {...next};}};
  const broker={async getOrders(){return structuredClone(rows);},async getPositions(){const n=rows.reduce((a,o)=>a+(o.transaction_type==='BUY'?o.filled_quantity:-o.filled_quantity),0);return n?[{instrument_token:KEY,quantity:n,product:'I'}]:[];},
    async placeOrder(o){rows.push({order_id:'broker-'+(rows.length+1),tag:o.tag,instrument_token:o.instrumentKey,quantity:o.quantity,price:o.price,trigger_price:o.trigger,
      transaction_type:o.side,product:'I',order_type:o.orderType,status:o.orderType==='SL'?'trigger pending':'open',filled_quantity:0,average_price:0});return {state:'ACKNOWLEDGED',orderId:'broker-'+rows.length};},
    async cancel(id){rows.find(o=>o.order_id===id).status='cancelled';return {state:'ACKNOWLEDGED',orderId:id};}};
  const service=createSandboxService({ownerToken:'owner-token-test',env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},
    getContext:()=>({analysis:{...ctx,timestamp:new Date(now).toISOString()}}),
    dependencies:{store,broker,advisor:fakeAdvisor,now:()=>now,bootId:'one',catalog:{async get(k){return k===KEY?meta():null;},status:()=>({ready:true})},
      quotes:{async get(keys){return Object.fromEntries(keys.map(k=>[k,{...quote(now),instrumentKey:k}]));}}}});
  assert.equal(await service.advise(),null,'not armed in Claude mode: no paid call');assert.equal(decisions,0);
  await store.mutate(s=>E.configurePolicy(s,{requestId:'policy-service-claude1',dailyGoal:1000,dailyLoss:500,perTradeRisk:500,entryMode:'CLAUDE_DECIDES_V1'},now));
  await service.tick();await store.mutate(s=>E.control(s,'ARM','arm-service-claude01',now));
  const first=await service.advise();assert.equal(first.action,'BUY');assert.equal(first.instrumentKey,KEY);assert.equal(decisions,1);
  now+=15000;assert.equal(await service.advise(),null,'one decision per 5-minute candle');assert.equal(decisions,1);
  await service.tick();assert.equal(rows.length,1,'Claude BUY reached the sandbox as one entry');assert.equal(rows[0].quantity,65);
  Object.assign(rows[0],{status:'complete',filled_quantity:65,average_price:100});now+=1000;await service.tick();
  assert.equal(rows[1].order_type,'SL','broker-held protective stop placed by code, not by the model');
  next={action:'EXIT',tier:'NONE',stopUnderlying:0,confidence:0.7,reason:'momentum faded'};
  now=Date.parse('2026-10-28T10:05:20+05:30');assert.equal((await service.advise()).action,'EXIT');assert.equal(decisions,2);
  await service.tick();assert.equal(rows[1].status,'cancelled','stop is cancelled before the model exit sells');
  now+=1000;await service.tick();assert.equal(rows[2].transaction_type,'SELL');assert.equal(rows[2].quantity,65);
  Object.assign(rows[2],{status:'complete',filled_quantity:65,average_price:104});now+=1000;await service.tick();
  const state=await store.read(),trade=Object.values(state.trades)[0];
  assert.ok(trade.closedAt);assert.equal(trade.exitReason,'MODEL_EXIT');assert.equal(trade.netPnl,160,'(104-100) x 65 - Rs 100 friction');
  assert.equal(state.modelDecisions.length,2);assert.equal(state.modelDecisions[1].action,'EXIT');

  const app=express();app.use(express.json());service.routes(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
    const url='http://127.0.0.1:'+server.address().port+'/api/v1/execution/sandbox';
    const publicBody=await (await fetch(url+'/status')).json();assert.equal(publicBody.advisorConfigured,true);assert.ok(!JSON.stringify(publicBody).includes('momentum faded'),'reasons stay owner-only');
    const body=await (await fetch(url,{headers:{Authorization:'Bearer owner-token-test'}})).json();
    assert.equal(body.advisor.lastAction,'EXIT');assert.equal(body.advisor.model,'claude-sonnet-5-5');
    assert.deepEqual(body.tierSummary.bySource.CLAUDE_DECIDES,{trades:1,wins:1,losses:0,netPnl:160});
    assert.deepEqual(body.tierSummary.byExpiryBucket.OTHER_DAYS,{trades:1,wins:1,losses:0,netPnl:160});
    assert.ok(body.tierSummary.bySourceAndExpiry['CLAUDE_DECIDES · OTHER_DAYS']);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}

  // without an API key the mode is inert and never calls anything
  const keyless=createSandboxService({ownerToken:'o',env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},getContext:()=>({analysis:ctx}),
    dependencies:{store:memoryStore(),broker,now:()=>now,catalog:{async get(){return null;},status:()=>({})},quotes:{async get(){return {};}}}});
  assert.equal(keyless.status().advisorConfigured,false);assert.equal(await keyless.advise(),null);
  console.log('Claude decision mode PASS: request format, strict answers, refusal/HTTP/garbage handling, daily call cap, code-enforced gates, once-per-candle cadence, model exit through broker stop cancel, and results by source and expiry bucket');
})().catch(e=>{console.error(e);process.exitCode=1;});
