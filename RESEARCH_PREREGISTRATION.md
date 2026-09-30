# EDGE Research Preregistration — Integrity Phase

**Phase:** Remember perfectly. Measure honestly. Don't fool ourselves.

This file freezes the initial research questions before enough measured evidence exists to evaluate them. Editing a hypothesis after results are visible requires a new hypothesis ID/version; the original remains in git history.

## Independence and reporting rules

- One READY_TO_EXECUTE episode is one trade hypothesis. Its 15/30/60/120-minute horizons are correlated measurements of that episode, **not four trades**.
- Signals within one NSE session are correlated. Report both episode count and **distinct trading-day count**.
- Do not promote a subgroup discovered after looking at results. Exploratory findings must become a new preregistered hypothesis and be tested on later untouched data.
- Research candidates remain research-only and have no live decision impact.
- No hypothesis may alter the live engine during this phase.
- Minimum sample bars are gates for evaluation, not proof of profitability.
- Maximum concurrently active hypotheses in this file: **6**.

## Frozen hypotheses

| ID | Question | Frozen comparison | Primary outcome | Minimum before evaluation | Promotion bar |
|---|---|---|---|---|---|
| H01_EVENT_DAY | Do scheduled high-impact event sessions change outcomes? | Event-tagged vs ordinary sessions; event taxonomy must be added before evaluation | friction-adjusted 60m return + MAE | 20 distinct event days and 40 ordinary days | Later-data holdout and walk-forward both improve without materially worse worst-fold result |
| H02_BIAS_FLIPS | Does frequent intraday regime/bias flipping predict poorer READY outcomes? | Session flip-count buckets frozen before result inspection | friction-adjusted 60m return + loss rate | 40 distinct trading days | Monotonic deterioration across preregistered buckets and survives later-data holdout |
| H03_ORB | Does Opening Range Break confirmation improve directional READY entries? | Existing research-only ORB tag present vs absent | friction-adjusted 60m return + MAE | 60 READY episodes across >=30 days | Positive holdout delta and non-negative walk-forward median delta |
| H04_VWAP | Does VWAP side/slope context improve directional READY entries? | Existing research-only VWAP tags; no post-hoc threshold tuning | friction-adjusted 60m return + MAE | 60 READY episodes across >=30 days | Positive holdout delta and non-negative walk-forward median delta |
| H05_RVOL | Does relative futures-volume context improve breakout entries? | Existing frozen RVOL buckets | friction-adjusted 60m return + MAE | 60 READY episodes across >=30 days | Positive holdout delta and non-negative walk-forward median delta |
| H06_LIQUIDITY | Does entry spread predict realized adverse execution/exit conditions? | Existing liquidity gate values vs later measured slippage proxy | realized/slippage proxy once captured | 80 READY episodes across >=40 days | Predeclared relationship survives untouched holdout; threshold changes require a new hypothesis version |

## Untouched holdout rule

Data used to formulate or revise a hypothesis cannot be its final confirmation set. When a hypothesis reaches its minimum sample, freeze a chronological cutoff and reserve subsequent data as the untouched confirmation set. Do not repeatedly inspect that set while tuning.

## Explicitly not being tested yet

New indicators, new strategy-selection rules, new live trigger thresholds, heuristic-score calibration, and position-size increases require separate preregistration.
