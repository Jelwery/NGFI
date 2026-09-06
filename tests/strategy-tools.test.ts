import { describe, expect, it } from 'vitest'
import { stableHash } from '@finance2dsh/strategy-core'
import { createStrategyTools } from '@finance2dsh/dsh-tools'

const project = `${process.cwd()}/packages/quant-research`
function tools() {
  const values = createStrategyTools({ quantProjectRoot: project })
  return (name: string, args: Record<string, unknown>) => {
    const tool = values.find(candidate => candidate.name === name)
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    return tool.execute(args as never, { signal: new AbortController().signal } as never) as Promise<any>
  }
}

function bar(index: number) {
  const date = new Date(Date.UTC(2026, 0, 1 + index))
  const close = new Date(date.getTime() + 6 * 60 * 60 * 1000)
  return {
    openAt: date.toISOString(), closeAt: close.toISOString(),
    availableAt: new Date(close.getTime() + 1000).toISOString(),
    open: 10 + index * 0.01, high: 10.2 + index * 0.01, low: 9.8 + index * 0.01,
    close: 10 + index * 0.01, volume: 1000,
  }
}

describe('strategy DSH tools', () => {
  it('exposes only fixed catalogs and rejects unknown parameters', async () => {
    const execute = tools()
    const catalog = await execute('finance_strategy_registry', { action: 'catalog' })
    expect(catalog.strategies.map((item: { id: string }) => item.id)).toEqual(['accumulation-breakout.v1'])
    expect(catalog.indicators.map((item: { id: string }) => item.id)).toContain('sma')
    await expect(execute('finance_strategy_registry', { action: 'catalog', command: 'whoami' }))
      .rejects.toThrow(/unsupported tool parameters: command/u)
  })

  it('evaluates indicators and preserves warm-up nulls', async () => {
    const execute = tools()
    const result = await execute('finance_strategy_registry', {
      action: 'indicator', indicator_id: 'sma', bars: [bar(0), bar(1), bar(2)], parameters: { period: 2 },
    })
    expect(result.series.sma[0]).toBeNull()
    expect(result.series.sma[1]).toBeCloseTo(10.005, 12)
    expect(result.series.sma[2]).toBeCloseTo(10.015, 12)
  })

  it('labels smoke backtests as never promotion eligible and rejects them as promotion evidence', async () => {
    const execute = tools()
    const input = {
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' },
      interval: '1d', adjustment: 'qfq', snapshotId: 'snapshot:smoke',
      asOf: '2026-06-01T00:00:00.000Z', bars: Array.from({ length: 30 }, (_, index) => bar(index)),
    }
    const smoke = await execute('finance_strategy_backtest', {
      tier: 'smoke', strategy_id: 'accumulation-breakout.v1', input,
    })
    expect(smoke).toMatchObject({ engineTier: 'smoke', promotionEligible: false, run: { engineTier: 'smoke' } })
    await expect(execute('finance_strategy_promotion', { input: { researchRun: smoke.run } }))
      .rejects.toThrow(/research-tier.*smoke is never eligible/u)
  })

  it('runs the fixed research backtest bridge and returns auditable hashes', async () => {
    const execute = tools()
    const instrument = { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' }
    const calendar = ['2026-01-05', '2026-01-06', '2026-01-07']
    const bars = calendar.map((date, index) => ({
      date, instrument, availableAt: `${date}T07:00:01+00:00`, open: 10 + index,
      high: 10.2 + index, low: 9.8 + index, close: 10 + index, previousClose: 9.5 + index,
    }))
    const result = await execute('finance_strategy_backtest', { tier: 'research', input: {
      calendar, bars, signals: [{ observationId: stableHash({ signal: 1 }), instrument, signalDate: calendar[0] }],
      costModel: { commissionRate: 0, minimumCommission: 0, stampDutyRate: 0, transferFeeRate: 0 },
      portfolio: { initialCapital: 100000, maxPositions: 1, allocationFraction: 0.5, holdingDays: 1 },
      metadata: {
        datasetSnapshotId: 'snapshot:research', datasetHash: stableHash({ dataset: 1 }),
        datasetAsOf: '2026-02-01T00:00:00+00:00', strategyHash: stableHash({ strategy: 1 }),
        configHash: stableHash({ config: 1 }), executionHash: stableHash({ execution: 1 }),
        benchmarkInstrument: null, benchmarkDatasetHash: null,
        startedAt: '2026-02-01T00:00:00+00:00', completedAt: '2026-02-01T00:00:01+00:00',
      },
    } })
    expect(result.run).toMatchObject({
      engineTier: 'research', id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      dataset: { snapshotId: 'snapshot:research', hash: stableHash({ dataset: 1 }) },
    })
  })
})
