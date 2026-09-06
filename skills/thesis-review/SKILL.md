---
name: thesis-review
description: Review an existing NGFI Thesis Snapshot against a newer snapshot and explain structured thesis drift. Use for thesis review, thesis update, investment-case drift, earnings follow-up, red-line checks, valuation-anchor changes, management or capital-allocation changes, and competitive-advantage changes. Requires a baseline snapshot; does not infer one from memory or compare report prose.
---

# Thesis Review

Use `finance_thesis_drift` in the `company-research` preset. The structured
domain code owns validation and classification; this skill explains the result
and identifies follow-up work.

## Workflow

1. Locate the baseline and current snapshots for the same caseId. If the
   baseline is missing, return insufficient; never reconstruct it from memory.
2. Supply both structured snapshots to `finance_thesis_drift`; the tool validates
   them before comparison.
4. Explain each fixed dimension: core assumptions, valuation anchors, red
   lines, management/capital allocation, and competitive advantage.
5. Preserve the returned improved, unchanged, weakened, or insufficient
   classification. Do not promote a wording change into factual drift.
6. Cite changedEvidenceRefs for every directional conclusion. If the function
   reports insufficient evidence, state what new evidence is needed.

## Interpretation rules

- Treat fact, price, and wording as distinct change kinds.
- A price-only change can affect valuation anchors, but cannot change the
  business-quality dimensions by itself.
- A red-line deterioration takes precedence over valuation improvement in the
  overall result returned by the library.
- Report missing, conflicting, or stale evidence as a limitation. Do not fill a
  structured gap with prose.

## Output

Provide the overall outcome, then one compact row per dimension containing its
outcome, change kinds, changed evidence references, and reason. End with the
next evidence or decision checkpoint. Do not rewrite snapshots or mutate the
research workspace unless the user separately requests it.
