'use strict';
const assert = require('assert');
const { describeRestoreError, formatRestoreError } = require('./restoreDiagnosis');
const err = (message, props = {}) => Object.assign(new Error(message), props);
const kind = (e, stage) => describeRestoreError(e, stage).kind;

// Errors as node-postgres and Node raise them.
assert.equal(kind(err('relation "edge_evidence_v1" does not exist', { code: '42P01' })), 'TABLE_MISSING');
assert.equal(kind(err('permission denied for table edge_evidence_v1', { code: '42501' })), 'PERMISSION_DENIED');
assert.equal(kind(err('password authentication failed for user "edge"', { code: '28P01' })), 'AUTH_FAILED');
assert.equal(kind(err('database "edge" does not exist', { code: '3D000' })), 'DATABASE_NOT_FOUND');
assert.equal(kind(err('Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.', { code: 'XX000' })), 'QUOTA_OR_LIMIT');
assert.equal(kind(err('sorry, too many clients already', { code: '53300' })), 'QUOTA_OR_LIMIT');
assert.equal(kind(err('self-signed certificate in certificate chain', { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), 'TLS');
assert.equal(kind(err('getaddrinfo ENOTFOUND db.example.internal', { code: 'ENOTFOUND' })), 'CONNECTION');
assert.equal(kind(err('Connection terminated due to connection timeout')), 'CONNECTION');
assert.equal(kind(err('canceling statement due to statement timeout', { code: '57014' })), 'STATEMENT_TIMEOUT');
assert.equal(kind(err('incorrect header check', { code: 'Z_DATA_ERROR' })), 'RECORD_DECODE');
assert.equal(kind(Object.assign(new SyntaxError('Unexpected token } in JSON'))), 'RECORD_DECODE');
assert.equal(kind(err('something new')), 'UNKNOWN');
assert.equal(kind(null), 'UNKNOWN');

// A failed local import carries the database error as its cause; the cause decides the kind.
const wrapped = new Error('EVIDENCE_MIGRATION_FAILED', { cause: err('relation "edge_evidence_v1" does not exist', { code: '42P01' }) });
const d = describeRestoreError(wrapped, 'LOCAL_IMPORT');
assert.deepEqual([d.stage, d.kind, d.code], ['LOCAL_IMPORT', 'TABLE_MISSING', '42P01']);
assert.match(formatRestoreError(d), /^\[evidence\] durable restore failed at LOCAL_IMPORT: TABLE_MISSING \(42P01\), the evidence table does not exist .*npm run migrate:data/);

// Connection details never reach the log line.
const leaky = err('connect to postgresql://edge_user:s3cretPass@ep-cool-db.aws.neon.tech:5432/edge?sslmode=require failed; host=10.1.2.3 password=hunter2', { code: 'ECONNREFUSED' });
const line = formatRestoreError(describeRestoreError(leaky, 'DATABASE_LOAD'));
for (const secret of ['s3cretPass', 'edge_user', 'neon.tech', 'hunter2', '10.1.2.3', 'postgresql://']) assert(!line.includes(secret), 'leaked ' + secret + ': ' + line);
assert.match(line, /CONNECTION \(ECONNREFUSED\)/);
assert(formatRestoreError(describeRestoreError(err('x'.repeat(5000)))).length < 500, 'bounded length');
console.log('Restore diagnosis PASS: database, quota, TLS, connection and decode failures named; wrapped causes followed; no connection details logged');
