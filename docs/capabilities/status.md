# Capability status

This document summarizes the machine-enforced inventory in `manifest.json`. The JSON file is authoritative and is validated by `pnpm capability:check`.

| Status | Count | Meaning |
|---|---:|---|
| `kernel-tested` | 3 | Deterministic domain capability with offline contract evidence, not exposed to an Agent. |
| `agent-exposed` | 5 | Available through a declared Skill, tool, or preset and covered by composition/isolation contracts. |
| `live-verified` | 0 | A dated live-provider/model run has been recorded in the manifest. |

Current Agent surface: 12 `finance_*` tools, 9 canonical Skills, the `skill` loader, one `finance-analyst` preset, and headless/Web profiles. The new canonical data-v2 and routing/reconciliation kernels are intentionally not Agent-exposed yet. Neither status nor a directory name implies live provider availability.

The baseline deliberately distinguishes `missing`, `no-data`, `unsupported`, `unavailable`, `unauthorized`, `insufficient-permission`, `partial`, `stale`, `unfillable`, `insufficient`, and `failed/error`; later phases may add these statuses to new contracts but may not collapse them into empty or zero-valued success.
