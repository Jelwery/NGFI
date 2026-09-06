import type {
  BacktestMetric,
  BacktestRun,
  CanonicalBar,
  JsonObject,
  SignalObservation,
  StrategyDefinition,
  StrategyRunInput,
} from './contracts.js'
import { NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1 } from './contracts.js'
import {
  configHash,
  createBacktestRun,
  deepFreeze,
  executionDefinitionHash,
  stableHash,
  strategyHash,
  strategyInputHash,
} from './identity.js'
import {
  assertSignalSequence,
  assertStrategyDefinition,
  assertStrategyRunInput,
  resolveStrategyConfig,
} from './validation.js'

const DEFAULT_INITIAL_CAPITAL = 100_000
const DEFAULT_FEE_RATE = 0.001
const MILLISECONDS_PER_YEAR = 365.25 * 86_400_000

export const SMOKE_BACKTEST_SOURCE = Object.freeze({
  sourceProject: 'dsh-trading',
  sourceCommit: 'c942057723ca7054519414575101e6bcc5ef7128',
  sourcePaths: Object.freeze(['packages/strategies/src/engine.ts']),
})

export interface SmokeBacktestOptions {
  readonly initialCapital?: number
  /** Proportional fee charged on each buy and sell notional, e.g. 0.001. */
  readonly feeRate?: number
  /** Adverse proportional price movement on each fill, e.g. 0.0005. */
  readonly slippageRate?: number
  readonly annualRiskFreeRate?: number
}

export interface SmokeBacktestRequest {
  readonly input: StrategyRunInput
  readonly strategy: StrategyDefinition
  readonly config?: Readonly<JsonObject>
  readonly options?: SmokeBacktestOptions
}

export interface SmokeTradeRecord {
  readonly entryObservationId: string
  readonly exitObservationId: string
  readonly entryBarIndex: number
  readonly entryAt: string
  readonly entryRawPrice: number
  readonly entryPrice: number
  readonly entryFee: number
  readonly exitBarIndex: number
  readonly exitAt: string
  readonly exitRawPrice: number
  readonly exitPrice: number
  readonly exitFee: number
  readonly holdingBars: number
  readonly profit: number
  readonly returnRatio: number
}

export type SmokeEquityPoint =
  | {
    readonly barIndex: number
    readonly at: string
    readonly status: 'available'
    readonly equity: number
    /** Positive peak-to-trough loss magnitude; zero at a high-water mark. */
    readonly drawdown: number
    readonly position: 'cash' | 'long'
  }
  | {
    readonly barIndex: number
    readonly at: string
    readonly status: 'missing'
    readonly equity: null
    readonly drawdown: null
    readonly position: 'long'
    readonly reason: string
  }

export type SmokeUnfilledReason =
  | 'no-next-bar'
  | 'next-open-missing'
  | 'no-open-position'
  | 'already-long'

export interface SmokeUnfilledSignal {
  readonly observationId: string
  readonly signalBarIndex: number
  readonly action: 'entry' | 'exit'
  readonly reason: SmokeUnfilledReason
}

export type SmokeTerminalPosition =
  | { readonly status: 'cash'; readonly cash: number }
  | {
    readonly status: 'open'
    readonly entryObservationId: string
    readonly entryBarIndex: number
    readonly entryAt: string
    readonly entryPrice: number
    readonly shares: number
    readonly valuationMode: 'net-liquidation-at-final-close'
    readonly valuationClose: number | null
    readonly liquidationValue: number | null
    readonly unrealizedProfit: number | null
  }

export interface SmokeBacktestMetrics {
  readonly [metric: string]: BacktestMetric
  readonly totalReturn: BacktestMetric
  readonly cagr: BacktestMetric
  readonly maxDrawdown: BacktestMetric
  readonly sharpe: BacktestMetric
  readonly winRate: BacktestMetric
  readonly profitFactor: BacktestMetric
  readonly exposure: BacktestMetric
  readonly tradeCount: BacktestMetric
}

