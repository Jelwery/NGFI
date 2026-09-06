import {
  NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1,
  createSignalObservation,
  type JsonObject,
  type StrategyDefinition,
  type StrategyEvaluationContext,
  type StrategySpec,
} from '@finance2dsh/strategy-core'
import type { AccumulationBreakoutConfig } from './contracts.js'
import { detectAccumulationBreakout } from './detector.js'

export const ACCUMULATION_BREAKOUT_SOURCE = Object.freeze({
  sourceProject: 'a-share-accumulation-breakout',
  sourceCommit: 'c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453',
  sourcePaths: Object.freeze([
    'signals.py',
    'ab_screener/signals.py',
    'ab_screener/strategies/accumulation_breakout_v1.py',
  ]),
})

export const ACCUMULATION_BREAKOUT_V1_SPEC: StrategySpec = Object.freeze<StrategySpec>({
  id: 'accumulation-breakout.v1',
  version: '1.0.0',
  horizon: { unit: 'trading-days', min: 1, max: 160 },
  economicAssumption: 'A long, bounded accumulation range followed by a moderate high-volume breakout can precede trend continuation.',
  failureConditions: Object.freeze([
    'The breakout closes back below the box resistance beyond the configured tolerance.',
    'The move lacks volume confirmation or is an extreme one-day price jump.',
    'The range is a continuation inside a material long-term decline.',
    'Adjusted bars contain a discontinuity or required point-in-time OHLCV values are missing.',
  ]),
  parameters: Object.freeze([
    { key: 'boxMinBars', type: 'number', default: 20, min: 8, max: 250, integer: true },
    { key: 'boxMaxBars', type: 'number', default: 125, min: 20, max: 500, integer: true },
    { key: 'boxMaxAmplitude', type: 'number', default: 0.26, min: 0.01, max: 1 },
    { key: 'breakoutWindowBars', type: 'number', default: 5, min: 1, max: 20, integer: true },
    { key: 'breakoutVolumeRatio', type: 'number', default: 1.6, min: 0.1, max: 20 },
    { key: 'breakoutChangeMin', type: 'number', default: 0.02, min: 0, max: 0.5 },
    { key: 'breakoutChangeMax', type: 'number', default: 0.095, min: 0.01, max: 1 },
    { key: 'recentVolumeRatio', type: 'number', default: 1.2, min: 0.1, max: 20 },
    { key: 'requireMa60', type: 'boolean', default: true },
    { key: 'maxPullbacks', type: 'number', default: 0, min: 0, max: 20, integer: true },
    { key: 'pullbackTolerance', type: 'number', default: 0.005, min: 0, max: 0.2 },
    { key: 'boxMaxMidDrawdown', type: 'number', default: 0.12, min: 0, max: 1 },
    { key: 'trendLookbackBars', type: 'number', default: 60, min: 2, max: 500, integer: true },
    { key: 'trendMaxDrop', type: 'number', default: -0.15, min: -1, max: 0.5 },
  ]),
  researchStatus: 'experimental',
})

export const DEFAULT_ACCUMULATION_BREAKOUT_CONFIG: AccumulationBreakoutConfig = Object.freeze(
  Object.fromEntries(ACCUMULATION_BREAKOUT_V1_SPEC.parameters.map(parameter => [parameter.key, parameter.default])),
) as unknown as AccumulationBreakoutConfig

function asConfig(config: Readonly<JsonObject>): AccumulationBreakoutConfig {
  return config as AccumulationBreakoutConfig
}

export const ACCUMULATION_BREAKOUT_STRATEGY_V1: StrategyDefinition = Object.freeze({
  kind: 'strategy',
  spec: ACCUMULATION_BREAKOUT_V1_SPEC,
  executionDefinitionId: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id,
  evaluate(context: StrategyEvaluationContext, resolvedConfig: Readonly<JsonObject>) {
    const config = asConfig(resolvedConfig)
    const minimumPrefix = Math.max(config.boxMinBars + 5, config.trendLookbackBars)
    for (let end = minimumPrefix; end <= context.bars.length; end += 1) {
      const detection = detectAccumulationBreakout(context.bars.slice(0, end), config)
      if (!detection.matched || detection.breakoutIndex === null) continue
      const signalBar = context.bars[detection.breakoutIndex]
      if (signalBar?.close === null || signalBar === undefined) continue
      return [createSignalObservation({
        strategyId: ACCUMULATION_BREAKOUT_V1_SPEC.id,
        strategyHash: context.strategyHash,
        inputHash: context.inputHash,
        snapshotId: context.snapshotId,
        instrument: context.instrument,
        signalAt: signalBar.closeAt,
        availableAt: signalBar.availableAt,
        configHash: context.configHash,
        action: 'entry',
        direction: 'long',
        confirmationPrice: signalBar.close,
        executionDefinitionId: context.executionDefinition.id,
        payload: {
          breakoutAt: signalBar.closeAt,
          boxStartIndex: detection.boxStartIndex,
          boxEndIndex: detection.boxEndIndex,
          boxDays: detection.boxDays,
          boxHigh: detection.boxHigh,
          boxLow: detection.boxLow,
          boxAmplitude: detection.boxAmplitude,
          breakoutVolumeRatio: detection.breakoutVolumeRatio,
          breakoutChange: detection.breakoutChange,
          recentVolumeRatio: detection.recentVolumeRatio,
          ma60: detection.ma60,
          positionDrawdown: detection.positionDrawdown,
          trendReturn: detection.trendReturn,
          pullbacks: detection.pullbacks,
          conditions: detection.conditions,
        },
        explanation: detection.reasons.join(' '),
        quality: {
          level: 'medium',
          inputStatus: 'complete',
          limitations: [
            'Experimental signal; it is not approved for production trading.',
            'Market-regime qualification is intentionally external to this strategy.',
          ],
        },
      })]
    }
    return []
  },
})
