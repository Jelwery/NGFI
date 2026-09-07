import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BOLL_DEFINITION,
  INDICATOR_DEFINITIONS,
  KDJ_DEFINITION,
  MACD_DEFINITION,
  WILDER_RSI_DEFINITION,
  bollingerBands,
  ema,
  kdj,
  macd,
  populationStandardDeviation,
  sma,
  wilderRsi,
  type CanonicalBar,
} from '@finance2dsh/technical-analysis'

function bars(closes: readonly (number | null)[]): CanonicalBar[] {
  return closes.map((close, index) => {
    const day = String(index + 1).padStart(2, '0')
    return {
      openAt: `2026-01-${day}T01:30:00.000Z`,
      closeAt: `2026-01-${day}T07:00:00.000Z`,
      availableAt: `2026-01-${day}T07:00:01.000Z`,
      open: close,
      high: close === null ? null : close + 0.5,
      low: close === null ? null : close - 0.5,
      close,
      volume: close === null ? null : 1_000 + index,
    }
  })
}

describe('technical-analysis math', () => {
  it('matches an offline pandas rolling-window fixture', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('./fixtures/technical-analysis/pandas-rolling-v1.json', import.meta.url),
      'utf8',
    )) as {
      values: number[]
      period: number
      sma: Array<number | null>
      populationStandardDeviation: Array<number | null>
    }
    expect(sma(fixture.values, fixture.period)).toEqual(fixture.sma)
    const actual = populationStandardDeviation(fixture.values, fixture.period)
    actual.forEach((value, index) => {
      const expected = fixture.populationStandardDeviation[index]
      if (expected === null || expected === undefined) expect(value).toBeNull()
      else expect(value).toBeCloseTo(expected, 14)
    })
  })

  it('matches hand-calculated SMA, EMA, population deviation, and BOLL fixtures', () => {
    const values = [1, 2, 3, 4, 5]
    expect(sma(values, 3)).toEqual([null, null, 2, 3, 4])
    expect(ema(values, 3)).toEqual([null, null, 2, 3, 4])

    const deviation = populationStandardDeviation(values, 3)
    expect(deviation[2]).toBeCloseTo(Math.sqrt(2 / 3), 12)
    expect(deviation[4]).toBeCloseTo(Math.sqrt(2 / 3), 12)

    const boll = bollingerBands(values, 3, 2)
    expect(boll.middle).toEqual([null, null, 2, 3, 4])
    expect(boll.upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 12)
    expect(boll.lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 12)
  })

  it('matches hand-calculated MACD, Wilder RSI, and KDJ fixtures', () => {
    const macdResult = macd([1, 2, 3, 4, 5], 2, 3, 2)
    expect(macdResult.dif).toEqual([null, null, 0.5, 0.5, 0.5])
    expect(macdResult.dea).toEqual([null, null, null, 0.5, 0.5])
    expect(macdResult.histogram).toEqual([null, null, null, 0, 0])

    const rsi = wilderRsi([10, 11, 12, 11, 14], 3)
    expect(rsi.slice(0, 3)).toEqual([null, null, null])
    expect(rsi[3]).toBeCloseTo(66.6666666667, 10)
    expect(rsi[4]).toBeCloseTo(86.6666666667, 10)

    const kdjResult = kdj([2, 3, 4, 5], [1, 2, 3, 4], [1.5, 2.5, 3.5, 4.5], 2)
    expect(kdjResult.k[1]).toBeCloseTo(58.3333333333, 10)
    expect(kdjResult.d[1]).toBeCloseTo(52.7777777778, 10)
    expect(kdjResult.j[2]).toBeCloseTo(78.7037037037, 10)
  })

  it('handles constant and very short sequences without non-finite outputs', () => {
    expect(populationStandardDeviation([7, 7, 7], 3)).toEqual([null, null, 0])
    expect(bollingerBands([7, 7, 7], 3, 2)).toEqual({
      middle: [null, null, 7], upper: [null, null, 7], lower: [null, null, 7],
    })
    expect(wilderRsi([7, 7, 7, 7], 3)).toEqual([null, null, null, 50])
    expect(sma([1, 2], 3)).toEqual([null, null])
    expect(ema([], 3)).toEqual([])
  })

  it('resets recursive and rolling calculations across explicit gaps', () => {
    expect(sma([1, 2, null, 4, 5, 6], 3)).toEqual([null, null, null, null, null, 5])
    expect(ema([1, 2, 3, null, 4, 5, 6], 3)).toEqual([null, null, 2, null, null, null, 5])
    expect(wilderRsi([1, 2, 3, 4, null, 5, 6, 7, 8], 3))
      .toEqual([null, null, null, 100, null, null, null, null, 100])
    expect(kdj([2, 3, null, 5, 6], [1, 2, null, 4, 5], [1.5, 2.5, null, 4.5, 5.5], 2).k)
      .toEqual([null, 58.333333333333336, null, null, 58.333333333333336])
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid period %s', period => {
    expect(() => sma([1, 2, 3], period)).toThrow(RangeError)
  })

  it('rejects NaN/Infinity and invalid multi-series parameters', () => {
    expect(() => ema([1, Number.NaN], 2)).toThrow(TypeError)
    expect(() => populationStandardDeviation([1, Number.POSITIVE_INFINITY], 2)).toThrow(TypeError)
    expect(() => bollingerBands([1, 2], 2, Number.NaN)).toThrow(RangeError)
    expect(() => macd([1, 2, 3], 3, 2, 1)).toThrow(RangeError)
    expect(() => kdj([1], [1, 2], [1], 1)).toThrow(RangeError)
  })

  it('does not mutate inputs', () => {
    const values = Object.freeze([1, 2, 3, 4])
    const before = JSON.stringify(values)
    sma(values, 2)
    ema(values, 2)
    macd(values, 2, 3, 1)
    expect(JSON.stringify(values)).toBe(before)
  })
})

