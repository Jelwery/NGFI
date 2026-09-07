import { assertCanonicalBars, type CanonicalBar } from '@finance2dsh/strategy-core'
import { sma } from '@finance2dsh/technical-analysis'
import type { AccumulationBreakoutConfig, AccumulationBreakoutDetection } from './contracts.js'

const SLOPE_LIMIT = 0.0025
const POSITION_LOOKBACK_BARS = 60
const BOX_PRE_MIN_HISTORY = 10
const BOX_EDGE_FRACTION = 0.18
const MIN_SUPPORT_TOUCHES = 2
const MIN_RESISTANCE_TOUCHES = 2
const MIN_MID_OCCUPANCY = 0.28
const MIN_SWINGS = 1
const MAX_HALF_DRIFT = 0.08
const CLOSE_AMPLITUDE_RATIO = 1.05

interface CompleteBar {
  readonly sourceIndex: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

interface BoxMetrics {
  readonly ok: boolean
  readonly resistance: number
  readonly support: number
  readonly amplitude: number
  readonly amplitudeLimit: number
  readonly slope: number
  readonly rSquared: number
  readonly supportTouches: number
  readonly resistanceTouches: number
  readonly middleOccupancy: number
  readonly swings: number
  readonly halfDrift: number
  readonly volumeShrink: number | null
  readonly quality: number
}

interface BoxCandidate {
  readonly start: number
  readonly end: number
  readonly length: number
  readonly metrics: BoxMetrics
  readonly score: number
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 1) return sorted[0] as number
  const position = (sorted.length - 1) * percentileValue / 100
  const lower = Math.floor(position)
  const upper = Math.min(lower + 1, sorted.length - 1)
  const weight = position - lower
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle] as number
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function linearRegression(values: readonly number[]): { readonly slope: number; readonly rSquared: number } {
  if (values.length < 5) return { slope: Number.POSITIVE_INFINITY, rSquared: 1 }
  const meanX = (values.length - 1) / 2
  const meanY = mean(values)
  let denominator = 0
  let numerator = 0
  let totalSquares = 0
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - meanX
    const yDelta = (values[index] as number) - meanY
    denominator += xDelta * xDelta
    numerator += xDelta * yDelta
    totalSquares += yDelta * yDelta
  }
  if (denominator === 0 || meanY === 0) return { slope: Number.POSITIVE_INFINITY, rSquared: 1 }
  const rawSlope = numerator / denominator
  if (totalSquares <= 1e-12) return { slope: rawSlope / Math.max(Math.abs(meanY), 1e-9), rSquared: 0 }
  const intercept = meanY - rawSlope * meanX
  let residualSquares = 0
  for (let index = 0; index < values.length; index += 1) {
    const residual = (values[index] as number) - (intercept + rawSlope * index)
    residualSquares += residual * residual
  }
  return {
    slope: rawSlope / Math.max(Math.abs(meanY), 1e-9),
    rSquared: Math.max(0, Math.min(1, 1 - residualSquares / totalSquares)),
  }
}

function supportResistance(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
): { readonly resistance: number; readonly support: number; readonly middle: number } {
  const sortedHighs = [...highs].sort((left, right) => left - right)
  const sortedLows = [...lows].sort((left, right) => left - right)
  let resistance: number
  let support: number
  if (closes.length >= 30) {
    const trimmedHigh = sortedHighs.at(-2) as number
    const trimmedLow = sortedLows[1] as number
    resistance = median([Math.max(percentile(sortedHighs, 92), Math.min(trimmedHigh, sortedHighs.at(-1) as number)), trimmedHigh, percentile(sortedHighs, 90)])
    support = median([percentile(sortedLows, 8), trimmedLow, percentile(sortedLows, 10)])
  } else if (closes.length >= 12) {
    resistance = sortedHighs.at(-2) as number
    support = sortedLows[1] as number
    if ((sortedHighs.at(-1) as number) <= resistance * 1.015) resistance = sortedHighs.at(-1) as number
    if ((sortedLows[0] as number) >= support * 0.985) support = sortedLows[0] as number
  } else {
    resistance = Math.max(...highs)
    support = Math.min(...lows)
  }
  if (!Number.isFinite(resistance) || !Number.isFinite(support) || resistance <= 0 || support <= 0) {
    resistance = Math.max(...closes)
    support = Math.min(...closes)
  }
  if (resistance < support) [resistance, support] = [support, resistance]
  let middle = (resistance + support) / 2
  const closeMedian = median(closes)
  if (Math.abs(closeMedian - middle) / Math.max(middle, 1e-9) < 0.05) {
    middle = 0.6 * middle + 0.4 * closeMedian
  }
  return { resistance, support, middle }
}

