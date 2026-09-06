import type { CanonicalBar } from '@finance2dsh/strategy-core'

/** A JSON-safe, input-aligned series. `null` means warm-up or an input gap. */
export type IndicatorSeries = readonly (number | null)[]

export type IndicatorInputField = 'open' | 'high' | 'low' | 'close' | 'volume' | 'turnover'

export interface IndicatorParameterSpec {
  readonly key: string
  readonly default: number
  readonly min: number
  readonly max: number
  readonly integer?: boolean
  readonly description?: string
}

export interface IndicatorOutputSpec {
  readonly key: string
  readonly description: string
}

export type IndicatorParameters = Readonly<Record<string, number>>
export type IndicatorResult = Readonly<Record<string, IndicatorSeries>>

/**
 * Pure technical-indicator extension contract. Implementations must not mutate
 * bars or parameters and every output series must have exactly `bars.length`
 * elements. Rendering metadata deliberately lives outside this contract.
 */
export interface IndicatorDefinition {
  readonly id: string
  readonly version: string
  readonly description: string
  readonly inputs: readonly IndicatorInputField[]
  readonly parameters: readonly IndicatorParameterSpec[]
  readonly outputs: readonly IndicatorOutputSpec[]
  compute(bars: readonly CanonicalBar[], parameters?: IndicatorParameters): IndicatorResult
}

export type { CanonicalBar } from '@finance2dsh/strategy-core'
