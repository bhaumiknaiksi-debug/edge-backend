'use strict';

// EDGE Home Screen Web Push. This is a notification transport only.
// All trading states come from the existing decision.orchestration.
const crypto = require('crypto');
const webpush = require('web-push');
const { Pool } = require('pg');

const MAX_SUBSCRIPTIONS = 4;
const MAX_BODY_LEN = 180;
const PUSH_TTL_SECONDS = 45;

function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    const host = u.hostname.toLowerCase();
    return host.endsWith('.push.apple.com') ||
      host === 'fcm.googleapis.com' ||
      host === 'android.googleapis.com' ||
      host === 'updates.push.services.mozilla.com' ||
      host === 'updates-autopush.stage.mozaws.net' ||
      host.endsWith('.notify.windows.com');
  } catch (_) { return false; }
}

function validSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) return false;
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== 'string' || endpoint.length > 1800 || !validEndpoint(endpoint)) return false;
  if (!keys || typeof keys !== 'object') return false;
  // Reject malformed Web Push key material before storing it.
  if (typeof keys.p256dh !== 'string' || !/^[A-Za-z0-9_-]{80,140}$/.test(keys.p256dh)) return false;
  if (typeof keys.auth !== 'string' || !/^[A-Za-z0-9_-]{15,80}$/.test(keys.auth)) return false;
  return true;
}

