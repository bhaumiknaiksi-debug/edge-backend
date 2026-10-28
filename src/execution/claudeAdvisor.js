'use strict';
// Sandbox-only decision step: asks Claude BUY / SKIP / EXIT about EDGE's own candidates.
// Claude never sees credentials and never talks to a broker. The executor validates every answer and
// enforces all limits in code; any error, refusal or malformed answer is treated as "no decision".
const {boundedJson}=require('./upstoxSandbox');

const ENDPOINT='https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL='claude-sonnet-5-5';
const DEFAULT_VERSION='2026-10-21';
const VERSION='CLAUDE_DECIDES_V1';
const MAX_CALLS_PER_DAY=90;

const SYSTEM=`You are the entry and exit decision step of EDGE, a NIFTY weekly-options system.
This runs on an Upstox SANDBOX account (simulated money) so your decisions can be evaluated against EDGE's rule-based signals before any real money is used. Every decision you make is logged with its outcome.

Every 5 minutes you receive a JSON market snapshot. Answer with exactly one action:
- BUY: buy ONE lot of exactly one offered candidate card ("A", "B" or "C") whose strategy is LONG_CALL or LONG_PUT. Give stopUnderlying: the NIFTY index level that proves the trade wrong (below spot for a call, above spot for a put, and close enough that the risk fits the per-trade budget in the snapshot). The system converts it to a premium stop, sets a 1.5R target, and refuses the trade if risk exceeds the budget.
- SKIP: no trade. This is the default. Choose it whenever the setup is not clearly favourable after costs (about Rs 100 per lot round trip), when the spread is wide, late in the session, or when you are unsure.
- EXIT: only when a position is open and its thesis has failed or the move is done.

Rules: never invent strikes or contracts; you cannot change quantity, average down or reverse; at most one position at a time. Weigh time of day, days to expiry (option premium behaves very differently on expiry day), the opening range, prior-day levels, momentum, option flow, implied volatility, spread and theta decay.
Use tier "NONE" and stopUnderlying 0 for SKIP and EXIT. Confidence is your calibrated probability (0 to 1) that the action is right. Keep reason under 200 characters.`;

const SCHEMA={type:'object',additionalProperties:false,required:['action','tier','stopUnderlying','confidence','reason'],properties:{
  action:{type:'string',enum:['BUY','SKIP','EXIT'],description:'BUY one lot of one offered card, SKIP, or EXIT the open position'},
  tier:{type:'string',enum:['A','B','C','NONE'],description:'Candidate card for BUY; NONE otherwise'},
  stopUnderlying:{type:'number',description:'NIFTY index invalidation level for BUY; 0 otherwise'},
  confidence:{type:'number',description:'Calibrated probability between 0 and 1'},
  reason:{type:'string',description:'Under 200 characters'}}};

function createClaudeAdvisor({apiKey,model=DEFAULT_MODEL,version=DEFAULT_VERSION,request=fetch,now=Date.now}={}){
  if(typeof apiKey!=='string'||!apiKey.trim()||/[\r\n]/.test(apiKey))throw Error('MODEL_API_KEY_REQUIRED');
  if(!/^[a-z0-9.-]{3,80}$/.test(model))throw Error('MODEL_NAME_INVALID');
  const usage={day:null,calls:0};
  async function decide(snapshot){
    const today=new Date(now()+19800000).toISOString().slice(0,10);
    if(usage.day!==today){usage.day=today;usage.calls=0;}
    if(usage.calls>=MAX_CALLS_PER_DAY)throw Error('MODEL_DAILY_CALL_LIMIT');
    usage.calls++;
    let response;
    try{
      response=await request(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{'content-type':'application/json','anthropic-version':version,'x-api-key':apiKey,Authorization:'Bearer '+apiKey},
        body:JSON.stringify({model,max_tokens:400,system:SYSTEM,
          messages:[{role:'user',content:'Market snapshot (JSON):\n'+JSON.stringify(snapshot)}],
          output_config:{format:{type:'json_schema',schema:SCHEMA}}})});
    }catch(_){throw Error('MODEL_UNREACHABLE');}
    const payload=await boundedJson(response,256*1024).catch(()=>null);
    if(!response.ok)throw Error('MODEL_HTTP_'+(Number.isInteger(response.status)?response.status:'ERROR'));
    if(payload?.stop_details?.type==='refusal'||payload?.stop_reason==='refusal')
      return {action:'SKIP',tier:'NONE',stopUnderlying:0,confidence:0,reason:'Model declined to decide.',declined:true};
    if(payload?.stop_reason==='max_tokens')throw Error('MODEL_OUTPUT_TRUNCATED');
    const text=(payload?.content||[]).find(b=>b?.type==='text')?.text;
    let raw;try{raw=JSON.parse(text);}catch(_){throw Error('MODEL_OUTPUT_INVALID');}
    return validate(raw);
  }
  return {decide,model,usage:()=>({...usage})};
}

