# EDGE Historical Outcome & Backtest Engine

Phase 11 connects a captured EDGE decision to subsequent historical option candles.

## Measures

For each execution-allowed decision:

- Target 1
- Target 2
- Stop
- Maximum-hold/time exit
- realised points
- realised rupee P&L
- R multiple
- holding time
- target-1 partial-exit path

The aggregate report includes trade count, wins/losses, win rate, gross profit/loss, net P&L, average/expectancy R, profit factor, maximum drawdown, exit counts, and strategy-level statistics.

## Fill and mark assumptions

Upstox expired historical candles provide OHLC/OI, not historical bid/ask. Therefore:

1. Entry uses the captured EDGE decision's entry credit/premium.
2. Long-option exits use the option candle high/low.
3. Credit-spread exits use a conservative OHLC envelope for the multi-leg debit.
4. If a candle could contain both stop and target, STOP is assumed first.
5. Target 1 closes 50% of the position; the remainder stays open for Target 2, stop, or time exit.
6. Time exit uses the last complete candle in the allowed holding window.
7. Costs are zero unless explicitly configured.
8. Underlying invalidation is not fabricated; this first version evaluates option-price exits only.

These are testable assumptions, not claims about exact historical fills.

## CLI

Run:

\`node scripts/run-backtest.js <backtest.json>\`

The JSON should contain:

\`decisions\`
A list of captured EDGE decision snapshots.

\`outcomesByDecisionId\`
Historical option candles keyed by decision id. Each candle needs \`instrumentKey\`, \`timestamp\`, \`open\`, \`high\`, \`low\`, and \`close\`.

\`defaults\`
Optional \`lotSize\`, \`costsPerLot\`, \`lots\`, and \`fillModel\`.

## Critical limitation

This is an outcome evaluator, not yet a complete historical signal generator.

A true apples-to-apples EDGE historical test requires the original full EDGE decision snapshots at each historical timestamp, including the option-chain inputs used to select strikes. The current expired-candle data does not provide historical bid/ask, IV, or Greeks.

Do not interpret unit-test fixtures or incomplete historical runs as evidence of profitability.
