'use strict';

const { createHash } = require('node:crypto');
const VERSION = 'EDGE_TELEGRAM_V1';
const FRESH_MS = 90000;
const READY_TTL_MS = 45000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = time => new Date(time).toISOString();
const day = time => new Date(time + 19800000).toISOString().slice(0, 10);
const clean = (value, limit = 100) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit);
const when = value => new Date(value).toLocaleString('en-GB', {timeZone:'Asia/Kolkata',hour12:false}) + ' IST';

// Whitelist backend facts only. Never copy private ledger data, modeled targets, or credentials.
function observationOf(result, now = Date.now()) {
  const time = Date.parse(result?.timestamp);
  if (!Number.isFinite(time) || time > now + 5000 || now - time > FRESH_MS) return null;
  const decision = result?.decision;
  if (!decision?.orchestration || !['OPEN','CLOSED','PRE_OPEN'].includes(result?.market?.phase)) return null;
  const legs = Object.entries(decision.tradeLegs || {}).filter(([,leg]) => leg && typeof leg === 'object' && leg.contractId)
    .map(([name,leg]) => ({name:clean(name,32),contractId:clean(leg.contractId),instrumentKey:clean(leg.instrumentKey)})).sort((a,b)=>a.name.localeCompare(b.name));
  const strategy = clean(decision.strategy || 'WAIT', 40);
  const tier = clean(decision.signalTier?.tier || 'OBSERVING', 12);
  const status = clean(decision.orchestration.status || 'UNKNOWN', 48);
  const allowed = decision.orchestration.executionAllowed === true;
  const ready = result.market.phase === 'OPEN' && status === 'READY_TO_EXECUTE' && allowed &&
    tier === 'A' && decision.signalTier?.researchOnly === false && decision.signalTier?.executionAllowed === true &&
    strategy !== 'WAIT' && legs.length > 0 && legs.length <= 4 && legs.every(leg=>leg.instrumentKey);
  // The limits this approval was sized under. Part of the identity: the same strike approved under other limits is a
  // different alert, so an old queued alert can never borrow a newer approval.
  const t = decision.limitsToken;
  const approval = t && /^[a-f0-9]{16}$/.test(t.version || '') && Number.isSafeInteger(t.generation) && t.generation >= 0 ? {version:t.version,generation:t.generation} : null;
  return {observedAt:iso(time),phase:result.market.phase,strategy,tier,status,executionAllowed:allowed,ready,legs,approval,
    identity:hash([strategy,clean(result.expiry || decision.expiry),legs,approval]),
    ruleVersion:clean(decision.ruleSpec?.version,40),
    ruleHash:/^[a-f0-9]{64}$/.test(decision.ruleSpec?.implementationHash || '') ? decision.ruleSpec.implementationHash : null};
}

function eventOf(type, key, facts, {recipientKey,bootId,now}) {
  const occurredAt = facts.observation?.observedAt || iso(now);
  const ttl = type === 'EXECUTION_READY' ? READY_TTL_MS : type === 'DAILY_SUMMARY' ? 6 * 3600000 : 5 * 60000;
  return {id:hash([VERSION,recipientKey,type,key]),version:VERSION,type,bootId,occurredAt,
    expiresAt:iso((type === 'EXECUTION_READY' ? Date.parse(occurredAt) : now) + ttl),...facts};
}

function summaryDue(state, context, events) {
  const daily = state.daily;
  if (!context.dailySummary || !daily?.openPolls || daily.summaryQueued ||
      context.now < Date.parse(daily.day + 'T15:45:00+05:30')) return;
  events.push(eventOf('DAILY_SUMMARY',daily.day,{daily:{...daily},coverage:'UNKNOWN',performanceIncluded:false},context));
  daily.summaryQueued = true;
}

