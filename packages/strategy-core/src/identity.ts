import { createHash } from 'node:crypto'
import type { InstrumentId } from '@finance2dsh/core'
import type {
  BacktestRun,
  BacktestRunInput,
  ExecutionDefinition,
  JsonObject,
  JsonValue,
  SignalObservation,
  SignalObservationInput,
  StrategyRunInput,
  StrategySpec,
} from './contracts.js'

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

function canonicalize(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('canonical JSON rejects cyclic arrays')
    const next = new Set(ancestors).add(value)
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`canonical JSON rejects sparse arrays at ${index}`)
      items.push(canonicalize(value[index], next))
    }
    return `[${items.join(',')}]`
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError('canonical JSON rejects cyclic objects')
    const object = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON accepts only plain objects')
    }
    const next = new Set(ancestors).add(object)
    return `{${Object.keys(object).sort().map(key => {
      const item = object[key]
      if (item === undefined) throw new TypeError(`canonical JSON rejects undefined at ${key}`)
      return `${JSON.stringify(key)}:${canonicalize(item, next)}`
    }).join(',')}}`
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`)
}

/** RFC 8785-inspired canonical JSON: object keys sort; array order stays semantic. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set())
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

export function isStableHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value)
}

function instrumentIdentity(instrument: InstrumentId): JsonObject {
  return {
    market: instrument.market,
    exchange: instrument.exchange,
    symbol: instrument.symbol,
    assetType: instrument.assetType,
  }
}

/** researchStatus is governance metadata and does not change algorithm semantics. */
export function strategyHash(spec: StrategySpec): string {
  return stableHash({
    id: spec.id,
    version: spec.version,
    horizon: spec.horizon,
    economicAssumption: spec.economicAssumption,
    failureConditions: spec.failureConditions,
    parameters: spec.parameters,
  })
}

export function configHash(config: Readonly<JsonObject>): string {
  return stableHash(config)
}

export function executionDefinitionHash(definition: ExecutionDefinition): string {
  return stableHash(definition)
}

/** Hashes the frozen input values; `asOf` is a validation boundary, not input data. */
export function strategyInputHash(input: StrategyRunInput): string {
  return stableHash({
    instrument: instrumentIdentity(input.instrument),
    interval: input.interval,
    adjustment: input.adjustment,
    snapshotId: input.snapshotId,
    bars: input.bars,
  })
}

function observationIdentity(observation: Omit<SignalObservation, 'id'>): unknown {
  return {
    strategyId: observation.strategyId,
    strategyHash: observation.strategyHash,
    inputHash: observation.inputHash,
    snapshotId: observation.snapshotId,
    instrument: instrumentIdentity(observation.instrument),
    signalAt: observation.signalAt,
    configHash: observation.configHash,
    executionDefinitionId: observation.executionDefinitionId,
  }
}

export function signalObservationId(observation: Omit<SignalObservation, 'id'>): string {
  return stableHash(observationIdentity(observation))
}

function backtestIdentity(run: Omit<BacktestRun, 'id' | 'startedAt' | 'completedAt'>): unknown {
  return {
    engine: run.engine,
    engineVersion: run.engineVersion,
    engineTier: run.engineTier,
    dataset: run.dataset,
    strategyHash: run.strategyHash,
    configHash: run.configHash,
    executionHash: run.executionHash,
    costModel: run.costModel,
    benchmark: run.benchmark.status === 'available'
      ? {
        status: run.benchmark.status,
        instrument: instrumentIdentity(run.benchmark.instrument),
        datasetHash: run.benchmark.datasetHash,
      }
      : run.benchmark,
    metrics: run.metrics,
    artifacts: run.artifacts.map(artifact => ({ kind: artifact.kind, hash: artifact.hash })),
    status: run.status,
    warnings: run.warnings,
  }
}

export function backtestRunId(run: Omit<BacktestRun, 'id'>): string {
  const { startedAt: _startedAt, completedAt: _completedAt, ...identity } = run
  return stableHash(backtestIdentity(identity))
}

function cloneAndFreeze<T extends JsonValue>(value: T): T {
  const clone = JSON.parse(canonicalJson(value)) as T
  return deepFreeze(clone)
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function createSignalObservation(input: SignalObservationInput): SignalObservation {
  const { id: suppliedId, ...semanticInput } = input
  const semantic = cloneAndFreeze(semanticInput as unknown as JsonObject) as unknown as Omit<SignalObservation, 'id'>
  const expectedId = signalObservationId(semantic)
  if (suppliedId !== undefined && suppliedId !== expectedId) {
    throw new TypeError(`signal observation id mismatch: expected ${expectedId}`)
  }
  return deepFreeze({ id: expectedId, ...semantic })
}

export function createBacktestRun(input: BacktestRunInput): BacktestRun {
  const { id: suppliedId, ...runInput } = input
  const semantic = cloneAndFreeze(runInput as unknown as JsonObject) as unknown as Omit<BacktestRun, 'id'>
  const expectedId = backtestRunId(semantic)
  if (suppliedId !== undefined && suppliedId !== expectedId) {
    throw new TypeError(`backtest run id mismatch: expected ${expectedId}`)
  }
  return deepFreeze({ id: expectedId, ...semantic })
}