/**
 * A fast contract-check result. Its literal tier and promotion flag prevent it
 * from being represented as research-grade evidence.
 */
export interface SmokeBacktestResult {
  readonly engineTier: 'smoke'
  readonly promotionEligible: false
  readonly run: BacktestRun & { readonly engineTier: 'smoke' }
  readonly observations: readonly SignalObservation[]
  readonly trades: readonly SmokeTradeRecord[]
  readonly equityCurve: readonly SmokeEquityPoint[]
  readonly unfilledSignals: readonly SmokeUnfilledSignal[]
  readonly terminalPosition: SmokeTerminalPosition
  readonly metrics: SmokeBacktestMetrics
  readonly initialCapital: number
  readonly finalCapital: number | null
}

interface ResolvedOptions {
  readonly initialCapital: number
  readonly feeRate: number
  readonly slippageRate: number
  readonly annualRiskFreeRate: number
}

interface OpenPosition {
  readonly observationId: string
  readonly entryBarIndex: number
  readonly entryAt: string
  readonly rawPrice: number
  readonly price: number
  readonly fee: number
  readonly shares: number
  readonly committedCapital: number
}

function available(value: number, unit: string): BacktestMetric {
  return { status: 'available', value, unit }
}

function unavailable(
  status: Exclude<BacktestMetric['status'], 'available'>,
  reason: string,
): BacktestMetric {
  return { status, value: null, reason }
}

function resolveOptions(options: SmokeBacktestOptions | undefined): ResolvedOptions {
  const resolved = {
    initialCapital: options?.initialCapital ?? DEFAULT_INITIAL_CAPITAL,
    feeRate: options?.feeRate ?? DEFAULT_FEE_RATE,
    slippageRate: options?.slippageRate ?? 0,
    annualRiskFreeRate: options?.annualRiskFreeRate ?? 0,
  }
  if (!Number.isFinite(resolved.initialCapital) || resolved.initialCapital <= 0) {
    throw new RangeError('initialCapital must be finite and greater than zero')
  }
  for (const key of ['feeRate', 'slippageRate'] as const) {
    const value = resolved[key]
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError(`${key} must be finite and within [0, 1)`)
    }
  }
  if (!Number.isFinite(resolved.annualRiskFreeRate) || resolved.annualRiskFreeRate <= -1) {
    throw new RangeError('annualRiskFreeRate must be finite and greater than -1')
  }
  return Object.freeze(resolved)
}

function barsPerYear(bars: readonly CanonicalBar[]): number | null {
  if (bars.length < 2) return null
  const first = Date.parse((bars[0] as CanonicalBar).openAt)
  const last = Date.parse((bars[bars.length - 1] as CanonicalBar).openAt)
  const interval = (last - first) / (bars.length - 1)
  return interval > 0 ? Math.max(1, Math.min(MILLISECONDS_PER_YEAR / interval, 525_960)) : null
}

function evaluateObservations(
  input: StrategyRunInput,
  strategy: StrategyDefinition,
  config: Readonly<JsonObject>,
): { readonly observations: readonly SignalObservation[]; readonly resolvedConfig: Readonly<JsonObject> } {
  assertStrategyRunInput(input)
  assertStrategyDefinition(strategy)
  if (strategy.executionDefinitionId !== NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id) {
    throw new TypeError(`smoke engine supports only ${NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id}`)
  }
  const resolvedConfig = resolveStrategyConfig(strategy.spec, config)
  const semanticStrategyHash = strategyHash(strategy.spec)
  const inputHash = strategyInputHash(input)
  const semanticConfigHash = configHash(resolvedConfig)
  const observations: unknown = strategy.evaluate(deepFreeze({
    ...input,
    instrument: { ...input.instrument },
    bars: input.bars.map(bar => ({ ...bar })),
    strategyHash: semanticStrategyHash,
    inputHash,
    configHash: semanticConfigHash,
    executionDefinition: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1,
  }), resolvedConfig)
  assertSignalSequence(observations, input.bars, {
    asOf: input.asOf,
    executionDefinitionIds: [NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id],
    expectedStrategyId: strategy.spec.id,
    expectedStrategyHash: semanticStrategyHash,
    expectedInputHash: inputHash,
    expectedSnapshotId: input.snapshotId,
    expectedConfigHash: semanticConfigHash,
    expectedInstrument: input.instrument,
    expectedExecutionDefinitionId: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id,
  })
  return { observations: deepFreeze(structuredClone(observations)), resolvedConfig }
}

