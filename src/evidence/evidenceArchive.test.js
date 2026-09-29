'use strict';
const assert = require('assert');
const { createEvidenceArchive, configured, signedHeaders } = require('./evidenceArchive');

const env = { R2_ENDPOINT:'https://abc.r2.cloudflarestorage.com', R2_BUCKET:'edge-evidence', R2_ACCESS_KEY_ID:'AKID', R2_SECRET_ACCESS_KEY:'SECRET' };
assert.strictEqual(configured({endpoint:'x',bucket:'b',accessKeyId:'a',secretAccessKey:'s'}), true);
assert.strictEqual(configured({endpoint:'',bucket:'b',accessKeyId:'a',secretAccessKey:'s'}), false);
const h=signedHeaders({method:'GET',url:new URL('https://abc.r2.cloudflarestorage.com/edge-evidence/latest.jsonl'),accessKeyId:'AKID',secretAccessKey:'SECRET',now:new Date('2026-09-29T00:00:00Z')});
assert.ok(h.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKID/20260929/auto/s3/aws4_request'));
assert.strictEqual(h['x-amz-date'],'20260929T000000Z');

(async()=>{
  const calls=[];
  const request=async req=>{calls.push(req); if(req.method==='GET') return {statusCode:200,body:'{"id":"1"}\n{"id":"2"}\n'}; return {statusCode:200,body:''};};
  const archive=createEvidenceArchive({env,request,now:()=>new Date('2026-09-29T00:00:00Z')});
  const restored=await archive.restore();
  assert.strictEqual(restored.restored,true); assert.strictEqual(restored.records.length,2);
  const backed=await archive.backup(restored.records);
  assert.strictEqual(backed.backedUp,true); assert.strictEqual(backed.records,2);
  assert.strictEqual(calls[1].body,'{"id":"1"}\n{"id":"2"}\n');
  assert.strictEqual(calls[1].headers['content-length'], String(Buffer.byteLength(calls[1].body, 'utf8')));
  assert.strictEqual(calls[1].headers['content-type'], 'application/x-ndjson');
  assert.strictEqual(archive.status().recordsBackedUp,2);

  const empty=createEvidenceArchive({env,request:async()=>({statusCode:404,body:''})});
  const none=await empty.restore();
  assert.strictEqual(none.reason,'ARCHIVE_EMPTY');

  const off=createEvidenceArchive({env:{}});
  assert.strictEqual((await off.restore()).reason,'NOT_CONFIGURED');
  console.log('evidenceArchive tests passed');
})().catch(err=>{console.error(err);process.exit(1);});
