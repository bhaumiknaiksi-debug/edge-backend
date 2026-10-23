'use strict';
// Read-only observation of an already-executed manual Kite trade.
// This module MUST NOT import or call signal selection, order placement, or ledger budget mutations.
const crypto=require('crypto');
const {timingSafeOwnerToken}=require('../notifications/edgeWebPush');
const {summarizeBroker}=require('./kiteTradebook');
const {buildTradePlans}=require('./readOnlyTradePlanner');

const ENABLED=process.env.EDGE_TRADE_SNAPSHOTS_ENABLED==='true';
const ISO_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MONTH_CODE={O:10,N:11,D:12};
const clone=x=>x==null?null:JSON.parse(JSON.stringify(x));

function contractFromKite(symbol){
  const s=String(symbol||'').toUpperCase();
  const weekly=/^NIFTY(\d{2})([1-9OND])(\d{2})(\d{5})(CE|PE)$/.exec(s);
  if(weekly){
    const month=MONTH_CODE[weekly[2]]||Number(weekly[2]);
    const date='20'+weekly[1]+'-'+String(month).padStart(2,'0')+'-'+weekly[3];
    if(!Number.isNaN(Date.parse(date))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date)
      return {expiry:date,strike:Number(weekly[4]),type:weekly[5],exact:true};
  }
  const monthly=/^NIFTY(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{5})(CE|PE)$/.exec(s);
  if(monthly)return {expiry:'20'+monthly[1]+'-'+String(MONTHS.indexOf(monthly[2])+1).padStart(2,'0'),strike:Number(monthly[3]),type:monthly[4],exact:false};
  return null;
}

function candidateLegs(plan){
  const legs=plan&&plan.legs||{};
  return ['buyLeg','sellLeg','ceShort','ceLong','peShort','peLong'].flatMap(name=>{
    const leg=legs[name];
    if(!leg||typeof leg!=='object'||!Number.isInteger(Number(leg.strike))||!['CE','PE'].includes(leg.type))return [];
    const side=['sellLeg','ceShort','peShort'].includes(name)?'SELL':'BUY';
    return [{name,side,strike:Number(leg.strike),type:leg.type,instrumentKey:leg.instrumentKey||null,contractId:leg.contractId||null}];
  });
}

function buildSnapshot(analysis,tier,expectedTimestamp,now=new Date()){
  if(!analysis||!ISO_RE.test(String(analysis.timestamp||'')))throw Error('SNAPSHOT_NO_CURRENT_ANALYSIS');
  if(analysis.timestamp!==expectedTimestamp)throw Error('SNAPSHOT_ANALYSIS_CHANGED');
  const age=now.getTime()-Date.parse(analysis.timestamp);
  if(!Number.isFinite(age)||age < -20000||age>120000)throw Error('SNAPSHOT_ANALYSIS_STALE');
  if(!['A','B','C'].includes(tier))throw Error('INVALID_SNAPSHOT_TIER');
  const plan=analysis.decision?.researchCandidatePlans?.plans?.[tier];
  if(!plan||plan.available!==true||!candidateLegs(plan).length)throw Error('SNAPSHOT_CANDIDATE_UNAVAILABLE');
  const d=analysis.decision||{},m=analysis.market||{};
  const snapshot={
    schemaVersion:1,analysisAt:analysis.timestamp,capturedAt:now.toISOString(),
    source:'EDGE_BACKEND',ruleSpec:clone(d.ruleSpec),tier,actualSignalTier:d.signalTier?.tier||'OBSERVING',
    strategy:plan.strategy||null,expiry:analysis.expiry||null,
    selectedCandidate:clone(plan),selectedLegs:candidateLegs(plan),
    // Freeze the contemporaneous research hypothesis BEFORE importing Kite results.
    tradePlan:clone(buildTradePlans(analysis).tiers[tier]),
    authorization:{executionAllowed:tier==='A'&&plan.executionAllowed===true&&d.orchestration?.status==='READY_TO_EXECUTE',
      researchOnly:tier!=='A',orchestrationStatus:d.orchestration?.status||null,
      failedGates:clone(d.signalTier?.failedGates||[]),blockers:clone(d.orchestration?.blockers||[])},
    prices:{spot:analysis.spot??null,bias:analysis.biasLabel||analysis.bias||null,confidence:analysis.confidence??null,pcr:analysis.pcr??null,ivRegime:analysis.ivRegime||null,avgIV:analysis.avgIV??null},
    context:{marketPhase:m.phase||null,dte:analysis.dte??null,support:clone(analysis.support),resistance:clone(analysis.resistance),maxPain:analysis.maxPain??null,
      entry:clone(d.entry),risk:clone(d.risk),regime:clone(d.regime),chartIntelligence:clone(m.chartIntelligence||m.context?.chartIntelligence),
      optionExecutionIntelligence:clone(d.optionExecutionIntelligence?.tiers?.[tier]),explain:clone(analysis.explain)}
  };
  if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>262144)throw Error('SNAPSHOT_PAYLOAD_TOO_LARGE');
  return snapshot;
}

