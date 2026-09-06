import {
  assertSignalObservation,
  canonicalJson,
  isStableHash,
  type JsonObject,
} from '@finance2dsh/strategy-core'

import {
  SIGNAL_FEEDBACK_VALUES,
  SIGNAL_LIFECYCLE_STATES,
  SIGNAL_OUTCOME_HORIZONS,
  SIGNAL_OUTCOME_STATUSES,
  type OutcomePriceBar,
  type SignalFeedback,
  type SignalLifecycleEvent,
  type SignalOutcomeRevision,
} from './contracts.js'
import { feedbackId, lifecycleEventId, outcomeRevisionId } from './identity.js'

export class SignalEvaluationError extends TypeError {
  constructor(
    readonly code: 'invalid' | 'conflict' | 'not-found' | 'transition' | 'corrupt' | 'locked',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SignalEvaluationError'
  }
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new SignalEvaluationError('invalid', `${label} must be a valid timestamp`)
  }
}

export function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SignalEvaluationError('invalid', `${label} must be a non-empty string`)
  }
}

export function assertFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SignalEvaluationError('invalid', `${label} must be finite`)
  }
}

export function assertPositive(value: unknown, label: string): asserts value is number {
  assertFinite(value, label)
  if (value <= 0) throw new SignalEvaluationError('invalid', `${label} must be positive`)
}

function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalEvaluationError('invalid', `${label} must be a JSON object`)
  }
  try { canonicalJson(value) } catch (error) {
    throw new SignalEvaluationError('invalid', `${label} must be JSON-safe`, { cause: error })
  }
}

export function assertOutcomeHorizon(value: unknown): asserts value is SignalOutcomeRevision['horizon'] {
  if (!SIGNAL_OUTCOME_HORIZONS.includes(value as never)) {
    throw new SignalEvaluationError('invalid', `horizon must be one of ${SIGNAL_OUTCOME_HORIZONS.join(', ')}`)
  }
}

export function assertLifecycleEvent(value: unknown): asserts value is SignalLifecycleEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalEvaluationError('invalid', 'lifecycle event must be an object')
  }
  const event = value as Record<string, unknown>
  if (!isStableHash(event.id)) throw new SignalEvaluationError('invalid', 'lifecycle event id is invalid')
  if (!isStableHash(event.observationId)) throw new SignalEvaluationError('invalid', 'observationId is invalid')
  if (!SIGNAL_LIFECYCLE_STATES.includes(event.type as never) || event.type === 'observed') {
    throw new SignalEvaluationError('invalid', 'lifecycle event type is invalid')
  }
  assertNonEmpty(event.actor, 'actor')
  assertTimestamp(event.occurredAt, 'occurredAt')
  assertJsonObject(event.payload, 'payload')
  const { id: _id, ...semantic } = event
  if (event.id !== lifecycleEventId(semantic as unknown as Omit<SignalLifecycleEvent, 'id'>)) {
    throw new SignalEvaluationError('corrupt', 'lifecycle event id does not match its content')
  }
}

function nullableFinite(value: unknown, label: string): void {
  if (value !== null) assertFinite(value, label)
}

