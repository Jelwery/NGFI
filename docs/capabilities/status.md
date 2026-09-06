# Capability status

This document summarizes the machine-enforced inventory in `manifest.json`. The JSON file is authoritative and is validated by `pnpm capability:check`.

| Status | Count | Meaning |
|---|---:|---|
| `kernel-tested` | 18 | Deterministic domain/provider/runtime capability with offline contract evidence; provider entries may be dormant or indirect. |
| `agent-exposed` | 8 | Available through a declared Skill, tool, or preset and covered by composition/isolation contracts. |
| `live-verified` | 0 | A dated live-provider/model run has been recorded in the manifest. |

Current Agent surface: 20 `finance_*` tools (the original 12 plus 8 curated A-share tools), 10 canonical Skills, the `skill` loader, one `finance-analyst` preset, and headless/Web profiles. Provider availability remains visible through `finance_data_catalog`; neither a tool name nor a provider package implies live availability.

The baseline deliberately distinguishes `missing`, `no-data`, `unsupported`, `unavailable`, `unauthorized`, `insufficient-permission`, `partial`, `stale`, `unfillable`, `insufficient`, and `failed/error`; later phases may add these statuses to new contracts but may not collapse them into empty or zero-valued success.
