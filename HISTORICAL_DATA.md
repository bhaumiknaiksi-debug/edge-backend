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

## Why this is not yet a full historical signal backtest

The current live EDGE strike-selection layer uses option Greeks and bid/ask for execution-quality checks. Historical expired candles provide OHLC/OI/volume, but not those historical quote/Greek fields. Therefore the replay system must not manufacture them.

For a true apples-to-apples EDGE backtest, use recorded EDGE snapshots containing the full option chain and then join each decision to subsequent historical contract candles for outcome measurement.

