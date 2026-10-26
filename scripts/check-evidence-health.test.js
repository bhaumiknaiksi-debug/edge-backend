'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { assertHealth, assertVerification, assertHarvest } = require('./check-evidence-health');

const now = Date.parse('2026-10-26T08:35:52Z');
const timestamp = new Date(now).toISOString();
const health = {healthy:true, issues:[], timestamp, collectionMode:'LIGHTWEIGHT', collector:{initialized:true},
  storage:{durable:true}, session:{marketOpen:true}, lastPollAt:timestamp, appendFresh:true};
assert.doesNotThrow(() => assertHealth(health, now));
assert.doesNotThrow(() => assertHealth({...health,storedEvidenceFresh:false}, now));
assert.throws(() => assertHealth({...health,healthy:false,issues:['POLL_STALE_DURING_MARKET']}, now));
assert.throws(() => assertHealth({...health,healthy:'true'}, now));
assert.throws(() => assertHealth({...health,issues:['STORAGE_WRITE_ERROR']}, now));
assert.throws(() => assertHealth({...health,timestamp:'2026-10-26T07:00:00Z'}, now));
assert.throws(() => assertHealth({...health,timestamp:'2026-10-26T09:00:00Z'}, now));
assert.throws(() => assertHealth({...health,lastPollAt:'2026-10-26T08:00:00Z'}, now));
assert.throws(() => assertHealth({...health,lastPollAt:null}, now));
assert.throws(() => assertHealth({...health,collector:{initialized:false}}, now));
assert.throws(() => assertHealth({...health,storage:{durable:false}}, now));
assert.throws(() => assertHealth({...health,storage:{durable:true,lastVerification:{ok:false}}}, now));
assert.throws(() => assertHealth({...health,researchHarvester:{lastError:'TEST_FAILURE'}}, now));
assert.doesNotThrow(() => assertHealth({...health,session:{marketOpen:false},lastPollAt:null}, now));

const verified = {ok:true, provider:'POSTGRES', scope:'SINGLE_RECORD_READBACK', timestamp,
  expectedRecords:1, verifiedRecords:1, verifiedRecordAt:'2026-10-26T04:00:00Z'};
assert.doesNotThrow(() => assertVerification(verified, now));
for (const changed of [{ok:false},{verifiedRecords:0},{expectedRecords:0},{scope:'FULL_DATABASE'},
  {verifiedRecordAt:null},{verifiedRecordAt:'2026-10-27T08:00:00Z'},{timestamp:'2026-10-25T08:00:00Z'}]) {
  assert.throws(() => assertVerification({...verified,...changed}, now));
}
const archive = {ok:true,stage:'ROUND_TRIP',timestamp,expectedRecords:2,restoredRecords:2,missingIds:[]};
assert.doesNotThrow(() => assertVerification(archive, now));
assert.throws(() => assertVerification({...archive,restoredRecords:1}, now));
assert.throws(() => assertVerification({...archive,expectedRecords:0,restoredRecords:0}, now));
const harvested = {authoritative:{lastRun:timestamp,lastError:null},researchCandidates:{lastRun:timestamp,lastError:null}};
assert.doesNotThrow(() => assertHarvest(harvested, now));
assert.throws(() => assertHarvest({...harvested,authoritative:{lastRun:timestamp,lastError:'FAILED'}}, now));
assert.throws(() => assertHarvest({...harvested,researchCandidates:{lastRun:timestamp,running:true}}, now));

// Exercise actual CLI exit codes for HTTP-200-shaped but unhealthy JSON and valid JSON.
const cli = path.join(__dirname, 'check-evidence-health.js');
const liveShape = {...health,timestamp:new Date().toISOString(),session:{marketOpen:false}};
const run = input => spawnSync(process.execPath, [cli,'health'], {input:JSON.stringify(input),encoding:'utf8'});
assert.equal(run({...liveShape,healthy:false,issues:['STORAGE_WRITE_ERROR']}).status, 1);
assert.equal(run(liveShape).status, 0);

// Keep the tested assertions wired into both production-facing workflows. Syntax-check
// their shell blocks without executing a single curl, harvest or production request.
const workflows = ['edge-market-session.yml','trade-snapshot-live-smoke.yml'];
for (const name of workflows) {
  const workflow = fs.readFileSync(path.join(__dirname,'../.github/workflows',name),'utf8');
  assert(workflow.includes('node scripts/check-evidence-health.js health'));
  const blocks = [...workflow.matchAll(/^        run: \|\n((?:^          .*\n|^\n)+)/gm)];
  assert(blocks.length > 0);
  for (const match of blocks) {
    const shell = match[1].replace(/^          /gm,'');
    assert.equal(spawnSync('bash',['-n'],{input:shell,encoding:'utf8'}).status,0);
  }
}
const keepalive = fs.readFileSync(path.join(__dirname,'../.github/workflows/edge-market-session.yml'),'utf8');
assert(keepalive.includes('/evidence/storage/verify'));
assert(keepalive.includes('node scripts/check-evidence-health.js verification'));
assert(keepalive.includes('node scripts/check-evidence-health.js harvest'));
console.log('Collection checks PASS: unhealthy/stale responses fail, provider proofs are scoped, workflow assertions and shell syntax verified');
