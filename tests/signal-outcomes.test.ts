import { describe, expect, it } from 'vitest'
import { createSignalObservation, stableHash, type SignalObservation } from '@finance2dsh/strategy-core'
import {
  InMemorySignalLedger,
  evaluateSignalOutcome,
  type OutcomePriceBar,
  type SignalOutcomeHorizon,
} from '@finance2dsh/signal-evaluation'

function observation(action: 'entry' | 'exit' = 'entry'): SignalObservation {
  return createSignalObservation({
    strategyId: 'fixture.strategy', strategyHash: stableHash({ strategy: 'v1' }), inputHash: stableHash({ bars: 1 }),
    snapshotId: 'snapshot:outcomes', instrument: { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' },
    signalAt: '2026-01-02T07:00:00.000Z', availableAt: '2026-01-02T07:00:01.000Z', configHash: stableHash({}),
    action, direction: action === 'entry' ? 'long' : 'flat', confirmationPrice: 10,
    executionDefinitionId: 'next-tradable-bar-open@1', payload: {}, explanation: 'fixture',
    quality: { level: 'medium', inputStatus: 'complete', limitations: [] },
  })
}

function bars(count = 60): OutcomePriceBar[] {
  return Array.from({ length: count }, (_, index) => {
    const closeAt = new Date(Date.UTC(2026, 0, 4 + index, 7)).toISOString()
    const availableAt = new Date(Date.UTC(2026, 0, 4 + index, 7, 0, 1)).toISOString()
    return { closeAt, availableAt, high: 10.2 + index * 0.1, low: 9.8 + index * 0.05, close: 10 + index * 0.1 }
  })
}

function input(horizon: SignalOutcomeHorizon = 5) {
  return {
    observation: observation(), horizon, calculationAt: '2027-01-01T00:00:00.000Z',
    entry: { status: 'filled' as const, at: '2026-01-03T01:30:00.000Z', price: 10 },
    bars: bars(), regime: 'bull',
    benchmark: { status: 'available' as const, entryPrice: 100, exitPrice: 102 },
  }
}

describe('signal outcome revisions', () => {
  it.each([5, 10, 20, 60] as const)('matures a hand-computed %d trading-day outcome', horizon => {
    const outcome = evaluateSignalOutcome(input(horizon))
    const expectedExit = 10 + (horizon - 1) * 0.1
    expect(outcome).toMatchObject({
      status: 'matured', horizon, entryPrice: 10, exitPrice: expectedExit,
      directionHit: true, reason: null,
    })
    expect(outcome.benchmarkReturn).toBeCloseTo(0.02, 12)
    expect(outcome.instrumentReturn).toBeCloseTo(expectedExit / 10 - 1, 12)
    expect(outcome.excessReturn).toBeCloseTo(expectedExit / 10 - 1.02, 12)
    expect(outcome.mae).toBeCloseTo(-0.02, 12)
    expect(outcome.mfe).toBeCloseTo((10.2 + (horizon - 1) * 0.1) / 10 - 1, 12)
  })

  it.each(['unfillable', 'expired', 'unable'] as const)('keeps every return null for %s entries', status => {
    const outcome = evaluateSignalOutcome({
      ...input(), entry: { status, reason: `${status} fixture` },
    })
    expect(outcome).toMatchObject({ status, reason: `${status} fixture` })
    expect([outcome.entryPrice, outcome.exitPrice, outcome.instrumentReturn, outcome.benchmarkReturn,
      outcome.excessReturn, outcome.mae, outcome.mfe, outcome.directionHit]).toEqual(Array(8).fill(null))
  })

  it('uses null, not zero, when the horizon is incomplete, future-available, or missing', () => {
    const incomplete = evaluateSignalOutcome({ ...input(10), bars: bars(9) })
    expect(incomplete).toMatchObject({ status: 'unable', instrumentReturn: null })

    const future = bars(5)
    future[4] = { ...future[4] as OutcomePriceBar, availableAt: '2028-01-01T00:00:00.000Z' }
    expect(evaluateSignalOutcome({ ...input(), bars: future })).toMatchObject({ status: 'unable', instrumentReturn: null })

    const missing = bars(5)
    missing[2] = { ...missing[2] as OutcomePriceBar, low: null }
    expect(evaluateSignalOutcome({ ...input(), bars: missing })).toMatchObject({ status: 'unable', instrumentReturn: null })
  })

  it('computes direction hit and excursions in the exit signal direction', () => {
    const outcome = evaluateSignalOutcome({ ...input(), observation: observation('exit') })
    expect(outcome.directionHit).toBe(false)
    expect(outcome.mae).toBeLessThan(0)
    expect(outcome.mfe).toBeGreaterThan(0)
  })

  it('appends revisions, preserves history, and deduplicates exact replay', () => {
    const ledger = new InMemorySignalLedger()
    const item = observation()
    ledger.appendObservation(item)
    const unable = evaluateSignalOutcome({ ...input(), observation: item, bars: bars(4) })
    const first = ledger.appendOutcomeRevision(unable)
    expect(first.record.revision).toBe(1)
    expect(ledger.appendOutcomeRevision(unable)).toMatchObject({ appended: false, record: first.record })
    const matured = evaluateSignalOutcome({ ...input(), observation: item })
    const second = ledger.appendOutcomeRevision(matured)
    expect(second.record.revision).toBe(2)
    expect(ledger.outcomesFor(item.id, 5)).toEqual([first.record, second.record])
    expect(ledger.latestOutcomes()).toEqual([second.record])
  })

  it('rejects duplicate dates, invalid values, and entry before availability', () => {
    const duplicate = bars(5)
    duplicate[2] = { ...duplicate[2] as OutcomePriceBar, closeAt: (duplicate[1] as OutcomePriceBar).closeAt }
    expect(() => evaluateSignalOutcome({ ...input(), bars: duplicate })).toThrow(/strictly ordered/)
    expect(() => evaluateSignalOutcome({ ...input(), entry: { status: 'filled', at: '2026-01-03T01:30:00.000Z', price: Number.NaN } }))
      .toThrow(/finite/)
    expect(() => evaluateSignalOutcome({ ...input(), entry: { status: 'filled', at: '2026-01-01T01:30:00.000Z', price: 10 } }))
      .toThrow(/predate/)
  })

  it('stores append-only feedback and rejects unknown observations', () => {
    const ledger = new InMemorySignalLedger()
    const item = observation()
    ledger.appendObservation(item)
    const feedback = {
      observationId: item.id, value: 'helpful' as const, reasonCode: 'clear-entry', note: 'Useful context',
      source: 'user' as const, createdAt: '2026-02-01T00:00:00.000Z',
    }
    expect(ledger.appendFeedback(feedback).appended).toBe(true)
    expect(ledger.appendFeedback(feedback).appended).toBe(false)
    expect(ledger.snapshot().feedback).toHaveLength(1)
    expect(() => ledger.appendFeedback({ ...feedback, observationId: stableHash({ missing: true }) })).toThrow(/not found/)
  })
})
