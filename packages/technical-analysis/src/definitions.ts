import { assertCanonicalBars } from '@finance2dsh/strategy-core'
import type { CanonicalBar } from '@finance2dsh/strategy-core'
import type {
  IndicatorDefinition,
  IndicatorInputField,
  IndicatorParameters,
  IndicatorResult,
} from './contracts.js'
import {
  bollingerBands,
  ema,
  kdj,
  macd,
  populationStandardDeviation,
  sma,
  wilderRsi,
} from './math.js'

export const TECHNICAL_ANALYSIS_SOURCE = Object.freeze({
  sourceProject: 'dsh-trading',
  sourceCommit: 'c942057723ca7054519414575101e6bcc5ef7128',
  sourcePaths: Object.freeze([
    'packages/indicators/src/types.ts',
    'packages/indicators/src/math.ts',
    'packages/indicators/src/presets.ts',
  ]),
})

function freezeDefinition(definition: IndicatorDefinition): IndicatorDefinition {
  Object.freeze(definition.inputs)
  definition.parameters.forEach(Object.freeze)
  definition.outputs.forEach(Object.freeze)
  Object.freeze(definition.parameters)
  Object.freeze(definition.outputs)
  return Object.freeze(definition)
}

export function resolveIndicatorParameters(
  definition: IndicatorDefinition,
  supplied: IndicatorParameters = {},
): IndicatorParameters {
  const known = new Set(definition.parameters.map(parameter => parameter.key))
  for (const [key, value] of Object.entries(supplied)) {
    if (!known.has(key)) throw new TypeError(`unknown ${definition.id} parameter: ${key}`)
    if (!Number.isFinite(value)) throw new TypeError(`${definition.id}.${key} must be finite`)
  }
  const resolved: Record<string, number> = {}
  for (const parameter of definition.parameters) {
    const value = supplied[parameter.key] ?? parameter.default
    if (!Number.isFinite(value) || value < parameter.min || value > parameter.max) {
      throw new RangeError(`${definition.id}.${parameter.key} must be within [${parameter.min}, ${parameter.max}]`)
    }
    if (parameter.integer === true && !Number.isInteger(value)) {
      throw new RangeError(`${definition.id}.${parameter.key} must be an integer`)
    }
    resolved[parameter.key] = value
  }
  return Object.freeze(resolved)
}

function fieldValues(bars: readonly CanonicalBar[], field: IndicatorInputField): readonly (number | null)[] {
  return bars.map(bar => bar[field] ?? null)
}

function checkedCompute(
  definition: IndicatorDefinition,
  bars: readonly CanonicalBar[],
  parameters: IndicatorParameters | undefined,
  calculate: (resolved: IndicatorParameters) => IndicatorResult,
): IndicatorResult {
  assertCanonicalBars(bars)
  const result = calculate(resolveIndicatorParameters(definition, parameters))
  const expectedKeys = new Set(definition.outputs.map(output => output.key))
  const actualKeys = Object.keys(result)
  if (actualKeys.length !== expectedKeys.size || actualKeys.some(key => !expectedKeys.has(key))) {
    throw new TypeError(`${definition.id} returned outputs inconsistent with its definition`)
  }
  for (const [key, series] of Object.entries(result)) {
    if (series.length !== bars.length) throw new TypeError(`${definition.id}.${key} is not input-aligned`)
    Object.freeze(series)
  }
  return Object.freeze(result)
}

const periodParameter = Object.freeze({
  key: 'period',
  default: 20,
  min: 1,
  max: 10_000,
  integer: true,
  description: 'Number of contiguous bars in the lookback window.',
})

export const SMA_DEFINITION: IndicatorDefinition = freezeDefinition({
  id: 'sma', version: '1.0.0', description: 'Simple moving average of close prices.',
  inputs: ['close'], parameters: [periodParameter], outputs: [{ key: 'sma', description: 'Simple moving average.' }],
  compute(bars, parameters) {
    return checkedCompute(SMA_DEFINITION, bars, parameters, resolved => ({ sma: sma(fieldValues(bars, 'close'), resolved.period as number) }))
  },
})

export const EMA_DEFINITION: IndicatorDefinition = freezeDefinition({
  id: 'ema', version: '1.0.0', description: 'SMA-seeded exponential moving average of close prices.',
  inputs: ['close'], parameters: [periodParameter], outputs: [{ key: 'ema', description: 'Exponential moving average.' }],
  compute(bars, parameters) {
    return checkedCompute(EMA_DEFINITION, bars, parameters, resolved => ({ ema: ema(fieldValues(bars, 'close'), resolved.period as number) }))
  },
})

