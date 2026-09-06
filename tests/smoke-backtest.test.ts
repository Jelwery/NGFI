import { describe, expect, it } from 'vitest'
import type { InstrumentId } from '@finance2dsh/core'
import {
  NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1,
  StrategyValidationError,
  createSignalObservation,
  runSmokeBacktest,
  type CanonicalBar,
  type JsonObject,
  type StrategyDefinition,
} from '@finance2dsh/strategy-core'

const instrument: InstrumentId = {
  market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity',
}

function makeBars(opens = [100, 103, 107, 111, 113, 108, 103, 107, 110, 111]): CanonicalBar[] {
  const closes = [102, 106, 110, 114, 109, 104, 106, 111, 112, 107]
  return opens.map((open, index) => {
    const date = `2026-01-${String(index + 1).padStart(2, '0')}`
    const close = closes[index] as number
    return {
      openAt: `${date}T01:30:00.000Z`,
      closeAt: `${date}T07:00:00.000Z`,
      availableAt: `${date}T07:00:01.000Z`,
      open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close,
      volume: 1_000 + index * 100,
    }
  })
}

function input(bars = makeBars()) {
  return {
    instrument, interval: '1d', adjustment: 'none' as const, snapshotId: 'snapshot:smoke-golden-v1',
    asOf: '2026-01-10T08:00:00.000Z', bars,
  }
}

function strategy(signalIndexes: readonly number[]): StrategyDefinition {
  return {
    kind: 'strategy',
    spec: {
      id: 'test.smoke', version: '1.0.0', horizon: { unit: 'bars', min: 1, max: 20 },
      economicAssumption: 'Fixture signals exercise deterministic next-open execution.',
      failureConditions: ['This fixture is not an investment strategy.'],
      parameters: [], researchStatus: 'experimental',
    },
    executionDefinitionId: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id,
    evaluate(context, _config) {
      return signalIndexes.map((barIndex, signalIndex) => {
        const bar = context.bars[barIndex] as CanonicalBar
        const action = signalIndex % 2 === 0 ? 'entry' : 'exit'
        return createSignalObservation({
          strategyId: this.spec.id,
          strategyHash: context.strategyHash,
          inputHash: context.inputHash,
          snapshotId: context.snapshotId,
          instrument: context.instrument,
          signalAt: bar.closeAt,
          availableAt: bar.availableAt,
          configHash: context.configHash,
          action,
          direction: action === 'entry' ? 'long' : 'flat',
          confirmationPrice: bar.close as number,
          executionDefinitionId: context.executionDefinition.id,
          payload: { barIndex },
          explanation: `${action} fixture`,
          quality: { level: 'high', inputStatus: 'complete', limitations: [] },
        })
      })
    },
  }
}

