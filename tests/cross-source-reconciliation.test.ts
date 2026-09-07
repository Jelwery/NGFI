import { describe, expect, it, vi } from 'vitest'
import { FinanceDataError } from '@finance2dsh/core'
import type { CanonicalDataResult, DataProvenance, InstrumentId } from '@finance2dsh/core'
import {
  FinanceDataService,
  reconcileCrossSourceResults,
  reconcileSources,
} from '../packages/finance-data-service/src/index.js'
import type {
  FundamentalsReconciliationPolicy,
  IndexReconciliationPolicy,
  MarketBarsReconciliationPolicy,
  QuoteReconciliationPolicy,
  RouteOptions,
  ServiceCapabilityRequest,
} from '../packages/finance-data-service/src/index.js'

const equity: InstrumentId = { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' }
const otherEquity: InstrumentId = { market: 'CN', exchange: 'SZSE', symbol: '000001', assetType: 'equity' }
const indexInstrument: InstrumentId = { market: 'CN', exchange: 'SSE', symbol: '000300', assetType: 'index' }

const quotePolicy: QuoteReconciliationPolicy = {
  capability: 'quote',
  price: { absolute: 0.1, relative: 0.001 },
  volume: { absolute: 20, relative: 0.02 },
  turnover: { absolute: 100, relative: 0.01 },
}

const barsPolicy: MarketBarsReconciliationPolicy = {
  capability: 'market-bars',
  price: { absolute: 0.01, relative: 0 },
  volume: { absolute: 1, relative: 0 },
  turnover: { absolute: 1, relative: 0 },
}

const fundamentalsPolicy: FundamentalsReconciliationPolicy = {
  capability: 'fundamentals',
  fields: {
    revenue: { absolute: 1, relative: 0, aliases: ['营业收入'] },
    netIncome: { absolute: 1, relative: 0, aliases: ['归母净利润'] },
  },
}

const indexPolicy: IndexReconciliationPolicy = {
  capability: 'index',
  weight: { absolute: 0.01, relative: 0 },
}

function provenance(
  provider: string,
  upstreamSource = `${provider}-feed`,
  overrides: Partial<DataProvenance> = {},
): DataProvenance {
  return {
    provider,
    actualProvider: provider,
    upstreamSource,
    sourceKind: 'official',
    fetchedAt: '2026-09-05T08:00:00.000Z',
    fallbackChain: [],
    ...overrides,
  }
}

function result(
  provider: string,
  data: unknown,
  overrides: Partial<CanonicalDataResult<unknown>> = {},
): CanonicalDataResult<unknown> {
  return {
    status: 'available',
    data,
    provenance: provenance(provider),
    warnings: [],
    ...overrides,
  }
}

function source(provider: string, data: unknown, overrides: Partial<CanonicalDataResult<unknown>> = {}) {
  return { provider, result: result(provider, data, overrides) }
}

function quote(
  instrument: InstrumentId,
  tradingDate: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  return { instrument, tradingDate, currency: 'CNY', fields: values }
}

describe('quote cross-source reconciliation', () => {
  it('uses explicit price, volume, and turnover tolerances and retains both source values and provenance', () => {
    const output = reconcileCrossSourceResults({
      capability: 'quote',
      policy: quotePolicy,
      sources: [
        source('zeta', quote(equity, '2026-09-04', {
          last: { status: 'available', value: 100 },
          volume: { status: 'available', value: 1_000 },
          turnover: { status: 'available', value: 10_000 },
        }), { provenance: provenance('zeta', 'zeta-exchange', { observedAt: '2026-09-04T07:00:00Z' }) }),
        source('alpha', {
          instrument: equity,
          observedAt: '2026-09-04T07:01:00Z',
          lastPrice: 100.2,
          vol: 1_015,
          amount: 10_050,
        }, {
          provenance: provenance('alpha', 'alpha-terminal', {
            observedAt: '2026-09-04T07:01:00Z', currency: 'CNY',
          }),
        }),
      ],
    })

    expect(output.status).toBe('conflict')
    expect(output.sources.map(item => item.provider)).toEqual(['alpha', 'zeta'])
    expect(output.findings.filter(item => item.status === 'conflict')).toEqual([
      expect.objectContaining({
        code: 'value-mismatch',
        path: '$.last',
        left: expect.objectContaining({
          provider: 'alpha', value: 100.2,
          provenance: expect.objectContaining({ upstreamSource: 'alpha-terminal' }),
        }),
        right: expect.objectContaining({
          provider: 'zeta', value: 100,
          provenance: expect.objectContaining({ upstreamSource: 'zeta-exchange' }),
        }),
        tolerance: quotePolicy.price,
      }),
    ])
    expect(output.findings.find(item => item.path === '$.volume')?.status).toBe('consistent')
    expect(output.findings.find(item => item.path === '$.turnover')?.status).toBe('consistent')
    expect(JSON.stringify(output)).not.toContain('average')
  })

  it('returns conflicts for different trading days and identities, but not for unknown-only fields', () => {
    const differentDay = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-03', { last: 100 })),
        source('beta', quote(equity, '2026-09-04', { last: 100 })),
      ],
    })
    expect(differentDay).toMatchObject({
      status: 'conflict',
      findings: [expect.objectContaining({ code: 'trading-date-mismatch' })],
    })

    const wrongIdentity = reconcileSources({
      capability: 'quote', policy: quotePolicy, context: { instrument: equity },
      sources: [
        source('alpha', quote(equity, '2026-09-04', { last: 100 })),
        source('beta', quote(otherEquity, '2026-09-04', { last: 100 })),
      ],
    })
    expect(wrongIdentity).toMatchObject({
      status: 'conflict',
      findings: [expect.objectContaining({ code: 'identity-mismatch' })],
    })

    const unknownOnly = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { currentPriceMaybe: 100 })),
        source('beta', quote(equity, '2026-09-04', { currentPriceMaybe: 100 })),
      ],
    })
    expect(unknownOnly.status).toBe('inconclusive')
    expect(unknownOnly.findings).toEqual([expect.objectContaining({ code: 'no-common-fields' })])
  })

  it('reports identity mismatch before shared-upstream dependence regardless of input order', () => {
    const sources = [
      source('beta', quote(otherEquity, '2026-09-04', { last: 100 }), {
        provenance: provenance('beta', ' SHARED-FEED '),
      }),
      source('alpha', quote(equity, '2026-09-04', { last: 100 }), {
        provenance: provenance('alpha', 'shared-feed'),
      }),
    ] as const

    const forward = reconcileSources({
      capability: 'quote',
      policy: quotePolicy,
      context: { instrument: equity },
      sources,
    })
    const reverse = reconcileSources({
      capability: 'quote',
      policy: quotePolicy,
      context: { instrument: equity },
      sources: [...sources].reverse(),
    })

    expect(forward).toEqual(reverse)
    expect(forward.status).toBe('conflict')
    expect(forward.sources.map(item => item.provider)).toEqual(['alpha', 'beta'])
    expect(forward.findings).toEqual([
      expect.objectContaining({
        status: 'conflict',
        code: 'identity-mismatch',
        path: '$.instrument',
        left: expect.objectContaining({
          provider: 'alpha',
          value: 'CN:SSE:600519:EQUITY',
        }),
        right: expect.objectContaining({
          provider: 'beta',
          value: 'CN:SZSE:000001:EQUITY',
        }),
      }),
    ])
  })

  it('requires independent upstreams even when provider names differ', () => {
    const output = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('alpha', 'shared-feed'),
        }),
        source('beta', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('beta', ' SHARED-FEED '),
        }),
      ],
    })
    expect(output).toMatchObject({
      status: 'inconclusive',
      findings: [expect.objectContaining({ code: 'source-not-independent' })],
    })

    const derived = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('derived-model', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('derived-model', 'cne6-derived', {
            sourceKind: 'derived',
            derived: {
              inputRefs: ['provider:alpha'],
              algorithm: 'fixture-model',
              algorithmVersion: '1',
            },
          }),
        }),
        source('alpha', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('alpha', 'alpha-feed'),
        }),
      ],
    })
    expect(derived).toMatchObject({
      status: 'inconclusive',
      findings: [expect.objectContaining({ code: 'source-not-independent' })],
    })

    const missingLineage = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('derived-model', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('derived-model', 'opaque-derived-feed', { sourceKind: 'derived' }),
        }),
        source('beta', quote(equity, '2026-09-04', { last: 100 })),
      ],
    })
    expect(missingLineage).toMatchObject({
      status: 'inconclusive',
      findings: [expect.objectContaining({ code: 'source-not-independent' })],
    })

    const emptyLineage = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('derived-model', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('derived-model', 'opaque-derived-feed', {
            sourceKind: 'derived',
            derived: { inputRefs: [], algorithm: 'fixture-model', algorithmVersion: '1' },
          }),
        }),
        source('beta', quote(equity, '2026-09-04', { last: 100 })),
      ],
    })
    expect(emptyLineage).toMatchObject({
      status: 'inconclusive',
      findings: [expect.objectContaining({ code: 'source-not-independent' })],
    })

    const equivalentLineage = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('derived-a', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('derived-a', 'model-a', {
            sourceKind: 'derived',
            derived: { inputRefs: ['provider:raw-feed'], algorithm: 'a', algorithmVersion: '1' },
          }),
        }),
        source('derived-b', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('derived-b', 'model-b', {
            sourceKind: 'derived',
            derived: { inputRefs: ['raw-feed'], algorithm: 'b', algorithmVersion: '1' },
          }),
        }),
      ],
    })
    expect(equivalentLineage.status).toBe('inconclusive')
  })

  it('requires a shared price field and declared currencies before returning consistent', () => {
    const volumeOnly = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { volume: 100 })),
        source('beta', quote(equity, '2026-09-04', { volume: 100 })),
      ],
    })
    expect(volumeOnly.status).toBe('inconclusive')
    expect(volumeOnly.findings).toContainEqual(expect.objectContaining({ code: 'no-common-fields' }))

    const missingCurrency = reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { last: 100 })),
        source('beta', { instrument: equity, tradingDate: '2026-09-04', lastPrice: 100 }),
      ],
    })
    expect(missingCurrency).toMatchObject({
      status: 'inconclusive',
      findings: [expect.objectContaining({ code: 'currency-mismatch' })],
    })
  })

  it('can require same-day snapshots to stay within an explicit observation-time skew', () => {
    const policy = { ...quotePolicy, maxObservationSkewMs: 1_000 }
    const output = reconcileSources({
      capability: 'quote', policy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('alpha', 'alpha-feed', { observedAt: '2026-09-04T07:00:00Z' }),
        }),
        source('beta', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('beta', 'beta-feed', { observedAt: '2026-09-04T07:00:02Z' }),
        }),
      ],
    })
    expect(output).toMatchObject({
      status: 'inconclusive',
      findings: [expect.objectContaining({ code: 'observation-time-mismatch' })],
    })
  })
})

