import type { SignalObservation } from '@finance2dsh/strategy-core'

import type {
  EvaluateSignalOutcomeInput,
  SignalOutcomeRevisionInput,
  SignalOutcomeStatus,
} from './contracts.js'
import {
  SignalEvaluationError,
  assertNonEmpty,
  assertObservation,
  assertOutcomeHorizon,
  assertOutcomePriceBars,
  assertPositive,
  assertTimestamp,
} from './validation.js'

function unavailable(
  observation: SignalObservation,
  input: EvaluateSignalOutcomeInput,
  status: Exclude<SignalOutcomeStatus, 'matured'>,
  reason: string,
): SignalOutcomeRevisionInput {
  return {
    observationId: observation.id, horizon: input.horizon, status, calculationAt: input.calculationAt,
    entryAt: null, maturityAt: null, entryPrice: null, exitPrice: null, instrumentReturn: null,
    benchmarkReturn: null, excessReturn: null, mae: null, mfe: null, directionHit: null,
    regime: input.regime, dataQuality: observation.quality.level, market: observation.instrument.market, reason,
  }
}

export function evaluateSignalOutcome(input: EvaluateSignalOutcomeInput): SignalOutcomeRevisionInput {
  assertObservation(input.observation)
  assertOutcomeHorizon(input.horizon)
  assertTimestamp(input.calculationAt, 'calculationAt')
  assertNonEmpty(input.regime, 'regime')
  assertOutcomePriceBars(input.bars, input.calculationAt)

  if (input.entry.status !== 'filled') {
    assertNonEmpty(input.entry.reason, 'entry.reason')
    return unavailable(input.observation, input, input.entry.status, input.entry.reason)
  }
  const entry = input.entry
  assertTimestamp(entry.at, 'entry.at')
  assertPositive(entry.price, 'entry.price')
  if (Date.parse(entry.at) < Date.parse(input.observation.availableAt)) {
    throw new SignalEvaluationError('invalid', 'entry cannot predate observation availability')
  }

  const eligible = input.bars.filter(bar => Date.parse(bar.closeAt) > Date.parse(entry.at))
  if (eligible.length < input.horizon) {
    return unavailable(input.observation, input, 'unable', `only ${eligible.length} of ${input.horizon} trading-day bars are available`)
  }
  const window = eligible.slice(0, input.horizon)
  const maturity = window.at(-1)
  if (maturity === undefined || Date.parse(maturity.availableAt) > Date.parse(input.calculationAt)) {
    return unavailable(input.observation, input, 'unable', 'maturity data was not available at calculationAt')
  }
  if (window.some(bar => Date.parse(bar.availableAt) > Date.parse(input.calculationAt))) {
    return unavailable(input.observation, input, 'unable', 'outcome window contains future-available data')
  }
  if (window.some(bar => bar.close === null || bar.high === null || bar.low === null)) {
    return unavailable(input.observation, input, 'unable', 'outcome window contains missing prices')
  }

  const exitPrice = maturity.close as number
  const instrumentReturn = exitPrice / entry.price - 1
  const expectedSign = input.observation.action === 'entry' ? 1 : -1
  const directionalLows = window.map(bar => expectedSign * ((bar.low as number) / entry.price - 1))
  const directionalHighs = window.map(bar => expectedSign * ((bar.high as number) / entry.price - 1))
  const mae = Math.min(0, ...directionalLows, ...directionalHighs)
  const mfe = Math.max(0, ...directionalLows, ...directionalHighs)
  const directionHit = expectedSign * instrumentReturn > 0

  let benchmarkReturn: number | null = null
  if (input.benchmark?.status === 'available') {
    assertPositive(input.benchmark.entryPrice, 'benchmark.entryPrice')
    assertPositive(input.benchmark.exitPrice, 'benchmark.exitPrice')
    benchmarkReturn = input.benchmark.exitPrice / input.benchmark.entryPrice - 1
  }

  return {
    observationId: input.observation.id, horizon: input.horizon, status: 'matured',
    calculationAt: input.calculationAt, entryAt: entry.at, maturityAt: maturity.closeAt,
    entryPrice: entry.price, exitPrice, instrumentReturn, benchmarkReturn,
    excessReturn: benchmarkReturn === null ? null : instrumentReturn - benchmarkReturn,
    mae, mfe, directionHit, regime: input.regime, dataQuality: input.observation.quality.level,
    market: input.observation.instrument.market, reason: null,
  }
}
