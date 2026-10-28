'use strict';
const {randomUUID}=require('node:crypto');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const engine=require('./sandboxEngine');
const {createSandboxStore}=require('./sandboxStore');
const {createSandbox}=require('./upstoxSandbox');
const {createCatalog}=require('./instrumentCatalog');
const {createMarketQuotes}=require('./marketQuotes');
const {timingSafeOwnerToken}=require('../notifications/edgeWebPush');
const {createClaudeAdvisor,buildSnapshot}=require('./claudeAdvisor');
const {rejectOwner}=require('../health/authThrottle');
function createSandboxService({pool,ownerToken,getContext=()=>({}),env=process.env,dependencies={},notify=()=>{}}){
  const enabled=env.EDGE_SANDBOX_EXECUTION_ENABLED==='true';
  const tokenValid=t=>typeof t==='string'&&!!t.trim()&&!/[\r\n]/.test(t);
  const reason=!enabled?'DISABLED':!ownerToken?'OWNER_AUTH_REQUIRED':!pool&&!dependencies.store?'DATABASE_REQUIRED':
    !tokenValid(env.EDGE_UPSTOX_SANDBOX_TOKEN)&&!dependencies.broker?'SANDBOX_TOKEN_REQUIRED':
    !tokenValid(env.UPSTOX_ACCESS_TOKEN)&&!dependencies.quotes?'MARKET_DATA_TOKEN_REQUIRED':null;
  const now=dependencies.now||Date.now,bootId=dependencies.bootId||randomUUID();
  const store=reason?null:dependencies.store||createSandboxStore({pool});
  const broker=reason?null:dependencies.broker||createSandbox({token:env.EDGE_UPSTOX_SANDBOX_TOKEN});
  const catalog=reason?null:dependencies.catalog||createCatalog({now});
  const quoteSource=reason?null:dependencies.quotes||createMarketQuotes({token:env.UPSTOX_ACCESS_TOKEN,now});
  // Optional Claude decision step. Without a key the CLAUDE_DECIDES_V1 mode simply never finds a decision.
  let advisor=null,advisorConfigError=null;
  if(!reason)try{advisor=dependencies.advisor||(tokenValid(env.ANTHROPIC_API_KEY)?createClaudeAdvisor({apiKey:env.ANTHROPIC_API_KEY,model:env.EDGE_CLAUDE_MODEL||undefined,now}):null);}
  catch(_){advisorConfigError='MODEL_CONFIG_INVALID';}
  let advice=null,advising=false,lastBucket=null,lastQuotes={},advisorTimer=null;
  const advisorStatus={lastDecisionAt:null,lastAction:null,lastTier:null,lastConfidence:null,lastReason:null,lastError:advisorConfigError,calls:0};
  const adviceFresh=time=>!!advice&&time-Date.parse(advice.decidedAt)<=90000&&time>=Date.parse(advice.decidedAt)-60000;
  // The analysis the executor sees, with the latest model decision attached alongside (never inside) EDGE's decision.
  const context=()=>{const c=getContext()||{};return advice&&c.analysis?{...c,analysis:{...c.analysis,claudeDecision:advice}}:c;};
  let running=false,stopped=false,timer=null,lastError=reason,lastTickAt=null,lastEntryResult=null,brokerReads=null,positionBasis=null,tickCount=0,lastTickStartedAt=null,lastErrorAt=null;
  const publicStatus=()=>({version:'EDGE_SANDBOX_EXECUTION_V1',enabled,mode:'SANDBOX',liveOrdersSupported:false,
    liveDecisionImpact:false,configured:!reason,reason:lastError,lastTickAt,lastEntryResult,brokerReads,positionBasis,tickCount,lastTickStartedAt,lastErrorAt,advisorConfigured:!!advisor});
  const clean=e=>/^[A-Z_]{3,80}$/.test(e?.message||'')?e.message:'SANDBOX_SERVICE_UNAVAILABLE';
  const human=x=>String(x||'').toLowerCase().replaceAll('_',' ');
  const send=(key,text)=>{try{notify(key,text);}catch(_){}};
  // Alerts on state transitions only. The first observation after a restart is a silent baseline.
  let seen=null;
  function watch(state){
    if(!state)return;
    const today=engine.day(now()),trades=Object.values(state.trades),orders=Object.values(state.orders);
    const snap={halt:state.haltReason||null,locked:state.lockedDays.includes(today),
      closed:new Set(trades.filter(t=>t.closedAt).map(t=>t.id)),filled:new Set(orders.filter(o=>o.kind==='ENTRY'&&o.filled>0).map(o=>o.tradeId))};
    if(seen){
      const open=trades.filter(t=>!t.closedAt).length;
      if(snap.halt&&snap.halt!==seen.halt)send('HALT:'+snap.halt+':'+today,'EDGE sandbox HALTED: '+human(snap.halt)+'. Open trades: '+open+'. New entries are disarmed; check the control page.');
      for(const id of snap.filled)if(!seen.filled.has(id)){
        const t=state.trades[id],e=orders.find(o=>o.tradeId===id&&o.kind==='ENTRY');
        if(t)send('FILL:'+id,'EDGE sandbox entry filled: '+(t.contractId||t.instrumentKey)+' x'+e.filled+' @ '+e.averagePrice+' (tier '+(t.tier||'A')+', '+human(t.entrySource||'AUTHORITATIVE_A')+'). Stop '+t.stop+', target '+t.target+'.');
      }
      for(const id of snap.closed)if(!seen.closed.has(id)){
        const t=state.trades[id];
        if(t&&t.buys>0)send('CLOSE:'+id,'EDGE sandbox trade closed: '+(t.contractId||t.instrumentKey)+', exit '+human(t.exitReason||'closed')+', estimated net Rs '+t.netPnl+' (tier '+(t.tier||'A')+').');
      }
      if(snap.locked&&!seen.locked)send('LOCK:'+today,'EDGE sandbox paused for today: daily loss limit reached.');
    }
    seen=snap;
  }
  // Same candidate rules the planner used; re-checked just before any entry is sent.
  function currentAllowed(order,context,time,policy){
    const r=context.analysis,t=Date.parse(r?.timestamp),q=context.quotes?.[order.instrumentKey];
    if(!(Number.isFinite(t)&&t<=time&&time-t<=60000&&r?.market?.phase==='OPEN'))return false;
    const pick=engine.selectCandidate(policy,r);
    return !pick.reason&&pick.strategy===order.strategy&&r.expiry===order.expiry&&
      pick.leg.instrumentKey===order.instrumentKey&&pick.leg.contractId===order.contractId&&
      !!q&&q.bid>0&&q.ask>=q.bid&&(q.ask-q.bid)/q.ask<=0.025&&q.receivedAt<=time&&time-q.receivedAt<=10000;
  }
  async function tick(){
    if(reason||running||stopped)return publicStatus();running=true;tickCount++;lastTickStartedAt=new Date(now()).toISOString();
    try{
      const time=now();
      const lease=await store.mutate(s=>{
        if(s.lease&&s.lease.owner!==bootId&&s.lease.until>time)return false;
        engine.recover(s,bootId);s.lease={owner:bootId,until:time+30000};return true;
      });
      if(!lease.result){lastError='ANOTHER_WORKER_ACTIVE';return publicStatus();}
      const analysis=context().analysis,selected=engine.selectCandidate(lease.state.policy,analysis);
      const instrumentKey=selected.leg?.instrumentKey||analysis?.decision?.tradeLegs?.buyLeg?.instrumentKey;
      const keys=Object.values(lease.state.trades).filter(t=>!t.closedAt).map(t=>t.instrumentKey);
      if(instrumentKey)keys.push(instrumentKey);
      let readAt;
      const [brokerState,quotes,meta]=await Promise.all([
        Promise.allSettled([broker.getOrders(),broker.getPositions()]).then(results=>{
          const describe=r=>r.status==='fulfilled'?{ok:true}:{ok:false,httpStatus:Number.isInteger(r.reason?.httpStatus)&&r.reason.httpStatus>=100&&r.reason.httpStatus<=599?r.reason.httpStatus:null};
          brokerReads={orders:describe(results[0]),positions:describe(results[1])};
          if(results[0].status==='rejected'||(results[1].status==='rejected'&&results[1].reason?.httpStatus!==404))throw Error('SANDBOX_READ_UNAVAILABLE');
          readAt=now();return [results[0].value,results[1].status==='fulfilled'?results[1].value:null];
        }),
        quoteSource.get(keys).catch(()=>({})),catalog.get(instrumentKey).catch(()=>null)]);
      const [book,positions]=brokerState;
      if(stopped)return publicStatus();
      lastQuotes=quotes||{};
      const view={...context(),quotes};
      const prepared=await store.mutate(s=>{
        if(s.lease?.owner!==bootId||s.lease.until<=now())return null;
        engine.reconcile(s,book,positions,readAt,{positionBasis:positions===null?'SANDBOX_ORDER_BOOK_DERIVED':'BROKER_POSITIONS'});
        engine.archiveClosed(s,now());
        if(advice?.action==='EXIT'&&advice.tradeId&&adviceFresh(now()))engine.requestModelExit(s,advice.tradeId,now());
        engine.manage(s,view.quotes||{},now());
        const planKey=engine.selectCandidate(s.policy,view.analysis).leg?.instrumentKey||view.analysis?.decision?.tradeLegs?.buyLeg?.instrumentKey;
        const previousEntryResult=lastEntryResult;
        lastEntryResult=engine.planEntry(s,view.analysis,view.quotes?.[planKey],meta,now());
        if(lastEntryResult==='LOSING_STREAK_LOCK'&&previousEntryResult!=='LOSING_STREAK_LOCK')send('STREAK:'+engine.day(now()),'EDGE sandbox paused for today: '+(s.policy.maxConsecutiveLosses||2)+' losing trades in a row.');
        const pending=Object.values(s.orders).find(o=>o.kind==='ENTRY'&&o.state==='QUEUED');
        return engine.claim(s,now(),!pending||currentAllowed(pending,{...context(),quotes},now(),s.policy));
      });
      positionBasis=prepared.state.positionBasis;watch(prepared.state);
      const action=prepared.result;
      if(action){
        if(action.action==='PLACE'&&action.order.kind==='ENTRY'){
          const allowed=await store.mutate(s=>{
            if(s.killed||!s.armed||stopped||s.lease?.owner!==bootId||!currentAllowed(action.order,{...context(),quotes},now(),s.policy)){
              s.orders[action.order.id].state='EXPIRED';return false;
            }return true;
          });
          if(!allowed.result)return publicStatus();
        }
        // No network request runs inside a DB transaction. Persistent SUBMITTING prevents duplicate claims.
        const result=action.action==='CANCEL'?await broker.cancel(action.order.orderId):await broker.placeOrder(action.order);
        await store.mutate(s=>{if(s.lease?.owner===bootId)engine.finish(s,action,result);});
      }
      lastError=null;lastTickAt=new Date(now()).toISOString();
    }catch(e){
      lastError=clean(e);lastErrorAt=new Date(now()).toISOString();
      if(store){
        const emergency=await store.mutate(s=>{
          if(s.lease?.owner!==bootId)return null;
          engine.halt(s,lastError);s.reconciledAt=null;return engine.claimEmergencyCancel(s,now());
        }).catch(()=>null);
        watch(emergency?.state);
        if(emergency?.result){
          const result=await broker.cancel(emergency.result.order.orderId).catch(()=>({state:'UNCERTAIN'}));
          await store.mutate(s=>{if(s.lease?.owner===bootId)engine.finish(s,emergency.result,result);}).catch(()=>{});
        }
      }
    }finally{running=false;}
    return publicStatus();
  }
  // Asks Claude once per completed 5-minute candle while armed in CLAUDE_DECIDES_V1 (entries 09:30-15:00, exits until 15:15).
  async function advise(){
    if(reason||!advisor||advising||stopped)return null;
    const time=now(),ist=new Date(time+19800000),minutes=ist.getUTCHours()*60+ist.getUTCMinutes(),today=ist.toISOString().slice(0,10);
    const analysis=getContext()?.analysis,at=Date.parse(analysis?.timestamp);
    if(analysis?.market?.phase!=='OPEN'||minutes<570||minutes>=915||!(time-at<=60000))return null;
    const bucket=today+'|'+Math.floor(minutes/5),bucketStart=Date.parse(today+'T00:00:00+05:30')+Math.floor(minutes/5)*300000;
    if(bucket===lastBucket||!(at>=bucketStart))return null; // decide on an analysis taken after this candle opened
    advising=true;
    try{
      const state=await store.read();
      if(state.policy?.entryMode!=='CLAUDE_DECIDES_V1'||!state.armed||state.killed||state.haltReason)return null;
      const open=Object.values(state.trades).find(t=>!t.closedAt);
      if(!open&&minutes>=900)return null;
      lastBucket=bucket;
      const snapshot=buildSnapshot(analysis,state,{now:time,quotes:lastQuotes,expiryBucket:engine.expiryBucket(analysis.expiry,today)});
      advisorStatus.calls++;
      const decision=await advisor.decide(snapshot);
      const plan=analysis.decision?.researchCandidatePlans?.plans?.[decision.tier];
      advice={...decision,decidedAt:new Date(now()).toISOString(),analysisTimestamp:analysis.timestamp,bucket,model:advisor.model||null,
        instrumentKey:decision.action==='BUY'?plan?.legs?.buyLeg?.instrumentKey||null:null,tradeId:open?.id||null};
      Object.assign(advisorStatus,{lastDecisionAt:advice.decidedAt,lastAction:advice.action,lastTier:advice.tier,lastConfidence:advice.confidence,lastReason:advice.reason,lastError:null});
      // Bounded audit trail of every decision, including SKIPs, for later comparison against outcomes.
      const record={at:advice.decidedAt,bucket,action:advice.action,tier:advice.tier,stopUnderlying:advice.stopUnderlying,confidence:advice.confidence,
        reason:advice.reason,spot:snapshot.spot,expiryBucket:snapshot.expiryBucket,tradeId:advice.tradeId,model:advice.model};
      // Recent decisions stay in state for the page; every decision is also archived permanently, in the same write.
      await store.mutate(s=>{s.modelDecisions=[...(s.modelDecisions||[]),record].slice(-60);
        (s.archiveQueue||=[]).push({id:'decision:'+bucket+':'+advice.decidedAt,kind:'DECISION',payload:{...record,snapshot}});});
      return advice;
    }catch(e){advisorStatus.lastError=clean(e);return null;}
    finally{advising=false;}
  }
  // Realized sandbox results by entry tier, decision source and days-to-expiry bucket.
  function tierSummary(state,archived=[]){
    const groups={byEntryTier:{},bySource:{},byExpiryBucket:{},bySourceAndExpiry:{}};
    const add=(group,key,t)=>{const row=groups[group][key]||={trades:0,wins:0,losses:0,netPnl:0};
      row.trades++;row.netPnl=Math.round((row.netPnl+t.netPnl)*100)/100;if(t.netPnl>0)row.wins++;else if(t.netPnl<0)row.losses++;};
    for(const t of [...archived.map(a=>a?.trade).filter(Boolean),...Object.values(state.trades)]){
      if(!t.closedAt||!(t.buys>0))continue;
      const source=t.entrySource||'AUTHORITATIVE_A',bucket=t.expiryBucket||'UNKNOWN';
      add('byEntryTier',t.tier||'A',t);add('bySource',source,t);add('byExpiryBucket',bucket,t);add('bySourceAndExpiry',source+' · '+bucket,t);
    }
    return {basis:'BROKER_FILLS_MINUS_ESTIMATED_FRICTION',...groups};
  }
  function start(){if(reason||timer)return;stopped=false;timer=setInterval(()=>{void tick();},2000);timer.unref?.();void tick();
    if(advisor){advisorTimer=setInterval(()=>{void advise();},10000);advisorTimer.unref?.();}}
  function stop(){stopped=true;if(timer)clearInterval(timer);timer=null;if(advisorTimer)clearInterval(advisorTimer);advisorTimer=null;}
  function routes(app){
    const base='/api/v1/execution/sandbox';
    for(const [suffix,file,type] of [['/control','control.html','html'],['/control.js','control.js','js'],['/control.css','control.css','css']])app.get(base+suffix,(_req,res)=>{
      res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');
      res.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.type(type).send(readFileSync(path.join(__dirname,file),'utf8'));
    });
    app.get(base+'/status',(_req,res)=>{res.set('Cache-Control','no-store');res.json(publicStatus());});
    const guard=fn=>async(req,res)=>{
      res.set('Cache-Control','no-store');
      if(rejectOwner(req,res,{ownerToken,compare:timingSafeOwnerToken,throttle:dependencies.throttle}))return;
      if(reason)return res.status(503).json({error:reason});
      try{await fn(req,res);}catch(e){res.status(409).json({error:clean(e)});}
    };
    app.get(base+'/decisions',guard(async(req,res)=>{
      const limit=Math.min(5000,Math.max(1,parseInt(req.query.limit,10)||500));
      res.json({decisions:store.readArchive?await store.readArchive('DECISION',limit):[]});
    }));
    app.get(base,guard(async(_req,res)=>{const state=await store.read(),archived=store.readArchive?await store.readArchive('TRADE'):[];
      res.json({status:publicStatus(),state,history:{archivedTrades:state.archivedTrades||0,archivedPnl:state.archivedPnl||0},tierSummary:tierSummary(state,archived),advisor:{configured:!!advisor,model:advisor?.model||null,...advisorStatus},catalog:catalog.status()});}));
    app.post(base+'/resolve',guard(async(req,res)=>{
      if(req.body?.confirmSandbox!==true)return res.status(400).json({error:'SANDBOX_CONFIRMATION_REQUIRED'});
      const updated=await store.mutate(s=>engine.resolveTrade(s,req.body||{},now()));
      const t=updated.state.trades[req.body.tradeId];res.json({mode:'SANDBOX',tradeId:t.id,closedAt:t.closedAt,netPnl:t.netPnl,pnlBasis:t.pnlBasis,liveOrdersSupported:false});
    }));
    app.post(base+'/policy',guard(async(req,res)=>{
      if(req.body?.confirmSandbox!==true)return res.status(400).json({error:'SANDBOX_CONFIRMATION_REQUIRED'});
      const updated=await store.mutate(s=>engine.configurePolicy(s,req.body||{},now()));
      const p=updated.state.policy;res.json({mode:'SANDBOX',policy:p,dailyLossGoalRatio:p.dailyLoss/(p.dailyGoal||1000),liveOrdersSupported:false});
    }));
    for(const [path,operation] of [['arm','ARM'],['stop','STOP']])app.post(base+'/'+path,guard(async(req,res)=>{
      if(req.body?.confirmSandbox!==true)return res.status(400).json({error:'SANDBOX_CONFIRMATION_REQUIRED'});
      const updated=await store.mutate(s=>engine.control(s,operation,req.body.requestId,now()));
      res.json({mode:'SANDBOX',armed:updated.state.armed,killed:updated.state.killed,liveOrdersSupported:false});
    }));
  }
  return {start,stop,tick,advise,routes,status:publicStatus};
}
module.exports={createSandboxService};