export function assertOutcomeRevision(value: unknown): asserts value is SignalOutcomeRevision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalEvaluationError('invalid', 'outcome revision must be an object')
  }
  const outcome = value as unknown as SignalOutcomeRevision
  if (!isStableHash(outcome.id) || !isStableHash(outcome.observationId)) {
    throw new SignalEvaluationError('invalid', 'outcome ids are invalid')
  }
  assertOutcomeHorizon(outcome.horizon)
  if (!Number.isInteger(outcome.revision) || outcome.revision < 1) {
    throw new SignalEvaluationError('invalid', 'outcome revision must be a positive integer')
  }
  if (!SIGNAL_OUTCOME_STATUSES.includes(outcome.status)) {
    throw new SignalEvaluationError('invalid', 'outcome status is invalid')
  }
  assertTimestamp(outcome.calculationAt, 'calculationAt')
  if (outcome.entryAt !== null) assertTimestamp(outcome.entryAt, 'entryAt')
  if (outcome.maturityAt !== null) assertTimestamp(outcome.maturityAt, 'maturityAt')
  for (const [label, item] of Object.entries({
    entryPrice: outcome.entryPrice, exitPrice: outcome.exitPrice, instrumentReturn: outcome.instrumentReturn,
    benchmarkReturn: outcome.benchmarkReturn, excessReturn: outcome.excessReturn, mae: outcome.mae, mfe: outcome.mfe,
  })) nullableFinite(item, label)
  if (outcome.directionHit !== null && typeof outcome.directionHit !== 'boolean') {
    throw new SignalEvaluationError('invalid', 'directionHit must be boolean or null')
  }
  assertNonEmpty(outcome.regime, 'regime')
  assertNonEmpty(outcome.market, 'market')
  if (!['unknown', 'low', 'medium', 'high'].includes(outcome.dataQuality)) {
    throw new SignalEvaluationError('invalid', 'dataQuality is invalid')
  }
  if (outcome.status === 'matured') {
    const required = [outcome.entryAt, outcome.maturityAt, outcome.entryPrice, outcome.exitPrice,
      outcome.instrumentReturn, outcome.mae, outcome.mfe, outcome.directionHit]
    if (required.some(item => item === null) || outcome.reason !== null) {
      throw new SignalEvaluationError('invalid', 'matured outcome is incomplete')
    }
  } else {
    const nullable = [outcome.entryAt, outcome.maturityAt, outcome.entryPrice, outcome.exitPrice,
      outcome.instrumentReturn, outcome.benchmarkReturn, outcome.excessReturn, outcome.mae, outcome.mfe,
      outcome.directionHit]
    if (nullable.some(item => item !== null) || typeof outcome.reason !== 'string' || outcome.reason.length === 0) {
      throw new SignalEvaluationError('invalid', 'non-matured outcome must contain null results and a reason')
    }
  }
  const { id: _id, ...semantic } = outcome
  if (outcome.id !== outcomeRevisionId(semantic)) {
    throw new SignalEvaluationError('corrupt', 'outcome revision id does not match its content')
  }
}

export function assertSignalFeedback(value: unknown): asserts value is SignalFeedback {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalEvaluationError('invalid', 'feedback must be an object')
  }
  const feedback = value as unknown as SignalFeedback
  if (!isStableHash(feedback.id) || !isStableHash(feedback.observationId)) {
    throw new SignalEvaluationError('invalid', 'feedback ids are invalid')
  }
  if (!SIGNAL_FEEDBACK_VALUES.includes(feedback.value)) throw new SignalEvaluationError('invalid', 'feedback value is invalid')
  if (feedback.reasonCode !== null) assertNonEmpty(feedback.reasonCode, 'reasonCode')
  if (feedback.note !== null) assertNonEmpty(feedback.note, 'note')
  if (feedback.source !== 'user' && feedback.source !== 'system') throw new SignalEvaluationError('invalid', 'feedback source is invalid')
  assertTimestamp(feedback.createdAt, 'createdAt')
  const { id: _id, ...semantic } = feedback
  if (feedback.id !== feedbackId(semantic)) throw new SignalEvaluationError('corrupt', 'feedback id does not match its content')
}

export function assertOutcomePriceBars(bars: readonly OutcomePriceBar[], calculationAt: string): void {
  assertTimestamp(calculationAt, 'calculationAt')
  let previous = Number.NEGATIVE_INFINITY
  for (const [index, bar] of bars.entries()) {
    assertTimestamp(bar.closeAt, `bars[${index}].closeAt`)
    assertTimestamp(bar.availableAt, `bars[${index}].availableAt`)
    const closeAt = Date.parse(bar.closeAt)
    if (closeAt <= previous) throw new SignalEvaluationError('invalid', 'outcome bars must be strictly ordered without duplicates')
    previous = closeAt
    for (const [field, item] of Object.entries({ high: bar.high, low: bar.low, close: bar.close })) {
      if (item !== null) assertPositive(item, `bars[${index}].${field}`)
    }
    if (bar.high !== null && bar.low !== null && bar.high < bar.low) {
      throw new SignalEvaluationError('invalid', `bars[${index}] high is below low`)
    }
    if (bar.close !== null && bar.high !== null && bar.close > bar.high) {
      throw new SignalEvaluationError('invalid', `bars[${index}] close is above high`)
    }
    if (bar.close !== null && bar.low !== null && bar.close < bar.low) {
      throw new SignalEvaluationError('invalid', `bars[${index}] close is below low`)
    }
  }
}

export function assertObservation(value: unknown): asserts value is import('@finance2dsh/strategy-core').SignalObservation {
  const executionDefinitionId = value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>).executionDefinitionId
    : undefined
  const executionDefinitionIds = typeof executionDefinitionId === 'string' ? [executionDefinitionId] : []
  try { assertSignalObservation(value, { executionDefinitionIds }) } catch (error) {
    throw new SignalEvaluationError('invalid', 'SignalObservation validation failed', { cause: error })
  }
}
