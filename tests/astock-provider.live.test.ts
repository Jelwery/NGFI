import { describe, expect, it } from 'vitest'
import { normalizeAshareInstrument } from '@finance2dsh/core'
import { AStockProvider } from '../packages/finance-data-service/src/providers/astock/index.js'

const live = process.env.NGFI_LIVE_ASTOCK === '1' ? describe : describe.skip
const SHANGHAI_DATE_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function requiredPart(parts: Intl.DateTimeFormatPart[], type: 'year' | 'month' | 'day' | 'hour' | 'minute'): string {
  const value = parts.find(part => part.type === type)?.value
  if (value === undefined) throw new Error(`Asia/Shanghai formatter omitted ${type}`)
  return value
}

function shiftIsoDate(value: string, days: number): string {
  const shifted = new Date(`${value}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

function completedTradingCalendarWindow(now = new Date()): { startDate: string; endDate: string } {
  const parts = SHANGHAI_DATE_TIME.formatToParts(now)
  const localDate = [
    requiredPart(parts, 'year'),
    requiredPart(parts, 'month'),
    requiredPart(parts, 'day'),
  ].join('-')
  const localMinutes = Number(requiredPart(parts, 'hour')) * 60 + Number(requiredPart(parts, 'minute'))
  const endDate = localMinutes >= 15 * 60 + 30 ? localDate : shiftIsoDate(localDate, -1)
  return { startDate: shiftIsoDate(endDate, -45), endDate }
}

live('AStockProvider public-web live smoke', () => {
  it('performs one low-frequency quote request with explicit provenance', async () => {
    const provider = new AStockProvider({ source: 'public-web', timeoutMs: 30_000, networkTimeoutMs: 15_000 })
    const result = await provider.quote({
      capability: 'quote',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      params: {},
    })

    expect(result.status).toBe('available')
    expect(result.data?.instrument).toMatchObject({ exchange: 'SSE', symbol: '600519', assetType: 'equity' })
    expect(result.data?.tradingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(result.provenance).toMatchObject({
      actualProvider: 'a-stock-public',
      upstreamSource: 'eastmoney-public-web',
      sourceKind: 'public-web',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
    })
  })

  it('fetches a minimal public fundamentals observation', async () => {
    const provider = new AStockProvider({ source: 'public-web', timeoutMs: 30_000, networkTimeoutMs: 15_000 })
    const result = await provider.fundamentalsV2({
      capability: 'fundamentals',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      params: { statement: 'income', limit: 1 },
    })

    expect(['available', 'partial']).toContain(result.status)
    expect(result.data?.periods.length).toBe(1)
    if (result.status === 'available') {
      expect(result.data?.pitSafe).toBe(true)
      expect(result.data?.periods[0]?.availableAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    } else {
      expect(result.data?.pitSafe).toBe(false)
      expect(result.data?.periods[0]?.availableAt).toBeNull()
      expect(result.warnings.join(' ')).toMatch(/not safe for historical as-of/i)
    }
    expect(result.provenance.upstreamSource).toBe('sina-public-web-finance')
  })

  it('uses the official calendar to fetch the latest completed trading day exactly', async () => {
    const provider = new AStockProvider({ source: 'public-web', timeoutMs: 90_000, networkTimeoutMs: 30_000 })
    const { startDate, endDate } = completedTradingCalendarWindow()
    const calendar = await provider.tradingCalendar({
      capability: 'trading-calendar',
      market: 'CN',
      params: { exchange: 'SSE', startDate, endDate, limit: 64 },
    })

    expect(calendar.status).toBe('available')
    if (calendar.data === null) throw new Error('official calendar returned no data')
    expect(calendar.data.days.length).toBeGreaterThan(0)
    expect(calendar.data.truncated).toBe(false)
    expect(calendar.provenance).toMatchObject({
      upstreamSource: 'szse-official-calendar',
      sourceKind: 'official',
      timezone: 'Asia/Shanghai',
    })

    const latestCompletedTradingDate = calendar.data.days
      .filter(day => day.isTradingDay)
      .map(day => day.date)
      .sort((left, right) => left.localeCompare(right))
      .at(-1)
    if (latestCompletedTradingDate === undefined) {
      throw new Error('official calendar returned no completed trading day in the requested window')
    }

    const bars = await provider.marketBars({
      capability: 'market-bars',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      params: {
        startDate: latestCompletedTradingDate,
        endDate: latestCompletedTradingDate,
        adjustment: 'none',
        interval: '1d',
        limit: 1,
      },
    })

    expect(bars.status).toBe('available')
    if (bars.data === null) throw new Error('latest completed trading day returned no market bars')
    expect(bars.data).toMatchObject({
      instrument: { exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      startDate: latestCompletedTradingDate,
      endDate: latestCompletedTradingDate,
      returned: 1,
    })
    expect(bars.data.bars).toHaveLength(1)
    expect(bars.data.bars.map(bar => bar.date)).toEqual([latestCompletedTradingDate])
    expect(bars.provenance).toMatchObject({
      upstreamSource: 'eastmoney-public-web',
      sourceKind: 'public-web',
      observedAt: latestCompletedTradingDate,
      adjustment: 'none',
      timezone: 'Asia/Shanghai',
    })
  }, 120_000)
})
