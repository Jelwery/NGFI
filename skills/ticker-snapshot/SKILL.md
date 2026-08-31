---
name: ticker-snapshot
description: Build a concise, timestamped public-equity snapshot covering identity, listing, currency, price, market cap, 52-week position and recent return. Use for ticker overviews, quick stock snapshots, current price context, or “what is this company/stock?” questions.
---

# Ticker snapshot

Use this workflow for a fast orientation, not a full investment thesis.

## Workflow

1. Call `finance_security_reference` first. Confirm canonical ticker, company, exchange and quote currency before interpreting values.
2. Call `finance_market_data` with a period suitable for the question; use `6mo`/`1d` by default.
3. Report price and market observations with `observedAt` or `retrievedAt`. Do not present them as filing-period facts.
4. State unavailable fields as unavailable. Never convert `null`, `missing`, `provider-error` or `stale` to zero.
5. Keep interpretation proportional: recent return and 52-week position describe price behavior, not business quality or intrinsic value.

## Output

Lead with a one-sentence identity and current snapshot. Then give: listing/currency; current price and observation time; market cap and shares; 52-week range; selected-period return/SMA; data limitations. Attribute structured values to yfinance and note that it is a best-effort, non-official source.
