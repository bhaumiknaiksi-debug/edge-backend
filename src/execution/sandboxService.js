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
function createSandboxService({pool,ownerToken,getContext=()=>({}),env=process.env,dependencies={}}){
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
  let running=false,stopped=false,timer=null,lastError=reason,lastTickAt=null,lastEntryResult=null,brokerReads=null,positionBasis=null;
  const publicStatus=()=>({version:'EDGE_SANDBOX_EXECUTION_V1',enabled,mode:'SANDBOX',liveOrdersSupported:false,
    liveDecisionImpact:false,configured:!reason,reason:lastError,lastTickAt,lastEntryResult,brokerReads,positionBasis});
  const clean=e=>/^[A-Z_]{3,80}$/.test(e?.message||'')?e.message:'SANDBOX_SERVICE_UNAVAILABLE';
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
    if(reason||running||stopped)return publicStatus();running=true;
    try{
      const time=now();
      const lease=await store.mutate(s=>{
        if(s.lease&&s.lease.owner!==bootId&&s.lease.until>time)return false;
        engine.recover(s,bootId);s.lease={owner:bootId,until:time+30000};return true;
      });
      if(!lease.result){lastError='ANOTHER_WORKER_ACTIVE';return publicStatus();}
      const analysis=getContext().analysis,selected=engine.selectCandidate(lease.state.policy,analysis);
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
      const context={...getContext(),quotes};
      const prepared=await store.mutate(s=>{
        if(s.lease?.owner!==bootId||s.lease.until<=now())return null;
        engine.reconcile(s,book,positions,readAt,{positionBasis:positions===null?'SANDBOX_ORDER_BOOK_DERIVED':'BROKER_POSITIONS'});
        engine.manage(s,context.quotes||{},now());
        const planKey=engine.selectCandidate(s.policy,context.analysis).leg?.instrumentKey||context.analysis?.decision?.tradeLegs?.buyLeg?.instrumentKey;
        lastEntryResult=engine.planEntry(s,context.analysis,context.quotes?.[planKey],meta,now());
        const pending=Object.values(s.orders).find(o=>o.kind==='ENTRY'&&o.state==='QUEUED');
        return engine.claim(s,now(),!pending||currentAllowed(pending,{...getContext(),quotes},now(),s.policy));
      });
      positionBasis=prepared.state.positionBasis;
      const action=prepared.result;
      if(action){
        if(action.action==='PLACE'&&action.order.kind==='ENTRY'){
          const allowed=await store.mutate(s=>{
            if(s.killed||!s.armed||stopped||s.lease?.owner!==bootId||!currentAllowed(action.order,{...getContext(),quotes},now(),s.policy)){
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
      lastError=clean(e);
      if(store){
        const emergency=await store.mutate(s=>{
          if(s.lease?.owner!==bootId)return null;
          engine.halt(s,lastError);s.reconciledAt=null;return engine.claimEmergencyCancel(s,now());
        }).catch(()=>null);
        if(emergency?.result){
          const result=await broker.cancel(emergency.result.order.orderId).catch(()=>({state:'UNCERTAIN'}));
          await store.mutate(s=>{if(s.lease?.owner===bootId)engine.finish(s,emergency.result,result);}).catch(()=>{});
        }
      }
    }finally{running=false;}
    return publicStatus();
  }
  // Realized sandbox results by the tier each trade entered at, so every tier can be judged on its own.
  function tierSummary(state){
    const out={};
    for(const t of Object.values(state.trades)){
      if(!t.closedAt||!(t.buys>0))continue;
      const k=t.tier||'A',row=out[k]||={trades:0,wins:0,losses:0,netPnl:0};
      row.trades++;row.netPnl=Math.round((row.netPnl+t.netPnl)*100)/100;if(t.netPnl>0)row.wins++;else if(t.netPnl<0)row.losses++;
    }
    return {basis:'BROKER_FILLS_MINUS_ESTIMATED_FRICTION',byEntryTier:out};
  }
  function start(){if(reason||timer)return;stopped=false;timer=setInterval(()=>{void tick();},2000);timer.unref?.();void tick();}
  function stop(){stopped=true;if(timer)clearInterval(timer);timer=null;}
  function routes(app){
    const base='/api/v1/execution/sandbox';
    for(const [suffix,file,type] of [['/control','control.html','html'],['/control.js','control.js','js'],['/control.css','control.css','css']])app.get(base+suffix,(_req,res)=>{
      res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');
      res.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.type(type).send(readFileSync(path.join(__dirname,file),'utf8'));
    });
    app.get(base+'/status',(_req,res)=>{res.set('Cache-Control','no-store');res.json(publicStatus());});
    const guard=fn=>async(req,res)=>{
      res.set('Cache-Control','no-store');const auth=String(req.headers.authorization||'');
      if(!ownerToken||!auth.startsWith('Bearer ')||!timingSafeOwnerToken(auth.slice(7),ownerToken))return res.status(401).json({error:'OWNER_AUTH_REQUIRED'});
      if(reason)return res.status(503).json({error:reason});
      try{await fn(req,res);}catch(e){res.status(409).json({error:clean(e)});}
    };
    app.get(base,guard(async(_req,res)=>{const state=await store.read();res.json({status:publicStatus(),state,tierSummary:tierSummary(state),catalog:catalog.status()});}));
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
  return {start,stop,tick,routes,status:publicStatus};
}
module.exports={createSandboxService};
