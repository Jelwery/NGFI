import type { AdjustmentMode, InstrumentId } from '@finance2dsh/core'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export const STRATEGY_RESEARCH_STATUSES = [
  'experimental',
  'candidate',
  'shadow',
  'approved',
  'retired',
  'rejected',
] as const

export type StrategyResearchStatus = typeof STRATEGY_RESEARCH_STATUSES[number]

export type StrategyHorizonUnit = 'bars' | 'trading-days' | 'calendar-days'

export interface StrategyHorizon {
  readonly unit: StrategyHorizonUnit
  readonly min: number
  readonly max: number
}

interface ParameterBase {
  readonly key: string
  readonly description?: string
}

export interface NumberParameterSpec extends ParameterBase {
  readonly type: 'number'
  readonly default: number
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly integer?: boolean
}

export interface BooleanParameterSpec extends ParameterBase {
  readonly type: 'boolean'
  readonly default: boolean
}

export interface StringParameterSpec extends ParameterBase {
  readonly type: 'string'
  readonly default: string
  readonly allowedValues: readonly string[]
}

export type StrategyParameterSpec =
  | NumberParameterSpec
  | BooleanParameterSpec
  | StringParameterSpec

export interface StrategySpec {
  readonly id: string
  readonly version: string
  readonly horizon: StrategyHorizon
  readonly economicAssumption: string
  readonly failureConditions: readonly string[]
  readonly parameters: readonly StrategyParameterSpec[]
  /** Governance metadata. It is intentionally excluded from strategyHash. */
  readonly researchStatus: StrategyResearchStatus
}

/**
 * Provider-neutral OHLCV input for deterministic strategy code. Null values are
 * explicit gaps and must never be coerced to zero. `availableAt` is the PIT
 * boundary at which this bar could first be consumed.
 */
export interface CanonicalBar {
  readonly openAt: string
  readonly closeAt: string
  readonly availableAt: string
  readonly open: number | null
  readonly high: number | null
  readonly low: number | null
  readonly close: number | null
  readonly volume: number | null
  readonly turnover?: number | null
}

export interface StrategyRunInput {
  readonly instrument: InstrumentId
  readonly interval: string
  readonly adjustment: AdjustmentMode
  readonly snapshotId: string
  /** Latest information time the caller permits this evaluation to observe. */
  readonly asOf: string
  readonly bars: readonly CanonicalBar[]
}

export type SignalAction = 'entry' | 'exit'
export type SignalDirection = 'long' | 'flat'
export type SignalQualityLevel = 'unknown' | 'low' | 'medium' | 'high'
export type SignalInputStatus = 'complete' | 'partial' | 'stale' | 'insufficient'

export interface SignalQuality {
  readonly level: SignalQualityLevel
  readonly inputStatus: SignalInputStatus
  readonly limitations: readonly string[]
}

export interface SignalObservation {
  readonly id: string
  readonly strategyId: string
  readonly strategyHash: string
  readonly inputHash: string
  readonly snapshotId: string
  readonly instrument: InstrumentId
  /** Time at which the strategy condition is confirmed. */
  readonly signalAt: string
  /** Earliest time at which all inputs needed for this observation were available. */
  readonly availableAt: string
  readonly configHash: string
  readonly action: SignalAction
  readonly direction: SignalDirection
  /** Confirmation price for audit/display; never the assumed execution price. */
  readonly confirmationPrice: number
  readonly executionDefinitionId: string
  readonly payload: Readonly<JsonObject>
  readonly explanation: string
  readonly quality: SignalQuality
}

export interface SignalObservationInput extends Omit<SignalObservation, 'id'> {
  readonly id?: string
}

export const EXECUTION_CONFIRMATION_TIMES = ['bar-close'] as const
export type ExecutionConfirmationTime = typeof EXECUTION_CONFIRMATION_TIMES[number]

export const EXECUTION_EARLIEST_FILL_TIMES = ['next-tradable-bar-open'] as const
export type ExecutionEarliestFillTime = typeof EXECUTION_EARLIEST_FILL_TIMES[number]

export const EXECUTION_PRICE_FIELDS = ['open'] as const
export type ExecutionPriceField = typeof EXECUTION_PRICE_FIELDS[number]

