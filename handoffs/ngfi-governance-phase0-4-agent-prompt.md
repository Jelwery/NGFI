# NGFI 仓库治理 Phase 0–4 实施 Prompt

> 将本文件整体交给新的实现 Agent。它是执行任务，不是调研或只写方案的任务。

## 任务目标

在不降低任何现有 Agent 能力、领域能力、失败语义或安全边界的前提下，完成 NGFI 仓库治理 Phase 0–4：

0. 把散落在仓库根目录的三套 Skill 正式整合进 NGFI 的 canonical `skills/` 与运行时；
1. 建立可审计、可持续执行的能力基线和绿色总门禁；
2. 将来源工作树中的大型未提交成果按领域拆入治理分支，形成可回滚的提交序列；
3. 收紧 package、DSH adapter、配置、文档和测试边界；
4. 完成稳定领域能力的 WP15 DSH Tools、Skills、presets 和 evals 接线。

不要只输出建议。请直接修改目标 worktree、运行验证并提交阶段性 commits，直到 Phase 0–4 全部满足验收条件，或遇到无法通过本地证据解决的真实阻塞。

## 已完成的保护现场前置步骤

- 只读来源工作树：当前治理 worktree 的 sibling `../NGFI`
- 治理目标 worktree：本文件所在仓库
- 治理分支：`codex/ngfi-governance`
- 两者创建时共同基线：`da101d13095c413e7904d4eb171afd11d01c97b5`
- 来源工作树保留了完整未提交成果，约有 70 个 tracked 修改/删除和 340 个 untracked 文件。

必须遵守：

1. 只在本治理 worktree 写文件、安装依赖、构建和提交。
2. sibling `../NGFI` 只允许读取和比较；禁止在其中 checkout、reset、clean、stash、commit、格式化、删除或生成文件。开始前通过 `git worktree list --porcelain` 校验两个路径及分支，不依赖硬编码机器绝对路径。
3. 不得运行 `git clean`、`git reset --hard`、`git checkout --` 或其他可能破坏来源工作树的命令。
4. 迁移文件时使用 `apply_patch` 或可审计的复制方式；每批迁移后检查 `git diff` 和 `git status`。
5. 不因来源工作树混乱而整包复制缓存、虚拟环境、构建产物、runtime 状态、用户凭据或本地市场数据。
6. 若治理 worktree 中发现用户后来加入的改动，保留并绕开，不得回滚。

## 已知基线与不可回退条件

来源工作树已经验证：

- TypeScript workspace build 通过；
- 全量 TypeScript typecheck 通过；
- Vitest：38 files、641 tests 全部通过；
- `packages/quant-research`：23 个 Python tests 全部通过；
- CNE6：142 passed、2 skipped；
- Skills V2 contracts：14 tests 全部通过；
- `公司财务分析/scripts/selftest.py` 全部通过；
- DSH runtime prepare、headless dump、web dump 通过；
- A 股 upstream integrity 和依赖许可证门禁通过；
- worktree security scan 当前失败，原因是 14 个绝对机器路径 finding；这是待修问题，不能通过禁用规则或忽略整个文件解决。

来源工作树的当前 Agent surface 至少包括：

- `skill`；
- 20 个 `finance_*` 工具，其中包括全球股票数据/估值/行为工具和 8 个 curated A 股工具；
- `skills/` 下 10 个可发现 Skill；
- headless 与 web 两套 profile；
- shell、任意 URL、raw provider/MCP 不在 finance agent allowlist。

治理后必须满足：

1. 现有 20 个金融工具的名称、参数语义和失败语义不得静默删除或弱化。
2. 现有 10 个 Skill 不得静默丢失；合并同名 Skill 时必须证明能力为超集。
3. 新整合的 `company-financial-analysis`、`macro-cycle-policy-analysis` 和唯一的 `investment-behavior-diagnosis` 必须可被 DSH Skill filesystem 发现。
4. `missing`、`no-data`、`unsupported`、`unavailable`、`unauthorized`、`insufficient-permission`、`partial`、`stale`、`unfillable`、`insufficient`、`failed/error` 保持区分，禁止用零或空成功结果代替。
5. canonical identity、PIT、单位、币种、复权、availableAt、hash、snapshot 和 provenance 语义不得回退。
6. smoke backtest 永远不能被标记或解释为 research-grade，也不能直接使策略晋级。
7. finance agent 继续禁止任意 shell、任意 URL、raw provider、raw MCP、订单和实盘交易入口。
8. 不建立第二套 agent loop；DSH 继续是唯一 Agent runtime。
9. 所有阶段必须在干净 checkout 可复现；测试不得依赖来源工作树的绝对路径。

