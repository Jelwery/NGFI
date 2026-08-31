import type { FinanceDataProvider, MarketData } from '@finance2dsh/core'
import {
  createBehaviorMarketEvidenceTool,
  createBehaviorTradeAuditTool,
} from '@finance2dsh/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

function market(ticker: string, length = 70): MarketData {
  const bars = Array.from({ length }, (_, index) => ({
    observedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    open: 100 + index,
    high: 100 + index,
    low: 100 + index,
    close: 100 + index,
    adjustedClose: 100 + index,
    volume: 1_000 + index,
  }))
  return {
    ticker,
    observation: {
      provider: 'fixture',
      source: 'fixture://' + ticker,
      retrievedAt: '2025-12-31T00:00:00Z',
      observedAt: bars.at(-1)?.observedAt as string,
      periodType: 'spot',
      currency: 'USD',
      unit: 'raw',
    },
    interval: '1d',
    bars,
    derived: {
      latestClose: { status: 'available', value: 100 + length - 1 },
      totalReturn: { status: 'available', value: (100 + length - 1) / 100 - 1 },
      simpleMovingAverage20: { status: 'available', value: 100 + length - 10.5 },
    },
  }
}

function provider(marketData: FinanceDataProvider['marketData']): FinanceDataProvider {
  return {
    securityReference: async () => { throw new Error('not used') },
    fundamentals: async () => { throw new Error('not used') },
    marketData,
    estimates: async () => { throw new Error('not used') },
    comparables: async () => { throw new Error('not used') },
  }
}

const exec = { signal: new AbortController().signal } as ToolRunContext

describe('finance_behavior_market_evidence adapter', () => {
  it('maps a semantic window to provider-neutral history calls and calculates aligned evidence', async () => {
    const marketData = vi.fn(async (ticker: string) => market(ticker))
    const tool = createBehaviorMarketEvidenceTool(provider(marketData))
    const result = await tool.execute({ ticker: 'AAA', benchmark: 'BBB', window: 60 }, exec) as {
      status: string
      coverage: { targetValidCloses: number; alignedBenchmarkObservations: number }
      metrics: { excessReturn: { status: string; value: number | null } }
      diagnosticCaveat: string
    }

    expect(marketData).toHaveBeenCalledTimes(2)
    expect(marketData).toHaveBeenCalledWith('AAA', expect.objectContaining({ period: '6mo', interval: '1d', signal: exec.signal }))
    expect(marketData).toHaveBeenCalledWith('BBB', expect.objectContaining({ period: '6mo', interval: '1d', signal: exec.signal }))
    expect(result.status).toBe('available')
    expect(result.coverage).toEqual(expect.objectContaining({ targetValidCloses: 60, alignedBenchmarkObservations: 60 }))
    expect(result.metrics.excessReturn).toEqual(expect.objectContaining({ status: 'available', value: 0 }))
    expect(result.diagnosticCaveat).toMatch(/cannot by themselves establish/)
  })

  it('returns an explicit provider-error without fabricated metrics', async () => {
    const failure = Object.assign(new Error('upstream unavailable'), { kind: 'network', retryable: true })
    const tool = createBehaviorMarketEvidenceTool(provider(async () => { throw failure }))
    const result = await tool.execute({ ticker: 'FAIL', window: 20 }, exec) as Record<string, unknown>

    expect(result).toEqual(expect.objectContaining({
      status: 'provider-error',
      ticker: 'FAIL',
      benchmark: null,
      window: 20,
      providerErrors: [{ request: 'target', ticker: 'FAIL', kind: 'network', message: 'upstream unavailable', retryable: true }],
    }))
    expect(result).not.toHaveProperty('metrics')
    expect(result).not.toHaveProperty('coverage')
  })

  it('preserves successful target provenance when only the benchmark fails', async () => {
    const tool = createBehaviorMarketEvidenceTool(provider(async ticker => {
      if (ticker === 'BENCH') throw new Error('benchmark unavailable')
      return market(ticker)
    }))
    const result = await tool.execute({ ticker: 'AAA', benchmark: 'BENCH', window: 20 }, exec) as {
      status: string
      observation: { target: { provider: string } | null; benchmark: null }
      providerErrors: Array<{ request: string; ticker: string }>
    }

    expect(result.status).toBe('provider-error')
    expect(result.observation.target?.provider).toBe('fixture')
    expect(result.observation.benchmark).toBeNull()
    expect(result.providerErrors).toEqual([expect.objectContaining({ request: 'benchmark', ticker: 'BENCH' })])
  })
})

describe('finance_behavior_trade_audit adapter', () => {
  const records = [
    { id: 'A', ticker: 'AAA', opened_at: '2025-01-01', closed_at: '2025-01-03', entry_price: 100, exit_price: 110, quantity: 2, fees: 1, rule_followed: true },
    { id: 'B', ticker: 'BBB', opened_at: '2025-01-01', closed_at: '2025-01-11', entry_price: 100, exit_price: 90, quantity: 1, fees: 1, rule_followed: false },
  ]

  it('normalizes public snake_case records and refuses to infer PGR/PLR from completed trades', async () => {
    const tool = createBehaviorTradeAuditTool()
    const result = await tool.execute({ records }, exec) as {
      sample: { records: number; winners: number; losers: number }
      winningTrades: { meanHoldingDays: number }
      losingTrades: { meanHoldingDays: number }
      dispositionOpportunityMetrics: { status: string; pgr: number | null; plr: number | null }
      diagnosticCaveat: string
    }

    expect(result.sample).toEqual(expect.objectContaining({ records: 2, winners: 1, losers: 1 }))
    expect(result.winningTrades.meanHoldingDays).toBe(2)
    expect(result.losingTrades.meanHoldingDays).toBe(10)
    expect(result.dispositionOpportunityMetrics).toEqual(expect.objectContaining({ status: 'missing', pgr: null, plr: null }))
    expect(result.diagnosticCaveat).toMatch(/does not identify a psychological cause/)
  })

  it('calculates PGR/PLR only when opportunity sets and the lot assumption are both supplied', async () => {
    const tool = createBehaviorTradeAuditTool()
    const opportunity_sets = [
      { id: 'sale-1', observed_at: '2025-01-03', realized_gains: 1, realized_losses: 0, paper_gains: 3, paper_losses: 2 },
      { id: 'sale-2', observed_at: '2025-01-11', realized_gains: 0, realized_losses: 1, paper_gains: 1, paper_losses: 3 },
    ]
    const withoutAssumption = await tool.execute({ records, opportunity_sets }, exec) as { dispositionOpportunityMetrics: { status: string } }
    const result = await tool.execute({ records, opportunity_sets, lot_matching_assumption: 'FIFO' }, exec) as {
      dispositionOpportunityMetrics: { status: string; pgr: number; plr: number }
    }

    expect(withoutAssumption.dispositionOpportunityMetrics.status).toBe('missing')
    expect(result.dispositionOpportunityMetrics.status).toBe('available')
    expect(result.dispositionOpportunityMetrics.pgr).toBeCloseTo(0.2)
    expect(result.dispositionOpportunityMetrics.plr).toBeCloseTo(1 / 6)
  })
})
