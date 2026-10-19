'use strict';
const assert=require('assert');const {isTradingDay,daySummary,buildEvidenceHealth}=require('./evidenceHealth');
const rows=[{id:'a',recordType:'POLL_SNAPSHOT',timestamp:'2026-09-30T04:00:00.000Z',strategy:'WAIT',orchestrationStatus:'NO_TRADE'},{id:'b',recordType:'POLL_SNAPSHOT',timestamp:'2026-09-30T04:01:00.000Z',strategy:'WAIT',orchestrationStatus:'NO_TRADE'}];
assert.equal(isTradingDay('2026-10-02'),false);assert.equal(isTradingDay('2026-09-30'),true);assert.equal(daySummary(rows,'2026-09-30').noTradeDay,true);
let h=buildEvidenceHealth({rows,storage:{durable:true},archive:{configured:true,lastBackup:'2026-09-30T04:02:00.000Z',recordsBackedUp:2,lastVerification:{ok:true,timestamp:'2026-09-30T04:02:30.000Z'}},harvester:{},now:new Date('2026-09-30T11:00:00.000Z')});assert.equal(h.healthy,true);assert.equal(h.archive.syncedThroughLastAppend,true);assert.equal(h.noTradeDays,1);assert.equal(h.verifiedMarketDays,1);assert.deepEqual(h.missingSessions,[]);
h=buildEvidenceHealth({rows,storage:{durable:true},archive:{configured:true,lastBackup:'2026-09-30T03:59:00.000Z',recordsBackedUp:1},harvester:{},now:new Date('2026-09-30T04:10:00.000Z'),staleAfterMinutes:5});assert(h.issues.includes('APPEND_STALE_DURING_MARKET'));assert(h.issues.includes('ARCHIVE_NOT_CAUGHT_UP'));
const gapRows=rows.concat([{id:'c',recordType:'POLL_SNAPSHOT',timestamp:'2026-10-05T04:00:00.000Z',strategy:'WAIT',orchestrationStatus:'NO_TRADE'}]);
const gap=buildEvidenceHealth({rows:gapRows,storage:{durable:true},archive:{configured:false},harvester:{},now:new Date('2026-10-05T11:00:00.000Z')});
assert(gap.missingSessions.includes('2026-10-01'),'trading-day gap must be detected');assert(!gap.missingSessions.includes('2026-10-02'),'NSE holiday must not be reported missing');
// Event-driven evidence is sparse by design; check successful market polling, not writes.
const sparse=buildEvidenceHealth({rows,storage:{durable:true},archive:{configured:false},harvester:{},
  now:new Date('2026-09-30T04:30:00Z'),collectionMode:'LIGHTWEIGHT',lastPollAt:'2026-09-30T04:29:00Z'});
assert.equal(sparse.collectionMode,'LIGHTWEIGHT');
assert.equal(sparse.appendFresh,true);
assert.equal(sparse.storedEvidenceFresh,false);
assert(!sparse.issues.includes('APPEND_STALE_DURING_MARKET'));
const stalled=buildEvidenceHealth({rows,storage:{durable:true},archive:{configured:false},harvester:{},
  now:new Date('2026-09-30T04:30:00Z'),collectionMode:'LIGHTWEIGHT',lastPollAt:'2026-09-30T04:18:00Z'});
assert(stalled.issues.includes('POLL_STALE_DURING_MARKET'));
console.log('evidenceHealth tests passed');
