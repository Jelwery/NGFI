import { describe, expect, it } from 'vitest'
import {
  FinanceDataError,
  canonicalInstrumentId,
  dataErrorKind,
  isRetryableDataError,
  normalizeAshareCanonical,
  normalizeAshareInstrument,
  parseCanonicalInstrument,
  toAshareProviderSymbol,
} from '@finance2dsh/core'

describe('data-v2 A-share canonical identity', () => {
  it.each([
    ['600519', {}, 'CN:SSE:600519:EQUITY'],
    ['sh600519', {}, 'CN:SSE:600519:EQUITY'],
    ['600519.SH', {}, 'CN:SSE:600519:EQUITY'],
    ['000001.SZ', {}, 'CN:SZSE:000001:EQUITY'],
    ['920021', {}, 'CN:BSE:920021:EQUITY'],
    ['bj920021', {}, 'CN:BSE:920021:EQUITY'],
    ['430047.BJ', {}, 'CN:BSE:430047:EQUITY'],
    ['510050', {}, 'CN:SSE:510050:ETF'],
    ['159915.SZ', {}, 'CN:SZSE:159915:ETF'],
    ['399006', {}, 'CN:SZSE:399006:INDEX'],
    ['899050', {}, 'CN:BSE:899050:INDEX'],
    ['sh000001', {}, 'CN:SSE:000001:INDEX'],
    ['000001', { assetType: 'equity' as const }, 'CN:SZSE:000001:EQUITY'],
  ])('normalizes %s without leaking a provider dialect', (value, options, expected) => {
    expect(normalizeAshareCanonical(value, options)).toBe(expected)
  })

  it.each(['000001', '000016', '000300', '000688', '000852', '000905'])(
    'requires context for the Shanghai index / Shenzhen equity collision at %s',
    symbol => {
      expect(() => normalizeAshareInstrument(symbol)).toThrowError(
        expect.objectContaining({ kind: 'ambiguous-instrument', retryable: false }),
      )
    },
  )

  it.each(['000001', '000016', '000300', '000688', '000852', '000905'])(
    'resolves the colliding code %s only with explicit index or listing context',
    symbol => {
      expect(normalizeAshareCanonical(`sh${symbol}`)).toBe(`CN:SSE:${symbol}:INDEX`)
      expect(normalizeAshareCanonical(`${symbol}.SH`)).toBe(`CN:SSE:${symbol}:INDEX`)
      expect(normalizeAshareCanonical(symbol, { assetType: 'index' })).toBe(`CN:SSE:${symbol}:INDEX`)
      expect(normalizeAshareCanonical(`${symbol}.SZ`)).toBe(`CN:SZSE:${symbol}:EQUITY`)
      expect(normalizeAshareCanonical(symbol, { assetType: 'equity' })).toBe(`CN:SZSE:${symbol}:EQUITY`)
    },
  )

  it('keeps ambiguity errors non-retryable', () => {
    expect(() => normalizeAshareInstrument('000300')).toThrowError(
      expect.objectContaining({ kind: 'ambiguous-instrument', retryable: false }),
    )
  })

  it('does not silently accept an equity code as an ETF', () => {
    expect(() => normalizeAshareInstrument('600519', { assetType: 'etf' })).toThrowError(
      expect.objectContaining({ kind: 'conflicting-instrument' }),
    )
  })

  it.each([
    ['113001', 'CN:SSE:113001:BOND'],
    ['123001', 'CN:SZSE:123001:BOND'],
    ['127001', 'CN:SZSE:127001:BOND'],
  ])('infers the exchange and bond identity for supported convertible-bond code %s', (symbol, expected) => {
    expect(normalizeAshareCanonical(symbol)).toBe(expected)
  })

  it.each(['600519', '000001'])(
    'rejects known equity code %s when the requested asset type is bond',
    symbol => {
      expect(() => normalizeAshareInstrument(symbol, { assetType: 'bond' })).toThrowError(
        expect.objectContaining({ kind: 'conflicting-instrument' }),
      )
    },
  )

  it.each([
    'CN:SZSE:113001:BOND',
    'CN:BSE:113001:BOND',
    'CN:SSE:123001:BOND',
    'CN:BSE:123001:BOND',
    'CN:SSE:127001:BOND',
    'CN:BSE:127001:BOND',
  ])('rejects canonical bond %s when its exchange conflicts with the supported code range', canonical => {
    expect(() => normalizeAshareInstrument(canonical)).toThrowError(
      expect.objectContaining({ kind: 'conflicting-instrument' }),
    )
  })

  it('rejects a known index when the canonical asset type claims equity', () => {
    expect(() => normalizeAshareInstrument('CN:SSE:000300:EQUITY')).toThrowError(
      expect.objectContaining({ kind: 'conflicting-instrument' }),
    )
  })

  it.each([
    ['sh600519.SZ', undefined],
    ['sz600519', undefined],
    ['600519.SH', { exchange: 'SZSE' as const }],
    ['399006.SH', { assetType: 'index' as const }],
    ['CN:SSE:600519:EQUITY', { exchange: 'SZSE' as const }],
  ])('fails closed on explicit conflicts for %s', (value, options) => {
    expect(() => normalizeAshareInstrument(value, options)).toThrowError(
      expect.objectContaining({ kind: 'conflicting-instrument' }),
    )
  })

  it('round-trips canonical ids and translates only at an adapter boundary', () => {
    const id = parseCanonicalInstrument('cn:sse:600519:equity')
    expect(id).toEqual({ market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' })
    expect(canonicalInstrumentId(id)).toBe('CN:SSE:600519:EQUITY')
    expect(toAshareProviderSymbol(id, 'suffix')).toBe('600519.SH')
    expect(toAshareProviderSymbol(id, 'lower-prefix')).toBe('sh600519')
  })
})

describe('data-v2 error taxonomy', () => {
  it.each([
    [401, 'unauthorized', false],
    [403, 'insufficient-permission', false],
    [429, 'rate-limited', true],
    [503, 'provider-error', true],
  ] as const)('classifies HTTP %s', (status, kind, retryable) => {
    const error = { status }
    expect(dataErrorKind(error)).toBe(kind)
    expect(isRetryableDataError(error)).toBe(retryable)
  })

  it('honors an explicit non-retryable provider error', () => {
    const error = new FinanceDataError('response shape changed', 'schema-drift')
    expect(error.retryable).toBe(false)
    expect(dataErrorKind(error)).toBe('schema-drift')
  })
})
