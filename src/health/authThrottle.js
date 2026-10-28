'use strict';
// Per-client throttle for wrong owner codes on owner-only endpoints. Blocks only the client that keeps
// failing, never everyone, so an attacker guessing codes cannot lock the owner out of STOP.
const WINDOW_MS=15*60000,BLOCK_MS=15*60000,MAX_FAILURES=5,MAX_CLIENTS=2000;

// Render appends the connecting address to X-Forwarded-For; the RIGHTMOST entry is the one a client cannot forge.
function clientKey(req){
  const forwarded=String(req?.headers?.['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);
  return (forwarded.at(-1)||req?.socket?.remoteAddress||req?.ip||'unknown').slice(0,100);
}
function createAuthThrottle({now=Date.now,maxFailures=MAX_FAILURES,windowMs=WINDOW_MS,blockMs=BLOCK_MS}={}){
  const clients=new Map();
  function entry(key){
    let e=clients.get(key);
    if(!e){
      if(clients.size>=MAX_CLIENTS)clients.delete(clients.keys().next().value); // oldest first; memory stays bounded
      e={failures:[],blockedUntil:0};clients.set(key,e);
    }
    return e;
  }
  return {
    // milliseconds until this client may try again, or 0
    retryAfter(req){const e=clients.get(clientKey(req));return e&&e.blockedUntil>now()?e.blockedUntil-now():0;},
    fail(req){
      const t=now(),e=entry(clientKey(req));
      e.failures=e.failures.filter(x=>t-x<windowMs);e.failures.push(t);
      if(e.failures.length>=maxFailures){e.blockedUntil=t+blockMs;e.failures=[];}
    },
    succeed(req){clients.delete(clientKey(req));},
    size:()=>clients.size
  };
}
// One process-wide instance so every owner endpoint shares the same counter per client.
const shared=createAuthThrottle();
// Express helper: returns true when the request was rejected (429 or 401) and the caller must stop.
function rejectOwner(req,res,{ownerToken,compare,throttle=shared}){
  const wait=throttle.retryAfter(req);
  if(wait>0){res.set('Retry-After',String(Math.ceil(wait/1000)));res.status(429).json({error:'TOO_MANY_FAILED_ATTEMPTS'});return true;}
  const auth=String(req.headers.authorization||'');
  if(!ownerToken||!auth.startsWith('Bearer ')||!compare(auth.slice(7),ownerToken)){throttle.fail(req);res.status(401).json({error:'OWNER_AUTH_REQUIRED'});return true;}
  throttle.succeed(req);return false;
}
module.exports={createAuthThrottle,clientKey,rejectOwner,shared,MAX_FAILURES};
