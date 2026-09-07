import { describe, expect, it } from 'vitest'
import { createSignalObservation, stableHash, type SignalObservation } from '@finance2dsh/strategy-core'
import {
  calibrationBucketId,
  createCalibrationSnapshot,
  InMemorySignalLedger,
  type CalibrationBucketDimensions,
  type SignalOutcomeRevisionInput,
} from '@finance2dsh/signal-evaluation'

function observation(index: number, strategy = 'v1', quality: 'high' | 'low' = 'high'): SignalObservation {
  return createSignalObservation({
    strategyId: 'fixture.strategy', strategyHash: stableHash({ strategy }), inputHash: stableHash({ index }),
    snapshotId: `snapshot:${index}`, instrument: { market: 'CN', exchange: 'SSE', symbol: String(600000 + index), assetType: 'equity' },
    signalAt: `2026-01-${String(index + 1).padStart(2, '0')}T07:00:00.000Z`,
    availableAt: `2026-01-${String(index + 1).padStart(2, '0')}T07:00:01.000Z`, configHash: stableHash({}),
    action: 'entry', direction: 'long', confirmationPrice: 10, executionDefinitionId: 'next-tradable-bar-open@1',
    payload: {}, explanation: 'fixture', quality: { level: quality, inputStatus: 'complete', limitations: [] },
  })
}

function matured(item: SignalObservation, value: number, regime = 'bull'): SignalOutcomeRevisionInput {
  return {
    observationId: item.id, horizon: 5, status: 'matured', calculationAt: '2026-03-01T00:00:00.000Z',
    entryAt: '2026-01-20T01:30:00.000Z', maturityAt: '2026-01-27T07:00:00.000Z',
    entryPrice: 10, exitPrice: 10 * (1 + value), instrumentReturn: value, benchmarkReturn: 0.01,
    excessReturn: value - 0.01, mae: -0.02, mfe: Math.max(0, value), directionHit: value > 0,
    regime, dataQuality: item.quality.level, market: item.instrument.market, reason: null,
  }
}

describe('calibration evidence', () => {
  it('groups by strategy hash, horizon, regime, data quality, and market with traceable ids', () => {
    const ledger = new InMemorySignalLedger()
    const first = observation(1)
    const second = observation(2)
    ledger.appendObservation(first)
    ledger.appendObservation(second)
    const firstOutcome = ledger.appendOutcomeRevision(matured(first, 0.1)).record
    const secondOutcome = ledger.appendOutcomeRevision(matured(second, -0.05)).record
    const snapshot = createCalibrationSnapshot(ledger.snapshot(), {
      createdAt: '2026-04-01T00:00:00.000Z', defaultMinimumSamples: 2,
    })
    expect(snapshot.evidenceOnly).toBe(true)
    expect(snapshot).not.toHaveProperty('weights')
    expect(snapshot.buckets).toHaveLength(1)
    expect(snapshot.buckets[0]).toMatchObject({
      totalCount: 2, maturedCount: 2, unavailableCount: 0,
      directionHitRate: { status: 'available', value: 0.5, sampleCount: 2, coverage: 1 },
      averageInstrumentReturn: { status: 'available', value: 0.025, sampleCount: 2, coverage: 1 },
    })
    expect(snapshot.buckets[0]?.observationIds).toEqual([first.id, second.id].sort())
    expect(snapshot.buckets[0]?.outcomeRevisionIds).toEqual([firstOutcome.id, secondOutcome.id].sort())
  })

  it('applies independent per-bucket thresholds and never emits a zero rate for insufficient samples', () => {
    const ledger = new InMemorySignalLedger()
    const v1a = observation(1, 'v1')
    const v1b = observation(2, 'v1')
    const v2 = observation(3, 'v2', 'low')
    for (const [item, value] of [[v1a, 0.1], [v1b, -0.1], [v2, 0.2]] as const) {
      ledger.appendObservation(item)
      ledger.appendOutcomeRevision(matured(item, value))
    }
    const v2Dimensions: CalibrationBucketDimensions = {
      strategy: v2.strategyHash, horizon: 5, regime: 'bull', dataQuality: 'low', market: 'CN',
    }
    const snapshot = createCalibrationSnapshot(ledger.snapshot(), {
      createdAt: '2026-04-01T00:00:00.000Z', defaultMinimumSamples: 2,
      minimumSamplesByBucket: { [calibrationBucketId(v2Dimensions)]: 1 },
    })
    const v1Bucket = snapshot.buckets.find(bucket => bucket.dimensions.strategy === v1a.strategyHash)
    const v2Bucket = snapshot.buckets.find(bucket => bucket.dimensions.strategy === v2.strategyHash)
    expect(v1Bucket?.directionHitRate).toMatchObject({ status: 'available', value: 0.5 })
    expect(v2Bucket?.minimumSamples).toBe(1)
    expect(v2Bucket?.directionHitRate).toMatchObject({ status: 'available', value: 1 })

    const insufficient = createCalibrationSnapshot(ledger.snapshot(), {
      createdAt: '2026-04-01T00:00:00.000Z', defaultMinimumSamples: 3,
    }).buckets.find(bucket => bucket.dimensions.strategy === v1a.strategyHash)
    expect(insufficient?.directionHitRate).toMatchObject({ status: 'insufficient', value: null, sampleCount: 2 })
  })

  it('uses only the latest revision and reports unavailable outcomes without fabricating returns', () => {
    const ledger = new InMemorySignalLedger()
    const item = observation(1)
    ledger.appendObservation(item)
    ledger.appendOutcomeRevision({
      observationId: item.id, horizon: 5, status: 'unable', calculationAt: '2026-02-01T00:00:00.000Z',
      entryAt: null, maturityAt: null, entryPrice: null, exitPrice: null, instrumentReturn: null,
      benchmarkReturn: null, excessReturn: null, mae: null, mfe: null, directionHit: null, regime: 'bull',
      dataQuality: 'high', market: 'CN', reason: 'not mature',
    })
    ledger.appendOutcomeRevision(matured(item, 0.1))
    const bucket = createCalibrationSnapshot(ledger.snapshot(), {
      createdAt: '2026-04-01T00:00:00.000Z', defaultMinimumSamples: 1,
    }).buckets[0]
    expect(bucket).toMatchObject({ totalCount: 1, maturedCount: 1, unavailableCount: 0 })
    expect(bucket?.outcomeRevisionIds).toHaveLength(1)
  })

  it('handles an empty sample deterministically and rejects invalid thresholds', () => {
    const empty = new InMemorySignalLedger().snapshot()
    const first = createCalibrationSnapshot(empty, { createdAt: '2026-04-01T00:00:00.000Z', defaultMinimumSamples: 1 })
    const second = createCalibrationSnapshot(empty, { createdAt: '2026-04-01T00:00:00.000Z', defaultMinimumSamples: 1 })
    expect(first).toEqual(second)
    expect(first.buckets).toEqual([])
    expect(() => createCalibrationSnapshot(empty, { createdAt: '2026-04-01T00:00:00.000Z', defaultMinimumSamples: 0 }))
      .toThrow(/positive integer/)
  })
})
