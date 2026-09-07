import { describe, expect, it } from 'vitest'
import type { InstrumentId } from '@finance2dsh/core'
import {
  NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1,
  StrategyRegistry,
  StrategyRegistryError,
  StrategyValidationError,
  assertBacktestRun,
  assertSignalObservation,
  assertSignalSequence,
  canonicalJson,
  configHash,
  createBacktestRun,
  createSignalObservation,
  executionDefinitionHash,
  strategyHash,
  strategyInputHash,
  validateScreenerMatch,
  validateStrategySpec,
  type BacktestRunInput,
  type CanonicalBar,
  type JsonObject,
  type SignalObservation,
  type StrategyDefinition,
  type StrategyEvaluationContext,
  type StrategySpec,
} from '@finance2dsh/strategy-core'

const instrument: InstrumentId = {
  market: 'CN',
  exchange: 'SSE',
  symbol: '600519',
  assetType: 'equity',
}

const bars: readonly CanonicalBar[] = [
  {
    openAt: '2026-08-26T01:30:00.000Z',
    closeAt: '2026-08-26T07:00:00.000Z',
    availableAt: '2026-08-26T07:00:01.000Z',
    open: 100, high: 103, low: 99, close: 102, volume: 1_000, turnover: 101_500,
  },
  {
    openAt: '2026-08-27T01:30:00.000Z',
    closeAt: '2026-08-27T07:00:00.000Z',
    availableAt: '2026-08-27T07:00:01.000Z',
    open: 102, high: 106, low: 101, close: 105, volume: 1_500, turnover: 156_000,
  },
  {
    openAt: '2026-08-28T01:30:00.000Z',
    closeAt: '2026-08-28T07:00:00.000Z',
    availableAt: '2026-08-28T07:00:01.000Z',
    open: 105, high: 108, low: 104, close: 107, volume: 1_800, turnover: 191_000,
  },
]

const spec: StrategySpec = {
  id: 'test.breakout',
  version: '1.0.0',
  horizon: { unit: 'trading-days', min: 2, max: 20 },
  economicAssumption: 'Persistent demand after a confirmed range breakout.',
  failureConditions: [
    'The apparent breakout is caused only by an adjustment discontinuity.',
    'The next tradable bar cannot be observed without point-in-time leakage.',
  ],
  parameters: [
    { key: 'lookback', type: 'number', default: 20, min: 2, max: 120, integer: true },
    { key: 'requireVolume', type: 'boolean', default: true },
  ],
  researchStatus: 'experimental',
}

const runInput = {
  instrument,
  interval: '1d',
  adjustment: 'none' as const,
  snapshotId: 'snapshot:bars:fixture-v1',
  asOf: '2026-08-28T08:00:00.000Z',
  bars,
}

const config: JsonObject = { lookback: 20, requireVolume: true }

function observation(
  action: 'entry' | 'exit',
  barIndex: number,
  overrides: Partial<Omit<SignalObservation, 'id'>> = {},
): SignalObservation {
  const bar = bars[barIndex] as CanonicalBar
  return createSignalObservation({
    strategyId: spec.id,
    strategyHash: strategyHash(spec),
    inputHash: strategyInputHash(runInput),
    snapshotId: runInput.snapshotId,
    instrument,
    signalAt: bar.closeAt,
    availableAt: bar.availableAt,
    configHash: configHash(config),
    action,
    direction: action === 'entry' ? 'long' : 'flat',
    confirmationPrice: bar.close as number,
    executionDefinitionId: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id,
    payload: { barIndex, lookback: 20 },
    explanation: action === 'entry' ? 'Range breakout confirmed.' : 'Exit condition confirmed.',
    quality: { level: 'high', inputStatus: 'complete', limitations: [] },
    ...overrides,
  })
}

function definition(id = spec.id): StrategyDefinition {
  const definitionSpec = id === spec.id ? spec : { ...spec, id }
  return {
    kind: 'strategy',
    spec: definitionSpec,
    executionDefinitionId: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id,
    evaluate(context: StrategyEvaluationContext, resolvedConfig: Readonly<JsonObject>) {
      const bar = context.bars[1] as CanonicalBar
      return [createSignalObservation({
        strategyId: definitionSpec.id,
        strategyHash: context.strategyHash,
        inputHash: context.inputHash,
        snapshotId: context.snapshotId,
        instrument: context.instrument,
        signalAt: bar.closeAt,
        availableAt: bar.availableAt,
        configHash: context.configHash,
        action: 'entry',
        direction: 'long',
        confirmationPrice: bar.close as number,
        executionDefinitionId: context.executionDefinition.id,
        payload: { lookback: resolvedConfig.lookback ?? null },
        explanation: 'Range breakout confirmed.',
        quality: { level: 'high', inputStatus: 'complete', limitations: [] },
      })]
    },
  }
}

