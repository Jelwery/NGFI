import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalJson, evidenceId, modelRunId, sha256, type ModelRun, type Evidence, type JsonObject } from '@finance2dsh/research-core'
import { ResearchWorkspace } from '@finance2dsh/research-workspace'
import { quantBridge } from './strategy-tools.js'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  Cne6PortfolioRiskFacade,
  InMemoryHoldingsStore,
  importHoldingsCsv,
  importHoldingsJson,
  type HoldingsImportContext,
  type HoldingsStore,
} from '@finance2dsh/portfolio-risk'
import { atomicJsonWrite, containedPath, ensurePlainDirectory, quantCodeIdentity, readJsonFile, requireRuntimeId, strictTool, withExclusiveLock } from './runtime-store.js'

export const PORTFOLIO_TOOL_NAMES = [
  'finance_holdings',
  'finance_portfolio_risk',
  'finance_portfolio_optimize',
  'finance_rebalance_plan',
] as const

export interface PortfolioToolOptions { runtimeRoot: string; quantProjectRoot?: string }

type HoldingsEvent =
  | { action: 'stage'; format: 'json' | 'csv'; text: string; context: HoldingsImportContext }
  | { action: 'confirm'; expectedSnapshotHash: `sha256:${string}` }
  | { action: 'discard' }
interface HoldingsState { schemaVersion: 1; events: HoldingsEvent[] }

const EMPTY_STATE: HoldingsState = { schemaVersion: 1, events: [] }
const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function jsonSafe(value: unknown): never { return JSON.parse(JSON.stringify(value)) as never }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}
function target(options: PortfolioToolOptions, workspaceId: unknown, portfolioId: unknown) {
  const directory = containedPath(
    options.runtimeRoot, 'portfolios', requireRuntimeId(workspaceId, 'workspace_id'), requireRuntimeId(portfolioId, 'portfolio_id'),
  )
  ensurePlainDirectory(directory)
  return { directory, state: join(directory, 'state.json') }
}
function importEvent(event: Extract<HoldingsEvent, { action: 'stage' }>) {
  return event.format === 'json'
    ? importHoldingsJson(event.text, event.context)
    : importHoldingsCsv(event.text, event.context)
}
function load(path: string): { state: HoldingsState; store: HoldingsStore } {
  const state = readJsonFile(path, EMPTY_STATE)
  if (state.schemaVersion !== 1 || !Array.isArray(state.events)) throw new TypeError('holdings runtime state is corrupt')
  const store = new InMemoryHoldingsStore()
  for (const event of state.events) {
    const revision = store.snapshot().revision
    if (event.action === 'stage') {
      const imported = importEvent(event)
      if (imported.status !== 'ready') throw new TypeError('holdings runtime state contains an invalid import')
      const result = store.stage(imported, revision)
      if (!result.changed) throw new TypeError('holdings runtime state contains a redundant stage event')
    } else if (event.action === 'confirm') {
      store.confirm(revision, event.expectedSnapshotHash)
    } else if (event.action === 'discard') {
      const result = store.discard(revision)
      if (!result.changed) throw new TypeError('holdings runtime state contains a redundant discard event')
    } else {
      throw new TypeError('holdings runtime state contains an unknown event')
    }
  }
  return { state, store }
}

function researchStore(options: PortfolioToolOptions, workspaceId: unknown) {
  const root = containedPath(options.runtimeRoot, 'research', requireRuntimeId(workspaceId, 'workspace_id'))
  ensurePlainDirectory(root)
  return new ResearchWorkspace({ root })
}