describe('market-bars cross-source reconciliation', () => {
  it('joins bars by normalized date key rather than array position', () => {
    const left = {
      instrument: equity, interval: '1d', adjustment: 'none', currency: 'CNY', unit: 'shares/CNY',
      bars: [
        { date: '2026-09-03', close: 100, volume: 10, turnover: 1_000 },
        { date: '2026-09-04', close: 101, volume: 20, turnover: 2_000 },
      ],
    }
    const right = {
      instrument: equity, interval: '1d', adjustment: 'none', currency: 'CNY', unit: 'shares/CNY',
      bars: [
        { observedAt: '2026-09-04T07:00:00Z', close: 101, vol: 20, amount: 2_000 },
        { observedAt: '2026-09-03T07:00:00Z', close: 100, vol: 10, amount: 1_000 },
      ],
    }

    const output = reconcileSources({
      capability: 'market-bars', policy: barsPolicy,
      sources: [source('beta', right), source('alpha', left)],
    })

    expect(output.status).toBe('consistent')
    expect(output.findings.filter(item => item.path.endsWith('.close')).map(item => [
      item.path, item.left.value, item.right.value,
    ])).toEqual([
      ['$.bars[\"2026-09-03\"].close', 100, 100],
      ['$.bars[\"2026-09-04\"].close', 101, 101],
    ])
  })

  it.each([
    ['adjustment', { interval: '1d', adjustment: 'none' }, { interval: '1d', adjustment: 'qfq' }, 'adjustment-mismatch'],
    ['interval', { interval: '1d', adjustment: 'none' }, { interval: '1w', adjustment: 'none' }, 'interval-mismatch'],
  ] as const)('returns inconclusive for a %s mismatch before comparing values', (_label, leftMeta, rightMeta, code) => {
    const bar = { date: '2026-09-04', close: 100 }
    const output = reconcileSources({
      capability: 'market-bars', policy: barsPolicy,
      sources: [
        source('alpha', { instrument: equity, ...leftMeta, bars: [bar] }),
        source('beta', { instrument: equity, ...rightMeta, bars: [bar] }),
      ],
    })
    expect(output).toMatchObject({
      status: 'inconclusive',
      findings: [expect.objectContaining({ code })],
    })
  })

  it('returns inconclusive rather than schema drift when a valid bars payload omits interval', () => {
    const bar = { date: '2026-09-04', close: 100 }
    const output = reconcileSources({
      capability: 'market-bars', policy: barsPolicy,
      sources: [
        source('alpha', { instrument: equity, interval: '1d', adjustment: 'none', bars: [bar] }),
        source('beta', { instrument: equity, adjustment: 'none', bars: [bar] }),
      ],
    })
    expect(output).toMatchObject({
      status: 'inconclusive', findings: [expect.objectContaining({ code: 'interval-mismatch' })],
    })
  })

  it.each([
    [false, 'conflict'],
    [true, 'conflict'],
  ] as const)('classifies a missing date using source completeness (truncated=%s)', (truncated, status) => {
    const output = reconcileSources({
      capability: 'market-bars', policy: barsPolicy,
      sources: [
        source('alpha', {
          instrument: equity, interval: '1d', adjustment: 'none', truncated, currency: 'CNY', unit: 'shares/CNY',
          bars: [{ date: '2026-09-03', close: 100 }, { date: '2026-09-04', close: 101 }],
        }),
        source('beta', {
          instrument: equity, interval: '1d', adjustment: 'none', truncated: false, currency: 'CNY', unit: 'shares/CNY',
          bars: [{ date: '2026-09-04', close: 101 }],
        }),
      ],
    })
    expect(output.status).toBe(status)
    expect(output.findings).toContainEqual(expect.objectContaining({
      code: 'missing-record', status, path: '$.bars[\"2026-09-03\"]',
    }))
  })

  it.each([
    [false, 'conflict'],
    [true, 'inconclusive'],
  ] as const)(
    'classifies a date missing from the left source using its completeness (truncated=%s)',
    (truncated, status) => {
      const output = reconcileSources({
        capability: 'market-bars', policy: barsPolicy,
        sources: [
          source('alpha', {
            instrument: equity, interval: '1d', adjustment: 'none', truncated,
            currency: 'CNY', unit: 'shares/CNY', bars: [{ date: '2026-09-04', close: 101 }],
          }),
          source('beta', {
            instrument: equity, interval: '1d', adjustment: 'none', truncated: true,
            currency: 'CNY', unit: 'shares/CNY',
            bars: [{ date: '2026-09-03', close: 100 }, { date: '2026-09-04', close: 101 }],
          }),
        ],
      })
      expect(output.status).toBe(status)
      expect(output.findings).toContainEqual(expect.objectContaining({
        code: 'missing-record', status, path: '$.bars[\"2026-09-03\"]',
      }))
    },
  )

  it.each([
    ['currency', { currency: 'CNY' }, { currency: 'USD' }, 'currency-mismatch'],
    ['missing currency', { currency: null }, { currency: null }, 'currency-mismatch'],
    ['unit', { unit: 'shares' }, { unit: 'lots' }, 'unit-mismatch'],
    ['missing unit', { unit: null }, { unit: null }, 'unit-mismatch'],
  ] as const)('returns inconclusive for mismatched bar %s metadata', (_label, leftMeta, rightMeta, code) => {
    const base = {
      instrument: equity, interval: '1d', adjustment: 'none', currency: 'CNY', unit: 'shares/CNY',
      bars: [{ date: '2026-09-04', close: 100 }],
    }
    const output = reconcileSources({
      capability: 'market-bars', policy: barsPolicy,
      sources: [source('alpha', { ...base, ...leftMeta }), source('beta', { ...base, ...rightMeta })],
    })
    expect(output).toMatchObject({
      status: 'inconclusive', findings: [expect.objectContaining({ code })],
    })
  })
})

