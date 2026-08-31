import type { MarketBar, ObservedField } from './contracts.js'
import type {
  BehaviorMarketEvidence,
  BehaviorMarketEvidenceInput,
  BehaviorWindow,
} from './behavior-contracts.js'

const WINDOWS: readonly BehaviorWindow[] = [20, 60, 120, 252]
const CAVEAT = 'These market statistics describe a price path. They cannot by themselves establish loss aversion, disposition effect, representativeness, FOMO, herding, or a bubble.'

interface Point { observedAt: string; key: string; close: number; volume: number | null }

function missing(note: string): ObservedField<number> {
  return { status: 'missing', value: null, note }
}

function available(value: number, note?: string): ObservedField<number> {
  return note === undefined ? { status: 'available', value } : { status: 'available', value, note }
}

function points(bars: readonly MarketBar[]): Point[] {
  const byTime = new Map<string, Point>()
  for (const bar of bars) {
    const close = bar.adjustedClose ?? bar.close
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue
    const timestamp = Date.parse(bar.observedAt)
    if (!Number.isFinite(timestamp)) continue
    const observedAt = new Date(timestamp).toISOString()
    byTime.set(observedAt, {
      observedAt,
      key: observedAt.slice(0, 10),
      close,
      volume: typeof bar.volume === 'number' && Number.isFinite(bar.volume) && bar.volume >= 0
        ? bar.volume
        : null,
    })
  }
  return [...byTime.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt))
}

function returnOf(values: readonly number[]): number | null {
  const first = values[0]
  const last = values.at(-1)
  return values.length >= 2 && first !== undefined && last !== undefined && first !== 0
    ? last / first - 1
    : null
}

function momentum(values: readonly number[], window: BehaviorWindow): ObservedField<number> {
  if (values.length < window) return missing('requires at least ' + window + ' valid closes')
  const value = returnOf(values.slice(-window))
  return value === null ? missing('return could not be calculated') : available(value, 'return across the latest ' + window + ' valid closes')
}

function maximumDrawdown(values: readonly number[]): number | null {
  if (values.length < 2) return null
  let peak = values[0] as number
  let drawdown = 0
  for (const value of values) {
    peak = Math.max(peak, value)
    drawdown = Math.min(drawdown, value / peak - 1)
  }
  return drawdown
}

function annualizedVolatility(values: readonly number[]): number | null {
  const returns: number[] = []
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous !== undefined && current !== undefined && previous > 0) returns.push(current / previous - 1)
  }
  if (returns.length < 2) return null
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * Math.sqrt(252)
}

function recentVolumeChange(selected: readonly Point[]): ObservedField<number> {
  if (selected.length < 40) return missing('requires 40 bars to compare the latest 20 with the preceding 20')
  const recent = selected.slice(-20).map(point => point.volume).filter((value): value is number => value !== null)
  const prior = selected.slice(-40, -20).map(point => point.volume).filter((value): value is number => value !== null)
  if (recent.length < 16 || prior.length < 16) return missing('at least 80% valid volume observations are required in both periods')
  const recentMean = recent.reduce((sum, value) => sum + value, 0) / recent.length
  const priorMean = prior.reduce((sum, value) => sum + value, 0) / prior.length
  return priorMean > 0
    ? available(recentMean / priorMean - 1, 'latest 20-bar mean volume versus the preceding 20-bar mean')
    : missing('preceding mean volume is zero')
}

