import type {
  JsonObject,
  SignalObservation,
  SignalQualityLevel,
} from '@finance2dsh/strategy-core'

export const SIGNAL_OUTCOME_HORIZONS = [5, 10, 20, 60] as const
export type SignalOutcomeHorizon = typeof SIGNAL_OUTCOME_HORIZONS[number]

export const SIGNAL_LIFECYCLE_STATES = [
  'observed',
  'qualified',
  'watching',
  'tradeable',
  'retired',
] as const
export type SignalLifecycleState = typeof SIGNAL_LIFECYCLE_STATES[number]
export type SignalLifecycleEventType = Exclude<SignalLifecycleState, 'observed'>

export interface SignalLifecycleEvent {
  readonly id: string
  readonly observationId: string
  readonly type: SignalLifecycleEventType
  readonly actor: string
  readonly occurredAt: string
  readonly payload: Readonly<JsonObject>
}

export interface SignalLifecycleEventInput extends Omit<SignalLifecycleEvent, 'id'> {
  readonly id?: string
}

export interface SignalLifecycleProjection {
  readonly observationId: string
  readonly state: SignalLifecycleState
  readonly eventCount: number
  readonly latestEventId: string | null
  readonly updatedAt: string
}

export const SIGNAL_OUTCOME_STATUSES = ['matured', 'unfillable', 'expired', 'unable'] as const
export type SignalOutcomeStatus = typeof SIGNAL_OUTCOME_STATUSES[number]

export interface OutcomePriceBar {
  readonly closeAt: string
  readonly availableAt: string
  readonly high: number | null
  readonly low: number | null
  readonly close: number | null
}

export type OutcomeEntry =
  | { readonly status: 'filled'; readonly at: string; readonly price: number }
  | { readonly status: Exclude<SignalOutcomeStatus, 'matured'>; readonly reason: string }

export type OutcomeBenchmark =
  | { readonly status: 'available'; readonly entryPrice: number; readonly exitPrice: number }
  | { readonly status: 'missing' | 'unable'; readonly reason: string }

export interface EvaluateSignalOutcomeInput {
  readonly observation: SignalObservation
  readonly horizon: SignalOutcomeHorizon
  readonly calculationAt: string
  readonly entry: OutcomeEntry
  readonly bars: readonly OutcomePriceBar[]
  readonly benchmark?: OutcomeBenchmark
  /** Externally supplied overlay; it never selects or mutates a strategy. */
  readonly regime: string
}

export interface SignalOutcomeRevision {
  readonly id: string
  readonly observationId: string
  readonly horizon: SignalOutcomeHorizon
  readonly revision: number
  readonly status: SignalOutcomeStatus
  readonly calculationAt: string
  readonly entryAt: string | null
  readonly maturityAt: string | null
  readonly entryPrice: number | null
  readonly exitPrice: number | null
  /** Raw instrument return over the horizon, before interpreting signal direction. */
  readonly instrumentReturn: number | null
  readonly benchmarkReturn: number | null
  readonly excessReturn: number | null
  /** Maximum adverse/favourable excursion in the signal's expected direction. */
  readonly mae: number | null
  readonly mfe: number | null
  readonly directionHit: boolean | null
  readonly regime: string
  readonly dataQuality: SignalQualityLevel
  readonly market: string
  readonly reason: string | null
}

export type SignalOutcomeRevisionInput = Omit<SignalOutcomeRevision, 'id' | 'revision'>

export const SIGNAL_FEEDBACK_VALUES = ['helpful', 'not-helpful', 'incorrect', 'other'] as const
export type SignalFeedbackValue = typeof SIGNAL_FEEDBACK_VALUES[number]

export interface SignalFeedback {
  readonly id: string
  readonly observationId: string
  readonly value: SignalFeedbackValue
  readonly reasonCode: string | null
  readonly note: string | null
  readonly source: 'user' | 'system'
  readonly createdAt: string
}

export interface SignalFeedbackInput extends Omit<SignalFeedback, 'id'> {
  readonly id?: string
}

export interface AppendRecordResult<T> {
  readonly appended: boolean
  readonly record: T
}

export interface SignalLedgerSnapshot {
  readonly observations: readonly SignalObservation[]
  readonly lifecycleEvents: readonly SignalLifecycleEvent[]
  readonly outcomeRevisions: readonly SignalOutcomeRevision[]
  readonly feedback: readonly SignalFeedback[]
}

export interface SignalLedger {
  appendObservation(observation: SignalObservation): AppendRecordResult<SignalObservation>
  appendLifecycleEvent(input: SignalLifecycleEventInput): AppendRecordResult<SignalLifecycleEvent>
  appendOutcomeRevision(input: SignalOutcomeRevisionInput): AppendRecordResult<SignalOutcomeRevision>
  appendFeedback(input: SignalFeedbackInput): AppendRecordResult<SignalFeedback>
  getObservation(observationId: string): SignalObservation | undefined
  projectLifecycle(observationId: string): SignalLifecycleProjection | undefined
  outcomesFor(observationId: string, horizon?: SignalOutcomeHorizon): readonly SignalOutcomeRevision[]
  latestOutcomes(): readonly SignalOutcomeRevision[]
  snapshot(): SignalLedgerSnapshot
}

export const CALIBRATION_DIMENSIONS = [
  'strategy',
  'horizon',
  'regime',
  'dataQuality',
  'market',
] as const

export interface CalibrationBucketDimensions {
  readonly strategy: string
  readonly horizon: SignalOutcomeHorizon
  readonly regime: string
  readonly dataQuality: SignalQualityLevel
  readonly market: string
}

export type CalibrationMetric =
  | { readonly status: 'available'; readonly value: number; readonly sampleCount: number; readonly coverage: number }
  | { readonly status: 'insufficient'; readonly value: null; readonly sampleCount: number; readonly coverage: number; readonly reason: string }

export interface CalibrationBucket {
  readonly id: string
  readonly dimensions: CalibrationBucketDimensions
  readonly minimumSamples: number
  readonly totalCount: number
  readonly maturedCount: number
  readonly unavailableCount: number
  readonly statusCounts: Readonly<Record<SignalOutcomeStatus, number>>
  readonly directionHitRate: CalibrationMetric
  readonly averageInstrumentReturn: CalibrationMetric
  readonly averageBenchmarkReturn: CalibrationMetric
  readonly averageExcessReturn: CalibrationMetric
  readonly averageMae: CalibrationMetric
  readonly averageMfe: CalibrationMetric
  readonly observationIds: readonly string[]
  readonly outcomeRevisionIds: readonly string[]
}

export interface CalibrationSnapshot {
  readonly id: string
  readonly createdAt: string
  readonly defaultMinimumSamples: number
  readonly buckets: readonly CalibrationBucket[]
  readonly evidenceOnly: true
}

export interface CalibrationOptions {
  readonly createdAt: string
  readonly defaultMinimumSamples: number
  /** Keys are produced by calibrationBucketId(dimensions). */
  readonly minimumSamplesByBucket?: Readonly<Record<string, number>>
}