describe('fundamentals cross-source reconciliation', () => {
  it('compares only explicitly configured aliases after fiscal-period, currency, unit, and scope alignment', () => {
    const output = reconcileSources({
      capability: 'fundamentals', policy: fundamentalsPolicy,
      sources: [
        source('alpha', {
          instrument: equity,
          periods: [{
            fiscalPeriod: '2025-12-31', currency: 'CNY', unit: 'CNY', scope: 'consolidated',
            fields: { revenue: 100, netIncome: 50, suspiciousRevenueEstimate: 999 },
          }],
        }),
        source('beta', {
          instrument: equity,
          periods: [{
            fiscalPeriod: '2025-12-31', currency: 'CNY', unit: 'CNY', consolidationScope: 'consolidated',
            fields: { 营业收入: 100.5, 归母净利润: 55, revenue_estimate: 100 },
          }],
        }),
      ],
    })

    expect(output.status).toBe('conflict')
    expect(output.findings.map(item => item.path)).toEqual([
      '$.periods[[\"2025-12-31\",\"CNY\",\"CNY\",\"consolidated\"]].fields.netIncome',
      '$.periods[[\"2025-12-31\",\"CNY\",\"CNY\",\"consolidated\"]].fields.revenue',
    ])
    expect(output.findings.find(item => item.path.endsWith('.revenue'))?.status).toBe('consistent')
    expect(output.findings.find(item => item.path.endsWith('.netIncome'))).toMatchObject({
      status: 'conflict',
      context: { fiscalPeriod: '2025-12-31', currency: 'CNY', unit: 'CNY', scope: 'consolidated' },
      left: { value: 50 },
      right: { value: 55 },
    })
  })

  it.each([
    ['fiscal period', 'fiscalPeriod', '2024-12-31'],
    ['currency', 'currency', 'USD'],
    ['unit', 'unit', 'CNY thousands'],
    ['scope', 'scope', 'parent'],
  ] as const)('returns inconclusive when the %s does not align', (_label, key, value) => {
    const leftPeriod = {
      fiscalPeriod: '2025-12-31', currency: 'CNY', unit: 'CNY', scope: 'consolidated', fields: { revenue: 100 },
    }
    const output = reconcileSources({
      capability: 'fundamentals', policy: fundamentalsPolicy,
      sources: [
        source('alpha', { instrument: equity, periods: [leftPeriod] }),
        source('beta', { instrument: equity, periods: [{ ...leftPeriod, [key]: value }] }),
      ],
    })
    expect(output.status).toBe('inconclusive')
    expect(output.findings.some(item => (
      item.code === 'period-context-mismatch' || item.code === 'missing-record'
    ))).toBe(true)
  })

  it('does not fuzzily guess an unconfigured field name', () => {
    const policy: FundamentalsReconciliationPolicy = {
      capability: 'fundamentals',
      fields: { revenue: { absolute: 0, relative: 0 } },
    }
    const period = {
      fiscalPeriod: '2025-12-31', currency: 'CNY', unit: 'CNY', scope: 'consolidated',
      fields: { revenueAdjusted: 100 },
    }
    const output = reconcileSources({
      capability: 'fundamentals', policy,
      sources: [
        source('alpha', { instrument: equity, periods: [period] }),
        source('beta', { instrument: equity, periods: [period] }),
      ],
    })
    expect(output.status).toBe('inconclusive')
    expect(output.findings).toEqual([expect.objectContaining({ code: 'no-common-fields' })])
  })
})