export function calculateBehaviorMarketEvidence(input: BehaviorMarketEvidenceInput): BehaviorMarketEvidence {
  if (!WINDOWS.includes(input.window)) throw new RangeError('window must be one of 20, 60, 120 or 252')
  const targetPoints = points(input.target.bars)
  const selected = targetPoints.slice(-input.window)
  const closes = selected.map(point => point.close)
  const latest = closes.at(-1)
  const high = closes.length > 0 ? Math.max(...closes) : null
  const low = closes.length > 0 ? Math.min(...closes) : null
  const periodReturn = returnOf(closes)
  const drawdown = maximumDrawdown(closes)
  const volatility = annualizedVolatility(closes)
  const limitations: string[] = []
  if (selected.length < input.window) limitations.push('target history contains fewer than the requested ' + input.window + ' valid closes')

  let benchmarkReturn: ObservedField<number> = { status: 'not-applicable', value: null, note: 'no benchmark was requested' }
  let excessReturn: ObservedField<number> = { status: 'not-applicable', value: null, note: 'no benchmark was requested' }
  let alignedBenchmarkObservations: number | null = null
  if (input.benchmark !== undefined) {
    const benchmarkByDay = new Map(points(input.benchmark.bars).map(point => [point.key, point.close]))
    const aligned = selected
      .map(point => ({ target: point.close, benchmark: benchmarkByDay.get(point.key) }))
      .filter((pair): pair is { target: number; benchmark: number } => pair.benchmark !== undefined)
    alignedBenchmarkObservations = aligned.length
    const targetAlignedReturn = returnOf(aligned.map(pair => pair.target))
    const benchmarkAlignedReturn = returnOf(aligned.map(pair => pair.benchmark))
    if (targetAlignedReturn !== null && benchmarkAlignedReturn !== null) {
      benchmarkReturn = available(benchmarkAlignedReturn, 'calculated on dates aligned with the target')
      excessReturn = available(targetAlignedReturn - benchmarkAlignedReturn, 'target return minus benchmark return on aligned dates')
    } else {
      benchmarkReturn = missing('fewer than two aligned target and benchmark closes')
      excessReturn = missing('fewer than two aligned target and benchmark closes')
      limitations.push('benchmark history could not be aligned sufficiently with the target')
    }
  }

  const metricValues = [periodReturn, drawdown, volatility]
  const availableCoreMetrics = metricValues.filter(value => value !== null).length
  const status = selected.length < 2
    ? 'insufficient-data'
    : selected.length < input.window || availableCoreMetrics < metricValues.length
      ? 'partial'
      : 'available'

  return {
    status,
    ticker: input.target.ticker,
    benchmark: input.benchmark?.ticker ?? null,
    window: input.window,
    observation: {
      target: input.target.observation,
      benchmark: input.benchmark?.observation ?? null,
    },
    coverage: {
      targetBarsReceived: input.target.bars.length,
      targetValidCloses: selected.length,
      targetMissingCloseRatio: input.target.bars.length === 0
        ? 1
        : (input.target.bars.length - targetPoints.length) / input.target.bars.length,
      benchmarkBarsReceived: input.benchmark?.bars.length ?? null,
      alignedBenchmarkObservations,
      startAt: selected[0]?.observedAt ?? null,
      endAt: selected.at(-1)?.observedAt ?? null,
    },
    metrics: {
      periodReturn: periodReturn === null ? missing('requires at least two valid closes') : available(periodReturn),
      benchmarkReturn,
      excessReturn,
      maximumDrawdown: drawdown === null ? missing('requires at least two valid closes') : available(drawdown),
      annualizedVolatility: volatility === null ? missing('requires at least three valid closes') : available(volatility, 'sample standard deviation of close-to-close returns, annualized by sqrt(252)'),
      distanceFromWindowHigh: latest === undefined || high === null ? missing('no valid close') : available(latest / high - 1),
      distanceFromWindowLow: latest === undefined || low === null ? missing('no valid close') : available(latest / low - 1),
      momentum20: momentum(closes, 20),
      momentum60: momentum(closes, 60),
      momentum120: momentum(closes, 120),
      momentum252: momentum(closes, 252),
      recentVolumeChange: recentVolumeChange(targetPoints),
    },
    metricUnit: 'decimal-return-or-ratio',
    diagnosticCaveat: CAVEAT,
    limitations,
  }
}