function confirmedInput(options: PortfolioToolOptions, args: Record<string, unknown>, input: Record<string, unknown>) {
  const book = load(target(options, args.workspace_id, args.portfolio_id).state).store.snapshot()
  const snapshot = book.confirmed
  if (snapshot === null || book.staged !== null || snapshot.snapshotHash !== args.holdings_snapshot_hash) throw new Error('confirmed holdings snapshot mismatch or pending staged changes')
  if (snapshot.baseCurrency !== 'CNY') throw new TypeError('optimizer requires CNY holdings')
  const asOf = Date.parse(String(input.asOf))
  const holdingTime = Date.parse(snapshot.asOf)
  if (!Number.isFinite(asOf) || !Number.isFinite(holdingTime) || holdingTime > asOf) throw new TypeError('holdings as-of is invalid or later than optimization')
  // When the confirmed snapshot carries an account state, cash, its availability
  // and per-position sellable quantities are confirmed together with quantities
  // as one unit. The optimizer input must not silently supply different values.
  const accountState = snapshot.accountState
  const sellableByKey = new Map<string, number>()
  const quantities = new Map<string, number>()
  for (const position of snapshot.positions) {
    const id = position.instrument
    const key = `${id.market}:${id.exchange}:${id.symbol}:${id.assetType}`
    quantities.set(key, (quantities.get(key) ?? 0) + position.quantity)
    if (accountState !== undefined) {
      if (position.sellableQuantity === undefined) throw new TypeError(`confirmed account state requires sellableQuantity for ${key}`)
      sellableByKey.set(key, (sellableByKey.get(key) ?? 0) + position.sellableQuantity)
    }
  }
  if (accountState !== undefined) {
    if (input.cash !== accountState.cash) throw new TypeError('optimization cash differs from confirmed account state')
    if (input.cashAvailableAt !== accountState.cashAvailableAt) throw new TypeError('optimization cashAvailableAt differs from confirmed account state')
  }
  if (!Array.isArray(input.assets)) throw new TypeError('assets must be an array')
  for (const value of input.assets) {
    const asset = object(value, 'asset')
    const id = object(asset.instrument, 'instrument')
    const key = `${id.market}:${id.exchange}:${id.symbol}:${id.assetType}`
    if (asset.quantity !== (quantities.get(key) ?? 0)) throw new TypeError(`asset quantity differs from confirmed holdings: ${key}`)
    if (accountState !== undefined && asset.sellableQuantity !== (sellableByKey.get(key) ?? 0)) throw new TypeError(`asset sellableQuantity differs from confirmed account state: ${key}`)
    quantities.delete(key)
  }
  if (quantities.size) throw new TypeError('optimization input omits confirmed holdings')
  return snapshot
}