function structureMetrics(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  resistance: number,
  support: number,
): { readonly supportTouches: number; readonly resistanceTouches: number; readonly middleOccupancy: number } {
  const height = Math.max(resistance - support, 1e-9)
  const band = height * BOX_EDGE_FRACTION
  let supportTouches = 0
  let resistanceTouches = 0
  let lastSupport = -99
  let lastResistance = -99
  let middleHits = 0
  for (let index = 0; index < closes.length; index += 1) {
    const low = lows[index] as number
    const high = highs[index] as number
    if (low <= support + band && low >= support - band * 0.5 && index - lastSupport >= 2) {
      supportTouches += 1
      lastSupport = index
    }
    if (high >= resistance - band && high <= resistance + band * 0.5 && index - lastResistance >= 2) {
      resistanceTouches += 1
      lastResistance = index
    }
    const close = closes[index] as number
    if (close >= support + 0.25 * height && close <= support + 0.75 * height) middleHits += 1
  }
  return { supportTouches, resistanceTouches, middleOccupancy: middleHits / closes.length }
}

function countSwings(closes: readonly number[]): number {
  if (closes.length < 8) return 0
  const threshold = Math.max(Math.abs(median(closes)) * 0.015, 1e-6)
  const smoothed = closes.map((value, index) => {
    const previous = index > 0 ? closes[index - 1] as number : 0
    const next = index + 1 < closes.length ? closes[index + 1] as number : 0
    return (previous + value + next) / 3
  })
  let swings = 0
  let direction = 0
  let anchor = smoothed[0] as number
  for (const value of smoothed.slice(1)) {
    if (direction >= 0 && value < anchor - threshold) {
      if (direction === 1) swings += 1
      direction = -1
      anchor = value
    } else if (direction <= 0 && value > anchor + threshold) {
      if (direction === -1) swings += 1
      direction = 1
      anchor = value
    } else {
      if (direction >= 0 && value > anchor) anchor = value
      if (direction <= 0 && value < anchor) anchor = value
    }
  }
  return swings
}

function evaluateBox(bars: readonly CompleteBar[], maxAmplitude: number, requireStructure: boolean): BoxMetrics {
  const highs = bars.map(bar => bar.high)
  const lows = bars.map(bar => bar.low)
  const closes = bars.map(bar => bar.close)
  const volumes = bars.map(bar => bar.volume)
  const boundary = supportResistance(highs, lows, closes)
  const height = boundary.resistance - boundary.support
  const amplitude = height / boundary.middle
  const amplitudeLow = height / Math.max(boundary.support, 1e-9)
  const closeAmplitude = (Math.max(...closes) - Math.min(...closes)) / Math.max(Math.min(...closes), 1e-9)
  const regression = linearRegression(closes)
  const half = Math.floor(closes.length / 2)
  const halfDrift = Math.abs(median(closes.slice(half)) - median(closes.slice(0, half))) / median(closes)
  const amplitudeLimit = maxAmplitude * Math.min(1.25, 1 + 0.12 * Math.log(Math.max(closes.length, 20) / 20))
  const structure = structureMetrics(highs, lows, closes, boundary.resistance, boundary.support)
  const swings = countSwings(closes)
  const volumeHalf = Math.max(1, Math.floor(volumes.length / 2))
  const frontVolume = mean(volumes.slice(0, volumeHalf))
  const volumeShrink = frontVolume > 0 ? mean(volumes.slice(volumeHalf)) / frontVolume : null
  const basic = !((amplitude > amplitudeLimit && amplitudeLow > amplitudeLimit * 1.05)
    || Math.abs(regression.slope) > SLOPE_LIMIT
    || halfDrift > MAX_HALF_DRIFT
    || (regression.rSquared >= 0.72 && Math.abs(regression.slope) > SLOPE_LIMIT * 0.45)
    || closeAmplitude > amplitudeLimit * CLOSE_AMPLITUDE_RATIO * 1.15)
  const structureOk = !requireStructure || (
    structure.supportTouches >= MIN_SUPPORT_TOUCHES
    && structure.resistanceTouches >= MIN_RESISTANCE_TOUCHES
    && structure.middleOccupancy >= MIN_MID_OCCUPANCY
    && swings >= MIN_SWINGS
  )
  let quality = Math.max(0, 1 - amplitude / Math.max(amplitudeLimit, 1e-6)) * 35
  quality += Math.min(structure.supportTouches, 6) * 3 + Math.min(structure.resistanceTouches, 6) * 3
  quality += Math.min(swings, 8) * 2.5
  quality += Math.max(0, 1 - Math.abs(regression.slope) / SLOPE_LIMIT) * 12
  quality += Math.max(0, 1 - halfDrift / MAX_HALF_DRIFT) * 8
  quality += Math.max(0, 1 - regression.rSquared) * 8
  quality += Math.max(0, structure.middleOccupancy - 0.2) * 20
  quality += Math.min(12, Math.log(Math.max(closes.length, 15) / 15) * 6)
  if (volumeShrink !== null && volumeShrink <= 0.8) quality += Math.max(0, (1 - volumeShrink) * 10)
  return {
    ok: height > 0 && boundary.middle > 0 && basic && structureOk,
    resistance: boundary.resistance, support: boundary.support, amplitude, amplitudeLimit,
    slope: regression.slope, rSquared: regression.rSquared,
    supportTouches: structure.supportTouches, resistanceTouches: structure.resistanceTouches,
    middleOccupancy: structure.middleOccupancy, swings, halfDrift, volumeShrink, quality,
  }
}

