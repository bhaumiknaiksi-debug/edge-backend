'use strict';
// Free-tier keep-alive: while this process runs, it requests its OWN public URL so the host sees inbound
// traffic and does not spin the service down after 15 idle minutes. It cannot wake a service that is
// already asleep; something external (opening the app, a scheduled job) must do that once.
// Read-only GET of a cheap status route. Never touches trading, evidence or execution endpoints.

const MODES=['off','market','weekdays','always'];
const DEFAULT_MODE='weekdays';
const PATH='/api/v1/market/status';
const INTERVAL_MS=9*60000; // comfortably inside a 15-minute idle window

function istParts(t){const d=new Date(t+19800000);return {weekday:d.getUTCDay(),minutes:d.getUTCHours()*60+d.getUTCMinutes()};}
// Whether this moment should be kept awake. 'market' = Mon-Fri 08:30-16:30 IST, 'weekdays' = all of Mon-Fri IST.
function wanted(mode,t){
  if(mode==='always')return true;
  if(mode==='off')return false;
  const {weekday,minutes}=istParts(t),weekdayIST=weekday>=1&&weekday<=5;
  if(mode==='weekdays')return weekdayIST;
  return weekdayIST&&minutes>=510&&minutes<990;
}
function resolveUrl(env){
  const raw=String(env.EDGE_PUBLIC_URL||env.RENDER_EXTERNAL_URL||'').trim().replace(/\/+$/,'');
  try{const u=new URL(raw);return u.protocol==='https:'&&!u.search&&!u.hash?u.origin+u.pathname.replace(/\/+$/,''):null;}catch(_){return null;}
}
function createKeepAlive({env=process.env,request=fetch,now=Date.now}={}){
  const requested=String(env.EDGE_KEEPALIVE||DEFAULT_MODE).toLowerCase();
  const mode=MODES.includes(requested)?requested:DEFAULT_MODE;
  const base=resolveUrl(env),target=base?base+PATH:null;
  const status={mode,configured:mode!=='off'&&!!target,reason:mode==='off'?'DISABLED':!target?'PUBLIC_URL_UNAVAILABLE':null,
    intervalMinutes:INTERVAL_MS/60000,lastAttemptAt:null,lastSuccessAt:null,lastStatus:null,lastError:null,attempts:0,failures:0};
  let timer=null,busy=false,lastAttempt=-Infinity;
  async function check(){
    const t=now();
    if(!status.configured||busy||!wanted(mode,t)||t-lastAttempt<INTERVAL_MS)return null;
    busy=true;lastAttempt=t;status.attempts++;status.lastAttemptAt=new Date(t).toISOString();
    try{
      const response=await request(target,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000),
        headers:{Accept:'application/json','User-Agent':'edge-keepalive/1'}});
      status.lastStatus=response.status;
      await response.body?.cancel?.().catch(()=>{});
      if(response.ok){status.lastSuccessAt=new Date(now()).toISOString();status.lastError=null;}
      else{status.failures++;status.lastError='HTTP_'+response.status;}
    }catch(_){status.failures++;status.lastStatus=null;status.lastError='UNREACHABLE';}
    finally{busy=false;}
    return {...status};
  }
  // Checks every minute; only actually requests once per interval inside the chosen window.
  function start(){if(!status.configured||timer)return;timer=setInterval(()=>{void check();},60000);timer.unref?.();void check();}
  function stop(){if(timer)clearInterval(timer);timer=null;}
  return {start,stop,check,status:()=>({...status})};
}
module.exports={createKeepAlive,wanted,resolveUrl,MODES,DEFAULT_MODE,INTERVAL_MS,PATH};
