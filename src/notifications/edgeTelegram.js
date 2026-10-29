'use strict';

const { randomUUID } = require('node:crypto');
const { createTelegramTransport,TelegramError } = require('./telegramTransport');
const { createTelegramStore } = require('./telegramStore');
const { hash,FRESH_MS,observationOf,deliverable,formatTelegramEvent } = require('./telegramEvents');

function telegramConfig(env, hasPool) {
  const enabled = env.EDGE_TELEGRAM_ENABLED === 'true';
  const token = env.EDGE_TELEGRAM_BOT_TOKEN || '';
  const chatId = env.EDGE_TELEGRAM_CHAT_ID || '';
  let reason = !enabled ? 'DISABLED' : !hasPool ? 'DURABLE_STORAGE_REQUIRED' : null;
  if (!reason && (!/^\d{3,20}:[A-Za-z0-9_-]{20,128}$/.test(token) ||
      !/^[1-9]\d{0,15}$/.test(chatId) || !Number.isSafeInteger(Number(chatId)))) reason = 'CONFIGURATION_REQUIRED';
  return {enabled,token,chatId,reason,dailySummary:env.EDGE_TELEGRAM_DAILY_SUMMARY_ENABLED !== 'false',
    recipientKey:reason ? null : hash([token.split(':')[0],chatId])};
}