function findBestBox(
  bars: readonly CompleteBar[],
  end: number,
  config: AccumulationBreakoutConfig,
  requireStructure = true,
): BoxCandidate | null {
  const startLow = Math.max(0, end - config.boxMaxBars + 1)
  const startHigh = end - config.boxMinBars + 1
  let best: BoxCandidate | null = null
  for (let start = startHigh; start >= startLow; start -= 1) {
    if (start < BOX_PRE_MIN_HISTORY) continue
    const length = end - start + 1
    if ((length > 90 && start % 3 !== 0 && start !== startLow)
      || (length > 45 && start % 2 !== 0 && start !== startLow)) continue
    const metrics = evaluateBox(bars.slice(start, end + 1), config.boxMaxAmplitude * (requireStructure ? 1 : 1.05), requireStructure)
    if (!metrics.ok) continue
    const score = metrics.quality
      + 8 * Math.log(Math.max(length, config.boxMinBars) / config.boxMinBars)
      - Math.max(0, POSITION_LOOKBACK_BARS - start) * 0.4
    if (best === null || score > best.score) best = { start, end, length, metrics, score }
  }
  return best ?? (requireStructure ? findBestBox(bars, end, config, false) : null)
}

function emptyDetection(reason: string): AccumulationBreakoutDetection {
  return {
    matched: false, breakoutIndex: null, boxStartIndex: null, boxEndIndex: null, boxDays: 0,
    boxHigh: null, boxLow: null, boxAmplitude: null, breakoutVolumeRatio: null, breakoutChange: null,
    recentVolumeRatio: null, ma5: null, ma20: null, ma60: null, positionDrawdown: null, trendReturn: null,
    pullbacks: 0,
    conditions: {
      box: false, flat: false, structure: false, breakout: false, volume: false, change: false,
      movingAverages: false, ma60: false, position: false, trend: false, retest: false,
    },
    reasons: [reason],
  }
}

function completeBars(bars: readonly CanonicalBar[]): CompleteBar[] | null {
  const output: CompleteBar[] = []
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index] as CanonicalBar
    if (bar.open === null || bar.high === null || bar.low === null || bar.close === null || bar.volume === null) return null
    output.push({ sourceIndex: index, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })
  }
  return output
}