function matchQuality(leg,fill,expiry){
  if(fill.side!==leg.side)return null;
  const contract=contractFromKite(fill.symbol);
  if(!contract||contract.strike!==leg.strike||contract.type!==leg.type||!expiry)return null;
  if(contract.exact)return contract.expiry===expiry?'EXACT':null;
  return contract.expiry===String(expiry).slice(0,7)?'MONTH_ONLY':null;
}
function parseIst(time){
  const t=Date.parse(String(time||'')+'+05:30');
  return Number.isFinite(t)?t:NaN;
}
function matchSnapshots(snapshots,fills,episodes=[]){
  const candidateMaps=snapshots.map(s=>{
    const d=s.payload,legs=d.selectedLegs||[],stamp=Date.parse(d.capturedAt);
    const legMatches=legs.map(leg=>(fills||[]).filter(f=>{
      const delta=parseIst(f.time)-stamp;
      return delta>=-20*60000&&delta<=5*60000&&matchQuality(leg,f,d.expiry);
    }).sort((a,b)=>Math.abs(parseIst(a.time)-stamp)-Math.abs(parseIst(b.time)-stamp)));
    return {s,legs,legMatches};
  });
  const claimCounts=new Map();
  for(const c of candidateMaps)for(const matching of c.legMatches)for(const f of matching){
    claimCounts.set(f.key,(claimCounts.get(f.key)||0)+1);
  }
  return candidateMaps.map(({s,legs,legMatches})=>{
    const selected=[],qualities=[],issues=[],used=new Set();
    for(let i=0;i<legs.length;i++){
      const possible=legMatches[i];
      if(!possible.length){issues.push('MISSING_LEG_'+legs[i].name);continue;}
      const distinctOrders=[...new Set(possible.map(f=>f.orderId))];
      if(distinctOrders.length>1){issues.push('MULTIPLE_POSSIBLE_ORDERS_'+legs[i].name);continue;}
      for(const f of possible){
        if(claimCounts.get(f.key)>1){issues.push('FILL_CLAIMED_BY_MULTIPLE_SNAPSHOTS');continue;}
        if(!used.has(f.key)){selected.push(f);used.add(f.key);qualities.push(matchQuality(legs[i],f,s.payload.expiry));}
      }
    }
    const ambiguous=issues.some(x=>x.startsWith('MULTIPLE_')||x.startsWith('FILL_CLAIMED_'));
    const complete=selected.length>0&&legs.every(leg=>selected.some(f=>matchQuality(leg,f,s.payload.expiry)));
    const exact=qualities.length>0&&qualities.every(x=>x==='EXACT');
    const status=ambiguous||complete&&!exact?'AMBIGUOUS':complete?'MATCHED':selected.length?'PARTIAL':fills.length?'UNMATCHED':'PENDING_TRADEBOOK';
    let grossPnl=null,matchedEpisode=null;
    if(status==='MATCHED'&&legs.length===1&&legs[0].side==='BUY'){
      // Attribute P&L only when this click accounts for the ENTIRE reconstructed
      // broker episode. Scale-ins and overlapping fills have no defensible
      // per-snapshot P&L without finer-grained order/position reconciliation.
      const quantity=selected.reduce((n,f)=>n+f.quantity,0);
      const weightedEntry=quantity?selected.reduce((n,f)=>n+f.quantity*f.price,0)/quantity:null;
      const epMatches=episodes.filter(ep=>ep.quantity===quantity&&
        Math.abs(ep.entry-weightedEntry)<=0.02&&
        selected.some(f=>f.symbol===ep.symbol&&Math.abs(parseIst(ep.openedAt)-parseIst(f.time))<=60000));
      if(epMatches.length===1){grossPnl=epMatches[0].grossPnl;matchedEpisode=epMatches[0];}
    }
    const hypothesis=s.payload?.tradePlan;
    const planEvaluation=matchedEpisode&&hypothesis?.status==='MODEL_READY_SHADOW'
      ? {
          methodology:'OBSERVED_EXIT_VS_PRETRADE_HYPOTHESIS',
          predictedEntryAsk:hypothesis.entry?.ask??null,
          brokerEntry:matchedEpisode.entry,
          brokerExit:matchedEpisode.exit,
          modeledStop:hypothesis.stop?.premium??null,
          modeledTarget:hypothesis.targets?.[0]?.premium??null,
          entrySlippagePoints:Number((matchedEpisode.entry-(hypothesis.entry?.ask??matchedEpisode.entry)).toFixed(2)),
          exitedBeyondModeledTarget:matchedEpisode.exit>=(hypothesis.targets?.[0]?.premium??Infinity),
          exitedBeyondModeledStop:matchedEpisode.exit<=(hypothesis.stop?.premium??-Infinity),
          predictionVerified:false,
          limitations:'Tradebook only shows executed fill prices; cannot establish whether target or stop was touched intratrade.'
        }
      : null;
    return {snapshotId:s.id,status,details:{matchedFillKeys:selected.map(f=>f.key),
      matchedQuantity:selected.reduce((n,f)=>n+f.quantity,0),matchedLegs:legs.filter(leg=>selected.some(f=>matchQuality(leg,f,s.payload.expiry))).map(leg=>leg.name),
      requiredLegs:legs.map(l=>l.name),issues,expiryExact:exact,
      grossPnl,planEvaluation,netPnl:null,chargesKnown:false,source:'KITE_TRADEBOOK',affectsRiskLedger:false}};
  });
}