describe('index cross-source reconciliation', () => {
  it('keeps each source date and refuses to force-align different snapshots', () => {
    const constituent = { instrument: equity, name: 'Kweichow Moutai', weight: 4.1 }
    const output = reconcileSources({
      capability: 'index', policy: indexPolicy,
      sources: [
        source('beta', { instrument: indexInstrument, asOf: '2026-08-31', constituents: [constituent] }),
        source('alpha', { instrument: indexInstrument, asOf: '2026-09-01', constituents: [constituent] }),
      ],
    })

    expect(output.status).toBe('inconclusive')
    expect(output.sources).toEqual([
      expect.objectContaining({ provider: 'alpha', sourceDate: '2026-09-01' }),
      expect.objectContaining({ provider: 'beta', sourceDate: '2026-08-31' }),
    ])
    expect(output.findings).toEqual([expect.objectContaining({
      code: 'source-date-mismatch',
      left: expect.objectContaining({ sourceDate: '2026-09-01', value: '2026-09-01' }),
      right: expect.objectContaining({ sourceDate: '2026-08-31', value: '2026-08-31' }),
    })])
  })

  it('reports same-date constituent and weight conflicts without averaging', () => {
    const output = reconcileSources({
      capability: 'index', policy: indexPolicy,
      sources: [
        source('alpha', {
          instrument: indexInstrument, asOf: '2026-08-31', truncated: false,
          constituents: [
            { instrument: equity, name: 'Kweichow Moutai', weight: 4.1 },
            { instrument: otherEquity, name: 'Ping An Bank', weight: 0.7 },
          ],
        }),
        source('beta', {
          instrument: indexInstrument, asOf: '2026-08-31', truncated: false,
          constituents: [{ instrument: equity, name: 'Kweichow Moutai', weightPercent: 4.2 }],
        }),
      ],
    })

    expect(output.status).toBe('conflict')
    expect(output.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-record', status: 'conflict' }),
      expect.objectContaining({
        code: 'value-mismatch', status: 'conflict',
        left: expect.objectContaining({ value: 4.1 }),
        right: expect.objectContaining({ value: 4.2 }),
      }),
    ]))
  })

  it('treats a missing constituent as a conflict when the missing snapshot is complete', () => {
    const output = reconcileSources({
      capability: 'index', policy: indexPolicy,
      sources: [
        source('alpha', {
          instrument: indexInstrument, asOf: '2026-08-31', truncated: true,
          constituents: [{ instrument: equity, weight: 4.1 }],
        }),
        source('beta', {
          instrument: indexInstrument, asOf: '2026-08-31', truncated: false, constituents: [],
        }),
      ],
    })
    expect(output.status).toBe('conflict')
    expect(output.findings).toContainEqual(expect.objectContaining({
      code: 'missing-record', status: 'conflict',
    }))
  })

  it.each([
    [false, 'conflict'],
    [true, 'inconclusive'],
  ] as const)(
    'classifies a constituent missing from the left source using its completeness (truncated=%s)',
    (truncated, status) => {
      const output = reconcileSources({
        capability: 'index', policy: indexPolicy,
        sources: [
          source('alpha', {
            instrument: indexInstrument, asOf: '2026-08-31', truncated,
            constituents: [{ instrument: equity, weight: 4.1 }],
          }),
          source('beta', {
            instrument: indexInstrument, asOf: '2026-08-31', truncated: true,
            constituents: [
              { instrument: equity, weight: 4.1 },
              { instrument: otherEquity, weight: 0.7 },
            ],
          }),
        ],
      })
      expect(output.status).toBe(status)
      expect(output.findings).toContainEqual(expect.objectContaining({
        code: 'missing-record', status,
      }))
    },
  )
})