function buildTelegram({pool,env = process.env,getMarketPhase,getCurrentResult = () => null,dependencies = {}}) {
  const config = telegramConfig(env,!!pool || !!dependencies.store);
  const now = dependencies.now || Date.now;
  const startedAt = now(), bootId = dependencies.bootId || randomUUID();
  const api = dependencies.api || (config.reason ? null : createTelegramTransport(config.token));
  const store = dependencies.store || (config.reason ? null : createTelegramStore({pool,recipientKey:config.recipientKey}));
  let initialized = false, initPromise = null, lastInitAt = -Infinity, initError = config.reason;
  let recordingError = null, deliveryError = null, recordingGap = false;
  let pending = null, observing = null, latestSeen = null, timer = null, ticking = false, stopped = false;
  const counters = {observations:0,coalesced:0,apiAccepted:0,expired:0,uncertain:0,failed:0,rateLimited:0};
  const status = () => ({version:'EDGE_TELEGRAM_V1',enabled:config.enabled,configured:!config.reason,transportReady:initialized,
    sendOnly:true,liveDecisionImpact:false,reason:initError,recordingError,deliveryError,processCounters:{...counters}});
  const context = observation => ({observation,now:now(),phase:getMarketPhase(),bootId,startedAt,
    dailySummary:config.dailySummary,resetBaseline:recordingGap});

  async function initialize() {
    if (config.reason || stopped) return false;
    if (initialized) return true;
    if (initPromise) return initPromise;
    if (now() - lastInitAt < 15000) return false;
    lastInitAt = now();
    initPromise = (async () => {
      try {
        const chat = await api('getChat',{chat_id:config.chatId});
        if (chat?.type !== 'private' || String(chat.id) !== config.chatId) {
          initError = 'PRIVATE_RECIPIENT_NOT_CONFIRMED'; return false;
        }
        await store.initialize();
        initialized = true; initError = null;
        return true;
      } catch (error) {
        initError = error instanceof TelegramError ? error.code : 'TELEGRAM_INITIALIZATION_UNAVAILABLE';
        return false;
      }
    })().finally(()=>{initPromise=null;});
    return initPromise;
  }

  function drain() {
    if (!observing) observing = (async () => {
      while (pending && !stopped) {
        const next = pending; pending = null;
        try {
          if (!(await initialize())) {recordingGap=true; continue;}
          if (now() - Date.parse(next.observedAt) > FRESH_MS) {recordingGap=true; continue;}
          await store.checkpoint(context(next));
          counters.observations++;
          recordingGap = false; recordingError = null;
        } catch (_) {recordingGap=true; recordingError='TELEGRAM_STORE_UNAVAILABLE';}
      }
    })().finally(()=>{observing=null; if(pending && !stopped)void drain();});
    return observing;
  }

  function onSuccessfulPoll(result) {
    if (config.reason || stopped) return Promise.resolve(false);
    let observation;
    try { observation = observationOf(result,now()); }
    catch (_) { return Promise.resolve(false); }
    if (!observation) return Promise.resolve(false);
    latestSeen = observation;
    if (pending) {
      observation.coalesced = (pending.coalesced || 0) + 1;
      counters.coalesced++;
    }
    pending = observation; // At most one pending, whitelisted observation, never an unbounded result queue.
    return drain();
  }

  async function tick() {
    if (ticking || stopped || config.reason) return status();
    ticking = true;
    let sending = false;
    try {
      if (!(await initialize())) return status();
      if (stopped) return status();
      await store.checkpoint(context(null));
      recordingError = null;
      const claimed = await store.claim(now());
      if (!claimed) return status();
      const {event,attempts} = claimed;
      const state = await store.loadState();
      const current = context(null);
      // Recheck the actual current backend object as well as the persisted cursor.
      // A ledger change or poll error can clear lastResult before a queued send.
      const live = event.type === 'EXECUTION_READY' ? observationOf(getCurrentResult(),now()) : null;
      const newerVeto = event.type === 'EXECUTION_READY' && latestSeen &&
        (!latestSeen.ready || latestSeen.identity !== event.observation.identity);
      // The approval stamp is part of the identity, so a newer approval for the same strike never matches an old alert.
      const liveVeto = event.type === 'EXECUTION_READY' && (!live?.ready || live.identity !== event.observation.identity);
      if ((event.type === 'EXECUTION_READY' && recordingGap) || liveVeto || newerVeto || !deliverable(event,state,current)) {
        await store.finish(event.id,'EXPIRED',{error:'NO_LONGER_CURRENT'});
        counters.expired++;
        return status();
      }
      let message;
      try {
        if (stopped) {
          await store.finish(event.id,'EXPIRED',{error:'TRANSPORT_STOPPED'});
          return status();
        }
        sending = true;
        message = await api('sendMessage',{chat_id:config.chatId,text:formatTelegramEvent(event),
          protect_content:true,link_preview_options:{is_disabled:true}});
        if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0 ||
            message.chat?.type !== 'private' || String(message.chat.id) !== config.chatId) {
          throw new TelegramError('INVALID_TELEGRAM_ACK',{ambiguous:true});
        }
      } catch (error) {
        const rateLimited = error instanceof TelegramError && error.retryAfterMs > 0;
        const permanent = error instanceof TelegramError && error.permanent;
        const cooldownUntil = rateLimited ? now()+error.retryAfterMs : null;
        deliveryError = rateLimited ? 'TELEGRAM_RATE_LIMIT' : permanent ? 'TELEGRAM_REQUEST_REJECTED' : 'DELIVERY_UNCERTAIN';
        if (rateLimited && attempts < 4) {
          await store.finish(event.id,'PENDING',{error:deliveryError,nextAttemptAt:new Date(cooldownUntil).toISOString(),cooldownUntil});
          counters.rateLimited++;
        } else {
          await store.finish(event.id,rateLimited || permanent ? 'FAILED' : 'UNCERTAIN',{error:deliveryError,cooldownUntil});
          if (rateLimited || permanent) counters.failed++; else counters.uncertain++;
        }
        if (permanent) {initialized=false; initError='TELEGRAM_REQUEST_REJECTED';}
        return status();
      }
      counters.apiAccepted++;
      await store.finish(event.id,'SENT',{messageId:message.message_id});
      deliveryError = null;
    } catch (_) {
      recordingGap = true; recordingError = 'TELEGRAM_STORE_UNAVAILABLE';
      if (sending) deliveryError = 'DELIVERY_ACK_UNCERTAIN';
    } finally {ticking=false;}
    return status();
  }
  function start() {
    if (config.reason || timer) return;
    stopped = false;
    timer = setInterval(()=>{void tick().then(()=>{if(alerts.length)void drainAlerts();});},5000);
    timer.unref?.();
    void tick();
  }
  function stop() {stopped=true; pending=null; if(timer)clearInterval(timer); timer=null;}
  function routes(app) {
    app.get('/api/v1/telegram/status',(_req,res)=>{
      res.setHeader('Cache-Control','no-store');
      res.json(status()); // No token, recipient ID, message contents or mutation/send endpoints.
    });
  }
  // Direct operational alerts (e.g. the sandbox executor halting). Best effort and in-memory: bounded queue,
  // same private recipient check, one message per key per 30 minutes, and it honours Telegram flood control.
  const alerts=[],alertSentAt=new Map();let alerting=false,alertCooldownUntil=0;
  function alert(key,text){
    if(config.reason||stopped||typeof key!=='string'||typeof text!=='string')return false;
    const last=alertSentAt.get(key);if(last&&now()-last<30*60000)return false;
    if(alerts.some(a=>a.key===key))return false;
    if(alerts.length>=20)alerts.shift();
    alerts.push({key,text:text.slice(0,600)});void drainAlerts();return true;
  }
  async function drainAlerts(){
    if(alerting)return;alerting=true;
    try{
      while(alerts.length&&!stopped){
        if(now()<alertCooldownUntil||!(await initialize()))break;
        const next=alerts[0];
        try{
          await api('sendMessage',{chat_id:config.chatId,text:next.text,protect_content:true,link_preview_options:{is_disabled:true}});
          alerts.shift();alertSentAt.set(next.key,now());counters.apiAccepted++;
          if(alertSentAt.size>500)alertSentAt.delete(alertSentAt.keys().next().value);
        }catch(error){
          if(error instanceof TelegramError&&error.retryAfterMs>0){alertCooldownUntil=now()+error.retryAfterMs;counters.rateLimited++;}
          else{alerts.shift();counters.failed++;deliveryError='ALERT_DELIVERY_FAILED';}
          break;
        }
      }
    }finally{alerting=false;}
  }
  const baseTick=tick;
  async function tickWithAlerts(){const result=await baseTick();if(alerts.length)void drainAlerts();return result;}
  return {onSuccessfulPoll,start,stop,tick:tickWithAlerts,initialize,status,routes,alert,pendingAlerts:()=>alerts.length};
}

module.exports = { buildTelegram,telegramConfig };