function createTradeSnapshots({app,pool,ownerToken,getAnalysis,enabled=ENABLED}){
  const base='/api/v1/trade-snapshots';
  app.get(base+'/status',(_req,res)=>res.json({enabled:!!enabled,version:1,readOnly:true}));
  const guard=fn=>async(req,res)=>{
    res.set('Cache-Control','no-store');
    const auth=String(req.headers.authorization||'');
    if(!ownerToken||!auth.startsWith('Bearer ')||!timingSafeOwnerToken(auth.slice(7),ownerToken))
      return res.status(401).json({error:'OWNER_AUTH_REQUIRED'});
    if(!enabled)return res.status(404).json({error:'SNAPSHOTS_DISABLED'});
    if(!pool)return res.status(503).json({error:'SNAPSHOT_DATABASE_UNAVAILABLE'});
    try{await fn(req,res);}catch(e){
      const message=String(e.message||'');
      const validation=/^(INVALID_|SNAPSHOT_)/.test(message);
      console.error('[trade snapshot]',validation?message:'STORAGE_OR_QUERY_ERROR');
      res.status(validation?(message==='SNAPSHOT_ANALYSIS_CHANGED'||message==='SNAPSHOT_ANALYSIS_STALE'?409:400):503).json({error:validation?message:'SNAPSHOT_STORAGE_UNAVAILABLE'});
    }
  };
  const readRows=async()=>{
    const r=await pool.query('SELECT s.id,s.payload,s.captured_at,m.status AS match_status,m.details AS match_details FROM edge_trade_snapshots_v1 s LEFT JOIN edge_trade_snapshot_matches_v1 m ON m.snapshot_id=s.id WHERE s.owner_id=$1 ORDER BY s.captured_at DESC LIMIT 500',['owner']);
    return r.rows;
  };
  async function reconcile(){
    if(!enabled||!pool)return {disabled:true};
    const r=await pool.query('SELECT payload FROM edge_trade_ledger_v1 WHERE owner_id=$1',['owner']);
    const ledger=r.rows[0]?.payload||{},fills=ledger.brokerFills||[],episodes=summarizeBroker(ledger).episodes;
    const rows=await readRows(),matches=matchSnapshots(rows,fills,episodes);
    for(const m of matches)await pool.query(
      'INSERT INTO edge_trade_snapshot_matches_v1(snapshot_id,status,details,updated_at) VALUES($1,$2,$3::jsonb,now()) ON CONFLICT(snapshot_id) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details,updated_at=now()',
      [m.snapshotId,m.status,JSON.stringify(m.details)]);
    return {count:matches.length,counts:matches.reduce((a,m)=>(a[m.status]=(a[m.status]||0)+1,a),{}),affectsRiskLedger:false};
  }
  app.post(base,guard(async(req,res)=>{
    const {requestId,tier,analysisTimestamp}=req.body||{};
    if(!UUID_RE.test(String(requestId||'')))throw Error('INVALID_SNAPSHOT_REQUEST_ID');
    if(!['A','B','C'].includes(tier)||!ISO_RE.test(String(analysisTimestamp||'')))throw Error('INVALID_SNAPSHOT_INPUT');
    const before=await pool.query('SELECT id,payload FROM edge_trade_snapshots_v1 WHERE owner_id=$1 AND request_id=$2',['owner',requestId]);
    if(before.rows.length){
      if(before.rows[0].payload.tier!==tier||before.rows[0].payload.analysisAt!==analysisTimestamp)throw Error('INVALID_SNAPSHOT_REQUEST_REUSE');
      return res.json({saved:true,duplicate:true,id:before.rows[0].id,payload:before.rows[0].payload});
    }
    const count=await pool.query("SELECT count(*)::int AS n FROM edge_trade_snapshots_v1 WHERE owner_id=$1 AND captured_at>now()-interval '1 hour'",['owner']);
    if(count.rows[0].n>=30)throw Error('SNAPSHOT_RATE_LIMIT');
    const payload=buildSnapshot(getAnalysis(),tier,analysisTimestamp);
    const id=crypto.randomUUID();
    const saved=await pool.query('INSERT INTO edge_trade_snapshots_v1(id,owner_id,request_id,analysis_at,captured_at,tier,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(owner_id,request_id) DO NOTHING RETURNING id',
      [id,'owner',requestId,payload.analysisAt,payload.capturedAt,tier,JSON.stringify(payload)]);
    if(!saved.rows.length){
      const same=await pool.query('SELECT id,payload FROM edge_trade_snapshots_v1 WHERE owner_id=$1 AND request_id=$2',['owner',requestId]);
      if(!same.rows.length||same.rows[0].payload.tier!==tier||same.rows[0].payload.analysisAt!==analysisTimestamp)throw Error('INVALID_SNAPSHOT_REQUEST_REUSE');
      return res.json({saved:true,duplicate:true,id:same.rows[0].id,payload:same.rows[0].payload});
    }
    res.status(201).json({saved:true,duplicate:false,id,payload});
  }));
  app.get(base,guard(async(req,res)=>{
    const rows=await readRows();
    res.json({snapshots:rows.map(r=>({id:r.id,payload:r.payload,matchStatus:r.match_status||'PENDING_TRADEBOOK',matchDetails:r.match_details||null})),affectsRiskLedger:false});
  }));
  app.post(base+'/reconcile',guard(async(req,res)=>res.json(await reconcile())));
  return {reconcile,enabled};
}
module.exports={buildSnapshot,contractFromKite,candidateLegs,matchQuality,matchSnapshots,createTradeSnapshots};