describe('strategy identity', () => {
  it('canonicalizes object keys while preserving array order', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, list: ['a', 'b'] }))
      .toBe('{"list":["a","b"],"nested":{"a":1,"b":2},"z":1}')
    expect(configHash({ b: 2, a: 1 })).toBe(configHash({ a: 1, b: 2 }))
    expect(configHash({ values: [1, 2] })).not.toBe(configHash({ values: [2, 1] }))
    expect(() => canonicalJson(new Array(1))).toThrow('sparse arrays')
  })

  it('locks the strategy semantic hash with a golden value', () => {
    expect(strategyHash(spec)).toBe(
      'sha256:f368dc5a907cd0f65f7f6e97ce6f747c3e82cf3a47e355dd84a14952d5553b3d',
    )
  })

  it('locks config, input, execution, and observation identities', () => {
    expect(configHash(config)).toBe(
      'sha256:fdaed234ee4460c01ea67285e043ddf1951ab194e36b7771677a5aaa99fb2093',
    )
    expect(strategyInputHash(runInput)).toBe(
      'sha256:002be128b310d831fb8094abfeb1aa8921e087a437eb77aa7db8617ce927727d',
    )
    expect(executionDefinitionHash(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1)).toBe(
      'sha256:7fb7ece2f90f6160eb5d772df5a4a3805d38b3915df2fac70d8baa30661b2c0f',
    )
    expect(observation('entry', 1).id).toBe(
      'sha256:d0c61f0ba51fbbda0bfd913c48910bddf8ff5990b0c156fe8764e9d7dcbd2cad',
    )
  })

  it('keeps governance status out of semantic identity but hashes semantic changes', () => {
    expect(strategyHash({ ...spec, researchStatus: 'candidate' })).toBe(strategyHash(spec))
    expect(strategyHash({ ...spec, economicAssumption: `${spec.economicAssumption} Changed.` }))
      .not.toBe(strategyHash(spec))
    expect(strategyHash({ ...spec, parameters: [...spec.parameters].reverse() }))
      .not.toBe(strategyHash(spec))
  })

  it('produces an idempotent observation id and separates config identity', () => {
    const first = observation('entry', 1)
    const second = observation('entry', 1, {
      payload: { lookback: 20, barIndex: 1 },
    })
    const explanationChanged = observation('entry', 1, { explanation: 'Equivalent display wording.' })
    const changedConfig = observation('entry', 1, { configHash: configHash({ ...config, lookback: 21 }) })

    expect(second.id).toBe(first.id)
    expect(explanationChanged.id).toBe(first.id)
    expect(changedConfig.id).not.toBe(first.id)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.payload)).toBe(true)
  })

  it('rejects unknown research governance status at runtime', () => {
    expect(validateStrategySpec({ ...spec, researchStatus: 'active' })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({
        path: '$.researchStatus',
        code: 'invalid-value',
      })]),
    })
  })
})

describe('strategy, screener, and execution registry', () => {
  it('rejects a strategy that references an unknown execution definition', () => {
    const registry = new StrategyRegistry()
    expect(() => registry.registerStrategy(definition())).toThrowError(
      expect.objectContaining({ code: 'unknown-execution-definition' }),
    )
  })

  it('registers and evaluates a deterministic strategy with validated observations', () => {
    const registry = new StrategyRegistry()
      .registerExecution(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1)
      .registerStrategy(definition())

    const result = registry.evaluateStrategy(spec.id, runInput, config)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      strategyId: spec.id,
      action: 'entry',
      direction: 'long',
      executionDefinitionId: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id,
    })
  })

  it('keeps screener output free of trading-path semantics', () => {
    const registry = new StrategyRegistry()
      .registerScreener({
        kind: 'screener',
        spec: { ...spec, id: 'scr.test-breakout' },
        evaluate: () => ({
          payload: { distanceFromHigh: 0.01 },
          explanation: 'Within one percent of the range high.',
          quality: { level: 'medium', inputStatus: 'complete', limitations: [] },
        }),
      })

    expect(registry.evaluateScreener('scr.test-breakout', runInput, config)).toMatchObject({
      payload: { distanceFromHigh: 0.01 },
    })
    expect(validateScreenerMatch({
      payload: {},
      explanation: 'Invalid transaction-bearing match.',
      quality: { level: 'high', inputStatus: 'complete', limitations: [] },
      action: 'entry',
    })).toMatchObject({ ok: false })
  })

  it('rejects duplicate plugin ids even across strategy and screener kinds', () => {
    const registry = new StrategyRegistry()
      .registerExecution(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1)
      .registerStrategy(definition())

    expect(() => registry.registerStrategy(definition())).toThrowError(StrategyRegistryError)
    expect(() => registry.registerScreener({
      kind: 'screener',
      spec,
      evaluate: () => null,
    })).toThrowError(expect.objectContaining({ code: 'duplicate-plugin-id' }))
  })

  it('isolates plugin failures when evaluating all registered strategies', () => {
    const registry = new StrategyRegistry()
      .registerExecution(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1)
      .registerStrategy(definition())
      .registerStrategy({
        ...definition('test.failing'),
        evaluate: () => { throw new Error('fixture failure') },
      })

    expect(registry.evaluateAllStrategies(runInput, { [spec.id]: config })).toMatchObject({
      [spec.id]: { ok: true },
      'test.failing': { ok: false, error: { message: 'fixture failure' } },
    })
  })
})

