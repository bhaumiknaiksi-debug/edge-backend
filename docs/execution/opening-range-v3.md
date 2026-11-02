# Opening-range timing V3 (flagged, off by default)

`OPENING_RANGE_SHADOW_V3` keeps V2's trading idea: a completed 5-minute NIFTY close that crosses the frozen
09:15–09:30 range. What changes is the state handling, so genuine breakouts aren't lost to bookkeeping.
Strike selection, A/B/C cards, owner limits, stops, targets and paper mode are unchanged.

## Enabling

| Variable | Default | Effect |
|---|---|---|
| `EDGE_SHADOW_TIMING_ENABLED` | as today | Required for either version |
| `EDGE_SHADOW_TIMING_V3_ENABLED` | unset (off) | `true` replaces V2 with V3 in `decision.shadowTiming` |

The sandbox entry mode stays `OPENING_RANGE_SHADOW_V1`. Trades record `ruleVersion` and, for V3, a `breakoutId`.

## Rule

| | V2 | V3 |
|---|---|---|
| Tracking | Per card, only while a card exists | Market level, per direction, whatever the regime |
| Confirmation | Lost when the 30-minute episode expires | Kept until a settled close goes back through the level |
| Entry window | Same as the episode | 10 minutes after the crossing candle closes (`ENTRY_FRESHNESS_MS`) |
| Candle judged | At first read | 60 s after close (`SETTLE_MS`) |
| Revised candle | Episode restarts; can loop | Conflict recorded. The breakout it touched is never tradable, and entries are blocked until a later candle settles and is read twice unchanged |
| Opening-range revised | Episode restarts | Range stays frozen; session fails closed |
| Fetch failure / stale data | Episode deleted | History kept; entries blocked until fresh data returns |
| Regime neutral at the break | Missed | Allowed if the regime aligns within the 10-minute window |
| Chasing | Only the risk budget | Spot at most 0.5 × range width beyond the level, plus the risk budget |
| Duplicate entries | One per contract per session (a strike roll can re-enter) | One per breakout, across strikes and tiers |

A fresh re-break after a failed breakout is a new breakout, as in V2. The daily trade limit and loss-streak pause still apply.

## Evidence

`npm run replay:shadow-timing` replays constructed session shapes under several data conditions through the real
timing rule, selection and executor gates, and compares V2 with V3. These are not recorded market sessions.

## Rollback

Unset `EDGE_SHADOW_TIMING_V3_ENABLED` (or set it to `false`) and restart. V2 resumes unchanged. An open V3 paper trade
keeps its stored stop and target and exits normally. No migration is needed.
