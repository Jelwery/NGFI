---
name: consensus-check
description: Check analyst expectations and price targets against current price and reported fundamentals, while keeping estimates separate from facts. Use for consensus, forward EPS/revenue, analyst ratings, price targets, expectations, estimate revisions, or earnings-expectation questions.
---

# Consensus check

Consensus is an expectation snapshot, not a verified future outcome. yfinance analyst coverage is best-effort and may be incomplete.

## Workflow

1. Call `finance_security_reference`, `finance_estimates` and `finance_fundamentals`. The estimates call may be incomplete; fundamentals and other analysis should continue when it is.
2. Separate historical/TTM values from `periodType: estimate` fields. Never describe forward EPS, target prices, recommendation mean or forward revenue as reported results.
3. Compare target-price range and mean/median with the current price using matching currency and a stated observation time. Do not infer precision from analyst counts or ratings.
4. Test whether expectations are directionally plausible against recent revenue growth, margins, FCF and financial capacity. A discrepancy is a question to explain, not proof that either side is correct.
5. Do not claim revision direction, management guidance or earnings surprise unless a tool or actually read source supplies it.

## Output

State what consensus fields are available, what is missing, the historical-versus-forward boundary, current-price comparison, supporting or conflicting fundamentals, and a confidence/coverage caveat.