describe('reconciliation determinism and validation', () => {
  it('supports N sources pairwise with stable output independent of input order and without mutation', () => {
    const sources = [
      source('charlie', quote(equity, '2026-09-04', { last: 100.02 })),
      source('alpha', quote(equity, '2026-09-04', { last: 100 })),
      source('bravo', quote(equity, '2026-09-04', { last: 100.01 })),
    ] as const
    const before = structuredClone(sources)
    const forward = reconcileSources({ capability: 'quote', policy: quotePolicy, sources })
    const reverse = reconcileSources({ capability: 'quote', policy: quotePolicy, sources: [...sources].reverse() })

    expect(forward).toEqual(reverse)
    expect(forward.status).toBe('consistent')
    expect(forward.findings).toHaveLength(3)
    expect(sources).toEqual(before)
  })

  it('rejects invalid policies and source strategies as invalid-request', () => {
    const validSources = [
      source('alpha', quote(equity, '2026-09-04', { last: 100 })),
      source('beta', quote(equity, '2026-09-04', { last: 100 })),
    ]
    expect(() => reconcileSources({
      capability: 'quote', policy: quotePolicy, sources: validSources.slice(0, 1),
    })).toThrowError(expect.objectContaining({ kind: 'invalid-request' }))
    expect(() => reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [validSources[0]!, { ...validSources[1]!, provider: 'auto' }],
    })).toThrowError(expect.objectContaining({ kind: 'invalid-request' }))
    expect(() => reconcileSources({
      capability: 'quote',
      policy: { ...quotePolicy, price: { absolute: -1, relative: 0 } },
      sources: validSources,
    })).toThrowError(expect.objectContaining({ kind: 'invalid-request' }))
    expect(() => reconcileSources({
      capability: 'fundamentals',
      policy: {
        capability: 'fundamentals',
        fields: {
          revenue: { absolute: 0, relative: 0, aliases: ['same'] },
          netIncome: { absolute: 0, relative: 0, aliases: ['same'] },
        },
      },
      sources: validSources,
    })).toThrowError(expect.objectContaining({ kind: 'invalid-request' }))
  })

  it('rejects malformed provider payloads as schema-drift', () => {
    expect(() => reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { last: '100' })),
        source('beta', quote(equity, '2026-09-04', { last: 100 })),
      ],
    })).toThrowError(expect.objectContaining({ kind: 'schema-drift', provider: 'alpha' }))

    expect(() => reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { last: { status: 'garbage', value: 100 } })),
        source('beta', quote(equity, '2026-09-04', { last: 100 })),
      ],
    })).toThrowError(expect.objectContaining({ kind: 'schema-drift', provider: 'alpha' }))

    expect(() => reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', {
          instrument: equity, observedAt: '2026-09-04Tgarbage', currency: 'CNY', last: 100,
        }),
        source('beta', quote(equity, '2026-09-04', { last: 100 })),
      ],
    })).toThrowError(expect.objectContaining({ kind: 'schema-drift', provider: 'alpha' }))

    expect(() => reconcileSources({
      capability: 'market-bars', policy: barsPolicy,
      sources: [
        source('alpha', {
          instrument: equity, interval: '1m', adjustment: 'none',
          bars: [{ date: '2026-09-04', close: 100 }],
        }),
        source('beta', {
          instrument: equity, interval: '1m', adjustment: 'none',
          bars: [{ observedAt: '2026-09-04T01:00:00Z', close: 100 }],
        }),
      ],
    })).toThrowError(expect.objectContaining({ kind: 'schema-drift', provider: 'alpha' }))

    expect(() => reconcileSources({
      capability: 'quote', policy: quotePolicy,
      sources: [
        source('alpha', quote(equity, '2026-09-04', { last: 100 }), {
          provenance: provenance('alpha', 'derived-feed', {
            sourceKind: 'derived',
            derived: { inputRefs: [42 as unknown as string], algorithm: 'fixture', algorithmVersion: '1' },
          }),
        }),
        source('beta', quote(equity, '2026-09-04', { last: 100 })),
      ],
    })).toThrowError(expect.objectContaining({ kind: 'schema-drift', provider: 'alpha' }))
  })

  it.each(['partial', 'stale'] as const)(
    'treats canonical %s null data as inconclusive instead of schema drift',
    status => {
      const output = reconcileSources({
        capability: 'quote', policy: quotePolicy,
        sources: [
          source('alpha', null, { status, warnings: status === 'stale' ? ['stale snapshot'] : [] }),
          source('beta', quote(equity, '2026-09-04', { last: 100 })),
        ],
      })
      expect(output).toMatchObject({
        status: 'inconclusive',
        findings: [expect.objectContaining({ code: 'source-status' })],
      })
    },
  )
})

