import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1,
  StrategyRegistry,
  runSmokeBacktest,
  type CanonicalBar,
  type StrategyRunInput,
} from '@finance2dsh/strategy-core'
import {
  ACCUMULATION_BREAKOUT_STRATEGY_V1,
  ACCUMULATION_BREAKOUT_V1_SPEC,
  DEFAULT_ACCUMULATION_BREAKOUT_CONFIG,
  detectAccumulationBreakout,
} from '@finance2dsh/strategy-accumulation-breakout'

interface Fixture {
  readonly instrument: StrategyRunInput['instrument']
  readonly interval: string
  readonly adjustment: StrategyRunInput['adjustment']
  readonly snapshotId: string
  readonly asOf: string
  readonly bars: CanonicalBar[]
  readonly config: typeof DEFAULT_ACCUMULATION_BREAKOUT_CONFIG
  readonly contractExpected: {
    readonly strategyId: string
    readonly strategyVersion: string
    readonly researchStatus: string
    readonly executionDefinitionId: string
    readonly strategyHash: string
    readonly inputHash: string
    readonly configHash: string
    readonly observationId: string
    readonly signalAt: string
    readonly confirmationPrice: number
    readonly payload: Record<string, unknown>
  }
  readonly upstreamExpected: {
    readonly is_breakout: boolean
    readonly box_days: number
    readonly box_amp: number
    readonly box_high: number
    readonly box_low: number
    readonly breakout_date: string
    readonly breakout_vol_ratio: number
    readonly breakout_pct_chg: number
    readonly hold_pullbacks: number
    readonly cond_ma60: boolean
    readonly cond_position: boolean
  }
}

const fixture = JSON.parse(readFileSync(
  new URL('../evals/strategy-contracts/accumulation-breakout-v1.json', import.meta.url),
  'utf8',
)) as Fixture

function input(bars: readonly CanonicalBar[] = fixture.bars): StrategyRunInput {
  return {
    instrument: fixture.instrument,
    interval: fixture.interval,
    adjustment: fixture.adjustment,
    snapshotId: fixture.snapshotId,
    asOf: fixture.asOf,
    bars,
  }
}

function registry(): StrategyRegistry {
  return new StrategyRegistry()
    .registerExecution(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1)
    .registerStrategy(ACCUMULATION_BREAKOUT_STRATEGY_V1)
}

