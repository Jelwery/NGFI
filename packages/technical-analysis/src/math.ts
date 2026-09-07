import type { IndicatorSeries } from './contracts.js'

export type NullableNumericSeries = readonly (number | null)[]

function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function assertFiniteParameter(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`)
}

function assertSeries(values: NullableNumericSeries, name: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value !== null && !Number.isFinite(value)) {
      throw new TypeError(`${name}[${index}] must be finite or null`)
    }
  }
}

function emptySeries(length: number): Array<number | null> {
  return new Array<number | null>(length).fill(null)
}

/** Simple moving average over contiguous, non-null windows. */
export function sma(values: NullableNumericSeries, period: number): IndicatorSeries {
  assertPeriod(period)
  assertSeries(values, 'values')
  const output = emptySeries(values.length)
  let sum = 0
  let gaps = 0
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number | null
    if (value === null) gaps += 1
    else sum += value
    if (index >= period) {
      const expired = values[index - period] as number | null
      if (expired === null) gaps -= 1
      else sum -= expired
    }
    if (index >= period - 1 && gaps === 0) output[index] = sum / period
  }
  return output
}

/** Standard EMA seeded by the first contiguous `period` values' SMA. */
export function ema(values: NullableNumericSeries, period: number): IndicatorSeries {
  assertPeriod(period)
  assertSeries(values, 'values')
  const output = emptySeries(values.length)
  const alpha = 2 / (period + 1)
  let seedSum = 0
  let seedCount = 0
  let previous: number | null = null
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number | null
    if (value === null) {
      seedSum = 0
      seedCount = 0
      previous = null
      continue
    }
    if (previous === null) {
      seedSum += value
      seedCount += 1
      if (seedCount === period) {
        previous = seedSum / period
        output[index] = previous
      }
      continue
    }
    previous = value * alpha + previous * (1 - alpha)
    output[index] = previous
  }
  return output
}

/** Rolling population standard deviation (variance divisor = N). */
export function populationStandardDeviation(
  values: NullableNumericSeries,
  period: number,
): IndicatorSeries {
  assertPeriod(period)
  assertSeries(values, 'values')
  const output = emptySeries(values.length)
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1)
    if (window.some(value => value === null)) continue
    const finiteWindow = window as readonly number[]
    const mean = finiteWindow.reduce((sum, value) => sum + value, 0) / period
    const variance = finiteWindow.reduce((sum, value) => {
      const delta = value - mean
      return sum + delta * delta
    }, 0) / period
    output[index] = Math.sqrt(variance)
  }
  return output
}

export interface BollingerBands {
  readonly middle: IndicatorSeries
  readonly upper: IndicatorSeries
  readonly lower: IndicatorSeries
}

/** Bollinger bands: SMA +/- `multiplier` population standard deviations. */
export function bollingerBands(
  values: NullableNumericSeries,
  period: number,
  multiplier: number,
): BollingerBands {
  assertFiniteParameter(multiplier, 'multiplier')
  if (multiplier < 0) throw new RangeError('multiplier must be non-negative')
  const middle = sma(values, period)
  const deviation = populationStandardDeviation(values, period)
  const upper = emptySeries(values.length)
  const lower = emptySeries(values.length)
  for (let index = 0; index < values.length; index += 1) {
    const base = middle[index]
    const width = deviation[index]
    if (base === null || base === undefined || width === null || width === undefined) continue
    upper[index] = base + multiplier * width
    lower[index] = base - multiplier * width
  }
  return { middle, upper, lower }
}

export interface MacdResult {
  readonly dif: IndicatorSeries
  readonly dea: IndicatorSeries
  readonly histogram: IndicatorSeries
}

/** MACD with SMA-seeded EMAs and the common Chinese-market 2x histogram. */
export function macd(
  values: NullableNumericSeries,
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdResult {
  assertPeriod(fastPeriod, 'fastPeriod')
  assertPeriod(slowPeriod, 'slowPeriod')
  assertPeriod(signalPeriod, 'signalPeriod')
  if (fastPeriod >= slowPeriod) throw new RangeError('fastPeriod must be less than slowPeriod')
  assertSeries(values, 'values')
  const fast = ema(values, fastPeriod)
  const slow = ema(values, slowPeriod)
  const dif = values.map((_, index) => {
    const fastValue = fast[index]
    const slowValue = slow[index]
    return fastValue == null || slowValue == null ? null : fastValue - slowValue
  })
  const dea = ema(dif, signalPeriod)
  const histogram = values.map((_, index) => {
    const difValue = dif[index]
    const deaValue = dea[index]
    return difValue == null || deaValue == null ? null : (difValue - deaValue) * 2
  })
  return { dif, dea, histogram }
}

function rsiValue(averageGain: number, averageLoss: number): number {
  if (averageGain === 0 && averageLoss === 0) return 50
  if (averageLoss === 0) return 100
  if (averageGain === 0) return 0
  return 100 - 100 / (1 + averageGain / averageLoss)
}

/** Wilder RSI. It needs `period + 1` contiguous prices before the first value. */
export function wilderRsi(values: NullableNumericSeries, period: number): IndicatorSeries {
  assertPeriod(period)
  assertSeries(values, 'values')
  const output = emptySeries(values.length)
  let previousValue: number | null = null
  let averageGain = 0
  let averageLoss = 0
  let changeCount = 0
  let seeded = false
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number | null
    if (value === null) {
      previousValue = null
      averageGain = 0
      averageLoss = 0
      changeCount = 0
      seeded = false
      continue
    }
    if (previousValue === null) {
      previousValue = value
      continue
    }
    const change = value - previousValue
    previousValue = value
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    if (!seeded) {
      averageGain += gain
      averageLoss += loss
      changeCount += 1
      if (changeCount === period) {
        averageGain /= period
        averageLoss /= period
        seeded = true
        output[index] = rsiValue(averageGain, averageLoss)
      }
      continue
    }
    averageGain = (averageGain * (period - 1) + gain) / period
    averageLoss = (averageLoss * (period - 1) + loss) / period
    output[index] = rsiValue(averageGain, averageLoss)
  }
  return output
}

export interface KdjResult {
  readonly k: IndicatorSeries
  readonly d: IndicatorSeries
  readonly j: IndicatorSeries
}

/** KDJ using RSV and 1/3 Wilder-style smoothing, seeded at K=D=50. */
export function kdj(
  highs: NullableNumericSeries,
  lows: NullableNumericSeries,
  closes: NullableNumericSeries,
  period: number,
): KdjResult {
  assertPeriod(period)
  assertSeries(highs, 'highs')
  assertSeries(lows, 'lows')
  assertSeries(closes, 'closes')
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new RangeError('highs, lows, and closes must have equal lengths')
  }
  const k = emptySeries(closes.length)
  const d = emptySeries(closes.length)
  const j = emptySeries(closes.length)
  let previousK = 50
  let previousD = 50
  let active = false
  for (let index = period - 1; index < closes.length; index += 1) {
    const start = index - period + 1
    const highWindow = highs.slice(start, index + 1)
    const lowWindow = lows.slice(start, index + 1)
    const close = closes[index]
    if (close == null || highWindow.some(value => value === null) || lowWindow.some(value => value === null)) {
      previousK = 50
      previousD = 50
      active = false
      continue
    }
    if (!active) {
      previousK = 50
      previousD = 50
      active = true
    }
    const highest = Math.max(...highWindow as readonly number[])
    const lowest = Math.min(...lowWindow as readonly number[])
    const rsv = highest === lowest ? 50 : (close - lowest) / (highest - lowest) * 100
    previousK += (rsv - previousK) / 3
    previousD += (previousK - previousD) / 3
    k[index] = previousK
    d[index] = previousD
    j[index] = 3 * previousK - 2 * previousD
  }
  return { k, d, j }
}

/** Compatibility aliases use the unambiguous implementations above. */
export const stdevPopulation = populationStandardDeviation
export const stdev = populationStandardDeviation
export const boll = bollingerBands
export const bollinger = bollingerBands
export const rsi = wilderRsi