export const POPULATION_STANDARD_DEVIATION_DEFINITION: IndicatorDefinition = freezeDefinition({
  id: 'population-standard-deviation', version: '1.0.0', description: 'Rolling population standard deviation of close prices.',
  inputs: ['close'], parameters: [periodParameter], outputs: [{ key: 'standardDeviation', description: 'Population standard deviation.' }],
  compute(bars, parameters) {
    return checkedCompute(POPULATION_STANDARD_DEVIATION_DEFINITION, bars, parameters, resolved => ({
      standardDeviation: populationStandardDeviation(fieldValues(bars, 'close'), resolved.period as number),
    }))
  },
})

export const BOLL_DEFINITION: IndicatorDefinition = freezeDefinition({
  id: 'boll', version: '1.0.0', description: 'Bollinger bands over close prices using population standard deviation.',
  inputs: ['close'],
  parameters: [
    periodParameter,
    { key: 'multiplier', default: 2, min: 0, max: 20, description: 'Band width in population standard deviations.' },
  ],
  outputs: [
    { key: 'middle', description: 'Middle SMA band.' },
    { key: 'upper', description: 'Upper band.' },
    { key: 'lower', description: 'Lower band.' },
  ],
  compute(bars, parameters) {
    return checkedCompute(BOLL_DEFINITION, bars, parameters, resolved => {
      const bands = bollingerBands(
        fieldValues(bars, 'close'), resolved.period as number, resolved.multiplier as number,
      )
      return { middle: bands.middle, upper: bands.upper, lower: bands.lower }
    })
  },
})

export const MACD_DEFINITION: IndicatorDefinition = freezeDefinition({
  id: 'macd', version: '1.0.0', description: 'MACD with a two-times DIF-minus-DEA histogram.',
  inputs: ['close'],
  parameters: [
    { key: 'fastPeriod', default: 12, min: 1, max: 10_000, integer: true },
    { key: 'slowPeriod', default: 26, min: 2, max: 10_000, integer: true },
    { key: 'signalPeriod', default: 9, min: 1, max: 10_000, integer: true },
  ],
  outputs: [
    { key: 'dif', description: 'Fast EMA minus slow EMA.' },
    { key: 'dea', description: 'Signal EMA of DIF.' },
    { key: 'histogram', description: 'Two times DIF minus DEA.' },
  ],
  compute(bars, parameters) {
    return checkedCompute(MACD_DEFINITION, bars, parameters, resolved => {
      const result = macd(
        fieldValues(bars, 'close'),
        resolved.fastPeriod as number,
        resolved.slowPeriod as number,
        resolved.signalPeriod as number,
      )
      return { dif: result.dif, dea: result.dea, histogram: result.histogram }
    })
  },
})

export const WILDER_RSI_DEFINITION: IndicatorDefinition = freezeDefinition({
  id: 'wilder-rsi', version: '1.0.0', description: 'Wilder relative strength index over close prices.',
  inputs: ['close'],
  parameters: [{ ...periodParameter, default: 14 }],
  outputs: [{ key: 'rsi', description: 'Wilder RSI on a 0-100 scale.' }],
  compute(bars, parameters) {
    return checkedCompute(WILDER_RSI_DEFINITION, bars, parameters, resolved => ({
      rsi: wilderRsi(fieldValues(bars, 'close'), resolved.period as number),
    }))
  },
})

export const KDJ_DEFINITION: IndicatorDefinition = freezeDefinition({
  id: 'kdj', version: '1.0.0', description: 'KDJ oscillator using high, low, and close prices.',
  inputs: ['high', 'low', 'close'],
  parameters: [{ ...periodParameter, default: 9 }],
  outputs: [
    { key: 'k', description: 'Smoothed RSV K line.' },
    { key: 'd', description: 'Smoothed K D line.' },
    { key: 'j', description: 'Three K minus two D.' },
  ],
  compute(bars, parameters) {
    return checkedCompute(KDJ_DEFINITION, bars, parameters, resolved => {
      const result = kdj(
        fieldValues(bars, 'high'), fieldValues(bars, 'low'), fieldValues(bars, 'close'), resolved.period as number,
      )
      return { k: result.k, d: result.d, j: result.j }
    })
  },
})

export const INDICATOR_DEFINITIONS: readonly IndicatorDefinition[] = Object.freeze([
  SMA_DEFINITION,
  EMA_DEFINITION,
  POPULATION_STANDARD_DEVIATION_DEFINITION,
  BOLL_DEFINITION,
  MACD_DEFINITION,
  WILDER_RSI_DEFINITION,
  KDJ_DEFINITION,
])

export function indicatorDefinition(id: string): IndicatorDefinition | undefined {
  return INDICATOR_DEFINITIONS.find(definition => definition.id === id)
}

export function computeIndicator(
  definition: IndicatorDefinition,
  bars: readonly CanonicalBar[],
  parameters: IndicatorParameters = {},
): IndicatorResult {
  return definition.compute(bars, parameters)
}
