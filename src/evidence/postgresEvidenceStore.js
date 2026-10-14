'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
function createPostgresEvidenceStore({ pool, limit = 10000 }) {
  let writeError = null, lastPersistedAt = null, restoredRecords = 0;
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
  return { load, append, status: () => ({ provider:'POSTGRES', durable:true, writeError, lastPersistedAt, restoredRecords, memoryLimit:limit, retention:'All persisted records retained; latest records loaded for analysis' }) };
}
module.exports = { createPostgresEvidenceStore };
