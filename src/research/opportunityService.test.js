'use strict';
const assert=require('node:assert/strict'),express=require('express');
const {createOpportunityResearch}=require('./opportunityService');
const {buildObservation}=require('./opportunityCensus');
const BASE=Date.parse('2026-10-28T10:00:00+05:30'),iso=t=>new Date(t).toISOString(),OWNER='research-owner-test';
const records=Array.from({length:5},(_,i)=>({id:'poll-'+i,recordType:'OPPORTUNITY_OBSERVATION',timestamp:iso(BASE+i*60000),observedAt:iso(BASE+i*60000),ruleSpec:{implementationHash:'rules-test'},signalTier:{tier:'C'},
 candidates:[{tier:'C',strategy:'LONG_CALL',expiry:'2026-11-03',lotSize:65,legs:{lotSize:65,buyLeg:{contractId:'contract-'+i,instrumentKey:'NSE_FO|'+i,strike:23000+i*50,type:'CE',bid:99.95,ask:100}}}]}));
(async()=>{
 const writes=[],service=createOpportunityResearch({pool:{},store:{async append(r){writes.push(r);records.push(r);return true;}},ownerToken:OWNER,token:'server-only-secret',
  dependencies:{now:()=>BASE+3*3600000,load:async()=>({records:structuredClone(records),ledger:{brokerFills:[]},snapshots:[],source:{scope:'TEST',completeRead:true}}),
   harvest:async snapshot=>({status:'MEASURED',entryLegMarks:{buyLeg:{contractId:snapshot.tradeLegs.buyLeg.contractId,side:'BUY',price:100}},
    horizonLegMarks:{60:{timestamp:iso(Date.parse(snapshot.timestamp)+3600000),marks:{buyLeg:snapshot.tradeLegs.buyLeg.strike===23000?102:99}}}})}});
 await service.run();assert.equal(writes.length,4,'bounded collection selects candidates regardless of outcome');
 const app=express();app.use(express.json());service.routes(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port+'/api/v1/opportunities';
 try{
  assert.equal((await fetch(base)).status,401);const report=await (await fetch(base,{headers:{Authorization:'Bearer '+OWNER}})).json();
  const c=report.byCandidateTier.find(x=>x.tier==='C');assert.equal(c.flagged,5);assert.equal(c.wins,1);assert.equal(c.losses,3);assert.equal(c.unmeasured,1);
  const panel=await fetch(base+'/control');assert.equal(panel.status,200);assert.ok(panel.headers.get('content-security-policy').includes("connect-src 'self'"));
  const publicStatus=await (await fetch(base+'/status')).text();assert.ok(!publicStatus.includes(OWNER)&&!publicStatus.includes('server-only-secret'));
 }finally{service.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
 const badRows=[structuredClone(records[4])],badWrites=[];let clock=BASE+3*3600000;
 const bad=createOpportunityResearch({pool:{},store:{async append(r){badRows.push(r);badWrites.push(r);return true;}},token:'test',ownerToken:OWNER,
  dependencies:{now:()=>clock,load:async()=>({records:structuredClone(badRows),ledger:{brokerFills:[]},snapshots:[]}),harvest:async()=>({status:'MEASURED'})}});
 await bad.run();assert.equal(badWrites[0].outcome.status,'UNAVAILABLE');assert.equal(badWrites[0].terminal,false,'invalid measured payload must not terminate collection as a success');
 await bad.run();assert.equal(badWrites.length,1);clock+=6*60000;await bad.run();assert.equal(badWrites.length,2,'unavailable result retries only after backoff');bad.stop();
 const analysis={timestamp:iso(BASE),expiry:'2026-11-03',spot:23000,support:{strike:22850},resistance:{strike:23150},structure:{ceWall:23200,peWall:22800},dte:5,
  expectedMove:{low:22700,high:23300},market:{phase:'OPEN',features:{trend30mPct:1}},decision:{regime:{direction:'BULLISH',evidenceCoverage:100},signalTier:{tier:'C'},ruleSpec:{implementationHash:'rules-test'},
   researchCandidatePlans:{plans:{C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:{contractId:'contract',instrumentKey:'NSE_FO|1',strike:23000,type:'CE',premium:100,bid:99.95,ask:100}}}}}}};
 const original=JSON.stringify(analysis),observation=buildObservation(analysis,{lotSize:65,budget:{confirmed:false},observedAt:BASE});
 assert.equal(JSON.stringify(analysis),original);assert.equal(observation.candidates[0].executionAllowed,false);assert.equal(observation.candidates[0].gates.trigger,false);assert.equal(observation.candidates[0].lotSize,65);
 console.log('Opportunity service/census PASS: private HTTP report, all-candidate outcome collection, loss inclusion, static CSP, sanitized status and unchanged decisions');
})().catch(e=>{console.error(e);process.exitCode=1;});
