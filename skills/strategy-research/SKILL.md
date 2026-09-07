---
name: strategy-research
description: Evaluate the fixed NGFI strategy catalog and technical indicators, run smoke or research-grade backtests, maintain signal lifecycle/outcome revisions, calibrate evidence, and evaluate evidence-only promotion criteria.
---

# Strategy Research

Use this Skill only in the `strategy-research` preset. Strategy formulas, validation, execution semantics, metrics, lifecycle transitions, calibration thresholds, and promotion gates live in domain code.

## Workflow

1. Inspect `finance_strategy_registry` before evaluation. Only fixed registered strategy and indicator IDs are valid; dynamic source or executable input is forbidden.
2. Evaluate with canonical instrument, explicit interval and adjustment, immutable `snapshotId`, `asOf`, strictly ordered bars, and PIT `availableAt`. Preserve separate strategy, input, config, execution, cost, dataset, and benchmark hashes.
3. Use a smoke backtest for deterministic signal/execution contract checks only. It always returns `engineTier=smoke` and `promotionEligible=false`; never call it research-grade or use it for promotion.
4. Use the research tier only with an explicit frozen research input contract. Preserve next-day execution, board-lot, fees, price-limit/suspension, capacity, benchmark, and missing-data rejections.
5. Append observations and legal lifecycle events through `finance_signal_ledger` with `workspace_id` and `expected_revision`. A `tradeable` lifecycle label is research metadata, not permission to trade.
6. Use `finance_signal_outcome` to append revisions. `unfillable`, `expired`, and `unable` keep all return fields null. Calibration is evidence-only and stays `insufficient` below its declared sample threshold.
7. `finance_strategy_promotion` accepts only research-tier evidence. It can recommend candidate/shadow status but cannot mutate the registry or execute a trade.

Report exact data windows, hashes, cost/execution semantics, IS/OOS separation, sample counts, unavailable metrics and every rejection. Never turn missing data into zero or statistical evidence into a guaranteed return.
