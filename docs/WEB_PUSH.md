# EDGE Home Screen Web Push — rollout

This module delivers **presentation only**. It never changes EDGE's deterministic trade pipeline.

Apple supports Web Push on **Home Screen web apps** in iOS/iPadOS 16.4+ without an Apple Developer membership. The user must install EDGE and explicitly tap **Enable alerts**.

## Required Render environment variables

```
EDGE_PUSH_VAPID_PUBLIC_KEY=<Web Push VAPID public P-256 key>
EDGE_PUSH_VAPID_PRIVATE_KEY=<matching private key>
EDGE_PUSH_VAPID_SUBJECT=mailto:<your verified email>
EDGE_PUSH_OWNER_TOKEN=<random unguessable secret of at least 24 chars>
EDGE_PUSH_DATABASE_URL=<durable PostgreSQL connection URL>
EDGE_PUSH_AUTO_ALERTS=false
```

Generate VAPID keys once with:

```bash
npx web-push generate-vapid-keys --json
```

Generate a distinct owner enrollment token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Store private credentials only in Render Environment.** Never commit VAPID private key, owner token, database URL, subscription endpoints, encryption keys, or screenshots of them to GitHub.

**No PostgreSQL is currently connected to EDGE.** The module deliberately returns `enabled:false` until all keys AND a working PostgreSQL store are available. A free, expiring/no-backup database is not production-durable; use a database with real retention/backups before relying on alerts.

## API

- `GET /api/v1/push/config`: public capability and VAPID **public** key.
- `POST /api/v1/push/subscribe`: owner Bearer token, `{ subscription }`.
- `POST /api/v1/push/unsubscribe`: owner Bearer token, `{ endpoint }`.
- `POST /api/v1/push/test`: owner Bearer token, `{ endpoint }`.

The enrollment token is entered manually on the user's Home Screen app, sent over HTTPS, and never saved to localStorage/sessionStorage. Registered subscriptions are persisted in PostgreSQL. A new browser installation needs explicit enrollment.

## Automatic alerts

**Off by default.** To enable after real-device delivery verification, set `EDGE_PUSH_AUTO_ALERTS=true`.

Only two automatic alerts exist in v1:

1. `EXECUTION_READY`: the authoritative backend changes from NOT-READY to `READY_TO_EXECUTE` with `executionAllowed===true` while market phase is `OPEN`.
2. `READY_INVALIDATED`: a recent ready state becomes non-ready.

Events are rate-limited by transitions, not arbitrary client-side guesses. The first poll after startup only establishes a baseline. Alerts carry a short TTL and tell the user to recheck EDGE; they do not place orders. Network failures or free-host suspension mean alerts may be late or missed: they are not a guaranteed trading signal service.

## Operator checklist

- Set the five private/public keys and durable database URL in Render.
- Verify `GET /api/v1/push/config` returns `enabled:true`.
- On iPhone, install EDGE to Home Screen, launch **that** icon, supply owner enrollment token, and tap **Enable alerts**.
- Click **Send test**; confirm Lock Screen delivery.
- Enable automatic alerts only after production checks. Keep trade execution manual.
