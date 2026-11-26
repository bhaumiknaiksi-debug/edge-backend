'use strict';
// Turns a startup evidence-restore failure into one log line that names the cause, without
// database addresses, user names or passwords. Render logs are private, but connection
// strings still never belong in them.
const KINDS = [
  ['TABLE_MISSING', e => e.code === '42P01', 'the evidence table does not exist in this database: run npm run migrate:data against it'],
  ['PERMISSION_DENIED', e => e.code === '42501', 'the database user cannot read or write the evidence table'],
  ['AUTH_FAILED', e => e.code === '28P01' || e.code === '28000', 'the database rejected the user or password in EDGE_DATA_DATABASE_URL'],
  ['DATABASE_NOT_FOUND', e => e.code === '3D000', 'the database named in EDGE_DATA_DATABASE_URL does not exist'],
  ['QUOTA_OR_LIMIT', e => ['53300', '53400', '53200'].includes(e.code) || /quota|exceeded|limit reached|suspended|too many connections/i.test(e.message), 'the hosted database is over a plan limit or suspended: check its dashboard'],
  ['STATEMENT_TIMEOUT', e => e.code === '57014', 'the restore query ran past the 10 s statement timeout'],
  ['TLS', e => /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(e.code || '') || /certificate|self[- ]signed|ssl|tls/i.test(e.message), 'the SSL certificate check failed (sslmode in the connection string)'],
  ['CONNECTION', e => /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH)$/.test(e.code || '') || /timeout|terminated|connect/i.test(e.message), 'the database could not be reached'],
  ['RECORD_DECODE', e => e.code === 'Z_DATA_ERROR' || e.code === 'Z_BUF_ERROR' || e.name === 'SyntaxError', 'a stored evidence record could not be decompressed or parsed']
];

function sanitize(text) {
  return String(text || '')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>')            // any connection string or URL
    .replace(/(password|user|host)\s*=\s*[^\s;'"]+/gi, '$1=<hidden>')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

// stage: which restore step failed. err may carry the underlying database error as err.cause.
function describeRestoreError(err, stage = 'UNKNOWN') {
  const root = err && err.cause ? err.cause : err;
  const e = { code: root && root.code ? String(root.code) : null, name: root && root.name ? String(root.name) : 'Error', message: sanitize(root && root.message) };
  const hit = KINDS.find(([, test]) => { try { return test(e); } catch (_) { return false; } });
  return { stage, kind: hit ? hit[0] : 'UNKNOWN', code: e.code, name: e.name, message: e.message, hint: hit ? hit[2] : 'see message' };
}

function formatRestoreError(d) {
  return `[evidence] durable restore failed at ${d.stage}: ${d.kind}${d.code ? ' (' + d.code + ')' : ''}, ${d.hint}. ${d.name}: ${d.message}`;
}

module.exports = { describeRestoreError, formatRestoreError, sanitize };
