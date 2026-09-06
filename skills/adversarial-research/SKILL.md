---
name: adversarial-research
description: Run an evidence-grounded bull case, bear case, cross-rebuttal, and neutral adjudication over an existing frozen NGFI research dossier. Use for adversarial review, bull/bear debate, red-team investment-thesis review, or structured challenge of a completed research run. Requires a verified non-empty frozen replay; never fetches new data and never converts role agreement or votes into trading or portfolio weights.
---

# Adversarial Research

Use `finance_adversarial_review` in the `company-research` preset to challenge a completed research run without changing its factual ground. This workflow finds reasoning weaknesses and evidence gaps; it is not an independent alpha source and does not replace out-of-sample validation.

## Preconditions

1. Locate the frozen replay for one complete, non-empty research run. Do not reconstruct a dossier from conversation memory, a current provider response, or a mutable workspace.
2. The tool calls the domain `loadFrozenEvidenceDossier` function only after the workspace layer verifies the replay manifest, file hashes, complete source-run status, and non-empty artifacts. An empty evidence collection is a hard stop.
3. Preserve every source-run gap. If the rendered dossier is truncated, keep the generated `adversarial-review:dossier` gap visible in the final result. Do not describe a truncated review as complete.

## Review protocol

1. Call `finance_adversarial_review` once with bounded workspace, snapshot, and review identifiers. Its DSH adapter implements the injected `AdversarialChatExecutor` contract in `dsh-finance-tools`, outside the domain package.
2. Advance exactly one stage at a time. Do not issue overlapping `advance()` calls for the same review. A `review-busy` error means another stage still owns the review.
3. Keep the built-in order and visibility contract:

   - `bull` sees only the frozen dossier.
   - `bear` sees only the frozen dossier.
   - `bull-rebuttal` sees the dossier plus `bear`.
   - `bear-rebuttal` sees the dossier plus `bull`.
   - `judge` sees the dossier and all four preceding outputs.

4. Every role uses a distinct Agent session. Never reuse or fork a role session: hidden conversation history would violate the `sees` boundary. A production adapter must disable tool execution, so roles cannot retrieve fresh data.
5. Continue after a failed or audit-incomplete stage. Preserve its error or audit findings as a gap; do not retry silently, erase it, or leave the stage running. `done` means no stage remains pending, while `outcome` says whether the review succeeded.
6. Treat each stage's `research-audit` result as authoritative for citations and numbers. An output with unknown references, uncited facts, unbound numbers, or incorrect calculation display remains `incomplete` even if its prose is persuasive.

## Role boundaries

The bull and bear cases must use the same dossier and independently state the strongest supportable case. Rebuttals challenge only the opposing result exposed by `sees`; concede claims the dossier cannot resolve. All factual and numeric claims cite an `ev-*` or `model-*` id on the same line. Never treat missing values as zero or external knowledge as evidence.

The judge is a neutral adjudicator, not a voter or portfolio allocator. Its output has exactly these H2 sections, in order:

1. `Consensus facts`
2. `Disputes`
3. `Evidence gaps`
4. `Adjudication conditions`

Do not name a winner, count votes, emit a buy/sell signal, recommend a position, or assign trading/portfolio weights. A condition explains which evidence, definition, period, or future observation could resolve a dispute.

## Output

Return the review identity and dossier hash, evidence/calculation counts, truncation flag, all recorded gaps, and each stage's session id, outcome, text, audit findings, and judge contract findings. End with the derived `done` and `outcome`; never infer success from `done` alone.
