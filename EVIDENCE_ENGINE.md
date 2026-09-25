# EDGE vNext.4 — Evidence Engine

Purpose: make EDGE's signals earn their place.

## What it measures

For a historical decision snapshot plus subsequent real option-contract candles, the evidence engine measures:
- entry value using executable bid/ask when the snapshot contains it
- maximum favourable excursion (MFE)
- maximum adverse excursion (MAE)
- return at 15 / 30 / 60 / 120 minute horizons
- minute of best observed excursion
- evidence buckets by regime, volatility richness, DTE, India-session segment and strategy

A bucket is not marked qualified until it has at least 20 measured observations by default.

## No fake history

Expired Upstox option candles provide OHLC, volume and OI. They do not reconstruct historical bid/ask, IV or Greeks. EDGE therefore records full live decision snapshots now and joins those snapshots to subsequent real contract candles later. Missing outcome candles return UNAVAILABLE rather than being synthesized.

## Evidence key

Example:

BULLISH|CHEAP|4_7DTE|MORNING|LONG_CALL

This allows future calibration to answer questions such as whether a particular strategy/regime/DTE/session combination historically had positive 60-minute expectancy, how ugly its typical adverse excursion was, and when favourable excursion tended to peak.

## Anti-overfit rule

Evidence is descriptive until sample thresholds and out-of-sample validation are satisfied. Future strategy promotion should use chronological train/validation splits rather than optimizing and grading on the same observations.