function calculateMetrics(
  bars: readonly CanonicalBar[],
  equityCurve: readonly SmokeEquityPoint[],
  trades: readonly SmokeTradeRecord[],
  initialCapital: number,
  finalCapital: number | null,
  holdingBars: number,
  annualRiskFreeRate: number,
): SmokeBacktestMetrics {
  const totalReturn = finalCapital === null
    ? unavailable('missing', 'The terminal open position has no finite final close for valuation.')
    : available(finalCapital / initialCapital - 1, 'ratio')

  let cagr: BacktestMetric = unavailable('insufficient', 'At least two distinct bar times and a terminal valuation are required.')
  if (bars.length >= 2 && finalCapital !== null) {
    const first = Date.parse((bars[0] as CanonicalBar).openAt)
    const last = Date.parse((bars[bars.length - 1] as CanonicalBar).openAt)
    const years = (last - first) / MILLISECONDS_PER_YEAR
    if (years > 0) {
      const annualized = Math.pow(finalCapital / initialCapital, 1 / years) - 1
      cagr = Number.isFinite(annualized)
        ? available(annualized, 'ratio-per-year')
        : unavailable('not-meaningful', 'The annualized result overflows for this short sample.')
    }
  }

  const drawdowns = equityCurve
    .filter((point): point is Extract<SmokeEquityPoint, { status: 'available' }> => point.status === 'available')
    .map(point => point.drawdown)
  const maxDrawdown = drawdowns.length === 0
    ? unavailable('insufficient', 'No finite equity observations are available.')
    : available(Math.max(...drawdowns), 'ratio')

  const periodReturns: number[] = []
  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = equityCurve[index - 1]
    const current = equityCurve[index]
    if (previous?.status === 'available' && current?.status === 'available' && previous.equity > 0) {
      periodReturns.push(current.equity / previous.equity - 1)
    }
  }
  let sharpe: BacktestMetric = unavailable('insufficient', 'At least two consecutive finite period returns are required.')
  const frequency = barsPerYear(bars)
  if (periodReturns.length >= 2 && frequency !== null) {
    const riskFreePerPeriod = Math.pow(1 + annualRiskFreeRate, 1 / frequency) - 1
    const excess = periodReturns.map(value => value - riskFreePerPeriod)
    const mean = excess.reduce((sum, value) => sum + value, 0) / excess.length
    const variance = excess.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (excess.length - 1)
    const deviation = Math.sqrt(variance)
    sharpe = deviation === 0
      ? unavailable('not-meaningful', 'Finite period returns have zero sample variance.')
      : available(mean / deviation * Math.sqrt(frequency), 'ratio')
  }

  const winning = trades.filter(trade => trade.profit > 0)
  const losses = trades.filter(trade => trade.profit < 0)
  const winRate = trades.length === 0
    ? unavailable('insufficient', 'No closed trades are available.')
    : available(winning.length / trades.length, 'ratio')
  const totalProfit = winning.reduce((sum, trade) => sum + trade.profit, 0)
  const totalLoss = losses.reduce((sum, trade) => sum + Math.abs(trade.profit), 0)
  const profitFactor = trades.length === 0
    ? unavailable('insufficient', 'No closed trades are available.')
    : totalLoss === 0
      ? unavailable('not-meaningful', 'Profit factor is unbounded because there are no losing trades.')
      : available(totalProfit / totalLoss, 'ratio')

  return Object.freeze({
    totalReturn, cagr, maxDrawdown, sharpe, winRate, profitFactor,
    exposure: available(bars.length === 0 ? 0 : holdingBars / bars.length, 'ratio'),
    tradeCount: available(trades.length, 'count'),
  })
}

