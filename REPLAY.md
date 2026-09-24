# EDGE Replay Harness

The replay harness is a deterministic validation layer for EDGE's decision pipeline.

## Input

Create a JSON array of normalized historical snapshots in:

`fixtures/replay-scenarios.json`

Each snapshot can contain the decision inputs already captured by EDGE:

- timestamp
- spot
- strategy
- regime
- setup
- marketPhase
- support/resistance and option walls
- expectedMove
- DTE
- tradeLegs including bid/ask
- account risk configuration

Missing derived fields are calculated by the current engines where possible. Missing market data is **not** invented.

## Run

```bash
node src/replay/replayEngine.test.js
```

or:

```bash
node -e "const fs=require('fs'); const {runReplay}=require('./src/replay/replayEngine'); const x=JSON.parse(fs.readFileSync('./fixtures/replay-scenarios.json')); console.log(JSON.stringify(runReplay(x),null,2));"
```

## Interpretation

Replay output is a validation report, not proof of profitability. It reports what EDGE's rules would have allowed from the supplied snapshots. It does not estimate slippage, taxes, latency, fills, or future P&L unless those fields are explicitly added to the dataset.
