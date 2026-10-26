# Collection monitoring repair

Baseline: `177e0e0b0a18364c75a9c8b478e4f1d78b97a10f` (23 October 2026).
The baseline full regression suite and syntax checks pass before these changes.

## Scope and invariants

This is a monitoring repair only. Selection, strike identity, A/B/C rules, entry authorization,
risk limits, notifications, planner hypotheses, broker imports and shadow-event logic are not
changed. No new dependencies, schema changes, environment flags, paid services or backfills.
No evidence, ledger rows or tables are deleted.

## What changes

- Evidence health is 503 until startup restoration completes, including outside market hours.
  Later operational failures also return 503, with the existing JSON issues preserved.
- Both keepalive and live smoke validate `healthy === true`, no issues, a fresh response,
  durable storage and market-time collection freshness. A 200 response containing unhealthy
  JSON fails. Research-harvester errors are no longer omitted from health.
- `GET /evidence/storage/verify` in PostgreSQL mode performs a parameterized SELECT for one
  known, loaded record, decompresses it and compares its contents. It fails for empty data,
  a missing row, mismatched/corrupt contents or a database failure. It performs no writes,
  does not call an archive backup, and returns no payloads, record IDs or connection details.
- The result scope is explicitly `SINGLE_RECORD_READBACK`. It proves only that record's
  readback integrity. It does not prove every record exists, a complete session was collected,
  a backup can recover the database, or any strategy is profitable.
- Keepalive performs readback before checking health, allowing a successful new readback
  to clear a previous verification error. Post-close checks validate both harvesters' returned
  status and choose PostgreSQL readback or the legacy archive round trip by provider.
- Health counters are labeled `LOADED_WORKING_SET`; `continuousCollectionVerified` remains
  false. Legacy archive-based `verifiedMarketDays` is not reinterpreted as PostgreSQL proof.
- Monitoring responses are not cacheable. Retry budgets cover expected startup time,
  but repeated unhealthy responses still fail instead of reporting success.

## Tests and safe validation

- `npm run test:health`: startup (including after close), stale polling, storage verification
  failure, research-harvester failure and explicit counter scope.
- `npm run test:collection`: loopback HTTP tests for 200/503 and provider selection; actual CLI
  exit codes for healthy/unhealthy JSON; static workflow wiring and `bash -n` on shell blocks.
- `node src/evidence/postgresEvidenceStore.test.js`: compressed round trip, restart load,
  deduplication, SELECT-only verification, missing/mismatched/corrupt records, sanitized
  database errors, recovery and preservation of an outstanding write error.
- `npm run test:syntax` and `npm run test:all`: full baseline regression gate.

All new automated tests use fixtures and local loopback HTTP only. Database adapter tests
use a fake pool; they are not a production PostgreSQL integration test. No production
harvest, trade, deployment or workflow rerun is needed to validate this branch locally.

## Rollout and rollback

Review the narrow diff and passing CI before merging. The service and workflow changes
must land together: the new scheduled check requires the new storage verification route.
After the backend deploy is confirmed live on the intended commit, use GET requests to
`/evidence/health` and `/evidence/storage/verify`; confirm restoration has completed and
the proof scope is `SINGLE_RECORD_READBACK`. Inspect the next natural scheduled run's
logs rather than assuming that a merge or a live deploy proves its collection checks passed.
Do not manually invoke harvest or alter trading state for deployment verification.

Rollback is a normal code revert of this monitoring patch; no migration is necessary and
existing evidence remains untouched. Reverting also restores the old monitoring defects.

## Still unresolved / not claimed by this patch

- Durable outcome harvesting beyond the 100-record working set and restart/backlog recovery.
  The 120-minute horizon must not be called fixed by this monitoring change.
- Full-session coverage, durable daily polling heartbeats and sampling-aware missing-session
  detection. Sparse lightweight records can still produce misleading coverage counters.
- Free-tier sleep and best-effort GitHub scheduling: no promise of continuous collection.
- Owner-token strength enforcement, planner display defects, Kite import/reconciliation
  defects, shadow cutoff behavior and incomplete decision provenance remain separate work.