## 开始前必须完成的核查

1. 阅读目标 worktree 的根 README、`.gitignore`、`package.json`、workspace、runtime、profiles、bundle、tools、skills 和 tests。
2. 从只读来源工作树阅读：
   - `handoffs/upstream-capability-adoption-study.md`；
   - `handoffs/upstream-capability-work-packages.md`；
   - `docs/ngfi-evolution-roadmap.md`；
   - `SKILLS_V2.md`；
   - 三个根目录 Skill；
   - 新增 packages、tests、evals、A 股 provider 与 CNE6 变更。
3. 记录治理 worktree 和来源工作树各自的 `git status --short --branch`。
4. 建立迁移 inventory：来源路径、目标路径、归属 phase、是否 tracked、是否生成物、验证命令、是否允许删除。
5. 先运行治理 worktree 的原始基线测试，并记录与来源工作树基线的差异。

---

## Phase 0：整合根目录三套 Skill

### 目标

将来源工作树根目录的：

- `公司财务分析/`；
- `宏观周期与政策分析/`；
- `投资行为诊断/`

整合到 runtime 已挂载的 canonical `skills/` 下。完成后仓库根目录和 `skills_v2/` 不再保留第二份运行时 Skill 源；但在迁移提交和 manifest 中保留来源、hash 和兼容说明。

### canonical 目标

- `skills/company-financial-analysis/`，frontmatter name 为 `company-financial-analysis`；
- `skills/macro-cycle-policy-analysis/`，frontmatter name 为 `macro-cycle-policy-analysis`；
- `skills/investment-behavior-diagnosis/`，frontmatter name 仍为 `investment-behavior-diagnosis`，全仓只能有一个 canonical 同名 Skill。

### 合并规则

1. 公司财务分析和宏观周期分析的 `SKILL.md`、references、scripts 必须完整迁入对应 canonical 目录。排除 `.DS_Store` 和运行产物。
2. 公司财务分析的确定性脚本和 JSON schema 是能力资产，不能因为整理目录而丢失；修正其中机器绝对路径，但不得改变公式、状态闸门或 fail-closed 行为。
3. 宏观分析的冻结快照、数据不足、tool error、传导链和反证条件必须保留。PDF 脚本可以作为显式 CLI 辅助能力保留，但不能导致 finance agent 获得任意 shell 权限。
4. `投资行为诊断` 存在同名冲突：
   - 当前 `skills/investment-behavior-diagnosis/` 是已经过更强正式评测的生产版本，应作为 canonical 基础；
   - 根目录 V2 版本不能覆盖生产版本；
   - 先制作逐项能力矩阵，再把 V2 独有且不降低现有严谨性的内容合并进去；
   - 必须保留生产版的证据分层、候选机制、竞争解释、工具使用、PGR/PLR 边界、置信度和隐私/心理健康边界；
   - 必须保留或吸收 V2 的 `needs_input`、`data_conflict`、`ok`、`not_a_bias`、理性行为零假设、最多三个核心机制、对抗指令防护、默认不写文件和不输出当前标的买卖/仓位/目标价等约束；
   - 两套 reference 若语义重复，合并为一个结构清晰的 canonical reference；若尚无法安全去重，先保留为清晰命名的兼容 reference，并在 manifest 标注来源，不能静默删除。
5. 把原 `skills_v2/tests/test_v2_contracts.py` 的有效断言迁到 canonical 路径；现有行为诊断 eval 也必须继续通过。
6. 更新 Skills 文档、版本信息和测试中的旧路径。不得保留会让用户误以为 `skills_v2/` 或根目录中文目录仍是运行入口的说明。
7. DSH runtime 继续只挂载一个 `skills/` 根，不通过扩大 skill roots 来掩盖目录重复。
8. 不开放任意 shell。若 Skill 文案声称 Agent 可以执行脚本，而当前没有受控 tool，则必须：
   - 要么提供最小、白名单、固定脚本/固定参数的薄适配工具；
   - 要么准确写成离线 CLI/人工辅助能力，并禁止 Agent 声称已经执行。
   不得留下虚假的 Agent 能力声明。

### Phase 0 必测

- 每个 canonical Skill 的 frontmatter 和 reference 链接校验；
- 全仓 Skill name 唯一性；
- DSH filesystem 实际发现三套 Skill；
- 原 14 个 V2 contract tests 迁移后通过；
- 公司财务分析 selftest 通过；
- 当前 `skills/investment-behavior-diagnosis/evals/evals.json` 继续有效；
- behavior tools/skill/composition/isolation tests 继续通过；
- 增加三个 Skill 的 runtime discovery contract；
- 根目录不再出现三套第二运行副本。