describe('runtime validation', () => {
  const executionIds = [NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id]

  it('accepts an alternating, strictly ordered entry/exit sequence', () => {
    expect(() => assertSignalSequence(
      [observation('entry', 0), observation('exit', 2)],
      bars,
      { asOf: runInput.asOf, executionDefinitionIds: executionIds },
    )).not.toThrow()
  })

  it.each([
    ['out of order', [observation('entry', 1), observation('exit', 0)]],
    ['duplicate time', [observation('entry', 1), observation('exit', 1)]],
    ['exit while flat', [observation('exit', 1)]],
  ])('rejects an illegal signal sequence: %s', (_name, signals) => {
    expect(() => assertSignalSequence(signals, bars, {
      asOf: runInput.asOf,
      executionDefinitionIds: executionIds,
    })).toThrowError(StrategyValidationError)
  })

  it('rejects future availability, non-finite payloads, and unknown execution definitions', () => {
    expect(() => assertSignalObservation(observation('entry', 1, {
      availableAt: '2026-08-29T08:00:00.000Z',
    }), { asOf: runInput.asOf, executionDefinitionIds: executionIds })).toThrowError(
      expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: 'future-time' })]) }),
    )

    const withInfinity = { ...observation('entry', 1), payload: { score: Number.POSITIVE_INFINITY } }
    expect(() => assertSignalObservation(withInfinity, { executionDefinitionIds: executionIds }))
      .toThrowError(expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'non-finite-number' })]),
      }))

    expect(() => assertSignalObservation(observation('entry', 1, {
      executionDefinitionId: 'unknown-execution@1',
    }), { executionDefinitionIds: executionIds })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown-execution-definition' })]),
      }),
    )

    expect(() => assertSignalObservation({
      ...observation('entry', 1),
      lifecycleStatus: 'observed',
    }, { executionDefinitionIds: executionIds })).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown-field' })]),
    }))
  })
})

describe('BacktestRun contract', () => {
  const input: BacktestRunInput = {
    engine: 'ngfi-smoke',
    engineVersion: '1.0.0',
    engineTier: 'smoke',
    dataset: { snapshotId: runInput.snapshotId, hash: strategyInputHash(runInput) },
    strategyHash: strategyHash(spec),
    configHash: configHash(config),
    executionHash: executionDefinitionHash(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1),
    costModel: { id: 'zero-cost', version: '1.0.0', hash: configHash({ fees: 0, slippage: 0 }) },
    benchmark: { status: 'not-meaningful', reason: 'Contract fixture does not compare performance.' },
    metrics: {
      totalReturn: { status: 'available', value: 0.05, unit: 'ratio' },
      sharpe: { status: 'insufficient', value: null, reason: 'Too few returns.' },
    },
    artifacts: [{ kind: 'signals', ref: 'artifact:signals.json', hash: configHash({ signals: [] }) }],
    status: 'complete',
    warnings: [],
    startedAt: '2026-08-28T08:00:00.000Z',
    completedAt: '2026-08-28T08:00:01.000Z',
  }

  it('creates a stable run id from reproducibility inputs', () => {
    const first = createBacktestRun(input)
    const second = createBacktestRun({ ...input, completedAt: '2026-08-28T08:00:02.000Z' })
    expect(first.id).toBe(second.id)
    expect(() => assertBacktestRun(first)).not.toThrow()
  })

  it('rejects non-finite metrics and status/value ambiguity', () => {
    expect(() => assertBacktestRun({
      ...createBacktestRun(input),
      metrics: { bad: { status: 'available', value: Number.NaN, unit: 'ratio' } },
    })).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'non-finite-number' })]),
    }))

    expect(() => assertBacktestRun({
      ...createBacktestRun(input),
      metrics: { bad: { status: 'insufficient', value: 0, reason: 'Must stay null.' } },
    })).toThrowError(StrategyValidationError)
  })
})