describe('IndicatorDefinition contract', () => {
  it('exports seven stable, versioned, UI-free definitions', () => {
    expect(INDICATOR_DEFINITIONS.map(definition => definition.id)).toEqual([
      'sma', 'ema', 'population-standard-deviation', 'boll', 'macd', 'wilder-rsi', 'kdj',
    ])
    for (const definition of INDICATOR_DEFINITIONS) {
      expect(definition.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(definition).not.toHaveProperty('color')
      expect(definition).not.toHaveProperty('pane')
    }
  })

  it('computes input-aligned series from canonical bars and preserves bars', () => {
    const input = bars([1, 2, 3, 4, 5])
    const before = structuredClone(input)
    expect(BOLL_DEFINITION.compute(input, { period: 3, multiplier: 2 }).middle).toHaveLength(input.length)
    expect(MACD_DEFINITION.compute(input, { fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 }).dea)
      .toHaveLength(input.length)
    expect(WILDER_RSI_DEFINITION.compute(input, { period: 3 }).rsi?.[3]).toBe(100)
    expect(KDJ_DEFINITION.compute(input, { period: 2 }).k).toHaveLength(input.length)
    expect(input).toEqual(before)
  })

  it('propagates canonical gaps and rejects bad bars or parameters', () => {
    const withGap = bars([1, 2, null, 4, 5])
    expect(BOLL_DEFINITION.compute(withGap, { period: 2, multiplier: 2 }).middle)
      .toEqual([null, 1.5, null, null, 4.5])
    expect(() => BOLL_DEFINITION.compute(withGap, { period: 0, multiplier: 2 })).toThrow(RangeError)
    expect(() => BOLL_DEFINITION.compute(withGap, { period: 2, multiplier: Number.NaN })).toThrow(TypeError)
    expect(() => BOLL_DEFINITION.compute(withGap, { period: 2, multiplier: 2, unknown: 1 })).toThrow(TypeError)
    expect(() => BOLL_DEFINITION.compute([
      { ...withGap[0] as CanonicalBar, close: Number.POSITIVE_INFINITY },
    ], { period: 2, multiplier: 2 })).toThrow()
  })
})