### Phase 0 提交

建议提交：`refactor(skills): consolidate canonical finance skills`。

---

## Phase 1：能力基线与绿色总门禁

### 目标

建立机器可读的 capability manifest、完整的离线总门禁和普通 PR CI，使后续治理中的任何能力下降都可被自动发现。

### 必须实现

1. 新增机器可读 capability manifest。建议路径为 `docs/capabilities/manifest.json`，并配套人类可读 `docs/capabilities/status.md`。每项至少包含：
   - capability id 和类别；
   - owner package；
   - public export；
   - `kernel-tested | agent-exposed | live-verified` 状态；
   - tool/Skill/preset 名；
   - contract test 与 golden fixture；
   - 上游 project、commit、path；
   - 安全边界和已知限制。
2. 编写 manifest validator，检查 owner、export、test、fixture、tool、Skill 与 preset 均真实存在，ID 唯一，不允许把无 provider 或无 Agent 接线的 surface 宣称为可用。
3. 修复当前 security scan 的 14 个绝对机器路径 finding：使用 repo-relative path、环境变量或稳定占位符。不要放宽扫描规则来掩盖 finding。
4. 调整 `.gitignore`：
   - 版本化治理所需的 `docs/`、`handoffs/`、eval contracts 和 capability manifest；
   - 继续忽略私有文档、runtime、cache、虚拟环境、真实数据、凭据和生成评测运行；
   - 避免“整个 docs 被忽略，只例外一个 JSON”的反直觉规则。
5. 将根总门禁拆成清晰脚本，例如 `check:static`、`test:ts`、`test:python`、`test:cne6`、`test:skills`、`test:runtime`、`check`。`check` 必须包含：
   - upstream integrity；
   - license gate；
   - security scan；
   - build；
   - typecheck；
   - 全量 Vitest；
   - quant-research 23 tests；
   - CNE6 offline suite；
   - Skills V2 contracts 和 company selftest；
   - capability manifest validation；
   - runtime prepare、headless dump、web dump；
   - 测试结束后无意外工作树漂移。
6. 新增普通 `pull_request` 和必要的 `push` CI。保留现有 A 股上游同步 workflow 的专项职责，不把普通 CI 塞进 scheduled sync workflow。
7. 所有 CI action 和依赖继续固定版本；默认测试不访问真实 provider、不请求 LLM、不启动长期服务。
8. 更新过期运行文档：路径、package 数、测试数和实际命令必须与当前仓库一致。

### Phase 1 验收

- 干净治理 worktree 中 `pnpm check` 完整通过；
- capability manifest validator 通过；
- security scan 为零 finding；
- CI 覆盖所有离线能力族；
- 删除一个现有 tool、Skill、public export 或关键 test 时，至少有一个门禁会失败；
- 文档不含开发者机器绝对路径。

### Phase 1 提交

建议拆为：

1. `chore(governance): add capability inventory and docs policy`；
2. `ci: enforce complete offline capability gates`。

---

## Phase 2：按能力域迁移并拆分来源工作树成果

### 目标

把 sibling `../NGFI` 的大型未提交成果迁入治理分支，但不做一次性目录镜像或超大提交。每个批次独立可构建、可测试、可回滚。

### 原则

1. 以来源工作树为实现来源，以目标分支当前状态为集成基线。
2. 逐文件审阅；禁止复制 `.runtime`、`node_modules`、`.venv`、`.uv-cache`、`lib`、`__pycache__`、`.pytest_cache`、`.DS_Store`、真实凭据、真实本地数据和临时报告。
3. 每批先迁领域 package 和测试，再增量修改 workspace、root dependencies、lockfile 和文档。
4. 不得用 root blanket dependencies 代替 package 正确依赖。
5. 每个提交必须说明迁移来源、固定 upstream commit、Copy/Adapt/Rewrite 属性、稳定 exports、测试和限制。
6. 不为通过测试而放宽 `any`、schema、hash、PIT 或失败状态。

### 强制迁移顺序

