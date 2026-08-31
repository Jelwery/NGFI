import type { FinanceDataProvider } from '@finance2dsh/core'
import { createFinanceTools } from '@finance2dsh/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

const unusedProvider: FinanceDataProvider = {
  securityReference: async () => { throw new Error('not used') },
  fundamentals: async () => { throw new Error('not used') },
  marketData: async () => { throw new Error('not used') },
  estimates: async () => { throw new Error('not used') },
  comparables: async () => { throw new Error('not used') },
}

const exec = { signal: new AbortController().signal } as ToolRunContext

describe('DSH finance calculation adapters', () => {
  const tools = createFinanceTools(unusedProvider)

  it('returns the full DCF bridge as canonical JSON', async () => {
    const tool = tools.find(candidate => candidate.name === 'finance_dcf')
    expect(tool).toBeDefined()
    const result = await tool?.execute({
      free_cash_flows: [100, 110, 121],
      discount_rate: 0.1,
      terminal_method: 'gordon-growth',
      terminal_growth_rate: 0.03,
      net_debt: 50,
      shares_outstanding: 10,
    }, exec) as { enterpriseValue: number; equityValue: number; intrinsicValuePerShare: number }
    expect(result.enterpriseValue).toBeCloseTo(1610.389182)
    expect(result.equityValue).toBeCloseTo(1560.389182)
    expect(result.intrinsicValuePerShare).toBeCloseTo(156.038918)
  })

  it('rejects an invalid Gordon-growth terminal assumption through the adapter', async () => {
    const tool = tools.find(candidate => candidate.name === 'finance_dcf')
    await expect(tool?.execute({
      free_cash_flows: [100],
      discount_rate: 0.03,
      terminal_method: 'gordon-growth',
      terminal_growth_rate: 0.03,
    }, exec)).rejects.toThrow(/lower than discountRate/)
  })
})