function optimizationTool(options: PortfolioToolOptions, name: 'finance_portfolio_optimize' | 'finance_rebalance_plan'): ToolDefinition {
  return defineTool({
    name,
    description: name === 'finance_portfolio_optimize'
      ? 'Optimize explicit cross-sectional scores against CNE6 risk and a registered mandate artifact. Stores immutable inputs, result, evidence and code lineage; dry-run only.'
      : 'Return an audited 100-share rebalance draft from an existing OptimizationRun and the unchanged confirmed holdings. Does not solve again or place orders.',
    parameters: {
      workspace_id: { type: 'string', required: true }, case_id: { type: 'string', required: true },
      portfolio_id: { type: 'string', required: true }, holdings_snapshot_hash: { type: 'string', required: true },
      expected_revision: { type: 'integer', required: true }, dry_run: { type: 'boolean' },
      input: { type: 'object', additionalProperties: true }, input_artifact: { type: 'string' },
      mandate_artifact: { type: 'string' }, optimization_run_id: { type: 'string' },
    },
    output: JSON_OUTPUT, timeoutMs: 120_000,
    async execute(raw, exec) {
      const args = raw as Record<string, unknown>
      if (args.dry_run !== undefined && args.dry_run !== true) throw new TypeError('only dry-run is supported')
      const caseId = requiredText(args.case_id, 'case_id')
      if (!/^case-[0-9a-f]{64}$/.test(caseId)) throw new TypeError('invalid case_id')
      const store = researchStore(options, args.workspace_id)
      const state = store.open(caseId)
      if (state.revision !== args.expected_revision) throw new Error('research revision conflict')
      if (state.case.subject.kind !== 'portfolio' || state.case.subject.portfolioId !== args.portfolio_id) throw new Error('research case portfolio mismatch')
      const project = resolve(options.quantProjectRoot ?? join(process.cwd(), 'packages/combinatorial-optimization'))
      const artifact = (value: unknown): Record<string, unknown> => {
        const ref = requiredText(value, 'artifact')
        if (!/^artifacts\/[a-zA-Z0-9_./-]+\.json$/.test(ref) || ref.split('/').includes('..') || !state.fileHashes[ref]) throw new TypeError('artifact must be a registered case JSON file')
        const path = containedPath(store.casePath(caseId), ref)
        const parsed = object(readJsonFile(path, null), 'artifact JSON')
        const hash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
        if (hash !== state.fileHashes[ref]) throw new Error('artifact hash changed during read')
        return parsed
      }
      if (name === 'finance_rebalance_plan') {
        if (args.input !== undefined || args.input_artifact !== undefined || args.mandate_artifact !== undefined) throw new TypeError('rebalance plan accepts only a saved OptimizationRun, not replacement inputs')
        const run = state.modelRuns.find(item => item.id === args.optimization_run_id && item.model === 'portfolio-optimization')
        if (!run || run.output.status !== 'ok') throw new Error('successful OptimizationRun not found')
        if (run.parameters.holdingsSnapshotHash !== args.holdings_snapshot_hash) throw new Error('OptimizationRun holdings mismatch')
        const original = object(run.parameters.input, 'stored optimization input')
        confirmedInput(options, args, original)
        const result = object(run.output.value, 'optimization result')
        if (result.status !== 'ok' || result.repaired === null) throw new Error('optimization has no feasible repaired plan')
        const plan: Omit<ModelRun, 'id'> = {
          model: 'portfolio-rebalance-plan', version: '1.0.0', inputRefs: [{ kind: 'model-run', id: run.id }],
          parameters: { holdingsSnapshotHash: args.holdings_snapshot_hash as string, dryRun: true },
          output: { status: 'ok', value: { dryRun: true, optimizationRunId: run.id, plan: result.repaired as JsonObject } },
          warnings: ['Simulation only; no order submission.'], createdAt: run.createdAt,
        }
        const saved = store.saveModelRun(caseId, state.revision, { id: modelRunId(plan), ...plan })
        return jsonSafe({ ...saved, modelRunId: modelRunId(plan), dryRun: true, optimizationRunId: run.id, plan: result.repaired })
      }
      if ((args.input === undefined) === (args.input_artifact === undefined)) throw new TypeError('supply exactly one of input or input_artifact')
      const input = args.input_artifact === undefined ? object(args.input, 'input') : artifact(args.input_artifact)
      const mandate = artifact(args.mandate_artifact)
      if (input.mandate !== undefined && canonicalJson(input.mandate) !== canonicalJson(mandate)) throw new TypeError('input mandate differs from registered mandate')
      const payload: Record<string, unknown> = { ...input, mandate, dryRun: true }
      const asOf = requiredText(payload.asOf, 'asOf')
      if (!Number.isFinite(Date.parse(asOf))) throw new TypeError('asOf must be a valid timestamp')
      const caseDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(asOf))
      if (state.case.asOf !== caseDate && Date.parse(state.case.asOf) !== Date.parse(asOf)) throw new TypeError('optimization date differs from research case')
      if (input.dryRun !== undefined && input.dryRun !== true) throw new TypeError('only dry-run is supported')
      const holdings = confirmedInput(options, args, payload)
      const evidenceRefs = new Set<string>()
      for (const row of payload.assets as Record<string, unknown>[]) {
        // Only scored assets carry alpha and therefore need evidence; unscored
        // held/benchmark names declare an explicit scoreReason instead.
        if (row.score === undefined) {
          if (row.evidenceRefs !== undefined) throw new TypeError('unscored asset must not carry evidence references')
          if (typeof row.scoreReason !== 'string' || row.scoreReason.trim() === '') throw new TypeError('unscored asset requires a scoreReason')
          continue
        }
        if (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.length === 0) throw new TypeError('every score needs evidence references')
        for (const ref of row.evidenceRefs) {
          const evidence = state.evidence.find(item => item.id === ref)
          if (!evidence || evidence.sourceRef.availableAt === undefined || Date.parse(evidence.sourceRef.availableAt) > Date.parse(String(input.asOf))) throw new TypeError('score evidence is absent or future-available')
          evidenceRefs.add(String(ref))
        }
      }
      const identity = quantCodeIdentity(project)
      const result = object(await quantBridge({ quantProjectRoot: project }, 'portfolio-optimize', payload, exec.signal), 'OptimizationRun')
      confirmedInput(options, args, payload)
      const createdAt = requiredText(input.asOf, 'asOf')
      const content: Omit<ModelRun, 'id'> = {
        model: 'portfolio-optimization', version: '1.0.0',
        inputRefs: [...evidenceRefs].sort().map(id => ({ kind: 'evidence' as const, id })),
        parameters: { input: payload as JsonObject, mandateArtifact: String(args.mandate_artifact), mandateHash: sha256(mandate), holdingsSnapshotHash: holdings.snapshotHash, ...identity, seed: 0 },
        output: result.status === 'ok' ? { status: 'ok', value: result as JsonObject }
          : { status: 'insufficient', reason: 'Optimization rejected', details: result as JsonObject },
        warnings: result.status === 'ok' ? [] : [JSON.stringify(result.rejectionReasons)], createdAt,
      }
      const id = modelRunId(content)
      const saved = store.saveModelRun(caseId, state.revision, { id, ...content })
      const calculation: Omit<Extract<Evidence, { kind: 'calculation' }>, 'id'> = {
        kind: 'calculation', subject: state.case.subject, field: 'OptimizationRun', value: result as JsonObject,
        modelRunRef: id, quality: result.status === 'ok' ? 'medium' : 'low',
        sourceRef: { provider: 'ngfi-optimizer', upstream: identity.codeVersion, sourceKind: 'derived', retrievedAt: createdAt, availableAt: createdAt, hash: sha256(result) },
        limitations: ['Rank preference is not an expected return forecast.', 'Continuous duals do not describe an integer optimum.'],
      }
      const evidence = { id: evidenceId(calculation), ...calculation }
      const current = store.open(caseId)
      const written = current.evidence.some(item => item.id === evidence.id) ? saved : store.appendEvidence(caseId, current.revision, [evidence])
      return jsonSafe({ revision: written.revision, modelRunId: id, evidenceId: evidence.id, result })
    },
  })
}

