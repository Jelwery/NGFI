import { describe, expect, it } from 'vitest'
import { YFinanceProvider } from '@finance2dsh/provider-yfinance'
import { createBehaviorMarketEvidenceTool } from '@finance2dsh/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const live = process.env.FINANCE2DSH_LIVE === '1' ? describe : describe.skip

live('live yfinance provider', () => {
  const provider = new YFinanceProvider({ timeoutMs: 90_000 })

  it('fetches a real AAPL reference and market history', async () => {
    const reference = await provider.securityReference('AAPL')
    const market = await provider.marketData('AAPL', { period: '1mo', interval: '1d' })
    expect(reference.ticker).toBe('AAPL')
    expect(reference.fields.currentPrice.status).toBe('available')
    expect(reference.fields.currentPrice.value).toBeGreaterThan(0)
    expect(reference.observation.provider).toBe('yfinance')
    expect(market.bars.length).toBeGreaterThan(5)
    expect(market.derived.latestClose.status).toBe('available')
  }, 120_000)

  it('fetches real fundamentals with explicit period metadata', async () => {
    const fundamentals = await provider.fundamentals('AAPL')
    expect(fundamentals.ttm.observation.periodType).toBe('ttm')
    expect(fundamentals.ttm.fields.revenue?.status).toBe('available')
    expect(fundamentals.annual.length).toBeGreaterThan(0)
    expect(fundamentals.annual[0]?.observation.fiscalPeriod).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }, 120_000)

  it('fetches estimates as a best-effort non-historical snapshot', async () => {
    const estimates = await provider.estimates('AAPL')
    expect(estimates.observation.periodType).toBe('estimate')
    expect(estimates.observation.provider).toBe('yfinance')
    expect(estimates.fields.forwardRevenue.status).toBe('available')
    expect(estimates.fields.forwardRevenue.note).toMatch(/estimate/)
  }, 120_000)

  it('builds real neutral behavior evidence through the DSH adapter', async () => {
    const tool = createBehaviorMarketEvidenceTool(provider)
    const exec = { signal: new AbortController().signal } as ToolRunContext
    const result = await tool.execute({ ticker: 'AAPL', benchmark: 'SPY', window: 20 }, exec) as {
      status: string
      ticker: string
      benchmark: string | null
      observation: { target: { provider: string; source?: string }; benchmark: { provider: string; source?: string } | null }
      coverage: { targetValidCloses: number; alignedBenchmarkObservations: number | null; endAt: string | null }
      metrics: {
        periodReturn: { status: string; value: number | null }
        excessReturn: { status: string; value: number | null }
        recentVolumeChange: { status: string; value: number | null }
      }
      diagnosticCaveat: string
    }

    expect(result.status).toBe('available')
    expect(result).toEqual(expect.objectContaining({ ticker: 'AAPL', benchmark: 'SPY' }))
    expect(result.observation.target).toEqual(expect.objectContaining({ provider: 'yfinance' }))
    expect(result.observation.target.source?.startsWith('https://')).toBe(true)
    expect(result.observation.benchmark).toEqual(expect.objectContaining({ provider: 'yfinance' }))
    expect(result.coverage.targetValidCloses).toBe(20)
    expect(result.coverage.alignedBenchmarkObservations).toBe(20)
    expect(result.coverage.endAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(result.metrics.periodReturn.status).toBe('available')
    expect(result.metrics.excessReturn.status).toBe('available')
    expect(result.metrics.recentVolumeChange.status).toBe('available')
    expect(result.diagnosticCaveat).toMatch(/cannot by themselves establish/)
  }, 120_000)
})