// Pure reducer. State and events are committed together before any send is attempted.
function advanceTelegram(previous, context) {
  const state = JSON.parse(JSON.stringify(previous || {})), events = [];
  const {observation,now,bootId,phase} = context;
  if (state.bootId !== bootId) {
    state.bootId = bootId;
    state.baselineRequired = true;
    state.activeEpisodeId = null;
  }
  if (observation && state.daily && state.daily.day !== day(Date.parse(observation.observedAt))) summaryDue(state, context, events);
  if (observation && (!state.latest || Date.parse(observation.observedAt) > Date.parse(state.latest.observedAt))) {
    const prior = state.latest;
    const sameDay = prior && day(Date.parse(prior.observedAt)) === day(Date.parse(observation.observedAt));
    const gap = prior ? Date.parse(observation.observedAt) - Date.parse(prior.observedAt) : Infinity;
    const continuous = !state.baselineRequired && !context.resetBaseline && !observation.coalesced && sameDay && gap <= FRESH_MS;
    const date = day(Date.parse(observation.observedAt));
    if (!state.daily || state.daily.day !== date) state.daily = {day:date,openPolls:0,readyAlerts:0,invalidations:0,
      gapCount:0,maxGapMs:0,coalesced:0,firstObservedAt:null,lastObservedAt:null,summaryQueued:false};
    const daily = state.daily;
    if (observation.phase === 'OPEN') {
      const priorOpen = daily.lastObservedAt;
      const openGap = priorOpen ? Date.parse(observation.observedAt) - Date.parse(priorOpen) : 0;
      if (openGap > FRESH_MS || observation.coalesced) daily.gapCount++;
      daily.maxGapMs = Math.max(daily.maxGapMs,openGap);
      daily.openPolls++;
      daily.coalesced += observation.coalesced || 0;
      daily.firstObservedAt ||= observation.observedAt;
      daily.lastObservedAt = observation.observedAt;
    }
    const changedContract = prior && prior.identity !== observation.identity;
    if (continuous && state.activeEpisodeId && (!observation.ready || changedContract)) {
      events.push(eventOf('READY_INVALIDATED',[state.activeEpisodeId,observation.observedAt],
        {priorEpisodeId:state.activeEpisodeId,priorContracts:prior.legs,observation,reason:changedContract?'CONTRACT_CHANGED':'BACKEND_GATE_ENDED'},context));
      daily.invalidations++;
      state.activeEpisodeId = null;
    }
    if (!continuous) state.activeEpisodeId = null;
    if (observation.ready && !state.activeEpisodeId) {
      if (continuous) {
        const event = eventOf('EXECUTION_READY',[observation.observedAt,observation.identity],{observation},context);
        state.activeEpisodeId = event.id;
        event.episodeId = event.id;
        events.push(event);
        daily.readyAlerts++;
      } else state.activeEpisodeId = 'baseline:' + hash([bootId,observation.observedAt,observation.identity]);
    }
    if (!observation.ready) state.activeEpisodeId = null;
    state.latest = {...observation};
    state.baselineRequired = false;
    state.staleWarnedFor = null;
  }
  if (state.latest && state.latest.phase === 'OPEN' && phase === 'OPEN' &&
      now - (context.startedAt || 0) > FRESH_MS &&
      now - Date.parse(state.latest.observedAt) > FRESH_MS && state.staleWarnedFor !== state.latest.observedAt) {
    events.push(eventOf('COLLECTOR_STALE',[bootId,state.latest.observedAt],{lastObservedAt:state.latest.observedAt},context));
    state.staleWarnedFor = state.latest.observedAt;
    state.activeEpisodeId = null;
    state.baselineRequired = true;
  }
  if (phase === 'CLOSED' && state.activeEpisodeId && !state.baselineRequired) {
    events.push(eventOf('READY_INVALIDATED',[state.activeEpisodeId,'MARKET_CLOSED'],
      {priorEpisodeId:state.activeEpisodeId,priorContracts:state.latest?.legs || [],reason:'MARKET_CLOSED'},context));
    state.activeEpisodeId = null;
    if (state.daily) state.daily.invalidations++;
  }
  summaryDue(state, context, events);
  return {state,events};
}

function deliverable(event, state, {now,phase,bootId}) {
  if (!event || event.version !== VERSION || !['EXECUTION_READY','READY_INVALIDATED','COLLECTOR_STALE','DAILY_SUMMARY'].includes(event.type) ||
      !Number.isFinite(Date.parse(event.expiresAt)) || Date.parse(event.expiresAt) <= now ||
      !Number.isFinite(Date.parse(event.occurredAt)) || Date.parse(event.occurredAt) > now + 5000) return false;
  if (event.type === 'DAILY_SUMMARY') return true;
  if (event.bootId !== bootId || state.bootId !== bootId) return false;
  if (event.type === 'COLLECTOR_STALE') return phase === 'OPEN' && state.baselineRequired === true &&
    state.staleWarnedFor === event.lastObservedAt && now - Date.parse(state.latest?.observedAt) > FRESH_MS;
  if (event.type !== 'EXECUTION_READY') return true;
  return phase === 'OPEN' && state.latest?.ready === true && state.activeEpisodeId === event.episodeId &&
    !!event.observation?.identity && state.latest.identity === event.observation.identity && now - Date.parse(state.latest.observedAt) <= READY_TTL_MS;
}

function formatTelegramEvent(event) {
  const id = event.id.slice(0,12);
  if (event.type === 'DAILY_SUMMARY') {
    const d = event.daily;
    return ['EDGE · Monitor summary · ' + d.day,
      'Observed open-market polls: ' + d.openPolls,
      'Observation window: ' + when(d.firstObservedAt) + ' → ' + when(d.lastObservedAt),
      'READY alerts recorded: ' + d.readyAlerts + '; invalidations: ' + d.invalidations,
      'Detected gaps: ' + d.gapCount + '; longest observed interval: ' + Math.round(d.maxGapMs/1000) + 's',
      'Coalesced observations: ' + d.coalesced,
      'Coverage UNKNOWN. This is not proof of a full session, fills, P&L or profitable signals.',
      'Generated: ' + when(event.occurredAt), 'Evidence: ' + id].join('\n');
  }
  if (event.type === 'COLLECTOR_STALE') return ['EDGE · Data freshness warning',
    'No recent successful backend observation. Do not rely on an earlier ready alert.',
    'Last observed: ' + when(event.lastObservedAt), 'This is a monitoring warning, not a trade instruction.', 'Evidence: ' + id].join('\n');
  const contracts = event.type === 'EXECUTION_READY' ? event.observation.legs : event.priorContracts;
  const lines = [event.type === 'EXECUTION_READY' ? 'EDGE · Backend-confirmed readiness' : 'EDGE · Previous ready state ended',
    ...(contracts || []).map(leg=>clean(leg.contractId)), 'Observed: ' + when(event.occurredAt)];
  if (event.type === 'EXECUTION_READY') lines.push('Do not use after: ' + when(event.expiresAt),
    'Open EDGE and recheck current entry, prices and risk before acting. This is not an order.');
  else lines.push('Reason: ' + event.reason, 'This does not mean you should place an exit order. Check EDGE and your actual position.');
  lines.push('Evidence: ' + id);
  return lines.join('\n').slice(0,3000);
}

module.exports = { VERSION,FRESH_MS,READY_TTL_MS,hash,observationOf,advanceTelegram,deliverable,formatTelegramEvent };