export function createPortfolioTools(options: PortfolioToolOptions): ToolDefinition[] {
  return [
    optimizationTool(options, 'finance_portfolio_optimize'),
    optimizationTool(options, 'finance_rebalance_plan'),
    defineTool({
      name: 'finance_holdings',
      description: 'Import, stage, inspect, explicitly confirm, or discard holdings in a bounded runtime book. Invalid/empty imports are returned as invalid and never staged; writes require exact revision and confirmation hash. An optional account_state confirms cash and per-position sellable quantities together with quantities as one unit.',
      parameters: {
        action: { type: 'string', enum: ['inspect', 'stage-json', 'stage-csv', 'confirm', 'discard'], required: true },
        workspace_id: { type: 'string', required: true },
        portfolio_id: { type: 'string', required: true },
        expected_revision: { type: 'integer' },
        as_of: { type: 'string' },
        base_currency: { type: 'string' },
        content: { type: 'string' },
        account_state: { type: 'object', additionalProperties: true },
        expected_snapshot_hash: { type: 'string' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const location = target(options, args.workspace_id, args.portfolio_id)
        if (args.action === 'inspect') return jsonSafe(load(location.state).store.snapshot())
        return jsonSafe(withExclusiveLock(location.directory, () => {
          const current = load(location.state)
          const expected = args.expected_revision
          let result
          let event: HoldingsEvent
          if (args.action === 'stage-json' || args.action === 'stage-csv') {
            const context: HoldingsImportContext = {
              portfolioId: requireRuntimeId(args.portfolio_id, 'portfolio_id'),
              asOf: requiredText(args.as_of, 'as_of'), baseCurrency: requiredText(args.base_currency, 'base_currency'),
              ...(args.account_state === undefined ? {} : { accountState: object(args.account_state, 'account_state') as never }),
            }
            event = {
              action: 'stage', format: args.action === 'stage-json' ? 'json' : 'csv',
              text: requiredText(args.content, 'content'), context,
            }
            const imported = importEvent(event)
            if (imported.status !== 'ready') return { revision: current.store.snapshot().revision, changed: false, import: imported }
            result = current.store.stage(imported, expected as number)
          } else if (args.action === 'confirm') {
            event = { action: 'confirm', expectedSnapshotHash: requiredText(args.expected_snapshot_hash, 'expected_snapshot_hash') as `sha256:${string}` }
            const book = current.store.snapshot()
            if (book.staged === null && book.confirmed?.snapshotHash === event.expectedSnapshotHash) {
              if (expected !== book.revision) throw new Error(`holdings revision conflict: expected ${String(expected)}, found ${book.revision}`)
              return { revision: book.revision, changed: false, snapshot: book.confirmed }
            }
            result = current.store.confirm(expected as number, event.expectedSnapshotHash)
          } else {
            event = { action: 'discard' }
            result = current.store.discard(expected as number)
          }
          if (result.changed) atomicJsonWrite(location.state, { schemaVersion: 1, events: [...current.state.events, event] })
          return result
        }))
      },
    }),
    defineTool({
      name: 'finance_portfolio_risk',
      description: 'Calculate CNE6 portfolio, marginal, or factor-scenario risk from explicitly supplied model data and the confirmed holdings snapshot. Staged, unmapped, currency-conflicted, low-coverage, or unreconciled inputs fail closed.',
      parameters: {
        action: { type: 'string', enum: ['snapshot', 'marginal', 'stress'], required: true },
        workspace_id: { type: 'string', required: true },
        portfolio_id: { type: 'string', required: true },
        model: { type: 'object', additionalProperties: true, required: true },
        options: { type: 'object', additionalProperties: true },
        proposal: { type: 'object', additionalProperties: true },
        scenario: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const book = load(target(options, args.workspace_id, args.portfolio_id).state).store.snapshot()
        const holdings = book.confirmed ?? book.staged
        if (holdings === null) throw new Error('holdings are unavailable; stage and confirm an import first')
        const facade = new Cne6PortfolioRiskFacade(
          object(args.model, 'model') as never, args.options === undefined ? {} : object(args.options, 'options'),
        )
        if (args.action === 'snapshot') return jsonSafe(facade.portfolioRisk(holdings))
        if (args.action === 'marginal') return jsonSafe(facade.marginalRisk(holdings, object(args.proposal, 'proposal') as never))
        return jsonSafe(facade.stress(holdings, object(args.scenario, 'scenario') as never))
      },
    }),
  ].map(strictTool)
}
