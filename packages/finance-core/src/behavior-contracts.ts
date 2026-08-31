import type { FieldStatus, MarketData, ObservationMeta, ObservedField } from './contracts.js'

export type BehaviorWindow = 20 | 60 | 120 | 252
export type EvidenceStatus = 'available' | 'partial' | 'insufficient-data' | 'provider-error'
export type CalculatedEvidenceStatus = Exclude<EvidenceStatus, 'provider-error'>

export interface BehaviorMarketMetrics {
  periodReturn: ObservedField<number>
  benchmarkReturn: ObservedField<number>
  excessReturn: ObservedField<number>
  maximumDrawdown: ObservedField<number>
  annualizedVolatility: ObservedField<number>
  distanceFromWindowHigh: ObservedField<number>
  distanceFromWindowLow: ObservedField<number>
  momentum20: ObservedField<number>
  momentum60: ObservedField<number>
  momentum120: ObservedField<number>
  momentum252: ObservedField<number>
  recentVolumeChange: ObservedField<number>
}

export interface BehaviorMarketEvidence {
  status: CalculatedEvidenceStatus
  ticker: string
  benchmark: string | null
  window: BehaviorWindow
  observation: {
    target: ObservationMeta
    benchmark: ObservationMeta | null
  }
  coverage: {
    targetBarsReceived: number
    targetValidCloses: number
    targetMissingCloseRatio: number
    benchmarkBarsReceived: number | null
    alignedBenchmarkObservations: number | null
    startAt: string | null
    endAt: string | null
  }
  metrics: BehaviorMarketMetrics
  metricUnit: 'decimal-return-or-ratio'
  diagnosticCaveat: string
  limitations: string[]
}

export interface BehaviorProviderError {
  request: 'target' | 'benchmark'
  ticker: string
  kind: string | null
  message: string
  retryable: boolean | null
}

export interface BehaviorMarketEvidenceProviderError {
  status: 'provider-error'
  ticker: string
  benchmark: string | null
  window: BehaviorWindow
  observation: {
    target: ObservationMeta | null
    benchmark: ObservationMeta | null
  }
  providerErrors: BehaviorProviderError[]
  diagnosticCaveat: string
  limitations: string[]
}

export type BehaviorMarketEvidenceResult =
  | BehaviorMarketEvidence
  | BehaviorMarketEvidenceProviderError

export interface BehaviorMarketEvidenceInput {
  target: MarketData
  benchmark?: MarketData
  window: BehaviorWindow
}

export interface CompletedTradeRecord {
  id: string
  ticker: string
  openedAt: string
  closedAt: string
  entryPrice: number
  exitPrice: number
  side?: 'long' | 'short'
  quantity?: number
  fees?: number
  rationale?: string
  plannedHorizonDays?: number
  confidence?: number
  ruleFollowed?: boolean
}

export interface SaleOpportunitySet {
  id: string
  observedAt: string
  realizedGains: number
  realizedLosses: number
  paperGains: number
  paperLosses: number
}

export interface TradeGroupStatistics {
  count: number
  meanReturn: number | null
  medianReturn: number | null
  meanHoldingDays: number | null
  medianHoldingDays: number | null
}

export interface DispositionOpportunityMetrics {
  status: FieldStatus
  pgr: number | null
  plr: number | null
  spread: number | null
  opportunityDates: number
  note: string
}

export interface BehaviorTradeAudit {
  status: CalculatedEvidenceStatus
  sample: {
    records: number
    winners: number
    losers: number
    flat: number
    startAt: string | null
    endAt: string | null
  }
  completeness: {
    quantity: number
    fees: number
    rationale: number
    plannedHorizon: number
    confidence: number
    ruleFollowed: number
  }
  allTrades: TradeGroupStatistics
  winningTrades: TradeGroupStatistics
  losingTrades: TradeGroupStatistics
  activity: {
    completedTradesPer30Days: ObservedField<number>
    medianDaysBetweenEntries: ObservedField<number>
    medianSameTickerReentryDays: ObservedField<number>
  }
  aggregate: {
    grossPnl: ObservedField<number>
    netPnl: ObservedField<number>
    feeDrag: ObservedField<number>
    ruleAdherenceRate: ObservedField<number>
    meanReturn95Ci: ObservedField<[number, number]>
  }
  dispositionOpportunityMetrics: DispositionOpportunityMetrics
  diagnosticCaveat: string
  limitations: string[]
}

export interface BehaviorTradeAuditInput {
  records: CompletedTradeRecord[]
  opportunitySets?: SaleOpportunitySet[]
  lotMatchingAssumption?: string
}