export function detectAccumulationBreakout(
  bars: readonly CanonicalBar[],
  config: AccumulationBreakoutConfig,
): AccumulationBreakoutDetection {
  assertCanonicalBars(bars)
  if (config.boxMinBars > config.boxMaxBars) throw new RangeError('boxMinBars must not exceed boxMaxBars')
  if (config.breakoutChangeMin >= config.breakoutChangeMax) {
    throw new RangeError('breakoutChangeMin must be less than breakoutChangeMax')
  }
  const complete = completeBars(bars)
  if (complete === null) return emptyDetection('A required OHLCV value is missing.')
  if (complete.length < config.boxMinBars + 5) return emptyDetection('Insufficient bars for the minimum box and breakout window.')
  const closes = complete.map(bar => bar.close)
  const ma5 = sma(closes, 5).at(-1) ?? null
  const ma20 = sma(closes, 20).at(-1) ?? null
  const ma60 = sma(closes, 60).at(-1) ?? null
  const observationLength = Math.min(complete.length, config.boxMaxBars + config.breakoutWindowBars + 5)
  const observationOffset = complete.length - observationLength
  const observed = complete.slice(observationOffset)
  let candidate: BoxCandidate | null = null
  let breakoutIndex = -1
  let breakoutChange: number | null = null
  let breakoutVolumeRatio: number | null = null
  for (let index = observed.length - 1; index >= Math.max(0, observed.length - config.breakoutWindowBars); index -= 1) {
    if (index <= 0) continue
    const bar = observed[index] as CompleteBar
    const previous = observed[index - 1] as CompleteBar
    const change = bar.close / previous.close - 1
    if (change < config.breakoutChangeMin || change > config.breakoutChangeMax) continue
    const found = findBestBox(observed, index - 1, config)
    if (found === null) continue
    const box = observed.slice(found.start, found.end + 1)
    const averageVolume = mean(box.map(item => item.volume))
    const volumeRatio = averageVolume > 0 ? bar.volume / averageVolume : 0
    if (bar.close <= found.metrics.resistance * 1.001 || volumeRatio < config.breakoutVolumeRatio) continue
    candidate = found
    breakoutIndex = index
    breakoutChange = change
    breakoutVolumeRatio = volumeRatio
    break
  }
  if (candidate === null || breakoutIndex < 0 || breakoutChange === null || breakoutVolumeRatio === null) {
    return { ...emptyDetection('No qualifying box and volume breakout were found.'), ma5, ma20, ma60 }
  }

  const metrics = candidate.metrics
  const box = observed.slice(candidate.start, candidate.end + 1)
  const boxMiddle = (metrics.resistance + metrics.support) / 2
  const fullBoxStart = observationOffset + candidate.start
  const positionHistory = complete.slice(Math.max(0, fullBoxStart - POSITION_LOOKBACK_BARS), fullBoxStart)
  const priorHigh = positionHistory.length >= BOX_PRE_MIN_HISTORY
    ? Math.max(...positionHistory.map(bar => bar.high))
    : null
  const positionDrawdown = priorHigh !== null && priorHigh > 0 ? boxMiddle / priorHigh - 1 : null
  const trendReturn = complete.length >= config.trendLookbackBars
    ? (complete.at(-1) as CompleteBar).close / (complete[complete.length - config.trendLookbackBars] as CompleteBar).close - 1
    : null
  const recentVolumes = observed.slice(Math.max(0, breakoutIndex - 5), breakoutIndex).map(bar => bar.volume)
  const recentAverage = recentVolumes.length > 0 ? mean(recentVolumes) : 0
  const recentRatio = recentAverage > 0 ? (observed[breakoutIndex] as CompleteBar).volume / recentAverage : null
  const pullbacks = observed.slice(breakoutIndex + 1)
    .filter(bar => bar.close <= metrics.resistance * (1 - config.pullbackTolerance)).length
  const latestClose = (observed.at(-1) as CompleteBar).close
  const conditions = {
    box: metrics.amplitude <= metrics.amplitudeLimit * 1.01,
    flat: Math.abs(metrics.slope) <= SLOPE_LIMIT * 1.05,
    structure: metrics.supportTouches >= MIN_SUPPORT_TOUCHES
      && metrics.resistanceTouches >= MIN_RESISTANCE_TOUCHES
      && metrics.swings >= MIN_SWINGS,
    breakout: true,
    volume: breakoutVolumeRatio >= config.breakoutVolumeRatio
      && (recentRatio === null || recentRatio >= config.recentVolumeRatio),
    change: breakoutChange >= config.breakoutChangeMin && breakoutChange <= config.breakoutChangeMax,
    movingAverages: ma5 !== null && ma20 !== null && latestClose > ma20 && ma5 > ma20,
    ma60: !config.requireMa60 || (ma60 !== null && latestClose > ma60),
    position: positionDrawdown !== null && positionDrawdown >= -config.boxMaxMidDrawdown,
    trend: trendReturn !== null && trendReturn >= config.trendMaxDrop,
    retest: latestClose > metrics.resistance && pullbacks <= config.maxPullbacks,
  }
  const failed = Object.entries(conditions).filter(([, value]) => !value).map(([key]) => key)
  const breakoutSourceIndex = (observed[breakoutIndex] as CompleteBar).sourceIndex
  return {
    matched: failed.length === 0,
    breakoutIndex: breakoutSourceIndex,
    boxStartIndex: (observed[candidate.start] as CompleteBar).sourceIndex,
    boxEndIndex: (observed[candidate.end] as CompleteBar).sourceIndex,
    boxDays: candidate.length,
    boxHigh: metrics.resistance,
    boxLow: metrics.support,
    boxAmplitude: metrics.amplitude,
    breakoutVolumeRatio,
    breakoutChange,
    recentVolumeRatio: recentRatio,
    ma5, ma20, ma60, positionDrawdown, trendReturn, pullbacks, conditions,
    reasons: failed.length === 0
      ? [
        `Range held for ${candidate.length} bars with ${(metrics.amplitude * 100).toFixed(1)}% amplitude.`,
        `Breakout volume was ${breakoutVolumeRatio.toFixed(2)}x the box average.`,
        `Breakout return was ${(breakoutChange * 100).toFixed(2)}%.`,
        pullbacks === 0 ? 'The breakout held without a qualifying pullback.' : `The breakout held after ${pullbacks} pullback(s).`,
      ]
      : failed.map(condition => `Condition failed: ${condition}.`),
  }
}
