---
name: portfolio-risk
description: Import and explicitly confirm holdings, then calculate CNE6 portfolio risk, marginal risk, factor exposure, and scenario stress with coverage and reconciliation gates. Use for portfolio risk diagnostics, not trading or automatic rebalancing.
---

# Portfolio Risk

Use this Skill only in the `portfolio-risk` preset. Holdings lifecycle, hashes, CNE6 calculations, coverage thresholds, covariance validation and reconciliation live in `@finance2dsh/portfolio-risk`; do not recompute them in prose.

## Workflow

1. Accept only an explicit JSON or CSV holdings payload. Call `finance_holdings` with bounded `workspace_id`, `portfolio_id`, `as_of`, `base_currency`, and `expected_revision`. An invalid or empty import is not staged.
2. Inspect the staged snapshot and show its positions, total market value, as-of, currency and `snapshotHash`. Confirmation requires the current revision and that exact hash. Never confirm implicitly.
3. Call `finance_portfolio_risk` only after confirmation. Supply an explicit read-only CNE6 model snapshot; preserve model version, as-of, input hash, coverage and covariance quality.
4. For marginal risk, describe a complete proposed portfolio with the same portfolio identity, as-of, and currency. This is a comparison, not an order or rebalance instruction.
5. For stress, use explicit named factor shocks in decimal return units. Unknown or duplicate factors fail closed.

Unconfirmed holdings, invalid hashes, as-of mismatch, currency conflict, unmapped securities, insufficient coverage, invalid covariance, or failed reconciliation must remain `rejected` with null formal risk where specified. Never drop positions to force coverage, perform hidden FX conversion, connect a broker, place orders, or claim live risk from a stale model.