/**
 * Runs a deterministic, long/cash, single-instrument smoke backtest. A signal
 * confirmed at bar i can fill only at bar i+1 open. Open terminal positions are
 * not converted into trades; they are valued as a hypothetical net liquidation
 * at the final close and reported explicitly in `terminalPosition`.
 */
export function runSmokeBacktest(request: SmokeBacktestRequest): SmokeBacktestResult {
  const options = resolveOptions(request.options)
  const config = request.config ?? {}
  const { observations, resolvedConfig } = evaluateObservations(request.input, request.strategy, config)
  const bars = request.input.bars
  const bySignalIndex = new Map<number, SignalObservation>()
  for (const observation of observations) {
    const index = bars.findIndex(bar => bar.closeAt === observation.signalAt)
    bySignalIndex.set(index, observation)
  }

  let cash = options.initialCapital
  let position: OpenPosition | null = null
  let holdingBars = 0
  let peakEquity = options.initialCapital
  const trades: SmokeTradeRecord[] = []
  const equityCurve: SmokeEquityPoint[] = []
  const unfilledSignals: SmokeUnfilledSignal[] = []

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index] as CanonicalBar
    if (index > 0) {
      const observation = bySignalIndex.get(index - 1)
      if (observation !== undefined) {
        if (bar.open === null) {
          unfilledSignals.push({
            observationId: observation.id, signalBarIndex: index - 1, action: observation.action, reason: 'next-open-missing',
          })
        } else if (observation.action === 'entry') {
          if (position !== null) {
            unfilledSignals.push({
              observationId: observation.id, signalBarIndex: index - 1, action: observation.action, reason: 'already-long',
            })
          } else {
            const executionPrice = bar.open * (1 + options.slippageRate)
            const shares = cash / (executionPrice * (1 + options.feeRate))
            const fee = shares * executionPrice * options.feeRate
            position = {
              observationId: observation.id, entryBarIndex: index, entryAt: bar.openAt, rawPrice: bar.open,
              price: executionPrice, fee, shares, committedCapital: cash,
            }
            cash = 0
          }
        } else if (position === null) {
          unfilledSignals.push({
            observationId: observation.id, signalBarIndex: index - 1, action: observation.action, reason: 'no-open-position',
          })
        } else {
          const executionPrice = bar.open * (1 - options.slippageRate)
          const gross = position.shares * executionPrice
          const fee = gross * options.feeRate
          const net = gross - fee
          trades.push({
            entryObservationId: position.observationId,
            exitObservationId: observation.id,
            entryBarIndex: position.entryBarIndex,
            entryAt: position.entryAt,
            entryRawPrice: position.rawPrice,
            entryPrice: position.price,
            entryFee: position.fee,
            exitBarIndex: index,
            exitAt: bar.openAt,
            exitRawPrice: bar.open,
            exitPrice: executionPrice,
            exitFee: fee,
            holdingBars: index - position.entryBarIndex,
            profit: net - position.committedCapital,
            returnRatio: net / position.committedCapital - 1,
          })
          cash = net
          position = null
        }
      }
    }

    if (position !== null) holdingBars += 1
    if (position === null) {
      peakEquity = Math.max(peakEquity, cash)
      equityCurve.push({
        barIndex: index, at: bar.closeAt, status: 'available', equity: cash,
        drawdown: peakEquity > 0 ? (peakEquity - cash) / peakEquity : 0, position: 'cash',
      })
    } else if (bar.close === null) {
      equityCurve.push({
        barIndex: index, at: bar.closeAt, status: 'missing', equity: null, drawdown: null, position: 'long',
        reason: 'The close price required for mark-to-liquidation valuation is missing.',
      })
    } else {
      const liquidationValue = position.shares * bar.close * (1 - options.slippageRate) * (1 - options.feeRate)
      peakEquity = Math.max(peakEquity, liquidationValue)
      equityCurve.push({
        barIndex: index, at: bar.closeAt, status: 'available', equity: liquidationValue,
        drawdown: peakEquity > 0 ? (peakEquity - liquidationValue) / peakEquity : 0, position: 'long',
      })
    }
  }

  const lastSignal = observations.at(-1)
  if (lastSignal !== undefined) {
    const signalIndex = bars.findIndex(bar => bar.closeAt === lastSignal.signalAt)
    if (signalIndex === bars.length - 1) {
      unfilledSignals.push({
        observationId: lastSignal.id, signalBarIndex: signalIndex, action: lastSignal.action, reason: 'no-next-bar',
      })
    }
  }

  const finalPoint = equityCurve.at(-1)
  const finalCapital = bars.length === 0
    ? cash
    : finalPoint?.status === 'available' ? finalPoint.equity : null
  const terminalPosition: SmokeTerminalPosition = position === null
    ? { status: 'cash', cash }
    : {
      status: 'open',
      entryObservationId: position.observationId,
      entryBarIndex: position.entryBarIndex,
      entryAt: position.entryAt,
      entryPrice: position.price,
      shares: position.shares,
      valuationMode: 'net-liquidation-at-final-close',
      valuationClose: (bars.at(-1)?.close ?? null),
      liquidationValue: finalCapital,
      unrealizedProfit: finalCapital === null ? null : finalCapital - position.committedCapital,
    }
  const metrics = calculateMetrics(
    bars, equityCurve, trades, options.initialCapital, finalCapital, holdingBars, options.annualRiskFreeRate,
  )
  const warnings = [
    'Smoke results validate deterministic signal/execution behavior only and are not research-grade promotion evidence.',
    ...(unfilledSignals.length > 0 ? [`${unfilledSignals.length} signal(s) were not filled.`] : []),
    ...(terminalPosition.status === 'open' ? ['The final position remains open; final equity is a net-liquidation estimate.'] : []),
  ]
  const run = createBacktestRun({
    engine: 'ngfi-smoke-backtest',
    engineVersion: '1.0.0',
    engineTier: 'smoke',
    dataset: { snapshotId: request.input.snapshotId, hash: strategyInputHash(request.input), asOf: request.input.asOf },
    strategyHash: strategyHash(request.strategy.spec),
    configHash: configHash(resolvedConfig),
    executionHash: executionDefinitionHash(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1),
    costModel: {
      id: 'proportional-fee-and-slippage',
      version: '1.0.0',
      hash: configHash({ feeRate: options.feeRate, slippageRate: options.slippageRate }),
      parameters: { feeRate: options.feeRate, slippageRate: options.slippageRate },
    },
    benchmark: { status: 'not-meaningful', reason: 'The smoke engine does not evaluate a benchmark.' },
    metrics,
    artifacts: [
      { kind: 'signal-observations', ref: 'memory:signal-observations', hash: stableHash(observations) },
      { kind: 'trade-records', ref: 'memory:trade-records', hash: stableHash(trades) },
      { kind: 'equity-curve', ref: 'memory:equity-curve', hash: stableHash(equityCurve) },
    ],
    status: bars.length === 0
      ? 'insufficient'
      : finalCapital === null || unfilledSignals.length > 0 ? 'partial' : 'complete',
    warnings,
    startedAt: request.input.asOf,
    completedAt: request.input.asOf,
  }) as BacktestRun & { readonly engineTier: 'smoke' }

  return deepFreeze({
    engineTier: 'smoke',
    promotionEligible: false,
    run,
    observations,
    trades,
    equityCurve,
    unfilledSignals,
    terminalPosition,
    metrics,
    initialCapital: options.initialCapital,
    finalCapital,
  })
}
