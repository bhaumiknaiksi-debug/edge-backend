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
// Insertion order. recorded_at is each record's OWN timestamp, so records routinely arrive "behind" a time cursor
// (an analysis stamped a few seconds earlier is written after a newer record). With a time cursor every such row
// forced a full re-read of the whole archive, about once a minute, which used up the database's monthly transfer.
// A per-row sequence number makes incremental reads exact. Added once, idempotently.
const sequenced=new WeakMap();
function ensureSequence(pool){
 if(!sequenced.has(pool))sequenced.set(pool,(async()=>{
  await pool.query('ALTER TABLE edge_evidence_v1 ADD COLUMN IF NOT EXISTS seq bigserial');
  await pool.query('CREATE INDEX IF NOT EXISTS edge_evidence_v1_seq ON edge_evidence_v1(seq)');
 })().catch(e=>{sequenced.delete(pool);throw e;}));
 return sequenced.get(pool);
}
const byTime=(a,b)=>a.at<b.at?-1:a.at>b.at?1:a.key<b.key?-1:a.key>b.key?1:0;
async function loadOpportunitySource(pool,previous=null){
 if(!pool)throw Error('REPORT_DATABASE_REQUIRED');
 await ensureSequence(pool);
 const client=await pool.connect();
 try{
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const count=await client.query('SELECT count(*)::int AS n FROM edge_evidence_v1 WHERE record_type = ANY($1::text[])',[TYPES]);
  const total=count.rows[0].n;if(total>50000)throw Error('REPORT_SOURCE_LIMIT');
  const cols='SELECT record_key,recorded_at,seq,payload_gzip FROM edge_evidence_v1 WHERE record_type = ANY($1::text[])';
  const full=()=>client.query(cols+' ORDER BY seq LIMIT 50001',[TYPES]);
  const keysSql='SELECT record_key FROM edge_evidence_v1 WHERE record_type = ANY($1::text[])';
  let dropped=null;
  const prior=previous?.source?.cursor?.seq!==undefined&&Array.isArray(previous.entries)?previous.entries:null;
  let incremental=!!prior,mode=incremental?'INCREMENTAL':'FULL',evidence;
  if(incremental){
   const after=previous.source.cursor.seq;
   evidence=await client.query(cols+' AND seq>$2 ORDER BY seq LIMIT 50001',[TYPES,after]);
   if(prior.length+evidence.rows.length!==total){
    // A row that took a lower sequence number but committed after the last read (sequence numbers also skip on
    // failed or conflicting inserts, so the gap can be anywhere). Compare KEYS only (no payloads) and fetch just the
    // missing rows: first in a recent window, then across the whole bounded archive. Rows deleted since the last
    // read are dropped from the cache. Payloads are only re-downloaded in full if keys still don't reconcile.
    const fetched=new Set(evidence.rows.map(r=>r.record_key));const known=new Set(prior.map(e=>e.key));
    const reconcile=async(rows,complete)=>{
     if(complete){const listed=new Set(rows.map(r=>r.record_key));removed=prior.filter(e=>!listed.has(e.key)).map(e=>e.key);}
     const missing=rows.map(r=>r.record_key).filter(k=>!known.has(k)&&!fetched.has(k));
     if(missing.length){const extra=await client.query(cols+' AND record_key = ANY($2::text[])',[TYPES,missing]);evidence={rows:[...evidence.rows,...extra.rows]};for(const r of extra.rows)fetched.add(r.record_key);}
    };
    let removed=[];mode='GAP_RECOVERY';
    await reconcile((await client.query(keysSql+' AND seq>$2 AND seq<=$3',[TYPES,Math.max(0,after-5000),after])).rows,false);
    if(prior.length+evidence.rows.length!==total)await reconcile((await client.query(keysSql+' LIMIT 50001',[TYPES])).rows,true);
    if(removed.length)dropped=new Set(removed);
    if(prior.length-removed.length+evidence.rows.length!==total){incremental=false;mode='FULL';evidence=await full();}
   }
  }else evidence=await full();
  if(evidence.rows.length>50000)throw Error('REPORT_SOURCE_LIMIT');
  let bytes=incremental?previous.source.retainedBytes:0,rawBytes=incremental?previous.source.rawBytesScanned:0;
  const added=evidence.rows.map(r=>{const buffer=gunzipSync(r.payload_gzip,{maxOutputLength:2*1024*1024});rawBytes+=buffer.length;
   const projected=projectRecord(JSON.parse(buffer.toString('utf8')));bytes+=Buffer.byteLength(JSON.stringify(projected));if(bytes>32*1024*1024)throw Error('REPORT_SOURCE_LIMIT');
   return {key:r.record_key,at:new Date(r.recorded_at).toISOString(),seq:Number(r.seq),record:projected};});
  // Records stay in recorded_at order, exactly as a full read returns them.
  let entries;
  if(!incremental)entries=added.sort(byTime);
  else{const kept=dropped?prior.filter(e=>!dropped.has(e.key)):prior;if(dropped)bytes=kept.reduce((a,e)=>a+Buffer.byteLength(JSON.stringify(e.record)),0)+added.reduce((a,e)=>a+Buffer.byteLength(JSON.stringify(e.record)),0);
   const sorted=added.sort(byTime);entries=kept.length&&sorted.length&&byTime(sorted[0],kept.at(-1))<0?[...kept,...sorted].sort(byTime):[...kept,...sorted];}
  const records=entries.map(e=>e.record);
  if(records.length!==total)throw Error('REPORT_ARCHIVE_COUNT_MISMATCH');
  const ledger=await client.query("SELECT jsonb_build_object('brokerFills',coalesce(payload->'brokerFills','[]'::jsonb)) AS payload FROM edge_trade_ledger_v1 WHERE owner_id='owner'");
  if(!ledger.rows[0]?.payload)throw Error('REPORT_LEDGER_UNAVAILABLE');
  const snapshots=await client.query("SELECT id,jsonb_build_object('analysisAt',payload->'analysisAt','capturedAt',payload->'capturedAt','tier',payload->'tier','actualSignalTier',payload->'actualSignalTier','expiry',payload->'expiry','strategy',payload->'strategy','ruleSpec',jsonb_build_object('implementationHash',payload->'ruleSpec'->'implementationHash'),'selectedCandidate',payload->'selectedCandidate','selectedLegs',payload->'selectedLegs','authorization',payload->'authorization') AS payload FROM edge_trade_snapshots_v1 WHERE owner_id='owner' ORDER BY captured_at,id LIMIT 10001");
  if(snapshots.rows.length>10000)throw Error('REPORT_SOURCE_LIMIT');
  await client.query('COMMIT');
  const maxSeq=entries.reduce((m,e)=>Math.max(m,e.seq),incremental?previous.source.cursor.seq:0);
  const result={records,ledger:ledger.rows[0].payload,snapshots:snapshots.rows,
   source:{scope:'PERSISTED_ARCHIVE',completeRead:true,evidenceRecords:records.length,savedSnapshots:snapshots.rows.length,retainedBytes:bytes,rawBytesScanned:rawBytes,
    cursor:{seq:maxSeq},incrementalRead:incremental,readMode:mode,recordsFetched:evidence.rows.length,readAt:new Date().toISOString()}};
  Object.defineProperty(result,'entries',{value:entries,enumerable:false}); // carried to the next read, never reported
  return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
module.exports={loadOpportunitySource,projectRecord};
