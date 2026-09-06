import type { JsonObject } from '@finance2dsh/strategy-core'

export interface AccumulationBreakoutConfig extends JsonObject {
  readonly boxMinBars: number
  readonly boxMaxBars: number
  readonly boxMaxAmplitude: number
  readonly breakoutWindowBars: number
  readonly breakoutVolumeRatio: number
  readonly breakoutChangeMin: number
  readonly breakoutChangeMax: number
  readonly recentVolumeRatio: number
  readonly requireMa60: boolean
  readonly maxPullbacks: number
  readonly pullbackTolerance: number
  readonly boxMaxMidDrawdown: number
  readonly trendLookbackBars: number
  readonly trendMaxDrop: number
}

export interface AccumulationBreakoutDetection extends JsonObject {
  readonly matched: boolean
  readonly breakoutIndex: number | null
  readonly boxStartIndex: number | null
  readonly boxEndIndex: number | null
  readonly boxDays: number
  readonly boxHigh: number | null
  readonly boxLow: number | null
  readonly boxAmplitude: number | null
  readonly breakoutVolumeRatio: number | null
  readonly breakoutChange: number | null
  readonly recentVolumeRatio: number | null
  readonly ma5: number | null
  readonly ma20: number | null
  readonly ma60: number | null
  readonly positionDrawdown: number | null
  readonly trendReturn: number | null
  readonly pullbacks: number
  readonly conditions: {
    readonly box: boolean
    readonly flat: boolean
    readonly structure: boolean
    readonly breakout: boolean
    readonly volume: boolean
    readonly change: boolean
    readonly movingAverages: boolean
    readonly ma60: boolean
    readonly position: boolean
    readonly trend: boolean
    readonly retest: boolean
  }
  readonly reasons: readonly string[]
}