1. `finance-core/data-v2`、`finance-data-service` 和跨来源 reconciliation；
2. A 股 provider、upstream snapshot、curated tools、A 股 Skill、fixtures、安全与许可证资产；
3. WP01–WP06：research core、workspace、audit、workflow、thesis drift；
4. WP03/WP07–WP10：strategy contracts、technical analysis、smoke backtest、breakout、signal evaluation；
5. WP11/WP13：quant-research、research-grade backtest、validation、factor kernel 和 TS/Python contract bridge；
6. WP14：holdings、portfolio-risk、CNE6 publication/facade；
7. 更新 handoffs 状态，明确哪些已迁移、哪些只是 kernel-tested、哪些还未 Agent exposed。

允许在依赖明确且 commits 仍可独立回滚时微调相邻批次，但不能把所有变更压成一个提交。

### 每批验收

- package build/typecheck/test；
- 对应负例和 golden fixture；
- root 受影响测试；
- capability manifest 同步；
- `git diff --check`；
- security 和 license 检查；
- 没有来源工作树写入；
- commit 后目标 worktree clean。

### Phase 2 退出条件

- 来源工作树中所有有意保留的代码、tests、fixtures、docs、workflow 均在 inventory 中标记为 migrated、superseded 或 intentionally-local；
- 不允许存在“看起来漏了但不知道是否该迁”的路径；
- WP01–WP14 的领域内核和专项测试在治理分支达到或超过来源基线；
- 不能仅凭目录存在把工作包标成 complete。

---

## Phase 3：收紧架构、依赖和 source-of-truth 边界

### 目标

在不改变领域行为的前提下消除反向依赖、重复配置和含糊的生成物归属。

### 必须实现

1. `research-workflow` 恢复为领域层：
   - workflow definition、stage state machine、dossier、executor interface 和纯 runner 留在领域 package；
   - DSH agent/session/message/event 适配移入 `dsh-finance-tools` 或独立 DSH adapter package；
   - mock executor 测试继续完全离线；
   - 领域 package 不再依赖 `@deepseek-ai/dsh-*`。
2. 建立并测试 package 依赖规则：
   - provider 不依赖 Agent；
   - domain 不依赖 DSH、provider、网络或 UI；
   - tools 可以依赖稳定 domain/application；
   - bundle 只依赖 tools/runtime glue，不包含业务算法；
   - 禁止依赖环。
3. 清理根 `package.json` 的 workspace blanket dependencies，只保留根 runtime、scripts 和跨包测试真正需要的依赖。每个 package 自己声明直接依赖。
4. 明确 preset/config source of truth：
   - 推荐把人工维护源放在 `config/agent-presets/`，生成到 `generated/agent-presets/`；
   - 若保留现结构，也必须有确定性生成/校验命令；
   - CI 必须能检测 source 与 generated drift。
5. 统一 docs 状态：
   - 当前入口文档只描述真实能力；
   - 历史 handoff 移入 `handoffs/archive/` 或明确标注 historical；
   - 不能继续建议从已经完成的 WP01/WP03 重新开始。
6. 测试目录按责任收敛：package 单测、跨包 contract、runtime/composition、live tests 和 immutable eval fixture 各有明确位置；迁移可分步，但命名和 ownership 必须可查。
7. `combinatorial-optimization` 的改名不是本 phase 的强制项。除非兼容入口、Python project、脚本、文档和所有测试可以一次完成并证明无回退，否则保留路径并只记录后续改名计划。
8. Python environments/cache 统一为可忽略、可重建位置；不提交虚拟环境和 egg-info。不要在本 phase 为了节省空间破坏来源工作树。

### Phase 3 验收

- 依赖规则测试通过，领域层没有 DSH/provider 反向依赖；
- package graph 无环；
- preset 只有一个人工 source of truth，生成结果无 drift；
- `pnpm check` 继续全绿；
- 领域 golden identity、hash 和结果与 Phase 2 基线一致。

### Phase 3 提交

按边界分别提交，至少区分 workflow/DSH 解耦、依赖治理、preset source-of-truth 和文档归档。

---

## Phase 4：完成 WP15 的安全 Agent 接线

### 目标

把 Phase 2 已稳定且通过测试的领域能力通过薄 DSH tools 暴露给 Agent，同时保持默认 Agent 的既有行为和安全边界。

### 接入策略

1. 保持现有 `finance-analyst` preset 兼容，不一次性塞入所有新能力。
2. 新增三个职责明确的 preset：
   - `company-research`；
   - `strategy-research`；
   - `portfolio-risk`。
3. 各 preset 使用显式 allowlist；共享基础 finance data tools，但只开放职责所需的新工具。
4. tool 只能做参数 schema、权限/路径边界、领域函数调用、结果裁剪与 JSON-safe 转换；不得重写算法、audit gate、hash 或状态机。
5. 不开放 shell/web/raw provider/raw MCP。研究数据继续来自 canonical data contract、已确认 workspace、冻结 replay 或显式用户输入。

