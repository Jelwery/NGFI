# Financial data and offline extraction

Runtime data comes from exposed curated finance tools (`finance_security_reference`, `finance_fundamentals`, and the applicable A-share capability). This reference documents the preserved provider extractor, not a shell-enabled alternative research workflow.

## Provider boundary

`packages/finance-data-service/providers/astock/python/sources/company_financials.py` owns akshare/Sina three-statement extraction, company-type detection, annual snapshots, latest-quarter/prior-year-quarter snapshots and historical year-end prices. Its offline CLI accepts `stock_code --years N --json-only -o data.json`; an authorized operator, not an unprivileged finance preset, may use it. Network/dependency errors remain errors. A wrapper over Sina is vendor-normalized, not an exchange-direct source; do not label it automatically L1 or count multiple wrappers as independent sources.

Material facts should reconcile with frozen/audited inputs or official filings available at the cutoff. Check parent net income, EPS, total assets and revenue, including CAS/IFRS, annual/YTD/quarterly/TTM basis and restatements. Discrepancies over 1% are investigation prompts, not an automatic choice of the lower number. Unknown publication/availability time means unknown PIT admissibility; a retrieval timestamp does not prove the fact was knowable historically.

## Preserved statement shape

```text
{
  metadata: {stock_code, sina_code, company_type, periods_count, periods_range,
             provider, upstream, source_kind, retrieved_at, publication_time,
             available_at, pit, status, limitations, currency, amount_unit,
             errors, year_end_prices, notes_checklist,
             latest_quarter_period, prev_year_quarter_period},
  company_type: GENERAL|INSURANCE|BANK|BROKER|FINANCIAL_HOLDING|UNKNOWN,
  annual_data: {"2024": {"利润表": {...}, "资产负债表": {...}, "现金流量表": {...}}},
  latest_quarter: {"利润表": {...}, ...},
  prev_year_quarter: {"利润表": {...}, ...}
}
```

Amounts are yuan/CNY in this provider format; core tools may expose different units, so normalize explicitly. A reported numeric zero is retained. A blank/null/missing column is unknown, never debt-free or cash-free. Historical year-end prices serve dated risk-screen inputs only; they do not license current-price anchoring or historic look-ahead. Missing prior-year quarter means no reliable YoY comparison; do not automatically multiply a YTD quarter by four.

## Notes and industry data still needed

Keep the nine notes-level checks: restricted cash; construction project budget/detail; controlling-shareholder pledge; receivables ageing and impairment; goodwill impairment assumptions; capitalized R&D; related-party transactions; borrowing collateral/type; litigation/contingent liabilities. The standard three statements do not establish these facts.

For insurance also obtain EV/per-share EV, NBV/VNB, solvency capital, COR, investment yield and ROEV with precise scope (group vs life insurer). Banks require NIM, NPL/provisions/CET1 and deposit/liquidity data. Brokers require net capital, client-money separation and liquidity. Read `financial-enterprise.md`; missing safety inputs block the applicable gate. EV/NBV absence prevents P/EV but is not evidence of insolvency.

## Provenance and retention

Keep provider/upstream/source kind, source IDs, period, units, all timestamps and original field status alongside observations. Explicit estimates are assumptions with sources/quality, not a lower numeric “confidence tier” of reported fact. Retain source files, returned payloads, calculations and provenance; do not delete them after the memo. Ledger audit owns persisted evidence/citations. Offline helpers operate only on supplied JSON and never create a second research case.
