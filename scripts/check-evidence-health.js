'use strict';

const fs = require('node:fs');

function freshTimestamp(value, now, maxAgeMs = 120000) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp <= now + 5000 && now - timestamp <= maxAgeMs;
}

function assertHealth(report, now = Date.now()) {
  if (report?.healthy !== true || !Array.isArray(report.issues) || report.issues.length) {
    throw new Error('Evidence unhealthy: ' + (report?.issues || ['INVALID_HEALTH_RESPONSE']).join(', '));
  }
  if (!freshTimestamp(report.timestamp, now)) throw new Error('Evidence health response is stale or invalid');
  if (report.collector?.initialized === false) throw new Error('Evidence initialization is incomplete');
  if (report.storage?.durable !== true || report.storage.writeError || report.storage.lastVerification?.ok === false) {
    throw new Error('Durable evidence storage is unavailable or its last verification failed');
  }
  if (!['LIGHTWEIGHT', 'FULL'].includes(report.collectionMode) || typeof report.session?.marketOpen !== 'boolean') {
    throw new Error('Evidence health mode or session is invalid');
  }
  if (report.harvester?.lastError || report.researchHarvester?.lastError) throw new Error('Outcome harvester failed');
  if (report.session.marketOpen) {
    const observedAt = report.collectionMode === 'LIGHTWEIGHT' ? report.lastPollAt : report.lastAppend;
    if (!freshTimestamp(observedAt, now, 5 * 60000) || report.appendFresh !== true) {
      throw new Error('Evidence collection is stale during market hours');
    }
  }
}

function assertVerification(report, now = Date.now()) {
  if (report?.ok !== true || !freshTimestamp(report.timestamp, now)) throw new Error('Evidence verification failed or is stale');
  if (report.provider === 'POSTGRES') {
    if (report.scope !== 'SINGLE_RECORD_READBACK' || report.expectedRecords !== 1 || report.verifiedRecords !== 1 ||
        typeof report.verifiedRecordAt !== 'string' || !Number.isFinite(Date.parse(report.verifiedRecordAt)) ||
        Date.parse(report.verifiedRecordAt) > now + 5000) throw new Error('PostgreSQL record readback was not established');
  } else if (report.stage !== 'ROUND_TRIP' || !(report.expectedRecords > 0) || report.restoredRecords !== report.expectedRecords ||
      !Array.isArray(report.missingIds) || report.missingIds.length) {
    throw new Error('Archive round trip was not established');
  }
}

function assertHarvest(report, now = Date.now()) {
  for (const key of ['authoritative', 'researchCandidates']) {
    const status = report?.[key];
    if (!status || status.lastError || status.running === true || !freshTimestamp(status.lastRun, now, 5 * 60000)) {
      throw new Error('Harvest did not finish successfully: ' + key);
    }
  }
}

if (require.main === module) {
  try {
    const [mode, file = '-'] = process.argv.slice(2);
    const check = {health:assertHealth, verification:assertVerification, harvest:assertHarvest}[mode];
    if (!check) throw new Error('Usage: node scripts/check-evidence-health.js health|verification|harvest [file|-]');
    const report = JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8'));
    check(report);
    console.log('Evidence ' + mode + ' check passed (not proof of continuous coverage or trading performance)');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { assertHealth, assertVerification, assertHarvest };