function digest(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

function timingSafeOwnerToken(provided, expected) {
  if (!expected || typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function summarizeDecision(result) {
  const orchestration = result?.decision?.orchestration;
  const marketPhase = result?.market?.phase;
  const ready = marketPhase === 'OPEN' &&
    orchestration?.status === 'READY_TO_EXECUTE' &&
    orchestration?.executionAllowed === true;
  const strategy = String(result?.decision?.strategy || 'WAIT').slice(0, 40);
  const contractId = String(result?.decision?.tradeLegs?.buyLeg?.contractId ||
    result?.decision?.tradeLegs?.sellLeg?.contractId || '').slice(0, 80);
  const timestamp = Date.parse(String(result?.timestamp || ''));
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > 90000 || timestamp > Date.now() + 10000) return null;
  return {
    ready,
    status: String(orchestration?.status || 'UNKNOWN').slice(0, 48),
    strategy,
    contractId,
    tier: String(result?.decision?.signalTier?.tier || 'OBSERVING').slice(0, 12),
    observedAt: result.timestamp
  };
}

function makeTransition(previous, current, nowMs = Date.now()) {
  if (!previous || !current) return null; // first observation is always a baseline
  const priorTime = Date.parse(String(previous.observedAt || ''));
  if (!Number.isFinite(priorTime) || nowMs - priorTime > 120000 || nowMs < priorTime) return null;

  // Only send readiness when the authoritative gate transitions to READY.
  if (!previous.ready && current.ready) {
    return {
      type: 'EXECUTION_READY',
      title: 'EDGE · Execution ready',
      body: 'A backend-confirmed setup is ready. Open EDGE and recheck live entry, risk and prices before acting.',
      url: '/',
      ttl: PUSH_TTL_SECONDS
    };
  }
  if (previous.ready && !current.ready) {
    return {
      type: 'READY_INVALIDATED',
      title: 'EDGE · Ready state ended',
      body: 'The previous execution-ready state is no longer valid. Review the current EDGE dashboard.',
      url: '/',
      ttl: PUSH_TTL_SECONDS
    };
  }
  return null;
}

function buildWebPush(env = process.env, dependencies = {}) {
  const settings = {
    publicKey: env.EDGE_PUSH_VAPID_PUBLIC_KEY || '',
    privateKey: env.EDGE_PUSH_VAPID_PRIVATE_KEY || '',
    subject: env.EDGE_PUSH_VAPID_SUBJECT || '',
    ownerToken: env.EDGE_PUSH_OWNER_TOKEN || '',
    databaseUrl: env.EDGE_PUSH_DATABASE_URL || '',
    autoAlerts: env.EDGE_PUSH_AUTO_ALERTS === 'true'
  };
  const required = settings.publicKey && settings.privateKey &&
    /^mailto:.+@.+\..+$/.test(settings.subject) &&
    settings.ownerToken.length >= 24 && settings.databaseUrl;
  let pool = null;
  let ready = false;
  let setupError = null;
  let queue = Promise.resolve();
  let lastManualTest = 0;
  let firstSuccessfulObservation = true;
  let lastInitAttemptAt = 0;
  let initPromise = null;
  const sender = dependencies.sender || webpush;

  if (required) {
    try {
      sender.setVapidDetails(settings.subject, settings.publicKey, settings.privateKey);
      pool = dependencies.pool || new Pool({
        connectionString: settings.databaseUrl,
        max: 2,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 15000
      });
    } catch (e) {
      setupError = 'INVALID_PUSH_CONFIGURATION';
    }
  }

  const initialize = async () => {
    if (!pool) return false;
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS edge_push_subscriptions (
        endpoint_hash TEXT PRIMARY KEY,
        subscription JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS edge_push_state (
        state_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      ready = true;
    } catch (e) {
      setupError = 'PERSISTENT_STORE_UNAVAILABLE';
      ready = false;
    }
    return ready;
  };
  async function usable() {
    if (!pool) return false;
    if (ready) return true;
    if (initPromise) return initPromise;
    // Transient PostgreSQL downtime must not leave Web Push disabled forever.
    if (Date.now() - lastInitAttemptAt < 15000) return false;
    lastInitAttemptAt = Date.now();
    initPromise = initialize().finally(() => { initPromise = null; });
    return initPromise;
  }
  // Start an initial attempt, and permit later retries after a failure.
  void usable();

  function authorized(req) {
    const header = String(req.headers.authorization || '');
    return header.startsWith('Bearer ') &&
      timingSafeOwnerToken(header.slice(7), settings.ownerToken);
  }
  function guarded(handler) {
    return async (req, res) => {
      if (!(await usable())) return res.status(503).json({ error: 'PUSH_NOT_CONFIGURED' });
      if (!authorized(req)) return res.status(401).json({ error: 'OWNER_AUTH_REQUIRED' });
      try { return await handler(req, res); }
      catch (_) { return res.status(503).json({ error: 'PUSH_STORE_UNAVAILABLE' }); }
    };
  }

  async function subscriptions() {
    const r = await pool.query('SELECT endpoint_hash, subscription FROM edge_push_subscriptions WHERE enabled = TRUE ORDER BY created_at LIMIT $1', [MAX_SUBSCRIPTIONS]);
    return r.rows;
  }

  async function sendStored(target, payload) {
    try {
      await sender.sendNotification(target.subscription, JSON.stringify(payload), {
        TTL: payload.ttl || PUSH_TTL_SECONDS,
        urgency: 'high',
        timeout: 7000
      });
      return true;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await pool.query('DELETE FROM edge_push_subscriptions WHERE endpoint_hash=$1', [target.endpoint_hash]);
      }
      return false;
    }
  }

  function routes(app) {
    app.get('/api/v1/push/config', async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const enabled = await usable();
      res.json({
        enabled,
        publicKey: enabled ? settings.publicKey : null,
        autoAlerts: enabled && settings.autoAlerts,
        reason: enabled ? null : 'BACKEND_SETUP_REQUIRED'
      });
    });
    app.post('/api/v1/push/subscribe', guarded(async (req, res) => {
      const subscription = req.body?.subscription;
      if (!validSubscription(subscription)) return res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });
      const hash = digest(subscription.endpoint);
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM edge_push_subscriptions WHERE enabled=TRUE');
      const found = await pool.query('SELECT 1 FROM edge_push_subscriptions WHERE endpoint_hash=$1', [hash]);
      if (!found.rowCount && Number(count.rows[0].count) >= MAX_SUBSCRIPTIONS) return res.status(409).json({ error: 'DEVICE_LIMIT_REACHED' });
      await pool.query(`INSERT INTO edge_push_subscriptions(endpoint_hash,subscription)
        VALUES($1,$2::jsonb) ON CONFLICT(endpoint_hash)
        DO UPDATE SET subscription=EXCLUDED.subscription,enabled=TRUE,updated_at=NOW()`, [hash, JSON.stringify(subscription)]);
      res.json({ ok: true, registered: true });
    }));
    app.post('/api/v1/push/unsubscribe', guarded(async (req, res) => {
      const endpoint = req.body?.endpoint;
      if (typeof endpoint !== 'string' || endpoint.length > 1800 || !validEndpoint(endpoint)) return res.status(400).json({ error: 'INVALID_ENDPOINT' });
      await pool.query('DELETE FROM edge_push_subscriptions WHERE endpoint_hash=$1', [digest(endpoint)]);
      res.json({ ok: true });
    }));
    app.post('/api/v1/push/test', guarded(async (req, res) => {
      if (Date.now() - lastManualTest < 30000) return res.status(429).json({ error: 'TEST_COOLDOWN' });
      const endpoint = req.body?.endpoint;
      if (typeof endpoint !== 'string' || !validEndpoint(endpoint)) return res.status(400).json({ error: 'INVALID_ENDPOINT' });
      const r = await pool.query('SELECT endpoint_hash,subscription FROM edge_push_subscriptions WHERE endpoint_hash=$1 AND enabled=TRUE', [digest(endpoint)]);
      if (!r.rowCount) return res.status(404).json({ error: 'DEVICE_NOT_REGISTERED' });
      lastManualTest = Date.now();
      const ok = await sendStored(r.rows[0], {
        type: 'TEST', title: 'EDGE · Test notification',
        body: 'Web Push is connected. No trade or execution signal is implied.',
        url: '/', ttl: 60
      });
      res.status(ok ? 200 : 502).json({ ok });
    }));
  }

  async function observe(result) {
    if (!(await usable())) return;
    const current = summarizeDecision(result);
    if (!current) return;
    const client = await pool.connect();
    let previous = null;
    const isFirst = firstSuccessfulObservation;
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO edge_push_state(state_id,payload)
        VALUES('latest',$1::jsonb) ON CONFLICT (state_id) DO NOTHING`, [JSON.stringify(current)]);
      const row = await client.query("SELECT payload FROM edge_push_state WHERE state_id='latest' FOR UPDATE");
      previous = row.rows[0]?.payload || null;
      await client.query("UPDATE edge_push_state SET payload=$1::jsonb,observed_at=NOW() WHERE state_id='latest'", [JSON.stringify(current)]);
      await client.query('COMMIT');
      firstSuccessfulObservation = false;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Even a quick restart with an existing database row starts with a
    // baseline, never a retroactive ready/invalidation notification.
    if (isFirst) return;
    if (!settings.autoAlerts) return;
    const event = makeTransition(previous, current);
    if (!event) return;
    // No delivery if market/observation has moved while the storage transaction was running.
    if (Date.now() - Date.parse(current.observedAt) > 60000) return;
    const targets = await subscriptions();
    await Promise.allSettled(targets.map(t => sendStored(t, event)));
  }

  function onSuccessfulPoll(result) {
    queue = queue.then(() => observe(result)).catch(() => {
      // Push errors may never break the authoritative EDGE polling/evidence pipeline.
    });
  }

  return { routes, onSuccessfulPoll, initialize: () => usable(), configStatus: async () => ({
    enabled: await usable(), autoAlerts: settings.autoAlerts, setupError
  }) };
}

module.exports = { buildWebPush, validEndpoint, validSubscription, timingSafeOwnerToken, summarizeDecision, makeTransition };
