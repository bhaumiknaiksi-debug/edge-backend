'use strict';

const crypto = require('crypto');
const https = require('https');

const DEFAULT_KEY = 'edge-evidence/latest.jsonl';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}
function encodePath(pathname) {
  return pathname.split('/').map(part => encodeURIComponent(part)).join('/');
}
function credentialsFromEnv(env = process.env) {
  const endpoint = (env.R2_ENDPOINT || '').replace(/\/$/, '');
  const bucket = env.R2_BUCKET || '';
  const accessKeyId = env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}
function configured(config) {
  return !!(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

function signedHeaders({ method, url, body = '', accessKeyId, secretAccessKey, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalUri = url.pathname;
  const canonicalHeaders = 'host:' + url.host + '\n' + 'x-amz-content-sha256:' + payloadHash + '\n' + 'x-amz-date:' + amzDate + '\n';
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signed, payloadHash].join('\n');
  const scope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'authorization': 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature
  };
}

function defaultRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('R2 request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createEvidenceArchive({ env = process.env, objectKey = env.R2_OBJECT_KEY || DEFAULT_KEY, request = defaultRequest, now = () => new Date() } = {}) {
  const config = credentialsFromEnv(env);
  let lastBackup = null, lastRestore = null, lastError = null, recordsBackedUp = 0, timer = null, running = false;

  function objectUrl() {
    const base = new URL(config.endpoint);
    const path = '/' + encodeURIComponent(config.bucket) + '/' + objectKey.split('/').map(encodeURIComponent).join('/');
    return new URL(path, base);
  }
  async function call(method, body = '') {
    const url = objectUrl();
    const headers = signedHeaders({ method, url, body, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now: now() });
    if (method === 'PUT') headers['content-type'] = 'application/x-ndjson';
    return request({ method, url, headers, body });
  }
  async function restore() {
    if (!configured(config)) return { restored: false, reason: 'NOT_CONFIGURED', records: [] };
    try {
      const response = await call('GET');
      if (response.statusCode === 404) {
        lastRestore = now().toISOString(); lastError = null;
        return { restored: false, reason: 'ARCHIVE_EMPTY', records: [] };
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('R2 restore HTTP ' + response.statusCode);
      const records = response.body.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
      lastRestore = now().toISOString(); lastError = null;
      return { restored: true, records };
    } catch (err) {
      lastError = err.message;
      return { restored: false, reason: 'ERROR', error: err.message, records: [] };
    }
  }
  async function backup(records) {
    if (!configured(config)) return { backedUp: false, reason: 'NOT_CONFIGURED' };
    if (running) return { backedUp: false, reason: 'ALREADY_RUNNING' };
    running = true;
    try {
      const body = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
      const response = await call('PUT', body);
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('R2 backup HTTP ' + response.statusCode);
      recordsBackedUp = records.length; lastBackup = now().toISOString(); lastError = null;
      return { backedUp: true, records: records.length };
    } catch (err) {
      lastError = err.message;
      return { backedUp: false, reason: 'ERROR', error: err.message };
    } finally { running = false; }
  }
  function start(getRecords, intervalMs = Number(env.R2_BACKUP_INTERVAL_MS) || DEFAULT_INTERVAL_MS) {
    if (!configured(config) || timer) return;
    timer = setInterval(() => backup(getRecords()), intervalMs);
    timer.unref?.();
  }
  function status() {
    return { configured: configured(config), provider: 'CLOUDFLARE_R2', bucket: config.bucket || null, objectKey, lastBackup, lastRestore, lastError, recordsBackedUp, running };
  }
  return { restore, backup, start, status };
}

module.exports = { createEvidenceArchive, credentialsFromEnv, configured, signedHeaders };
