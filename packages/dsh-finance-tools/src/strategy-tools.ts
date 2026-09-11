import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
import { containedPath, requireRuntimeId, strictTool } from './runtime-store.js'

const MAX_BRIDGE_BYTES = 8 * 1024 * 1024

export const STRATEGY_TOOL_NAMES = [
  'finance_strategy_registry',
  'finance_strategy_backtest',
  'finance_strategy_promotion',
  'finance_quant_research',
] as const

export interface StrategyToolOptions {
  quantProjectRoot: string
  uvExecutable?: string
  runtimeRoot?: string
}

export function resolveQuantUvExecutable(options: StrategyToolOptions): string {
  if (options.uvExecutable !== undefined) return options.uvExecutable
  const localUv = resolve(options.quantProjectRoot, '../../.runtime/python-tools/bin/uv')
  return existsSync(localUv) ? localUv : 'uv'
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

async function quantBridge(
  options: StrategyToolOptions, operation: 'research-backtest' | 'promotion' | 'experiment', input: unknown,
  signal?: AbortSignal, storeRoot?: string,
) {
  signal?.throwIfAborted()
  const project = resolve(options.quantProjectRoot)
  const payload = JSON.stringify(input)
  if (Buffer.byteLength(payload) > MAX_BRIDGE_BYTES) throw new RangeError('quant research input exceeds 8 MiB')
  const executable = resolveQuantUvExecutable(options)
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(executable, ['run', '--project', project, '--frozen', '--offline', 'python', '-m', 'ngfi_quant.agent_bridge', operation], {
      cwd: project, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH,
        UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? resolve(project, '.uv-cache'),
        PYTHONDONTWRITEBYTECODE: '1',
        NGFI_QUANT_STORE: storeRoot,
        OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1',
      },
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let errorBytes = 0
    let timedOut = false
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error)
      }
    }
    const timeout = setTimeout(() => { timedOut = true; terminate('SIGKILL') }, 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BRIDGE_BYTES) terminate('SIGKILL')
      else output.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length
      if (errorBytes <= 64 * 1024) errors.push(chunk)
    })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', status => {
      clearTimeout(timeout)
      if (signal?.aborted) reject(new Error('quant research aborted'))
      else if (timedOut) reject(new Error('quant research exceeded 120 seconds; use the offline CLI for larger runs'))
      else if (bytes > MAX_BRIDGE_BYTES) reject(new Error('quant research output exceeds 8 MiB'))
      else if (status !== 0) reject(new Error(`quant research bridge failed: ${Buffer.concat(errors).toString('utf8').trim()}`))
      else resolveOutput(Buffer.concat(output).toString('utf8'))
    })
    const abort = () => terminate('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.once('close', () => signal?.removeEventListener('abort', abort))
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error) })
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
        tier: { type: 'string', enum: ['smoke', 'research'], required: true },
        strategy_id: { type: 'string' },
        input: { type: 'object', additionalProperties: true, required: true },
        config: { type: 'object', additionalProperties: true },
        options: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args.tier === 'research') {
          const result = object(await quantBridge(options, 'research-backtest', args.input, exec.signal), 'research result')
          assertBacktestRun(result.run)
          if (result.run.engineTier !== 'research') throw new TypeError('research bridge returned a non-research run')
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
    defineTool({
      name: 'finance_quant_research',
      description: 'Run native NGFI daily cross-sectional research: inspect catalog/schema, import a frozen PIT dataset, run versioned factor graphs through purged rolling ML, constrained portfolio optimization and next-open replay, or inspect immutable results by ID. Research only: no source execution, arbitrary paths, providers or live orders. Imports are capped at 8 MiB; larger datasets use the operator CLI. Never invent market data, historical membership or availability timestamps.',
      parameters: {
        action: { type: 'string', enum: ['catalog', 'schema', 'import', 'run', 'get', 'list'], required: true },
        workspace_id: { type: 'string', description: 'Required except for catalog/schema; safe local research workspace ID.' },
        dataset: { type: 'object', additionalProperties: true },
        dataset_id: { type: 'string' },
        spec: { type: 'object', additionalProperties: true },
        run_id: { type: 'string' },
        section: { type: 'string', enum: ['summary', 'spec', 'models', 'predictions', 'factors', 'diagnostics', 'factorSummary', 'correlations', 'modelDiagnostics', 'equity', 'orders', 'fills', 'decisions', 'benchmark'] },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 125_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const workspace = ['catalog', 'schema'].includes(args.action) ? 'catalog' : requireRuntimeId(args.workspace_id, 'workspace_id')
        const root = options.runtimeRoot ?? resolve(options.quantProjectRoot, '../../.runtime/finance-data')
        const store = containedPath(root, 'quant-research', workspace)
        const payload: Record<string, unknown> = { action: args.action }
        for (const [source, target] of [
          ['dataset', 'dataset'], ['dataset_id', 'datasetId'], ['spec', 'spec'],
          ['run_id', 'runId'], ['section', 'section'], ['offset', 'offset'], ['limit', 'limit'],
        ] as const) {
          if (args[source] !== undefined) payload[target] = args[source]
        }
        return jsonSafe(await quantBridge(options, 'experiment', payload, exec.signal, store))
      },
    }),
  ].map(strictTool)
}
