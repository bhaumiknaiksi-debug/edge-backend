'use strict';
const assert=require('assert');const {isTradingDay,daySummary,buildEvidenceHealth}=require('./evidenceHealth');
const rows=[{id:'a',recordType:'POLL_SNAPSHOT',timestamp:'2026-09-30T04:00:00.000Z',strategy:'WAIT',orchestrationStatus:'NO_TRADE'},{id:'b',recordType:'POLL_SNAPSHOT',timestamp:'2026-09-30T04:01:00.000Z',strategy:'WAIT',orchestrationStatus:'NO_TRADE'}];
assert.equal(isTradingDay('2026-10-02'),false);assert.equal(isTradingDay('2026-09-30'),true);assert.equal(daySummary(rows,'2026-09-30').noTradeDay,true);
let h=buildEvidenceHealth({rows,storage:{durable:true},archive:{configured:true,lastBackup:'2026-09-30T04:02:00.000Z',recordsBackedUp:2},harvester:{},now:new Date('2026-09-30T04:03:00.000Z')});assert.equal(h.healthy,true);assert.equal(h.archive.syncedThroughLastAppend,true);assert.equal(h.noTradeDays,1);
h=buildEvidenceHealth({rows,storage:{durable:true},archive:{configured:true,lastBackup:'2026-09-30T03:59:00.000Z',recordsBackedUp:1},harvester:{},now:new Date('2026-09-30T04:10:00.000Z'),staleAfterMinutes:5});assert(h.issues.includes('APPEND_STALE_DURING_MARKET'));assert(h.issues.includes('ARCHIVE_NOT_CAUGHT_UP'));
console.log('evidenceHealth tests passed');
