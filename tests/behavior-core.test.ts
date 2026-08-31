import { describe, expect, it } from 'vitest'
import {
  calculateBehaviorMarketEvidence,
  calculateBehaviorTradeAudit,
  type MarketBar,
  type MarketData,
} from '@finance2dsh/core'

function market(ticker: string, closes: Array<number | null>, options: { start?: number; offsetDays?: number } = {}): MarketData {
  const start = options.start ?? Date.parse('2025-01-01T00:00:00Z')
  const offsetDays = options.offsetDays ?? 0
  const bars: MarketBar[] = closes.map((close, index) => ({
    observedAt: new Date(start + (index + offsetDays) * 86_400_000).toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    adjustedClose: close,
    volume: close === null ? null : 1_000 + index * 10,
  }))
  const observedAt = bars.at(-1)?.observedAt
  return {
    ticker,
    observation: {
      provider: 'fixture',
      source: 'fixture://' + ticker,
      retrievedAt: '2025-12-31T00:00:00Z',
      ...(observedAt === undefined ? {} : { observedAt }),
      periodType: 'spot',
      currency: 'USD',
      unit: 'raw',
    },
    interval: '1d',
    bars,
    derived: {
      latestClose: { status: 'available', value: closes.findLast(value => value !== null) ?? null },
      totalReturn: { status: 'missing', value: null },
      simpleMovingAverage20: { status: 'missing', value: null },
    },
  }
}

describe('behavior market evidence', () => {
  it('calculates return, maximum drawdown, volatility, high-low distance and aligned benchmark evidence', () => {
    const targetCloses = Array.from({ length: 60 }, (_, index) => 100 + index)
    targetCloses[30] = 90
    const benchmarkCloses = Array.from({ length: 60 }, (_, index) => 200 + index)
    const result = calculateBehaviorMarketEvidence({
      target: market('TEST', targetCloses),
      benchmark: market('BENCH', benchmarkCloses),
      window: 60,
    })
    expect(result.status).toBe('available')
    expect(result.metrics.periodReturn.value).toBeCloseTo(0.59)
    expect(result.metrics.maximumDrawdown.value).toBeCloseTo(90 / 129 - 1)
    expect(result.metrics.annualizedVolatility.value).toBeGreaterThan(0)
    expect(result.metrics.distanceFromWindowHigh.value).toBe(0)
    expect(result.metrics.momentum20.status).toBe('available')
    expect(result.metrics.momentum60.status).toBe('available')
    expect(result.metrics.momentum120.status).toBe('missing')
    expect(result.metrics.benchmarkReturn.status).toBe('available')
    expect(result.metrics.excessReturn.status).toBe('available')
    expect(result.metricUnit).toBe('decimal-return-or-ratio')
    expect(result.diagnosticCaveat).toMatch(/cannot by themselves establish/)
  })

  it('preserves missingness and reports insufficient coverage', () => {
    const result = calculateBehaviorMarketEvidence({
      target: market('TEST', [null, 100, null]),
      window: 20,
    })
    expect(result.status).toBe('insufficient-data')
    expect(result.coverage.targetMissingCloseRatio).toBeCloseTo(2 / 3)
    expect(result.metrics.periodReturn.status).toBe('missing')
    expect(result.metrics.benchmarkReturn.status).toBe('not-applicable')
    expect(result.limitations).toHaveLength(1)
  })

  it('uses fetched history outside a 20-close analysis window for the two-period volume comparison', () => {
    const result = calculateBehaviorMarketEvidence({
      target: market('TEST', Array.from({ length: 45 }, (_, index) => 100 + index)),
      window: 20,
    })
    expect(result.coverage.targetValidCloses).toBe(20)
    expect(result.metrics.recentVolumeChange.status).toBe('available')
  })

  it('does not invent excess return when benchmark dates do not align', () => {
    const result = calculateBehaviorMarketEvidence({
      target: market('TEST', [100, 110]),
      benchmark: market('BENCH', [200, 210], { offsetDays: 20 }),
      window: 20,
    })
    expect(result.metrics.benchmarkReturn.status).toBe('missing')
    expect(result.metrics.excessReturn.value).toBeNull()
    expect(result.coverage.alignedBenchmarkObservations).toBe(0)
  })
})