### 最小工具能力面

根据稳定 exports 设计少而完整的工具，不要求一个函数一个工具，但至少覆盖：

- Research：case create/open/update、evidence/assumption/claim append、snapshot/verify/replay、workflow run/resume、audit、thesis drift、adversarial review；
- Strategy：registry/catalog、strategy evaluate、technical indicators、smoke backtest、research backtest evidence、promotion evidence；
- Signal：observation append、lifecycle event/projection、outcome revision、calibration snapshot；
- Portfolio：holdings import stage/inspect/confirm、risk snapshot、marginal risk、scenario stress。

写操作必须具备显式 workspace/case、revision、幂等、原子写和确认边界。持仓必须 staged 后再 confirmed。空、损坏、冲突或样本不足不得被工具包装成成功。

### Skills 与解释纪律

1. 更新或新增 company research、strategy research、portfolio risk、thesis review、adversarial review Skills。
2. Skill 只负责选择流程、解释输出和声明限制；公式、状态转换、晋级和 audit gate 必须在领域代码。
3. Skill 不得声称不存在或未 allowlist 的工具。
4. company financial analysis 的确定性脚本若暴露给 Agent，必须通过窄工具参数和固定入口执行；禁止通用命令执行。

### Agent 级 eval 与测试

至少新增：

- frozen replay 完整性和篡改拒绝；
- 引用完整性与数字忠实度；
- report audit 未通过时不能 complete；
- strategy tool trajectory；
- 禁止工具与越权参数；
- missing/insufficient/unfillable/error 保真；
- smoke backtest 不能晋级；
- signal outcome revision 和 calibration 最小样本；
- holdings staged-confirmed；
- portfolio risk coverage/reconciliation fail-closed；
- adversarial review 的共享 dossier、角色隔离与不投票产生交易权重；
- 三个新 preset 的 composition/isolation；
- 现有 finance-analyst 全球股票、A 股、估值、行为诊断回归。

默认 CI 只跑 deterministic/offline eval。真实 provider 和真实 LLM E2E 保留为显式 opt-in；若凭据不可用，必须报告未运行，不能伪造通过。

### Phase 4 验收

- 三个新 preset 能 materialize，且 tool allowlist 与 capability manifest 一致；
- 领域 package 不因接线新增 DSH 依赖；
- 现有 finance-analyst 的 20 个工具与既有 Skill 均保留；
- 新能力至少各有 contract、composition、isolation 和离线 trajectory/eval 证据；
- `pnpm check` 完整通过；
- 有凭据时再运行现有 E2E 和三个新 preset 的最小 E2E，并记录真实结果。

---

## 实施纪律

1. 每个 phase 开始时列出输入、将修改的路径、保持不变的能力和验收命令。
2. 每个 phase 结束时运行该 phase 专项测试和完整 `pnpm check`，确认目标 worktree clean 后提交。
3. 不用大量 README 文案替代测试和 manifest 证据。
4. 不为“整洁”删除尚未等价迁移的代码、Skill、reference、fixture、eval 或兼容入口。
5. 重命名必须先提供引用更新、兼容策略和测试；不能只移动目录。
6. 所有 hash、fixture 和 manifest 更新必须由真实输入变化触发，不得在测试失败后手改期望值掩盖回归。
7. 网络/live 检查与离线门禁分离；没有凭据或实时源不稳定不应阻止离线治理，但必须如实记录。
8. 不修改 DSH core，不复制上游完整 checkout，不引入数据库、UI、Bot、通知、订单或实盘交易。

## 最终交付格式

最终回复必须包含：

1. Phase 0–4 每阶段完成状态；
2. commit 列表及每个 commit 的职责；
3. capability manifest 中 kernel-tested、agent-exposed、live-verified 的统计；
4. 三套根目录 Skill 的迁移/合并说明，特别是同名行为诊断的能力矩阵结论；
5. 新旧 tool、Skill、preset 对照表；
6. 架构依赖变化；
7. 运行的所有测试、通过数量、耗时和未运行项原因；
8. security/license/upstream checks 结果；
9. 已知限制与尚未 live-verified 的能力；
10. 对只读来源工作树的确认：未修改、未清理、未提交；
11. 回滚方式，至少能按 phase 回滚而不影响其他能力域。

只有当能力清单无缩水、离线总门禁全绿、Agent surface 可验证、目标 worktree 无意外改动且每个 phase 可独立回滚时，任务才算完成。
