# NGFI governance migration inventory

Source worktree: sibling `../NGFI` at common base `da101d13095c413e7904d4eb171afd11d01c97b5`. It is read-only. Target worktree: this repository on `codex/ngfi-governance`.

| Source path | Target path | Phase | Source state | Generated | Validation | Source deletion allowed | Disposition |
|---|---|---:|---|---|---|---|---|
| `公司财务分析/**` | `skills/company-financial-analysis/**` | 0 | untracked | no | V2 contracts; selftest; DSH discovery | no | migrated |
| `宏观周期与政策分析/**` | `skills/macro-cycle-policy-analysis/**` | 0 | untracked | no | V2 contracts; DSH discovery | no | migrated |
| `投资行为诊断/**` | `skills/investment-behavior-diagnosis/**` | 0 | untracked | no | behavior tests/eval contract; DSH discovery | no | merged as production superset |
| `skills_v2/**` | canonical paths above | 0 | tracked deletions in source | mixed | V2 contracts; duplicate-name check | no | superseded by canonical paths |
| `SKILLS_V2.md`, `VERSION.json` | same | 0 | untracked | no | path/security scan | no | migrated and rewritten |
| `NGFI-skill-evaluation.html`, `tests/dsh-smoke-results.json` | none | 0 | untracked | yes | n/a | no | intentionally local/generated |
| `tests/dsh-v2.patch.yml`, `tests/run_dsh_smoke.py` | none | 0 | untracked | machine-specific/live harness | n/a | no | superseded by isolated runtime and opt-in E2E |
| `.env.example`, `.gitignore`, `README.md`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `pyproject.toml`, `tsconfig.json`, `uv.lock`, `.github/**`, `docs/**`, `handoffs/**`, `scripts/**` | same or governed replacement | 1–3 | tracked/untracked | mixed | `pnpm check`; governance validators | no | pending by phase |
| `packages/finance-core/src/data-v2/**`, `packages/finance-data-service/**` | same | 2.1 | untracked plus export edit | no | data-v2/service/reconciliation tests | no | migrated |
| `packages/finance-provider-astock/**`, `packages/finance-provider-{cne6,ifind,tdx,tushare-mcp}/**`, `skills/a-share-data-research/**`, A-share tests/fixtures/workflow/notices | same | 2.2 | untracked | generated upstream snapshot only where manifest-governed | upstream/license/security/provider tests | no | pending |
| `packages/research-{core,workspace,audit,workflow}/**`, `skills/{thesis-review,adversarial-research}/**`, research tests/evals | same | 2.3 | untracked | no | WP01–WP06/WP12 tests | no | pending |
| `packages/{strategy-core,technical-analysis,strategy-accumulation-breakout,signal-evaluation}/**`, strategy/signal tests/evals | same | 2.4 | untracked | no | WP03/WP07–WP10 tests | no | pending |
| `packages/quant-research/**`, `tests/quant-research-contract.test.ts` | same | 2.5 | untracked | no | 23 Python tests; TS bridge | no | pending |
| `packages/portfolio-risk/**`, CNE6 tracked edits/new facade/tests | same | 2.6 | mixed | no | portfolio contracts; CNE6 suite | no | pending |
| `packages/dsh-finance-tools/**`, `packages/dsh-finance-bundle/**`, presets, composition/isolation/E2E tests | reviewed thin adapters and generated presets | 3–4 | mixed | preset output only | build/typecheck/composition/isolation/trajectory | no | pending |
| `.runtime/**`, `node_modules/**`, `**/.venv/**`, `**/.uv-cache/**`, `**/lib/**`, `**/__pycache__/**`, `**/.pytest_cache/**`, local market data, credentials and transient reports | none | all | ignored/local | yes/private | absence checks | no | intentionally local, never migrate |

Every broad inventory row is closed only when all files below that source prefix have been classified. Phase commits update `Disposition` and the capability manifest together; directory presence alone is not evidence of completion.