describe('behavior trade audit', () => {
  const records = [
    { id: 'A', ticker: 'AAA', openedAt: '2025-01-01', closedAt: '2025-01-11', entryPrice: 100, exitPrice: 110, quantity: 2, fees: 2, ruleFollowed: true },
    { id: 'B', ticker: 'BBB', openedAt: '2025-01-01', closedAt: '2025-02-10', entryPrice: 100, exitPrice: 80, quantity: 1, fees: 1, ruleFollowed: false },
    { id: 'C', ticker: 'CCC', openedAt: '2025-01-01', closedAt: '2025-01-21', entryPrice: 100, exitPrice: 105, quantity: 3, fees: 3 },
    { id: 'D', ticker: 'DDD', openedAt: '2025-01-01', closedAt: '2025-03-02', entryPrice: 100, exitPrice: 90, quantity: 1, fees: 1 },
  ]

  it('reports descriptive winner-loser differences without fabricating PGR or PLR', () => {
    const result = calculateBehaviorTradeAudit({ records })
    expect(result.status).toBe('partial')
    expect(result.sample).toEqual(expect.objectContaining({ records: 4, winners: 2, losers: 2, flat: 0 }))
    expect(result.winningTrades.meanHoldingDays).toBe(15)
    expect(result.losingTrades.meanHoldingDays).toBe(50)
    expect(result.aggregate.grossPnl.value).toBe(5)
    expect(result.aggregate.netPnl.value).toBe(-2)
    expect(result.aggregate.feeDrag.value).toBe(7)
    expect(result.aggregate.ruleAdherenceRate.value).toBe(0.5)
    expect(result.activity.completedTradesPer30Days.status).toBe('available')
    expect(result.activity.medianDaysBetweenEntries.value).toBe(0)
    expect(result.activity.medianSameTickerReentryDays.status).toBe('missing')
    expect(result.dispositionOpportunityMetrics).toEqual(expect.objectContaining({
      status: 'missing', pgr: null, plr: null, opportunityDates: 0,
    }))
    expect(result.diagnosticCaveat).toMatch(/does not identify a psychological cause/)
  })

  it('calculates Odean-style opportunity rates only with complete opportunity counts and a lot assumption', () => {
    const opportunitySets = [
      { id: 'day-1', observedAt: '2025-01-11', realizedGains: 1, realizedLosses: 0, paperGains: 3, paperLosses: 2 },
      { id: 'day-2', observedAt: '2025-02-10', realizedGains: 0, realizedLosses: 1, paperGains: 1, paperLosses: 3 },
    ]
    const withoutLots = calculateBehaviorTradeAudit({ records, opportunitySets })
    expect(withoutLots.dispositionOpportunityMetrics.status).toBe('missing')
    const result = calculateBehaviorTradeAudit({ records, opportunitySets, lotMatchingAssumption: 'FIFO' })
    expect(result.dispositionOpportunityMetrics.pgr).toBeCloseTo(0.2)
    expect(result.dispositionOpportunityMetrics.plr).toBeCloseTo(1 / 6)
    expect(result.dispositionOpportunityMetrics.spread).toBeCloseTo(1 / 30)
  })

  it('marks the audit partial and rejects duplicate opportunity ids when PGR/PLR inputs are incomplete', () => {
    const opportunitySets = [
      { id: 'day-1', observedAt: '2025-01-11', realizedGains: 1, realizedLosses: 0, paperGains: 1, paperLosses: 1 },
    ]
    const partial = calculateBehaviorTradeAudit({
      records: Array.from({ length: 10 }, (_, index) => ({ ...records[index % records.length]!, id: String(index) })),
      opportunitySets,
    })
    expect(partial.status).toBe('partial')
    expect(partial.limitations).toEqual(expect.arrayContaining([expect.stringMatching(/lot-matching assumption/)]))
    expect(() => calculateBehaviorTradeAudit({
      records,
      opportunitySets: [opportunitySets[0]!, opportunitySets[0]!],
    })).toThrow(/opportunity-set ids must be unique/)
  })

  it('validates prices, chronology, confidence and duplicate ids', () => {
    expect(() => calculateBehaviorTradeAudit({ records: [{ ...records[0]!, exitPrice: 0 }] })).toThrow(/positive/)
    expect(() => calculateBehaviorTradeAudit({ records: [{ ...records[0]!, closedAt: '2024-12-31' }] })).toThrow(/precede/)
    expect(() => calculateBehaviorTradeAudit({ records: [{ ...records[0]!, confidence: 2 }] })).toThrow(/between 0 and 1/)
    expect(() => calculateBehaviorTradeAudit({ records: [records[0]!, records[0]!] })).toThrow(/unique/)
  })
})