describe('accumulation-breakout v1', () => {
  it('stays experimental and pins its execution semantics', () => {
    expect(ACCUMULATION_BREAKOUT_V1_SPEC).toMatchObject({
      id: 'accumulation-breakout.v1', version: '1.0.0', researchStatus: 'experimental',
    })
    expect(ACCUMULATION_BREAKOUT_STRATEGY_V1.executionDefinitionId)
      .toBe(NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id)
  })

  it('matches the upstream seed=42 golden behavior on canonical bars', () => {
    expect(fixture.config).toEqual(DEFAULT_ACCUMULATION_BREAKOUT_CONFIG)
    const detected = detectAccumulationBreakout(fixture.bars, fixture.config)
    expect(detected.matched).toBe(fixture.upstreamExpected.is_breakout)
    expect(detected.boxDays).toBe(fixture.upstreamExpected.box_days)
    expect(detected.boxAmplitude).toBeCloseTo(fixture.upstreamExpected.box_amp, 12)
    expect(detected.boxHigh).toBeCloseTo(fixture.upstreamExpected.box_high, 12)
    expect(detected.boxLow).toBeCloseTo(fixture.upstreamExpected.box_low, 12)
    expect(detected.breakoutVolumeRatio).toBeCloseTo(fixture.upstreamExpected.breakout_vol_ratio, 12)
    expect(detected.breakoutChange).toBeCloseTo(fixture.upstreamExpected.breakout_pct_chg, 12)
    expect(detected.breakoutIndex).toBe(fixture.bars.length - 1)
    expect((fixture.bars[detected.breakoutIndex as number] as CanonicalBar).closeAt.startsWith(
      fixture.upstreamExpected.breakout_date,
    )).toBe(true)
    expect(detected.pullbacks).toBe(fixture.upstreamExpected.hold_pullbacks)
    expect(detected.conditions.ma60).toBe(fixture.upstreamExpected.cond_ma60)
    expect(detected.conditions.position).toBe(fixture.upstreamExpected.cond_position)
  })

  it('emits one canonical SignalObservation with complete condition diagnostics', () => {
    const observations = registry().evaluateStrategy(ACCUMULATION_BREAKOUT_V1_SPEC.id, input())
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      id: fixture.contractExpected.observationId,
      strategyId: fixture.contractExpected.strategyId,
      strategyHash: fixture.contractExpected.strategyHash,
      inputHash: fixture.contractExpected.inputHash,
      configHash: fixture.contractExpected.configHash,
      signalAt: fixture.contractExpected.signalAt,
      confirmationPrice: fixture.contractExpected.confirmationPrice,
      payload: fixture.contractExpected.payload,
    })
    expect(observations[0]).toMatchObject({
      strategyId: ACCUMULATION_BREAKOUT_V1_SPEC.id,
      action: 'entry',
      direction: 'long',
      confirmationPrice: fixture.bars.at(-1)?.close,
      executionDefinitionId: NEXT_TRADABLE_BAR_OPEN_EXECUTION_V1.id,
      payload: {
        boxDays: fixture.upstreamExpected.box_days,
        pullbacks: 0,
        conditions: {
          box: true, flat: true, structure: true, breakout: true, volume: true, change: true,
          movingAverages: true, ma60: true, position: true, trend: true, retest: true,
        },
      },
    })
  })

  it('does not let future bars rewrite the historical observation', () => {
    const base = registry().evaluateStrategy(ACCUMULATION_BREAKOUT_V1_SPEC.id, input())
    const last = fixture.bars.at(-1) as CanonicalBar
    const future: CanonicalBar = {
      openAt: '2026-04-30T01:30:00.000Z',
      closeAt: '2026-04-30T07:00:00.000Z',
      availableAt: '2026-04-30T07:00:01.000Z',
      open: last.close, high: (last.close as number) * 1.01, low: 9.5, close: 9.6, volume: 1_000,
    }
    const extendedInput = { ...input([...fixture.bars, future]), asOf: '2026-04-30T08:00:00.000Z' }
    const extended = registry().evaluateStrategy(ACCUMULATION_BREAKOUT_V1_SPEC.id, extendedInput)
    expect(extended).toHaveLength(1)
    expect(extended[0]?.signalAt).toBe(base[0]?.signalAt)
    expect(extended[0]?.payload).toEqual(base[0]?.payload)
    expect(extended[0]?.inputHash).not.toBe(base[0]?.inputHash)
  })

  it('changes config identity without changing strategy identity', () => {
    const first = registry().evaluateStrategy(ACCUMULATION_BREAKOUT_V1_SPEC.id, input())
    const second = registry().evaluateStrategy(ACCUMULATION_BREAKOUT_V1_SPEC.id, input(), {
      breakoutVolumeRatio: 1.5,
    })
    expect(second).toHaveLength(1)
    expect(second[0]?.strategyHash).toBe(first[0]?.strategyHash)
    expect(second[0]?.configHash).not.toBe(first[0]?.configHash)
  })

  it('fails closed for insufficient or gapped data and enforces position/retest filters', () => {
    expect(registry().evaluateStrategy(ACCUMULATION_BREAKOUT_V1_SPEC.id, input(fixture.bars.slice(-20))))
      .toEqual([])
    const gapped = fixture.bars.map((bar, index) => index === 80 ? { ...bar, volume: null } : bar)
    expect(registry().evaluateStrategy(ACCUMULATION_BREAKOUT_V1_SPEC.id, input(gapped))).toEqual([])

    const deepPosition = fixture.bars.map((bar, index) => index < 70
      ? { ...bar, open: (bar.open as number) + 4, high: (bar.high as number) + 4, low: (bar.low as number) + 4, close: (bar.close as number) + 4 }
      : bar)
    expect(detectAccumulationBreakout(deepPosition, DEFAULT_ACCUMULATION_BREAKOUT_CONFIG).conditions.position)
      .toBe(false)

    const brokenRetest = [...fixture.bars, {
      openAt: '2026-04-30T01:30:00.000Z', closeAt: '2026-04-30T07:00:00.000Z', availableAt: '2026-04-30T07:00:01.000Z',
      open: 10.6, high: 10.7, low: 9.5, close: 9.6, volume: 1_000,
    } satisfies CanonicalBar]
    const detection = detectAccumulationBreakout(brokenRetest, DEFAULT_ACCUMULATION_BREAKOUT_CONFIG)
    expect(detection.matched).toBe(false)
    expect(detection.pullbacks).toBe(1)
    expect(detection.conditions.retest).toBe(false)
  })

  it('isolates this strategy from failures in another registered plugin', () => {
    const failing: typeof ACCUMULATION_BREAKOUT_STRATEGY_V1 = {
      ...ACCUMULATION_BREAKOUT_STRATEGY_V1,
      spec: { ...ACCUMULATION_BREAKOUT_V1_SPEC, id: 'fixture.failing' },
      evaluate: () => { throw new Error('isolated fixture failure') },
    }
    const results = registry().registerStrategy(failing).evaluateAllStrategies(input())
    expect(results[ACCUMULATION_BREAKOUT_V1_SPEC.id]).toMatchObject({ ok: true })
    expect(results['fixture.failing']).toEqual({
      ok: false, error: { name: 'Error', message: 'isolated fixture failure' },
    })
  })

  it('runs the golden signal through the smoke engine at the next bar open', () => {
    const nextBar: CanonicalBar = {
      openAt: '2026-04-30T01:30:00.000Z', closeAt: '2026-04-30T07:00:00.000Z', availableAt: '2026-04-30T07:00:01.000Z',
      open: 10.8, high: 11.1, low: 10.7, close: 11, volume: 1_500,
    }
    const smokeInput = { ...input([...fixture.bars, nextBar]), asOf: '2026-04-30T08:00:00.000Z' }
    const result = runSmokeBacktest({
      input: smokeInput, strategy: ACCUMULATION_BREAKOUT_STRATEGY_V1, options: { feeRate: 0.001, slippageRate: 0.0005 },
    })
    expect(result.engineTier).toBe('smoke')
    expect(result.promotionEligible).toBe(false)
    expect(result.terminalPosition).toMatchObject({ status: 'open', entryBarIndex: fixture.bars.length })
    expect(result.terminalPosition.status === 'open' && result.terminalPosition.entryPrice)
      .toBeCloseTo(10.8 * 1.0005, 12)
  })
})