describe('FinanceDataService.reconcile', () => {
  it('starts every explicit source, forces fallback off, and keeps an operational failure inconclusive', async () => {
    const service = new FinanceDataService()
    const controls = new Map<string, {
      resolve: (value: CanonicalDataResult<unknown>) => void
      reject: (reason: unknown) => void
    }>()
    const execute = vi.spyOn(service, 'execute').mockImplementation(<T>(
      _request: ServiceCapabilityRequest,
      options: RouteOptions = {},
    ): Promise<CanonicalDataResult<T>> => new Promise((resolve, reject) => {
      controls.set(options.provider as string, {
        resolve: value => resolve(value as CanonicalDataResult<T>),
        reject,
      })
    }))

    const pending = service.reconcile(
      { capability: 'quote', market: 'CN', instrument: equity },
      { providers: ['beta', 'alpha'], policy: quotePolicy, cache: false },
    )
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      { provider: 'beta', fallback: false, cache: false },
      { provider: 'alpha', fallback: false, cache: false },
    ])

    controls.get('alpha')?.resolve(result('alpha', quote(equity, '2026-09-04', { last: 100 })))
    controls.get('beta')?.reject(new FinanceDataError('feed unavailable', 'transport'))
    await expect(pending).resolves.toMatchObject({
      status: 'inconclusive',
      sources: [
        expect.objectContaining({ provider: 'alpha', outcome: 'fulfilled' }),
        expect.objectContaining({
          provider: 'beta', outcome: 'rejected', error: expect.objectContaining({ kind: 'transport' }),
        }),
      ],
    })
  })

  it('returns business conflicts but propagates structural failures', async () => {
    const conflictService = new FinanceDataService()
    vi.spyOn(conflictService, 'execute').mockImplementation(async <T>(
      _request: ServiceCapabilityRequest,
      options: RouteOptions = {},
    ): Promise<CanonicalDataResult<T>> => result(
      options.provider as string,
      quote(equity, '2026-09-04', { last: options.provider === 'alpha' ? 100 : 110 }),
    ) as CanonicalDataResult<T>)
    await expect(conflictService.reconcile(
      { capability: 'quote', market: 'CN', instrument: equity },
      { providers: ['alpha', 'beta'], policy: quotePolicy },
    )).resolves.toMatchObject({ status: 'conflict' })

    const malformedService = new FinanceDataService()
    vi.spyOn(malformedService, 'execute').mockImplementation(async <T>(
      _request: ServiceCapabilityRequest,
      options: RouteOptions = {},
    ): Promise<CanonicalDataResult<T>> => {
      if (options.provider === 'alpha') throw new FinanceDataError('malformed payload', 'schema-drift')
      return result('beta', quote(equity, '2026-09-04', { last: 100 })) as CanonicalDataResult<T>
    })
    await expect(malformedService.reconcile(
      { capability: 'quote', market: 'CN', instrument: equity },
      { providers: ['alpha', 'beta'], policy: quotePolicy },
    )).rejects.toMatchObject({ kind: 'schema-drift' })
  })

  it('disables cache by default for fresh cross-source observations', async () => {
    const service = new FinanceDataService()
    const execute = vi.spyOn(service, 'execute').mockImplementation(async <T>(
      _request: ServiceCapabilityRequest,
      options: RouteOptions = {},
    ): Promise<CanonicalDataResult<T>> => result(
      options.provider as string, quote(equity, '2026-09-04', { last: 100 }),
    ) as CanonicalDataResult<T>)
    await service.reconcile(
      { capability: 'quote', market: 'CN', instrument: equity },
      { providers: ['alpha', 'beta'], policy: quotePolicy },
    )
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      { provider: 'alpha', fallback: false, cache: false },
      { provider: 'beta', fallback: false, cache: false },
    ])
  })

  it('propagates caller cancellation instead of resolving an inconclusive business result', async () => {
    const service = new FinanceDataService()
    vi.spyOn(service, 'execute').mockRejectedValue(new FinanceDataError('request cancelled', 'aborted'))
    await expect(service.reconcile(
      { capability: 'quote', market: 'CN', instrument: equity },
      { providers: ['alpha', 'beta'], policy: quotePolicy },
    )).rejects.toMatchObject({ kind: 'aborted' })
  })
})
