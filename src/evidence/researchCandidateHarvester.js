'use strict';

const { harvestOutcome, retryDelay } = require('./outcomeHarvester');

const MAX_RETRIES=6;

function planKey(plan){
  const legs=Object.entries(plan?.legs||{}).filter(([,leg])=>leg&&leg.instrumentKey)
    .map(([name,leg])=>name+':'+leg.instrumentKey).sort().join(',');
  return String(plan?.strategy||'WAIT')+'|'+legs;
}
function candidateEpisodeStarts(rows,tier){
  const polls=(rows||[]).filter(x=>x.recordType==='POLL_SNAPSHOT').sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const starts=new Set();let previous=null;
  for(const snap of polls){
    const plan=snap?.researchCandidatePlans?.plans?.[tier];
    const available=!!plan?.available&&!!plan?.strategy&&plan.strategy!=='WAIT';
    const key=available?planKey(plan):null;
    if(available&&(!previous?.available||previous.key!==key))starts.add(snap.id);
    previous={available,key};
  }
  return starts;
}
function syntheticSnapshot(snap,tier){
  const plan=snap?.researchCandidatePlans?.plans?.[tier];
  if(!plan?.available||!plan?.strategy||!plan?.legs)return null;
  return{
    ...snap,
    id:String(snap.id)+'|RESEARCH|'+tier,
    strategy:plan.strategy,
    tradeLegs:plan.legs,
    orchestrationStatus:'RESEARCH_CANDIDATE',
    researchTier:tier
  };
}
function eligibleCandidate(snap,tier,now=Date.now(),horizonMinutes=120){
  const synthetic=syntheticSnapshot(snap,tier);if(!synthetic)return false;
  const age=now-new Date(snap.timestamp).getTime();
  if(!Number.isFinite(age)||age<horizonMinutes*60000)return false;
  const legs=Object.values(synthetic.tradeLegs||{}).filter(x=>x&&typeof x==='object'&&x.contractId);
  return legs.length>0&&legs.every(x=>x.instrumentKey);
}
function createResearchCandidateHarvester({store,snapshots,token,intervalMs=60000,horizonMinutes=120,harvest=harvestOutcome}={}){
  let timer=null,running=false;
  const terminal=new Set(),attempts=new Map();
  for(const row of snapshots||[]){
    if(row.recordType!=='RESEARCH_CANDIDATE_OUTCOME'||!row.snapshotId||!row.tier)continue;
    const key=row.tier+'|'+row.snapshotId;
    if(row.outcome?.status==='MEASURED'||row.outcome?.terminal===true)terminal.add(key);
    const a=Number(row.attempt);if(Number.isFinite(a))attempts.set(key,Math.max(attempts.get(key)||0,a));
  }
  const status={lastRun:null,lastError:null,measured:{B:0,C:0},eligible:0,retried:0,terminalFailures:terminal.size};
  for(const row of snapshots||[])if(row.recordType==='RESEARCH_CANDIDATE_OUTCOME'&&row.outcome?.status==='MEASURED'&&['B','C'].includes(row.tier))status.measured[row.tier]++;

  async function run(){
    if(running)return{...status,running:true};
    running=true;status.lastRun=new Date().toISOString();status.lastError=null;status.eligible=0;status.retried=0;
    try{
      const now=Date.now(),existing=new Set((snapshots||[]).map(x=>x.id));
      for(const tier of ['B','C']){
        const starts=candidateEpisodeStarts(snapshots||[],tier);
        for(const snap of [...(snapshots||[])]){
          if(!starts.has(snap.id)||!eligibleCandidate(snap,tier,now,horizonMinutes))continue;
          const stateKey=tier+'|'+snap.id;if(terminal.has(stateKey))continue;
          const last=(snapshots||[]).filter(x=>x.recordType==='RESEARCH_CANDIDATE_OUTCOME'&&x.snapshotId===snap.id&&x.tier===tier).slice(-1)[0];
          if(last?.nextRetryAt&&now<new Date(last.nextRetryAt).getTime())continue;
          status.eligible++;
          const attempt=(attempts.get(stateKey)||0)+1,synthetic=syntheticSnapshot(snap,tier);
          let outcome;try{outcome=await harvest(synthetic,{token});}catch(e){outcome={status:'UNAVAILABLE',reason:'HARVEST_ERROR',error:e.message};}
          const measured=outcome.status==='MEASURED',terminalFailure=!measured&&attempt>=MAX_RETRIES;
          if(terminalFailure)outcome={...outcome,terminal:true};
          const recId=snap.id+'|RESEARCH_OUTCOME|'+tier+'|'+attempt;
          if(existing.has(recId))continue;
          const rec={id:recId,recordType:'RESEARCH_CANDIDATE_OUTCOME',timestamp:new Date().toISOString(),snapshotId:snap.id,tier,attempt,
            candidateKey:planKey(snap.researchCandidatePlans.plans[tier]),nextRetryAt:measured||terminalFailure?null:new Date(now+retryDelay(attempt)).toISOString(),
            snapshot:synthetic,outcome};
          if(store.append(rec)===false)throw new Error('RESEARCH_EVIDENCE_STORE_APPEND_FAILED');
          snapshots.push(rec);existing.add(recId);attempts.set(stateKey,attempt);
          if(measured){terminal.add(stateKey);status.measured[tier]++;}
          else if(terminalFailure){terminal.add(stateKey);status.terminalFailures++;}
          else status.retried++;
        }
      }
    }catch(e){status.lastError=e.message;}finally{running=false;}
    return{...status,measured:{...status.measured}};
  }
  function start(){if(timer)return;timer=setInterval(run,intervalMs);timer.unref?.();}
  function getStatus(){return{...status,measured:{...status.measured},running};}
  return{run,start,getStatus};
}
module.exports={planKey,candidateEpisodeStarts,syntheticSnapshot,eligibleCandidate,createResearchCandidateHarvester};
