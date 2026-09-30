# EDGE historical data acquisition

EDGE can now acquire real expired NIFTY option data through Upstox's Expired Instruments APIs.

Upstox provides expired option contracts and expired historical candles (including OHLC, volume and OI). The expired candle API does **not** provide historical bid/ask, IV or Greeks, so the acquisition tool records that coverage explicitly instead of fabricating them. citeturn2search0turn2search4

## Fetch

```bash
UPSTOX_ACCESS_TOKEN=... node scripts/fetch-expired-window.js \
  --expiry 2026-04-30 \
  --from 2026-04-01 \
  --to 2026-04-30 \
  --interval 5minute \
  --min-strike 22000 \
  --max-strike 24000
```

Output defaults to:

`fixtures/historical/<expiry>.json`

The expired-contract APIs require an Upstox Plus subscription. citeturn2search0turn2search2

## Why expired candles alone are not a full historical signal backtest

The current live EDGE strike-selection layer uses option Greeks and bid/ask for execution-quality checks. Historical expired candles provide OHLC/OI/volume, but not those historical quote/Greek fields. Therefore the replay system must not manufacture them.

For a true apples-to-apples EDGE backtest, use recorded EDGE snapshots containing the full option chain and then join each decision to subsequent historical contract candles for outcome measurement.


## Current evidence pipeline

EDGE no longer relies on replay as its profitability evidence. Live READY_TO_EXECUTE episodes are persisted with their executable quote context, harvested against later contract candles, and evaluated through chronological holdout, walk-forward replication, friction-adjusted stability, research governance and the research-only candidate registry. The limiting factor is accumulated measured episodes and distinct trading days, not the absence of validation machinery.

The 15/30/60/120-minute measurements from one READY episode are correlated horizons of one episode; they are not four independent trades.