describe('smoke backtest', () => {
  it('locks next-open fills, fees, trades, equity, and metrics with a golden case', () => {
    const result = runSmokeBacktest({
      input: input(), strategy: strategy([1, 3]), options: { initialCapital: 100_000, feeRate: 0.001 },
    })
    const expectedReturn = (113 / 107) * (0.999 / 1.001) - 1

    expect(result.engineTier).toBe('smoke')
    expect(result.promotionEligible).toBe(false)
    expect(result.run.engineTier).toBe('smoke')
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0]).toMatchObject({
      entryBarIndex: 2, entryRawPrice: 107, entryPrice: 107,
      exitBarIndex: 4, exitRawPrice: 113, exitPrice: 113, holdingBars: 2,
    })
    expect(result.trades[0]?.returnRatio).toBeCloseTo(expectedReturn, 12)
    expect(result.finalCapital).toBeCloseTo(100_000 * (1 + expectedReturn), 8)
    expect(result.metrics.totalReturn).toEqual(expect.objectContaining({ status: 'available', unit: 'ratio' }))
    expect(result.metrics.totalReturn.status === 'available' && result.metrics.totalReturn.value)
      .toBeCloseTo(expectedReturn, 12)
    expect(result.metrics.winRate).toEqual({ status: 'available', value: 1, unit: 'ratio' })
    expect(result.metrics.profitFactor.status).toBe('not-meaningful')
    expect(result.metrics.exposure).toEqual({ status: 'available', value: 0.2, unit: 'ratio' })
    expect(result.metrics.maxDrawdown.status).toBe('available')
    expect(result.metrics.sharpe.status).toBe('available')
    expect(result.terminalPosition.status).toBe('cash')
    expect(result.unfilledSignals).toEqual([])
  })

  it('applies adverse slippage on both sides', () => {
    const result = runSmokeBacktest({
      input: input(), strategy: strategy([1, 3]),
      options: { initialCapital: 10_000, feeRate: 0, slippageRate: 0.01 },
    })
    expect(result.trades[0]?.entryPrice).toBeCloseTo(107 * 1.01)
    expect(result.trades[0]?.exitPrice).toBeCloseTo(113 * 0.99)
  })

  it('keeps a terminal position open and values it at net final-close liquidation', () => {
    const result = runSmokeBacktest({ input: input(), strategy: strategy([1]), options: { feeRate: 0.001 } })
    expect(result.trades).toEqual([])
    expect(result.terminalPosition).toMatchObject({
      status: 'open', entryBarIndex: 2, valuationMode: 'net-liquidation-at-final-close', valuationClose: 107,
    })
    expect(result.finalCapital).not.toBeNull()
    expect(result.run.warnings).toContain('The final position remains open; final equity is a net-liquidation estimate.')
  })

  it('reports a final-bar signal as unfilled instead of executing it', () => {
    const result = runSmokeBacktest({ input: input(), strategy: strategy([9]) })
    expect(result.trades).toEqual([])
    expect(result.terminalPosition.status).toBe('cash')
    expect(result.run.status).toBe('partial')
    expect(result.unfilledSignals).toEqual([expect.objectContaining({ reason: 'no-next-bar', signalBarIndex: 9 })])
  })

  it('reports missing next-open fills and does not seek a later bar', () => {
    const bars = makeBars()
    bars[2] = { ...bars[2] as CanonicalBar, open: null }
    const result = runSmokeBacktest({ input: input(bars), strategy: strategy([1]) })
    expect(result.unfilledSignals).toEqual([expect.objectContaining({ reason: 'next-open-missing' })])
    expect(result.terminalPosition).toEqual({ status: 'cash', cash: 100_000 })
    expect(result.run.status).toBe('partial')
  })

  it('rejects unordered, duplicate, invalid OHLC, and non-finite bars', () => {
    const valid = makeBars()
    const unordered = [...valid]
    unordered[2] = { ...unordered[2] as CanonicalBar, openAt: (unordered[1] as CanonicalBar).openAt }
    expect(() => runSmokeBacktest({ input: input(unordered), strategy: strategy([]) }))
      .toThrow(StrategyValidationError)

    const invalidOhlc = [...valid]
    invalidOhlc[0] = { ...invalidOhlc[0] as CanonicalBar, high: 90 }
    expect(() => runSmokeBacktest({ input: input(invalidOhlc), strategy: strategy([]) }))
      .toThrow(StrategyValidationError)

    const nonFinite = [...valid]
    nonFinite[0] = { ...nonFinite[0] as CanonicalBar, close: Number.NaN }
    expect(() => runSmokeBacktest({ input: input(nonFinite), strategy: strategy([]) }))
      .toThrow(StrategyValidationError)
  })

  it('rejects invalid costs and remains deterministic without mutating input', () => {
    const runInput = input()
    const before = structuredClone(runInput)
    const first = runSmokeBacktest({ input: runInput, strategy: strategy([1, 3]), config: {} as JsonObject })
    const second = runSmokeBacktest({ input: runInput, strategy: strategy([1, 3]), config: {} as JsonObject })
    expect(first).toEqual(second)
    expect(runInput).toEqual(before)
    expect(() => runSmokeBacktest({ input: runInput, strategy: strategy([]), options: { feeRate: 1 } }))
      .toThrow(RangeError)
  })
})
