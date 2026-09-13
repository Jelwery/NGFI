---
name: strategy-research
description: Evaluate fixed strategies or native factor graphs and rolling models, run governed research experiments on the shared ledger, inspect immutable results, maintain signal evidence, and evaluate evidence-only promotion criteria.
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

For daily portfolio simulation, supply target schedules known before the execution open, explicit PIT trading status, lagged ADV, raw prices and corporate-action events. Require actual CSI300/CSI800 series; metadata alone is not a benchmark. Read industry/style/residual-selection attribution together with cash, cost and trading-timing effects and coverage.

Use `finance_strategy_backtest(tier=walk-forward)` in a research case with `workspace_id`, `case_id` and `expected_revision`. Register explicit candidate weights/thresholds, matched candidate-return dates, train/test folds, purge/label horizon, dataset/code versions and seed. Training selects parameters; each frozen test fold runs once. Repeating an identical registered request returns its recorded result; changing parameters creates another visible experiment. Candidate returns must already come from frozen cost-aware portfolio runs, not invented observations.

For native cross-sectional experiments, use `finance_quant_research`: inspect catalog/schema, import an explicit dataset, then run with workspace/case/revision and dataset ID. Read results by run ID and section; do not pass file paths, source code, URLs or model binaries. An interrupted run requires explicit resume of the same frozen registration.

Native mean-variance/top-k outputs are diagnostic targets, not confirmed-account A3 plans. Preserve synthetic flags, explicit CNE6/Ledoit–Wolf choice, full-L1 turnover, next-open fixed quantities, partial/rejected fills, missing actual index benchmark and `promotionEligible=false`. Do not treat the equal-weight experiment benchmark as CSI300/800 or rolling diagnostics as unused-holdout approval. Large imports belong to the operator CLI, not the Agent payload.

Report exact data windows, hashes, cost/execution semantics, IS/OOS separation, sample counts, unavailable metrics and every rejection. Never turn missing data into zero or statistical evidence into a guaranteed return.