// Strict check of the model's answer; enum capitalization is not guaranteed by the API.
function validate(raw){
  const action=String(raw?.action||'').toUpperCase(),tier=String(raw?.tier||'').toUpperCase();
  const stop=Number(raw?.stopUnderlying),confidence=Number(raw?.confidence);
  if(!['BUY','SKIP','EXIT'].includes(action)||!['A','B','C','NONE'].includes(tier)||!Number.isFinite(stop)||
    !Number.isFinite(confidence)||typeof raw?.reason!=='string')throw Error('MODEL_OUTPUT_INVALID');
  if(action==='BUY'&&(tier==='NONE'||!(stop>0)))throw Error('MODEL_OUTPUT_INVALID');
  return {action,tier:action==='BUY'?tier:'NONE',stopUnderlying:action==='BUY'?stop:0,
    confidence:Math.min(1,Math.max(0,confidence)),reason:raw.reason.slice(0,200)};
}

const num=x=>typeof x==='number'&&Number.isFinite(x)?Math.round(x*100)/100:undefined;
// Only short, plain labels reach the model; anything else is dropped (defence against text injection via data fields).
const label=v=>typeof v==='string'&&/^[A-Za-z0-9 _.:\-\/()%+]{1,60}$/.test(v)?v:undefined;
function scalars(o,keys){const out={};for(const k of keys){const v=o?.[k];if(typeof v==='number'&&Number.isFinite(v))out[k]=num(v);else if(typeof v==='string'){const l=label(v);if(l!==undefined)out[k]=l;}else if(typeof v==='boolean')out[k]=v;}return out;}
const candle=c=>c?scalars(c,['open','high','low','close']):undefined;

// Compact, bounded view of the current EDGE analysis plus the sandbox's own position and limits.
function buildSnapshot(analysis,state,{now=Date.now(),quotes={},expiryBucket=null}={}){
  const d=analysis?.decision||{},ist=new Date(now+19800000),minutes=ist.getUTCHours()*60+ist.getUTCMinutes();
  const ctx=analysis?.market?.context||{},timing=ctx.timingSource||{},chart=analysis?.market?.chartIntelligence||ctx.chartIntelligence||{};
  const candidates={};
  for(const tier of ['A','B','C']){
    const p=d.researchCandidatePlans?.plans?.[tier];if(!p?.available)continue;
    const leg=p.legs?.buyLeg,st=d.shadowTiming?.plans?.[tier];
    candidates[tier]={strategy:label(p.strategy),singleLeg:!p.legs?.sellLeg,
      buy:leg?{strike:num(leg.strike),type:label(leg.type),...scalars(leg,['bid','ask','premium','delta'])}:undefined,
      sell:p.legs?.sellLeg?{strike:num(p.legs.sellLeg.strike),type:label(p.legs.sellLeg.type)}:undefined,
      openingRangeTiming:st?{status:label(st.status),reason:label(st.reason),ready:st.shadowEntryReady===true}:undefined};
  }
  const open=Object.values(state?.trades||{}).find(t=>!t.closedAt);
  const orders=Object.values(state?.orders||{});
  const entry=open&&orders.find(o=>o.tradeId===open.id&&o.kind==='ENTRY');
  const todays=Object.values(state?.trades||{}).filter(t=>t.day===ist.toISOString().slice(0,10));
  const realized=todays.filter(t=>t.closedAt&&t.buys>0).reduce((a,t)=>a+t.netPnl,0);
  const snap={
    timeIST:ist.toISOString().slice(11,16),minutesToClose:Math.max(0,930-minutes),date:ist.toISOString().slice(0,10),
    spot:num(analysis?.spot),expiry:label(analysis?.expiry),expiryBucket:label(expiryBucket),
    openingRange:timing.available?{high:num(timing.high),low:num(timing.low),latest5m:candle(timing.latest),previous5m:candle(timing.previous)}:'NOT_COMPLETE',
    previousDay:chart.previousDay?scalars(chart.previousDay,['high','low','close','open']):undefined,
    regime:scalars(d.regime,['direction','label','score','confidence']),
    momentum:{...scalars(analysis?.market?.features,['trend30mPct','sessionChangePct']),optionFlow:label(analysis?.market?.features?.optionFlow?.aggregate?.label)},
    volatility:scalars(analysis,['nearAtmIV','ivRegime','pcr','maxPain']),
    walls:scalars(analysis?.structure,['peWall','ceWall','rangeWidth','compression','breakoutRisk']),
    expectedMove:scalars(analysis?.expectedMove,['low','high','points']),
    edgeSignalTier:label(d.signalTier?.tier)||null,
    candidates,
    position:open?{tier:label(open.tier),strategy:label(open.strategy),strike:label(open.contractId),entryPrice:num(entry?.averagePrice),filled:entry?.filled||0,
      stopPremium:open.stop,targetPremium:open.target,currentBid:num(quotes[open.instrumentKey]?.bid)}:null,
    today:{realizedNetPnl:Math.round(realized*100)/100,tradesTaken:todays.length},
    limits:{lotSize:65,perTradeRiskRupees:state?.policy?.perTradeRisk,dailyLossRupees:state?.policy?.dailyLoss,
      maxTradesPerDay:state?.policy?.maxTradesPerDay,newEntriesUntilIST:'15:00',forcedExitIST:'15:15',frictionRupeesPerLot:state?.policy?.costReserve}};
  return JSON.parse(JSON.stringify(snap)); // drops undefined
}
module.exports={createClaudeAdvisor,buildSnapshot,validate,SYSTEM,SCHEMA,VERSION,DEFAULT_MODEL,MAX_CALLS_PER_DAY};
