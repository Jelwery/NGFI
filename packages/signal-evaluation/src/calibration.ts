import { deepFreeze } from '@finance2dsh/strategy-core'

import type {
  CalibrationBucket,
  CalibrationBucketDimensions,
  CalibrationMetric,
  CalibrationOptions,
  CalibrationSnapshot,
  SignalLedgerSnapshot,
  SignalOutcomeRevision,
  SignalOutcomeStatus,
} from './contracts.js'
import { calibrationBucketId, calibrationSnapshotId } from './identity.js'
import { SignalEvaluationError, assertTimestamp } from './validation.js'

function assertThreshold(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new SignalEvaluationError('invalid', `${label} must be a positive integer`)
}

function metric(values: readonly number[], denominator: number, minimumSamples: number, label: string): CalibrationMetric {
  const coverage = denominator === 0 ? 0 : values.length / denominator
  if (values.length < minimumSamples) {
    return {
      status: 'insufficient', value: null, sampleCount: values.length, coverage,
      reason: `${label} requires ${minimumSamples} samples; received ${values.length}`,
    }
  }
  return {
    status: 'available', value: values.reduce((total, value) => total + value, 0) / values.length,
    sampleCount: values.length, coverage,
  }
}

function latestOutcomes(outcomes: readonly SignalOutcomeRevision[]): SignalOutcomeRevision[] {
  const latest = new Map<string, SignalOutcomeRevision>()
  for (const outcome of outcomes) {
    const key = `${outcome.observationId}:${outcome.horizon}`
    const prior = latest.get(key)
    if (prior === undefined || outcome.revision > prior.revision) latest.set(key, outcome)
  }
  return [...latest.values()]
}

export function createCalibrationSnapshot(
  ledger: SignalLedgerSnapshot,
  options: CalibrationOptions,
): CalibrationSnapshot {
  assertTimestamp(options.createdAt, 'createdAt')
  assertThreshold(options.defaultMinimumSamples, 'defaultMinimumSamples')
  for (const [key, threshold] of Object.entries(options.minimumSamplesByBucket ?? {})) {
    assertThreshold(threshold, `minimumSamplesByBucket[${key}]`)
  }
  const observations = new Map(ledger.observations.map(observation => [observation.id, observation]))
  const groups = new Map<string, { dimensions: CalibrationBucketDimensions; outcomes: SignalOutcomeRevision[] }>()
  for (const outcome of latestOutcomes(ledger.outcomeRevisions)) {
    const observation = observations.get(outcome.observationId)
    if (observation === undefined) throw new SignalEvaluationError('corrupt', `outcome has no observation: ${outcome.id}`)
    const dimensions: CalibrationBucketDimensions = {
      strategy: observation.strategyHash, horizon: outcome.horizon, regime: outcome.regime,
      dataQuality: outcome.dataQuality, market: outcome.market,
    }
    const id = calibrationBucketId(dimensions)
    const group = groups.get(id) ?? { dimensions, outcomes: [] }
    group.outcomes.push(outcome)
    groups.set(id, group)
  }

  const buckets: CalibrationBucket[] = [...groups.entries()].map(([id, group]) => {
    const minimumSamples = options.minimumSamplesByBucket?.[id] ?? options.defaultMinimumSamples
    const matured = group.outcomes.filter(outcome => outcome.status === 'matured')
    const values = (selector: (outcome: SignalOutcomeRevision) => number | null): number[] =>
      matured.map(selector).filter((value): value is number => value !== null)
    const statusCounts = Object.fromEntries(
      (['matured', 'unfillable', 'expired', 'unable'] satisfies SignalOutcomeStatus[]).map(status => [
        status, group.outcomes.filter(outcome => outcome.status === status).length,
      ]),
    ) as Record<SignalOutcomeStatus, number>
    return {
      id, dimensions: group.dimensions, minimumSamples, totalCount: group.outcomes.length,
      maturedCount: matured.length, unavailableCount: group.outcomes.length - matured.length, statusCounts,
      directionHitRate: metric(matured.map(outcome => outcome.directionHit ? 1 : 0), matured.length, minimumSamples, 'directionHitRate'),
      averageInstrumentReturn: metric(values(outcome => outcome.instrumentReturn), matured.length, minimumSamples, 'averageInstrumentReturn'),
      averageBenchmarkReturn: metric(values(outcome => outcome.benchmarkReturn), matured.length, minimumSamples, 'averageBenchmarkReturn'),
      averageExcessReturn: metric(values(outcome => outcome.excessReturn), matured.length, minimumSamples, 'averageExcessReturn'),
      averageMae: metric(values(outcome => outcome.mae), matured.length, minimumSamples, 'averageMae'),
      averageMfe: metric(values(outcome => outcome.mfe), matured.length, minimumSamples, 'averageMfe'),
      observationIds: [...new Set(group.outcomes.map(outcome => outcome.observationId))].sort(),
      outcomeRevisionIds: group.outcomes.map(outcome => outcome.id).sort(),
    }
  }).sort((left, right) => left.id.localeCompare(right.id))

  const semantic = {
    createdAt: options.createdAt, defaultMinimumSamples: options.defaultMinimumSamples, buckets, evidenceOnly: true as const,
  }
  return deepFreeze({ id: calibrationSnapshotId(semantic), ...semantic })
}
