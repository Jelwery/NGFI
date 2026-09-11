# Financial and industry fatal gates

These gates preserve the former company-financial-analysis safety checks. They are research stopping rules, not automatic assertions of fraud or insolvency. Use evidence available by the analysis cutoff. Record `pass|blocked|fatal`, formula, operands, comparable periods, sources, limitations and next stage. If essential inputs are missing or conflicting, use `blocked` with `partial/needs_input/data_conflict`; never manufacture a pass or a company failure.

## Before financial modelling

Verified delisting/long-term suspension/bankruptcy proceedings, adverse/disclaimer audit opinion, material going-concern uncertainty, confirmed major financial fraud under regulatory investigation, irreversible displacement of the core business, or an auditor resignation/dismissal caused by a documented accounting dispute stop valuation. Routine auditor rotation alone is not a fatal signal; an unsupported news assertion requires verification.

## Three-statement checks

For GENERAL companies only, independently check the operands rather than accepting an earlier narrative verdict:

- **CV-1**: same-period profit growth > revenue growth **and** OCF growth < profit growth **and** inventory growth > revenue growth **and** payables growth < revenue growth. All four must be supported; negative/zero-base growth must be interpreted and cannot be naively divided. The isolated OCF/profit <0.5 signal is a quality warning, not the four-condition fatal gate.
- OCF negative for at least three years with no improvement (absolute deficit not narrowing).
- OCF/parent-profit <0.3 for three years, only with valid positive-profit denominators.
- FCF negative for three years **and** cash self-sufficiency <0.3 for three years **and** cash/short-term interest-bearing debt <0.5.
- CV-2 checks asset/investment/financing consistency; CV-3 reconciles balance-sheet cash change with cash-flow change, profit/retained earnings and depreciation; CV-4 applies industry-specific interest/underwriting checks. Discrepancies are investigated rather than zero-filled.

## Risk/governance checks

- Same-year Beneish M > -1.78 **and** Altman Z <1.81, only if the model is applicable and required observations are complete; heuristic DEPI/AQI substitutions cannot alone establish this gate.
- Asset growth >50% with ROE declining for three consecutive years.
- Effective cash yield <0.5%, cash/assets >20% and interest-bearing debt/assets >20%, all together with comparable accounting scope.
- Controlling shareholder annual reduction >5 percentage points and declining control stake; distinguish measured ownership movement from rumours.
- Controlling-shareholder pledge >90% and OCF negative for two years.

Financial businesses use `financial-enterprise.md` instead of generic Z/M or industrial cash-flow signals. Banks check NIM, NPL trend, provision coverage, CET1 and deposit liquidity; insurers check solvency and underwriting/investment structure; brokers check net capital/client money/liquidity; holding-company gates are the union of applicable segment gates. Regulatory limits must be checked against the applicable jurisdiction, institution class and cutoff; legacy numeric thresholds are screening references, not timeless regulatory claims.

## After modelling

If all supported pessimistic/base/optimistic intrinsic equity scenarios are negative, record the value-destruction result as fatal and stop recommendation synthesis. If all core model assumptions lack evidence, block the valuation as insufficient instead of manufacturing a range. An already triggered pre-model fatal gate forbids running valuation at all.

## Stop output

Use **分析终止** for verified fatal conditions and state stage, signal, formula, values, periods, sources and unresolved questions. No valuation result follows a pre-model fatal gate. Preserve all evidence and prior artifacts; never delete them to simplify the report.
