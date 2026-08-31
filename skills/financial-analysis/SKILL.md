---
name: financial-analysis
description: Analyze a public company’s revenue, margins, earnings, cash conversion, balance sheet and financial quality from normalized statements. Use for fundamentals reviews, earnings quality, growth/margin trends, cash flow analysis, leverage questions, or historical-versus-TTM comparisons.
---

# Financial analysis

Build the analysis from reported periods and TTM data, preserving fiscal period, currency and unit.

## Workflow

1. Resolve the security with `finance_security_reference`, then call `finance_fundamentals`.
2. Separate annual, quarterly and TTM observations. Do not compare a quarterly amount directly with an annual amount.
3. Assess revenue growth and operating leverage using revenue, gross margin, operating income/margin and net income/margin. Label growth rates as decimals when the provider returns decimals.
4. Assess cash conversion using operating cash flow, capital expenditure and free cash flow. Check whether FCF direction is consistent with earnings and explain material divergence without inventing causes.
5. Assess balance-sheet capacity using cash, debt and net debt where available. Never infer missing debt or cash as zero.
6. Cross-check derived relationships. Treat provider fields as inputs that may be incomplete; disclose inconsistencies instead of silently forcing reconciliation.

## Output

Start with the financial-quality conclusion. Cover growth, profitability, cash conversion, balance sheet, notable period changes, missing/inconsistent data and the exact periods used. Distinguish observed facts from explanations or hypotheses.
