'use strict';
// Second-review findings, each reproduced as a behaviour test (no source-text checks):
// 1. a database read that started before a save cannot reinstall the old limits;
// 2. a failed read after a good load stops approvals at once;
// 3. a READY sized under limits that changed, failed or expired is never published or served;
// 4. the signal and the executor round a stop the same way (the real executor decides here).
const assert=require('node:assert/strict');
const {createOwnerLimits}=require('../execution/ownerLimits');
const {plannedLongRisk,stopLimitPrice,down}=require('../execution/riskMath');
const {createSandboxService}=require('../execution/sandboxService');
const {control,configurePolicy}=require('../execution/sandboxEngine');
const {memoryStore}=require('../execution/sandboxTestHelpers');
const {buildPositionPlan}=require('../engine/positionSizingEngine');
const {budget}=require('./ledger');
const policy=(perTrade,daily=700)=>({capital:10000,dailyLoss:daily,perTradeRisk:perTrade,costReserve:100});
const READY=token=>({decision:{orchestration:{status:'READY_TO_EXECUTE'},limitsToken:token}});

(async()=>{
 let clock=Date.parse('2026-10-30T10:00:00+05:30');
 // --- 1. A slow read that began before a save never reinstalls the old limit. ---
 {
  let release,db=policy(660);const changes=[];
  const limits=createOwnerLimits({read:()=>new Promise(r=>{const snap=structuredClone(db);release=()=>r({policy:snap});}),now:()=>clock,onChange:l=>changes.push(l&&l.perTrade)});
  const first=limits.refresh();release();await first;assert.equal(limits.get().perTrade,660);
  const slow=limits.refresh();             // reads the Rs 660 policy...
  db=policy(450);limits.set(db);           // ...meanwhile the owner saves Rs 450
  assert.equal(limits.get().perTrade,450);assert.deepEqual(changes,[450]);
  release();await slow;                    // the old read finishes last
  assert.equal(limits.get().perTrade,450,'the superseded read is discarded');assert.deepEqual(changes,[450],'and announces nothing');
  const next=limits.refresh();release();await next;assert.equal(limits.get().perTrade,450,'later reads see the saved value');
 }
 // --- 2. A failed read after a good load stops approvals and announces the loss. ---
 {
  let fail=false;const changes=[];
  const limits=createOwnerLimits({read:async()=>{if(fail)throw Error('db');return {policy:policy(660)};},now:()=>clock,onChange:l=>changes.push(l)});
  await limits.refresh();const t=limits.token();assert.ok(limits.valid(t));
  fail=true;await limits.refresh();
  assert.equal(limits.get(),null,'no usable limits after a failed read');assert.equal(limits.status().error,'OWNER_LIMITS_UNAVAILABLE');
  assert.equal(limits.valid(t),false);assert.equal(limits.servable(READY(t)),false,'an earlier READY can no longer be served');
  assert.deepEqual(changes,[null],'approvals are invalidated');
  fail=false;await limits.refresh();assert.equal(limits.servable(READY(t)),false,'a READY from before the outage stays void after recovery');
  assert.equal(limits.servable(READY(limits.token())),true,'a fresh analysis can approve again');
 }
 // --- 3. Publish and serve only under the exact, current, fresh limits. ---
 {
  let db=policy(660);
  const limits=createOwnerLimits({read:async()=>({policy:structuredClone(db)}),now:()=>clock,maxAgeMs:60000});
  await limits.refresh();const t=limits.token();
  assert.equal(limits.servable(READY(t)),true);
  assert.equal(limits.servable({decision:{orchestration:{status:'NO_TRADE'}}}),true,'non-READY results need no limits');
  assert.equal(limits.servable(READY(null)),false,'a READY without a stamp is never served');
  assert.equal(limits.servable(READY({...t,version:'other'})),false);
  clock+=61000;assert.equal(limits.servable(READY(t)),false,'expired limits: the cached READY is refused (the reviewer case)');
  await limits.refresh();assert.equal(limits.servable(READY(t)),true,'same limits re-read: the same stamp is valid again');
  db=policy(450);await limits.refresh();assert.equal(limits.servable(READY(t)),false,'limits changed in the database: refused');
  limits.set(policy(450));assert.equal(limits.servable(READY(limits.token())),true);
 }
 // --- 4. Stop rounding: the signal and the real executor agree. ---
 {
  for(const raw of [92,92.04,91.99,92.01,87.33,120.47]){
   assert.equal(stopLimitPrice(raw),stopLimitPrice(down(raw,0.05)),'raw '+raw+' and its tick-normalized stop give one stop-limit');
  }
  const r=plannedLongRisk({ask:100,stop:92.04,lotSize:65,costReserve:100});
  assert.equal(r.stopLimit,91.5);assert.equal(r.risk,652.5,'the reviewer case now plans Rs 652.50, as the executor does');
  // The real executor, Tier A authoritative mode, stop 92.04, per-trade Rs 650 vs Rs 660.
  const verdict=async perTrade=>{
   let now=Date.parse('2026-10-30T10:00:00+05:30');const store=memoryStore(),rows=[];
   await store.mutate(s=>configurePolicy(s,{requestId:'policy-parity-'+perTrade+'-0001',dailyGoal:1000,dailyLoss:700,perTradeRisk:perTrade},now));
   const result={timestamp:new Date(now).toISOString(),expiry:'2026-11-03',market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
    tradeLegs:{buyLeg:{instrumentKey:'NSE_FO|12345',contractId:'NIFTY 03 NOV 23000 CE',strike:23000,type:'CE'}},
    orchestration:{status:'READY_TO_EXECUTE',executionAllowed:true},signalTier:{tier:'A',researchOnly:false,executionAllowed:true},
    position:{status:'READY'},risk:{status:'READY',stop:{value:92.04},target1:{value:112}}}};
   const svc=createSandboxService({ownerToken:'owner-token-test',env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},getContext:()=>({analysis:result}),
    dependencies:{store,now:()=>now,bootId:'one',idleTickMs:0,
     broker:{async getOrders(){return structuredClone(rows);},async getPositions(){return [];},async placeOrder(o){rows.push({order_id:'b1',tag:o.tag,instrument_token:o.instrumentKey,quantity:o.quantity,price:o.price,trigger_price:o.trigger,transaction_type:o.side,product:'I',order_type:o.orderType,status:'open',filled_quantity:0,average_price:0});return {state:'ACKNOWLEDGED',orderId:'b1'};},async cancel(){return {state:'ACKNOWLEDGED'};}},
     catalog:{async get(){return {instrumentKey:'NSE_FO|12345',underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-03',session:'2026-10-30',lotSize:65,tickSizeRupees:0.05};},status:()=>({ready:true})},
     quotes:{async get(keys){return Object.fromEntries(keys.map(k=>[k,{instrumentKey:k,bid:99.95,ask:100,receivedAt:now}]));}}}});
   await svc.tick();await store.mutate(s=>control(s,'ARM','parity-arm-'+perTrade+'-00001',now));now+=1000;await svc.tick();
   return svc.status().lastEntryResult;
  };
  const signal=perTrade=>buildPositionPlan({strategy:'LONG_CALL',tradeLegs:{lotSize:65,buyLeg:{ask:100,bid:99.95}},risk:{status:'READY',entryPremium:100,stop:{value:92.04},maxLossPoints:7.96},marketPhase:'OPEN',
   budget:{...budget({trades:[],confirmedDay:budget({trades:[]},new Date()).day},new Date(),{capital:10000,daily:700,perTrade,costReserve:100,source:'SANDBOX_POLICY'}),checkedAt:new Date().toISOString()}}).status;
  assert.equal(await verdict(650),'RISK_LIMIT');assert.equal(signal(650),'BLOCKED','Rs 650: the executor refuses, and so does the signal');
  const at660=await verdict(660);assert.equal(at660,'QUEUED','Rs 660: the executor queues the entry');assert.equal(signal(660),'READY','and so does the signal');
 }

 // --- 5. Telegram: a READY queued under fresh limits is not sent after they expire (real manager, fake API). ---
 {
  const {buildTelegram}=require('../notifications/edgeTelegram');const {fakeTelegramPool,decision,testEnv}=require('../notifications/telegramTestHelpers');
  const {pool}=fakeTelegramPool();let time=Date.parse('2026-10-26T05:00:00Z'),current=null;const sends=[];
  const limits=createOwnerLimits({read:async()=>({policy:policy(660)}),now:()=>time});await limits.refresh();
  const api=async(method)=>{if(method==='getChat')return {id:Number(testEnv.EDGE_TELEGRAM_CHAT_ID),type:'private'};sends.push(method);return {message_id:sends.length,chat:{type:'private',id:Number(testEnv.EDGE_TELEGRAM_CHAT_ID)}};};
  const tg=buildTelegram({pool,env:testEnv,getMarketPhase:()=>'OPEN',getCurrentResult:()=>limits.approvedOnly(current),dependencies:{api,now:()=>time,bootId:'b'}});
  const stamped=ready=>{const r=decision(time,ready);r.decision.limitsToken=limits.token();return r;};
  current=stamped(false);await tg.onSuccessfulPoll(current);time+=10000;
  current=stamped(true);await tg.onSuccessfulPoll(current);   // READY queued while limits are current
  limits.set(policy(450));                                     // owner tightens limits before delivery (no time passes,
  await tg.tick();                                             // so only the limits guard can stop this send)
  assert.equal(sends.filter(m=>m==='sendMessage').length,0,'Telegram does not deliver a READY whose limits changed while queued');
  // Control: with fresh limits the same flow delivers.
  time+=61000;await limits.refresh();current=stamped(false);await tg.onSuccessfulPoll(current);time+=10000;current=stamped(true);await tg.onSuccessfulPoll(current);await tg.tick();
  assert.equal(sends.filter(m=>m==='sendMessage').length,1,'control: a READY under current limits is delivered');
 }
 // --- 6. Push: a READY paused in the subscription lookup is not sent after a tighter save (real manager, fake pool). ---
 {
  const {buildWebPush}=require('../notifications/edgeWebPush');
  let state=null,gate=null,release=null;const sends=[];
  const client={async query(sql,params){if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
   if(sql.includes('INSERT INTO edge_push_state')){if(!state)state=JSON.parse(params[0]);return {rows:[],rowCount:1};}
   if(sql.includes('SELECT payload FROM edge_push_state'))return {rows:[{payload:state}],rowCount:1};
   if(sql.includes('UPDATE edge_push_state')){state=JSON.parse(params[0]);return {rows:[],rowCount:1};}throw Error(sql);},release(){}};
  const fakePool={async query(sql,params){if(sql.includes('CREATE TABLE'))return {rows:[]};
   if(sql.includes('SELECT endpoint_hash, subscription FROM edge_push_subscriptions')){if(gate)await gate;return {rows:[{endpoint_hash:'h',subscription:{endpoint:'https://push.example/x',keys:{}}}]};}
   if(sql.includes('UPDATE edge_push_state')&&sql.includes("payload->>'observedAt'")){if(state&&state.observedAt===params[1])state=JSON.parse(params[0]);return {rows:[],rowCount:1};}throw Error(sql);},
   async connect(){return client;}};
  let lclock=Date.now(),pdb=policy(660);const limits=createOwnerLimits({read:async()=>({policy:structuredClone(pdb)}),now:()=>lclock});await limits.refresh();
  const save=p=>{pdb=p;limits.set(p);};
  const env={EDGE_PUSH_VAPID_PUBLIC_KEY:'A'.repeat(87),EDGE_PUSH_VAPID_PRIVATE_KEY:'B'.repeat(43),EDGE_PUSH_VAPID_SUBJECT:'mailto:edge@example.com',
   EDGE_PUSH_OWNER_TOKEN:'z'.repeat(32),EDGE_PUSH_DATABASE_URL:'postgresql://localhost/fake',EDGE_PUSH_AUTO_ALERTS:'true'};
  const push=buildWebPush(env,{pool:fakePool,sender:{setVapidDetails(){},async sendNotification(_s,payload){sends.push(JSON.parse(payload).type);return {statusCode:201};}},
   stillApproved:r=>limits.servable(r)});
  assert.equal(await push.initialize(),true);
  const result=status=>({timestamp:new Date().toISOString(),market:{phase:'OPEN'},decision:{orchestration:{status,executionAllowed:status==='READY_TO_EXECUTE'},
   strategy:'LONG_CALL',signalTier:{tier:'A'},tradeLegs:{buyLeg:{contractId:'NIFTY TEST CE'}},limitsToken:limits.token()}});
  await push.onSuccessfulPoll(result('WAIT_FOR_TRIGGER'));     // baseline after start
  gate=new Promise(r=>{release=r;});
  const pending=push.onSuccessfulPoll(result('READY_TO_EXECUTE'));
  await new Promise(r=>setTimeout(r,20));                       // paused in the subscription lookup
  save(policy(450));                                      // owner saves a tighter limit
  release();await pending;
  assert.ok(!sends.includes('EXECUTION_READY'),'push does not deliver a READY whose limits changed while it was queued');
  // Reviewer v4: the next valid READY comes straight after the vetoed one, with no WAIT in between. It must alert.
  gate=null;await push.onSuccessfulPoll(result('READY_TO_EXECUTE'));
  assert.ok(sends.includes('EXECUTION_READY'),'a vetoed READY does not consume the next valid READY');
  // And a READY re-approved under different limits, while still ready, is a new alert.
  const before=sends.filter(x=>x==='EXECUTION_READY').length;save(policy(500));
  await push.onSuccessfulPoll(result('READY_TO_EXECUTE'));
  assert.equal(sends.filter(x=>x==='EXECUTION_READY').length,before+1,'READY under new limits alerts again');
  await push.onSuccessfulPoll(result('READY_TO_EXECUTE'));
  assert.equal(sends.filter(x=>x==='EXECUTION_READY').length,before+1,'the same approval does not repeat');
  // Limits expire while a READY waits in the subscription lookup, then come back unchanged (same version and
  // generation). The vetoed READY must be recorded as not ready, or the next READY under the same approval is missed.
  await push.onSuccessfulPoll(result('WAIT_FOR_TRIGGER'));
  const count=()=>sends.filter(x=>x==='EXECUTION_READY').length,base=count();
  const tokenVetoed=limits.token();
  gate=new Promise(r=>{release=r;});const paused=push.onSuccessfulPoll(result('READY_TO_EXECUTE'));
  await new Promise(r=>setTimeout(r,20));lclock+=61000;release();await paused;
  assert.equal(count(),base,'expired while queued: not sent');
  gate=null;const tokenBefore=limits.token();await limits.refresh();const tokenAfter=limits.token();
  assert.equal(tokenBefore,null,'expired before the refresh');assert.deepEqual(tokenAfter,tokenVetoed,'limits came back unchanged: same approval');
  await push.onSuccessfulPoll(result('READY_TO_EXECUTE'));
  assert.equal(count(),base+1,'the next READY under the same approval still alerts');
  assert.ok(tokenAfter,'limits recovered');
 }
 // --- 5b. Telegram (reviewer v4): rate-limited READY under Rs 660, owner saves Rs 450, a fresh valid READY for the
 //     same strike appears, delivery retries. The old alert must not be sent on the new approval.
 {
  const {buildTelegram}=require('../notifications/edgeTelegram');const {TelegramError}=require('../notifications/telegramTransport');
  const {fakeTelegramPool,decision,testEnv}=require('../notifications/telegramTestHelpers');
  const {fake,pool}=fakeTelegramPool();let time=Date.parse('2026-10-26T05:00:00Z'),current=null,limited=true;const sent=[];
  let db=policy(660);const limits=createOwnerLimits({read:async()=>({policy:structuredClone(db)}),now:()=>time});await limits.refresh();
  const api=async(method,params)=>{if(method==='getChat')return {id:Number(testEnv.EDGE_TELEGRAM_CHAT_ID),type:'private'};
   if(limited)throw new TelegramError('TELEGRAM_RATE_LIMIT',{retryAfterMs:5000});sent.push(params.text);return {message_id:sent.length,chat:{type:'private',id:Number(testEnv.EDGE_TELEGRAM_CHAT_ID)}};};
  const tg=buildTelegram({pool,env:testEnv,getMarketPhase:()=>'OPEN',getCurrentResult:()=>limits.approvedOnly(current),approvalValid:t=>limits.valid(t),dependencies:{api,now:()=>time,bootId:'b'}});
  const stamped=ready=>{const r=decision(time,ready);r.decision.limitsToken=limits.token();return r;};
  current=stamped(false);await tg.onSuccessfulPoll(current);time+=10000;
  current=stamped(true);await tg.onSuccessfulPoll(current);await tg.tick();       // READY under Rs 660, rate-limited
  const oldIds=[...fake.outbox.keys()];assert.ok(oldIds.length>=1);
  db=policy(450);limits.set(db);                                                    // owner saves Rs 450
  time+=6000;current=stamped(true);await tg.onSuccessfulPoll(current);              // fresh valid READY, same strike
  limited=false;for(let i=0;i<4;i++){time+=6000;await tg.tick();}                   // delivery retries
  for(const id of oldIds)assert.notEqual(fake.outbox.get(id)?.status,'SENT','the alert approved under Rs 660 is never delivered');
  assert.deepEqual(sent.map(x=>x.split('\n')[0]),['EDGE · Previous ready state ended','EDGE · Backend-confirmed readiness'],'the old approval is reported as ended, then the new one alerts');
  const fresh=[...fake.outbox.entries()].filter(([id,o])=>!oldIds.includes(id)&&o.status==='SENT'&&fake.events.get(id)?.payload?.type==='EXECUTION_READY');
  assert.equal(fresh.length,1,'the readiness alert delivered is the one approved under Rs 450');
 }
 // --- 7. An impossible protective stop: the signal refuses, as the executor does. ---
 {
  const r=plannedLongRisk({ask:2.05,stop:0.05,lotSize:65,costReserve:100});assert.equal(r.stopLimit,0);
  const sized=buildPositionPlan({strategy:'LONG_CALL',tradeLegs:{lotSize:65,buyLeg:{ask:2.05,bid:2}},risk:{status:'READY',entryPremium:2.05,stop:{value:0.05},maxLossPoints:2},marketPhase:'OPEN',
   budget:{...budget({trades:[],confirmedDay:budget({trades:[]},new Date()).day},new Date(),{capital:10000,daily:700,perTrade:660,costReserve:100,source:'SANDBOX_POLICY'}),checkedAt:new Date().toISOString()}});
  assert.equal(sized.status,'BLOCKED');assert.match(sized.reason,/stop-limit/);
 }
 // --- 8. Every read of the current result in server.js goes through the guard (fails if a new outlet forgets). ---
 {
  const lines=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','server.js'),'utf8').split('\n');
  // Judge each occurrence: assignments are removed first, so a line that also clears lastResult is still checked.
  const strip=l=>l.replace(/\blastResult\s*=\s*(null|result)\b/g,'').replace(/^\s*let lastResult\b.*/,'');
  const reads=lines.map((l,i)=>({l:strip(l),i})).filter(({l})=>/\blastResult\b/.test(l));
  const allowed=[/approvedOnly\(lastResult\)/,/servable\(lastResult\)/,/dashboardAvailability\(/,/phase === 'CLOSED' && lastResult !== null/,
   /orchestration\?\.status === 'READY_TO_EXECUTE' && !ledger\.snapshot\(\)\.confirmed/];
  for(const {l,i} of reads){
   if(allowed.some(re=>re.test(l)))continue;
   // A direct use is allowed only right after a servable() guard on the previous code line.
   const prev=lines.slice(0,i).reverse().find(x=>x.trim()&&!x.trim().startsWith('//'));
   assert.ok(/servable\(lastResult\)\) return res\.status\(503\)/.test(prev||''),'unguarded read of lastResult at server.js:'+(i+1)+': '+l.trim());
  }
 }
 console.log('Limits guards PASS: superseded reads discarded, failed reads stop approvals, READY served/published only under current fresh limits, signal and real executor agree on stop rounding, queued Telegram and push READY revalidated (own stamp, no inherited approval, veto does not swallow the next READY), impossible stops refused, every server outlet guarded');
})().catch(e=>{console.error(e);process.exit(1);});