/** Versioned execution semantics referenced by observations and backtests. */
export interface ExecutionDefinition {
  readonly id: string
  readonly version: string
  readonly confirmationTime: ExecutionConfirmationTime
  readonly earliestFillTime: ExecutionEarliestFillTime
  readonly priceField: ExecutionPriceField
  readonly unfillableConditions: readonly string[]
}

export const NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1: ExecutionDefinition = Object.freeze({
  id: 'next-tradable-bar-open@1',
  version: '1.0.0',
  confirmationTime: 'bar-close',
  earliestFillTime: 'next-tradable-bar-open',
  priceField: 'open',
  unfillableConditions: Object.freeze([
    'No later tradable bar exists in the evaluated dataset.',
    'The next bar has no finite opening price.',
    'The venue marks the instrument suspended or otherwise not tradable.',
    'A venue price-limit rule prevents the requested fill.',
  ]),
})

export interface StrategyEvaluationContext extends StrategyRunInput {
  readonly strategyHash: string
  readonly inputHash: string
  readonly configHash: string
  readonly executionDefinition: ExecutionDefinition
}

export interface StrategyDefinition {
  readonly kind: 'strategy'
  readonly spec: StrategySpec
  readonly executionDefinitionId: string
  /** Pure, deterministic, IO-free evaluation of one instrument's ordered bars. */
  evaluate(
    context: StrategyEvaluationContext,
    config: Readonly<JsonObject>,
  ): readonly SignalObservation[]
}

export interface ScreenerMatch {
  readonly payload: Readonly<JsonObject>
  readonly explanation: string
  readonly quality: SignalQuality
}

export interface ScreenerEvaluationContext extends StrategyRunInput {
  readonly asOf: string
  readonly inputHash: string
  readonly configHash: string
  readonly screenerHash: string
}

export interface ScreenerDefinition {
  readonly kind: 'screener'
  readonly spec: StrategySpec
  /** Point-in-time match only. A screener has no entry/exit or execution semantics. */
  evaluate(
    context: ScreenerEvaluationContext,
    config: Readonly<JsonObject>,
  ): ScreenerMatch | null
}

export type StrategyPluginDefinition = StrategyDefinition | ScreenerDefinition

export const BACKTEST_ENGINE_TIERS = ['smoke', 'research'] as const
export type BacktestEngineTier = typeof BACKTEST_ENGINE_TIERS[number]

export const BACKTEST_RUN_STATUSES = ['complete', 'partial', 'failed', 'insufficient'] as const
export type BacktestRunStatus = typeof BACKTEST_RUN_STATUSES[number]

export const QUANT_RESULT_STATUSES = [
  'available',
  'missing',
  'unfillable',
  'insufficient',
  'not-meaningful',
  'error',
] as const
export type QuantResultStatus = typeof QUANT_RESULT_STATUSES[number]

export type BacktestMetric =
  | { readonly status: 'available'; readonly value: number; readonly unit: string }
  | {
    readonly status: Exclude<QuantResultStatus, 'available'>
    readonly value: null
    readonly reason: string
  }

export interface BacktestDatasetRef {
  readonly snapshotId: string
  readonly hash: string
  readonly asOf?: string
}

export interface BacktestCostModelRef {
  readonly id: string
  readonly version: string
  readonly hash: string
  readonly parameters?: Readonly<JsonObject>
}

export type BacktestBenchmarkRef =
  | {
    readonly status: 'available'
    readonly instrument: InstrumentId
    readonly datasetHash: string
  }
  | {
    readonly status: Exclude<QuantResultStatus, 'available' | 'unfillable'>
    readonly reason: string
  }

export interface BacktestArtifactRef {
  readonly kind: string
  readonly ref: string
  readonly hash: string
}

export interface BacktestRun {
  readonly id: string
  readonly engine: string
  readonly engineVersion: string
  readonly engineTier: BacktestEngineTier
  readonly dataset: BacktestDatasetRef
  readonly strategyHash: string
  readonly configHash: string
  readonly executionHash: string
  readonly costModel: BacktestCostModelRef
  readonly benchmark: BacktestBenchmarkRef
  readonly metrics: Readonly<Record<string, BacktestMetric>>
  readonly artifacts: readonly BacktestArtifactRef[]
  readonly status: BacktestRunStatus
  readonly warnings: readonly string[]
  readonly startedAt: string
  readonly completedAt: string
}

export interface BacktestRunInput extends Omit<BacktestRun, 'id'> {
  readonly id?: string
}
