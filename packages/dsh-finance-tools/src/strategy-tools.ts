import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ACCUMULATION_BREAKOUT_STRATEGY_V1 } from '@finance2dsh/strategy-accumulation-breakout'
import {
  NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1,
  StrategyRegistry,
  assertBacktestRun,
  runSmokeBacktest,
  type JsonObject,
  type StrategyRunInput,
} from '@finance2dsh/strategy-core'
import { INDICATOR_DEFINITIONS, computeIndicator, indicatorDefinition } from '@finance2dsh/technical-analysis'
import { ResearchWorkspace } from '@finance2dsh/research-workspace'
import { canonicalJson, evidenceId, modelRunId, sha256, type JsonObject as ResearchJsonObject, type ModelRun } from '@finance2dsh/research-core'
import { containedPath, ensurePlainDirectory, quantCodeIdentity, requireRuntimeId, strictTool } from './runtime-store.js'

const MAX_BRIDGE_BYTES = 8 * 1024 * 1024

export const STRATEGY_TOOL_NAMES = [
  'finance_strategy_registry',
  'finance_strategy_backtest',
  'finance_strategy_promotion',
] as const

export interface StrategyToolOptions {
  quantProjectRoot: string
  uvExecutable?: string
  runtimeRoot?: string
}

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function jsonSafe(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function strategyRegistry(): StrategyRegistry {
  return new StrategyRegistry()
    .registerExecution(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1)
    .registerStrategy(ACCUMULATION_BREAKOUT_STRATEGY_V1)
}

export async function quantBridge(
  options: StrategyToolOptions, operation: 'research-backtest' | 'promotion' | 'portfolio-optimize' | 'rebalance-plan' | 'walk-forward', input: unknown, signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error('quant computation aborted')
  const project = resolve(options.quantProjectRoot)
  const payload = JSON.stringify(input)
  if (Buffer.byteLength(payload) > MAX_BRIDGE_BYTES) throw new RangeError('quant research input exceeds 8 MiB')
  const executable = options.uvExecutable ?? 'uv'
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(executable, ['run', '--project', project, '--frozen', '--offline', '--no-sync', '--no-env-file', '--no-config', 'python', '-m', 'ngfi_quant.agent_bridge', operation], {
      cwd: project, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? resolve(project, '.uv-cache'),
        PYTHONDONTWRITEBYTECODE: '1',
      },
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BRIDGE_BYTES) child.kill('SIGKILL')
      else output.push(chunk)
    })
    let errorBytes = 0
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length
      if (errorBytes > MAX_BRIDGE_BYTES) child.kill('SIGKILL')
      else errors.push(chunk)
    })
    child.stdin.on('error', () => child.kill('SIGTERM'))
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', status => {
      clearTimeout(timeout)
      if (signal?.aborted) reject(new Error('quant computation aborted'))
      else if (bytes > MAX_BRIDGE_BYTES || errorBytes > MAX_BRIDGE_BYTES) reject(new Error('quant research output exceeds 8 MiB'))
      else if (status !== 0) reject(new Error(`quant research bridge failed: ${Buffer.concat(errors).toString('utf8').trim()}`))
      else resolveOutput(Buffer.concat(output).toString('utf8'))
    })
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal?.removeEventListener('abort', abort))
    child.stdin.end(payload)
  })
  return JSON.parse(stdout) as unknown
}

