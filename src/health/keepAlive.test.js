'use strict';
const assert=require('node:assert/strict');
const {createKeepAlive,wanted,resolveUrl,INTERVAL_MS}=require('./keepAlive');
const at=s=>Date.parse(s);

// Windows are evaluated in IST.
assert.equal(wanted('weekdays',at('2026-10-30T23:50:00+05:30')),true,'Friday late night IST');
assert.equal(wanted('weekdays',at('2026-10-31T00:10:00+05:30')),false,'Saturday IST');
assert.equal(wanted('weekdays',at('2026-11-02T00:05:00+05:30')),true,'Monday just after midnight IST');
assert.equal(wanted('market',at('2026-10-28T08:20:00+05:30')),false);
assert.equal(wanted('market',at('2026-10-28T08:30:00+05:30')),true);
assert.equal(wanted('market',at('2026-10-28T16:29:00+05:30')),true);
assert.equal(wanted('market',at('2026-10-28T16:30:00+05:30')),false);
assert.equal(wanted('always',at('2026-11-01T03:00:00+05:30')),true);
assert.equal(wanted('off',at('2026-10-28T10:00:00+05:30')),false);

// Only an https public origin is accepted; Render provides RENDER_EXTERNAL_URL automatically.
assert.equal(resolveUrl({RENDER_EXTERNAL_URL:'https://edge-backend-r1ng.onrender.com/'}),'https://edge-backend-r1ng.onrender.com');
assert.equal(resolveUrl({EDGE_PUBLIC_URL:'https://x.example.com',RENDER_EXTERNAL_URL:'https://y.onrender.com'}),'https://x.example.com');
assert.equal(resolveUrl({RENDER_EXTERNAL_URL:'http://insecure.example.com'}),null);
assert.equal(resolveUrl({}),null);

(async()=>{
  let t=at('2026-10-28T10:00:00+05:30');const calls=[];
  const k=createKeepAlive({env:{RENDER_EXTERNAL_URL:'https://edge-backend-r1ng.onrender.com'},now:()=>t,
    request:async(url,options)=>{calls.push({url,options});return new Response('{}',{status:200});}});
  assert.equal(k.status().mode,'weekdays');assert.equal(k.status().configured,true);
  const first=await k.check();assert.equal(first.lastStatus,200);assert.ok(first.lastSuccessAt);
  assert.equal(calls[0].url,'https://edge-backend-r1ng.onrender.com/api/v1/market/status');
  assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');
  t+=60000;assert.equal(await k.check(),null,'no request before the interval');assert.equal(calls.length,1);
  t+=INTERVAL_MS;await k.check();assert.equal(calls.length,2,'one request per interval');
  t=at('2026-10-31T10:00:00+05:30');assert.equal(await k.check(),null,'weekend: let it sleep in weekdays mode');assert.equal(calls.length,2);

  // failures are recorded, never thrown
  let mode=429;t=at('2026-11-02T10:00:00+05:30');
  const failing=createKeepAlive({env:{RENDER_EXTERNAL_URL:'https://e.onrender.com',EDGE_KEEPALIVE:'always'},now:()=>t,request:async()=>new Response('',{status:mode})});
  let s=await failing.check();assert.equal(s.lastError,'HTTP_429');assert.equal(s.failures,1);
  const down=createKeepAlive({env:{RENDER_EXTERNAL_URL:'https://e.onrender.com'},now:()=>t,request:async()=>{throw Error('dns');}});
  s=await down.check();assert.equal(s.lastError,'UNREACHABLE');

  // disabled and unconfigured cases never make requests
  let none=0;const req=async()=>{none++;return new Response('',{status:200});};
  const off=createKeepAlive({env:{RENDER_EXTERNAL_URL:'https://e.onrender.com',EDGE_KEEPALIVE:'off'},now:()=>t,request:req});
  assert.equal(off.status().reason,'DISABLED');assert.equal(await off.check(),null);
  const local=createKeepAlive({env:{},now:()=>t,request:req});
  assert.equal(local.status().reason,'PUBLIC_URL_UNAVAILABLE');assert.equal(await local.check(),null);
  const unknown=createKeepAlive({env:{RENDER_EXTERNAL_URL:'https://e.onrender.com',EDGE_KEEPALIVE:'sometimes'},now:()=>t,request:req});
  assert.equal(unknown.status().mode,'weekdays','unknown mode falls back to the default');
  assert.equal(none,0);
  console.log('keepAlive PASS: IST windows, own https URL only, one GET per interval, weekend sleep, failures recorded, off/unconfigured inert');
})().catch(e=>{console.error(e);process.exitCode=1;});
