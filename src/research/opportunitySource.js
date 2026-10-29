'use strict';
const {gunzipSync}=require('node:zlib');
const TYPES=['POLL_SNAPSHOT','OPPORTUNITY_OBSERVATION','OUTCOME','RESEARCH_CANDIDATE_OUTCOME','OPPORTUNITY_OUTCOME','OPPORTUNITY_QUICK_EXIT'];
const pick=(x,keys)=>Object.fromEntries(keys.filter(k=>x?.[k]!==undefined).map(k=>[k,x[k]]));
function compactLegs(legs){
 const result=pick(legs,['lotSize','legDelta']);
 for(const name of ['buyLeg','sellLeg','ceShort','ceLong','peShort','peLong'])if(legs?.[name])result[name]=pick(legs[name],['contractId','instrumentKey','strike','type','bid','ask','premium','delta']);
 return result;
}
function compactPlan(p){return {...pick(p,['available','strategy','executionAllowed']),legs:compactLegs(p?.legs)};}
function projectRecord(r){
 const out=pick(r,['id','recordType','timestamp','observedAt','snapshotId','episodeId','tier','cardTier','attempt','terminal','nextRetryAt','expiry','strategy','orchestrationStatus','marketPhase']);
 if(r.ruleSpec)out.ruleSpec=pick(r.ruleSpec,['version','implementationHash']);
 if(r.tradeLegs)out.tradeLegs=compactLegs(r.tradeLegs);
 if(r.signalTier)out.signalTier=typeof r.signalTier==='string'?r.signalTier:pick(r.signalTier,['tier','gates']);
 if(r.entry)out.entry=pick(r.entry,['triggerReady','priceReady','liquidityReady']);
 if(r.orchestration)out.orchestration=pick(r.orchestration,['status','gates','blockers']);
 if(r.researchCandidatePlans)out.researchCandidatePlans={plans:Object.fromEntries(Object.entries(r.researchCandidatePlans.plans||{}).map(([t,p])=>[t,compactPlan(p)]))};
 if(r.candidates)out.candidates=r.candidates.map(c=>({...pick(c,['tier','strategy','expiry','lotSize','gateScope','gates','blockers','executionAllowed']),legs:compactLegs(c.legs)}));
 if(r.outcome)out.outcome=r.recordType==='OPPORTUNITY_QUICK_EXIT'?pick(r.outcome,['status','reason','version','entry','lotSize','results'])
  :{...pick(r.outcome,['status','reason','entryLegMarks']),horizonLegMarks:r.outcome.horizonLegMarks?.[60]?{60:r.outcome.horizonLegMarks[60]}:{}};
 return out;
}
async function loadOpportunitySource(pool,previous=null){
 if(!pool)throw Error('REPORT_DATABASE_REQUIRED');
 const client=await pool.connect();
 try{
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const count=await client.query('SELECT count(*)::int AS n FROM edge_evidence_v1 WHERE record_type = ANY($1::text[])',[TYPES]);
  const total=count.rows[0].n;if(total>50000)throw Error('REPORT_SOURCE_LIMIT');
  const full=()=>client.query('SELECT record_key,recorded_at,payload_gzip FROM edge_evidence_v1 WHERE record_type = ANY($1::text[]) ORDER BY recorded_at,record_key LIMIT 50001',[TYPES]);
  let incremental=!!previous?.source?.cursor,evidence;
  if(incremental){
   const c=previous.source.cursor;
   evidence=await client.query('SELECT record_key,recorded_at,payload_gzip FROM edge_evidence_v1 WHERE record_type = ANY($1::text[]) AND (recorded_at,record_key)>($2::timestamptz,$3::text) ORDER BY recorded_at,record_key LIMIT 50001',[TYPES,c.at,c.key]);
   // A late historical insert is behind the cursor: the count mismatch forces a full read.
   if(previous.records.length+evidence.rows.length!==total){incremental=false;evidence=await full();}
  }else evidence=await full();
  if(evidence.rows.length>50000)throw Error('REPORT_SOURCE_LIMIT');
  let bytes=incremental?previous.source.retainedBytes:0,rawBytes=incremental?previous.source.rawBytesScanned:0;
  const added=evidence.rows.map(r=>{const buffer=gunzipSync(r.payload_gzip,{maxOutputLength:2*1024*1024});rawBytes+=buffer.length;
   const projected=projectRecord(JSON.parse(buffer.toString('utf8')));bytes+=Buffer.byteLength(JSON.stringify(projected));if(bytes>32*1024*1024)throw Error('REPORT_SOURCE_LIMIT');return projected;});
  const records=incremental?[...previous.records,...added]:added;
  if(records.length!==total)throw Error('REPORT_ARCHIVE_COUNT_MISMATCH');
  const ledger=await client.query("SELECT jsonb_build_object('brokerFills',coalesce(payload->'brokerFills','[]'::jsonb)) AS payload FROM edge_trade_ledger_v1 WHERE owner_id='owner'");
  if(!ledger.rows[0]?.payload)throw Error('REPORT_LEDGER_UNAVAILABLE');
  const snapshots=await client.query("SELECT id,jsonb_build_object('analysisAt',payload->'analysisAt','capturedAt',payload->'capturedAt','tier',payload->'tier','actualSignalTier',payload->'actualSignalTier','expiry',payload->'expiry','strategy',payload->'strategy','ruleSpec',jsonb_build_object('implementationHash',payload->'ruleSpec'->'implementationHash'),'selectedCandidate',payload->'selectedCandidate','selectedLegs',payload->'selectedLegs','authorization',payload->'authorization') AS payload FROM edge_trade_snapshots_v1 WHERE owner_id='owner' ORDER BY captured_at,id LIMIT 10001");
  if(snapshots.rows.length>10000)throw Error('REPORT_SOURCE_LIMIT');
  await client.query('COMMIT');
  const last=evidence.rows.at(-1),cursor=last?{at:new Date(last.recorded_at).toISOString(),key:last.record_key}:previous?.source?.cursor||null;
  return {records,ledger:ledger.rows[0].payload,snapshots:snapshots.rows,
   source:{scope:'PERSISTED_ARCHIVE',completeRead:true,evidenceRecords:records.length,savedSnapshots:snapshots.rows.length,retainedBytes:bytes,rawBytesScanned:rawBytes,
    cursor,incrementalRead:incremental,recordsFetched:evidence.rows.length,readAt:new Date().toISOString()}};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
module.exports={loadOpportunitySource,projectRecord};