export function createStrategyTools(options: StrategyToolOptions): ToolDefinition[] {
  return [
    defineTool({
      name: 'finance_strategy_registry',
      description: 'Inspect the fixed strategy/indicator catalog or deterministically evaluate the registered strategy over caller-supplied PIT bars. No dynamic code or provider access is supported.',
      parameters: {
        action: { type: 'string', enum: ['catalog', 'evaluate', 'indicator'], required: true },
        strategy_id: { type: 'string' },
        indicator_id: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        bars: { type: 'array', items: { type: 'object', additionalProperties: true } },
        config: { type: 'object', additionalProperties: true },
        parameters: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const registry = strategyRegistry()
        if (args.action === 'catalog') {
          return jsonSafe({
            strategies: registry.strategyIds().map(id => registry.resolveStrategy(id).spec),
            executions: registry.executionIds().map(id => registry.resolveExecution(id)),
            indicators: INDICATOR_DEFINITIONS.map(({ compute: _compute, ...definition }) => definition),
          })
        }
        if (args.action === 'evaluate') {
          if (typeof args.strategy_id !== 'string') throw new TypeError('strategy_id is required for evaluate')
          return jsonSafe(registry.evaluateStrategy(
            args.strategy_id, object(args.input, 'input') as unknown as StrategyRunInput,
            (args.config === undefined ? {} : object(args.config, 'config')) as JsonObject,
          ))
        }
        if (typeof args.indicator_id !== 'string') throw new TypeError('indicator_id is required for indicator')
        const definition = indicatorDefinition(args.indicator_id)
        if (definition === undefined) throw new TypeError(`unknown indicator ${args.indicator_id}`)
        if (!Array.isArray(args.bars)) throw new TypeError('bars must be an array')
        return jsonSafe({
          definition: (({ compute: _compute, ...metadata }) => metadata)(definition),
          series: computeIndicator(
            definition, args.bars as never,
            (args.parameters === undefined ? {} : object(args.parameters, 'parameters')) as never,
          ),
        })
      },
    }),
    defineTool({
      name: 'finance_strategy_backtest',
      description: 'Run either the fixed TypeScript smoke contract check or the fixed Python research-grade backtest. Smoke output always has promotionEligible=false and cannot be used by the promotion tool.',
      parameters: {
        tier: { type: 'string', enum: ['smoke', 'research', 'walk-forward'], required: true },
        workspace_id: { type: 'string' }, case_id: { type: 'string' }, expected_revision: { type: 'integer' },
        strategy_id: { type: 'string' },
        input: { type: 'object', additionalProperties: true, required: true },
        config: { type: 'object', additionalProperties: true },
        options: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args.tier === 'research' || args.tier === 'walk-forward') {
          const registered = args.workspace_id !== undefined || args.case_id !== undefined
          if (args.tier === 'walk-forward' && !registered) throw new TypeError('walk-forward requires a registered research case')
          let store: ResearchWorkspace | undefined
          let caseId = ''
          let revision = 0
          let registration: Omit<ModelRun, 'id'> | undefined
          if (registered) {
            const root = containedPath(options.runtimeRoot ?? resolve(process.cwd(), '.runtime/finance-data'), 'research', requireRuntimeId(args.workspace_id, 'workspace_id'))
            ensurePlainDirectory(root)
            store = new ResearchWorkspace({ root })
            if (typeof args.case_id !== 'string' || !/^case-[0-9a-f]{64}$/.test(args.case_id)) throw new TypeError('invalid case_id')
            caseId = args.case_id
            const state = store.open(caseId)
            if (state.revision !== args.expected_revision) throw new Error('research revision conflict')
            const model = args.tier === 'walk-forward' ? 'walk-forward' : 'portfolio-backtest'
            const input = object(args.input, 'input')
            const identity = quantCodeIdentity(resolve(options.quantProjectRoot))
            const key = sha256({ model, input, identity })
            const cached = state.modelRuns.find(run => run.model === model && run.parameters.requestHash === key)
            if (cached !== undefined) return jsonSafe({ revision: state.revision, modelRunId: cached.id, replay: true, result: cached.output.status === 'ok' ? cached.output.value : cached.output })
            const start = args.tier === 'walk-forward' ? state.case.createdAt : String(object(input.metadata, 'metadata').startedAt)
            const source = { kind: 'structured' as const, subject: state.case.subject, field: 'frozen-experiment-input', value: input as ResearchJsonObject,
              quality: 'unknown' as const, sourceRef: { provider: 'user', upstream: 'explicit-frozen-input', sourceKind: 'user' as const, retrievedAt: start, hash: sha256(input) },
              limitations: ['Caller supplied input; historical source lineage must be independently verified.'] }
            const sourceId = evidenceId(source)
            registration = { model: `${model}-registration`, version: '1.0.0', inputRefs: [{ kind: 'evidence', id: sourceId }],
              parameters: { requestHash: key, input: input as ResearchJsonObject, ...identity },
              output: { status: 'ok', value: { status: 'registered', testRuns: 0 } }, warnings: [], createdAt: start }
            const prior = state.modelRuns.find(run => run.model === registration!.model && run.parameters.requestHash === key)
            if (prior) throw new Error('experiment was already registered; interrupted test cannot be retried as a fresh holdout')
            const evidenceRevision = state.evidence.some(item => item.id === sourceId) ? state.revision
              : store.appendEvidence(caseId, state.revision, [{ id: sourceId, ...source }]).revision
            revision = store.saveModelRun(caseId, evidenceRevision, { id: modelRunId(registration), ...registration }).revision
          }
          const result = object(await quantBridge(options, args.tier === 'walk-forward' ? 'walk-forward' : 'research-backtest', args.input, exec.signal), 'research result')
          if (args.tier === 'research') {
            assertBacktestRun(result.run)
            if (result.run.engineTier !== 'research') throw new TypeError('research bridge returned a non-research run')
          }
          if (store && registration) {
            canonicalJson(result)
            const run: Omit<ModelRun, 'id'> = { ...registration, model: args.tier === 'walk-forward' ? 'walk-forward' : 'portfolio-backtest',
              inputRefs: [{ kind: 'model-run', id: modelRunId(registration) }], output: { status: 'ok', value: result as ResearchJsonObject } }
            const saved = store.saveModelRun(caseId, revision, { id: modelRunId(run), ...run })
            return jsonSafe({ ...saved, modelRunId: modelRunId(run), replay: false, result })
          }
          return jsonSafe(result)
        }
        if (typeof args.strategy_id !== 'string') throw new TypeError('strategy_id is required for smoke')
        const registry = strategyRegistry()
        return jsonSafe(runSmokeBacktest({
          input: object(args.input, 'input') as unknown as StrategyRunInput,
          strategy: registry.resolveStrategy(args.strategy_id),
          config: (args.config === undefined ? {} : object(args.config, 'config')) as JsonObject,
          options: args.options === undefined ? {} : object(args.options, 'options'),
        }))
      },
    }),
    defineTool({
      name: 'finance_strategy_promotion',
      description: 'Evaluate evidence-only promotion criteria for a research-tier backtest and validation evidence. It never changes strategy registration or trading state and rejects smoke-tier input.',
      parameters: { input: { type: 'object', additionalProperties: true, required: true } },
      output: JSON_OUTPUT,
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = object(args.input, 'input')
        assertBacktestRun(input.researchRun)
        if (input.researchRun.engineTier !== 'research') {
          throw new TypeError('promotion evidence requires a research-tier backtest; smoke is never eligible')
        }
        return jsonSafe(await quantBridge(options, 'promotion', input, exec.signal))
      },
    }),
  ].map(strictTool)
}
