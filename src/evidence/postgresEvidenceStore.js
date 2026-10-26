'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
function createPostgresEvidenceStore({ pool, limit = 10000 }) {
  let writeError = null, lastPersistedAt = null, restoredRecords = 0, lastVerification = null;
  function key(r) { return crypto.createHash('sha256').update(String(r.recordType || '') + '|' + (r.id || JSON.stringify(r))).digest('hex'); }
  async function load() {
    try {
      const result = await pool.query('SELECT payload_gzip FROM edge_evidence_v1 ORDER BY recorded_at DESC, record_key DESC LIMIT $1', [limit]);
      const rows = result.rows.map(r => JSON.parse(zlib.gunzipSync(r.payload_gzip).toString('utf8'))).reverse();
      restoredRecords = rows.length; writeError = null;
      return rows;
    } catch (e) { writeError = 'DATABASE_RESTORE_FAILED'; throw e; }
  }
  async function append(record) {
    try {
      const payload = zlib.gzipSync(Buffer.from(JSON.stringify(record)));
      await pool.query('INSERT INTO edge_evidence_v1(record_key,recorded_at,record_type,payload_gzip) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [key(record), record.timestamp, record.recordType || 'UNKNOWN', payload]);
      lastPersistedAt = new Date().toISOString(); writeError = null; return true;
    } catch (_) { writeError = 'DATABASE_APPEND_FAILED'; return false; }
  }
  // Read back one known persisted record, without INSERT/UPDATE/DELETE or an archive backup.
  // This is a bounded integrity check, not proof of full retention or continuous collection.
  async function verify(record) {
    const result = { provider:'POSTGRES', scope:'SINGLE_RECORD_READBACK', timestamp:new Date().toISOString(),
      ok:false, expectedRecords:record ? 1 : 0, verifiedRecords:0, verifiedRecordAt:record?.timestamp || null };
    try {
      if (!record) throw new Error('NO_PERSISTED_RECORDS_TO_VERIFY');
      const expected = JSON.stringify(record);
      const stored = await pool.query('SELECT payload_gzip FROM edge_evidence_v1 WHERE record_key = $1', [key(record)]);
      if (stored.rows.length !== 1) throw new Error('PERSISTED_RECORD_NOT_FOUND');
      const decoded = JSON.parse(zlib.gunzipSync(stored.rows[0].payload_gzip).toString('utf8'));
      if (JSON.stringify(decoded) !== expected) throw new Error('PERSISTED_RECORD_MISMATCH');
      result.ok = true; result.verifiedRecords = 1;
    } catch (e) {
      // Never expose database connection details or payload contents through the public probe.
      const expectedErrors = ['NO_PERSISTED_RECORDS_TO_VERIFY','PERSISTED_RECORD_NOT_FOUND','PERSISTED_RECORD_MISMATCH'];
      result.error = expectedErrors.includes(e.message) ? e.message : 'DATABASE_VERIFICATION_FAILED';
    }
    lastVerification = result;
    return { ...result };
  }
  return { load, append, verify, status: () => ({ provider:'POSTGRES', durable:true, writeError, lastPersistedAt, restoredRecords, lastVerification:lastVerification && {...lastVerification}, memoryLimit:limit, retention:'All persisted records retained; latest records loaded for analysis' }) };
}
module.exports = { createPostgresEvidenceStore };
