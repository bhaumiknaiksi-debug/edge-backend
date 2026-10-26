'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const { registerEvidenceMonitoring } = require('./evidenceMonitoring');
const { createPostgresEvidenceStore } = require('./postgresEvidenceStore');

(async () => {
  const app = express();
  const record = Object.freeze({id:'private-fixture-id',recordType:'POLL_SNAPSHOT',
    timestamp:'2026-10-26T08:00:00Z',strategy:'WAIT'});
  let initialized = false, databaseFails = false, damaged = false, researchError = null;
  const rows = [record], queries = [];
  const store = createPostgresEvidenceStore({pool:{query:async sql => {
    queries.push(sql);
    if (databaseFails) throw new Error('postgres://private-credential@private-host');
    return {rows:[{payload_gzip:zlib.gzipSync(JSON.stringify(damaged ? {...record,strategy:'DAMAGED'} : record))}]};
  }}});
  const options = {store,archive:{status:()=>({configured:false})},postgresPrimary:true,
    getSnapshots:()=>rows,getLastPollAt:()=>null,isInitialized:()=>initialized,
    harvester:{getStatus:()=>({})},researchHarvester:{getStatus:()=>({lastError:researchError})},
    collectionMode:'LIGHTWEIGHT',now:()=>new Date('2026-10-26T11:00:00Z')};
  registerEvidenceMonitoring(app, options);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  async function request(path, method = 'GET') {
    return new Promise((resolve,reject) => {
      const req = http.request({hostname:'127.0.0.1',port:server.address().port,path,method}, res => {
        let text = '';
        res.on('data',chunk=>{text+=chunk;});
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,
          body:res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null}));
      });
      req.on('error',reject); req.end();
    });
  }
  try {
    let response = await request('/evidence/health');
    assert.equal(response.status,503);
    assert.equal(response.body.healthy,false);
    assert(response.body.issues.includes('EVIDENCE_INITIALIZING'));
    assert.equal(response.headers['cache-control'],'no-store');
    assert.equal((await request('/evidence/storage/verify')).status,503);
    assert.equal(queries.length,0,'startup must not issue a premature verification query');

    initialized = true;
    response = await request('/evidence/health');
    assert.equal(response.status,200);
    assert.equal(response.body.counterScope,'LOADED_WORKING_SET');
    assert.equal(response.body.continuousCollectionVerified,false);
    response = await request('/evidence/storage/verify');
    assert.equal(response.status,200);
    assert.equal(response.body.ok,true);
    assert.equal(response.body.scope,'SINGLE_RECORD_READBACK');
    assert(!response.text.includes(record.id),'probe must not disclose evidence payloads');
    assert.equal(response.headers['cache-control'],'no-store');
    assert.equal((await request('/evidence/storage/verify','POST')).status,404);

    damaged = true;
    response = await request('/evidence/storage/verify');
    assert.equal(response.status,503);
    assert.equal(response.body.error,'PERSISTED_RECORD_MISMATCH');
    assert((await request('/evidence/health')).body.issues.includes('STORAGE_VERIFICATION_FAILED'));
    damaged = false; databaseFails = true;
    response = await request('/evidence/storage/verify');
    assert.equal(response.status,503);
    assert(!response.text.includes('private-credential'));
    databaseFails = false;
    assert.equal((await request('/evidence/storage/verify')).status,200);
    assert.equal((await request('/evidence/health')).status,200);

    researchError = 'TEST_FAILURE';
    response = await request('/evidence/health');
    assert.equal(response.status,503);
    assert(response.body.issues.includes('RESEARCH_HARVESTER_ERROR'));
    assert(queries.every(sql=>sql.startsWith('SELECT')),'monitoring must never write to storage');
    assert.deepEqual(rows,[record]);

    // Local/archive mode is explicitly distinguished; its mutating backup endpoint
    // is not invoked by the read-only PostgreSQL verification route.
    const localApp = express();
    const registered = {};
    localApp.get = (route,handler) => {registered[route]=handler;};
    registerEvidenceMonitoring(localApp,{...options,postgresPrimary:false});
    const localResponse = {set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await registered['/evidence/storage/verify']({},localResponse);
    assert.equal(localResponse.code,409);
    assert.equal(localResponse.body.verificationPath,'/evidence/archive/verify');
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
  console.log('Evidence monitoring HTTP PASS: cold-start 503, scoped readback, no writes, failure/recovery, research errors and archive-mode separation');
})().catch(error=>{console.error(error);process.exitCode=1;});
