export type FieldStatus =
  | 'available'
  | 'missing'
  | 'not-applicable'
  | 'provider-error'
  | 'stale'

export type PeriodType = 'annual' | 'quarterly' | 'ttm' | 'spot' | 'estimate'

export interface ObservationMeta {
  provider: string
  source?: string
  retrievedAt: string
  observedAt?: string
  reportedAt?: string
  fiscalPeriod?: string
  periodType?: PeriodType
  currency?: string
  unit?: string
}

export interface ObservedField<T> {
  status: FieldStatus
  value: T | null
  note?: string
}

export type FinancialFields = Record<string, ObservedField<number>>

export interface SecurityReference {
  ticker: string
  observation: ObservationMeta
  fields: {
    name: ObservedField<string>
    exchange: ObservedField<string>
    country: ObservedField<string>
    sector: ObservedField<string>
    industry: ObservedField<string>
    quoteCurrency: ObservedField<string>
    currentPrice: ObservedField<number>
    sharesOutstanding: ObservedField<number>
    marketCap: ObservedField<number>
    beta: ObservedField<number>
    fiftyTwoWeekLow: ObservedField<number>
    fiftyTwoWeekHigh: ObservedField<number>
  }
}

export interface FundamentalPeriod {
  observation: ObservationMeta
  fields: FinancialFields
}

export interface Fundamentals {
  ticker: string
  ttm: FundamentalPeriod
  annual: FundamentalPeriod[]
  quarterly: FundamentalPeriod[]
}

export interface MarketBar {
  observedAt: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  adjustedClose: number | null
  volume: number | null
}

export interface MarketData {
  ticker: string
  observation: ObservationMeta
  interval: string
  bars: MarketBar[]
  derived: {
    latestClose: ObservedField<number>
    totalReturn: ObservedField<number>
    simpleMovingAverage20: ObservedField<number>
  }
}

export interface EstimateSnapshot {
  ticker: string
  observation: ObservationMeta
  fields: {
    forwardEps: ObservedField<number>
    forwardRevenue: ObservedField<number>
    targetLowPrice: ObservedField<number>
    targetMeanPrice: ObservedField<number>
    targetMedianPrice: ObservedField<number>
    targetHighPrice: ObservedField<number>
    analystCount: ObservedField<number>
    recommendationMean: ObservedField<number>
    recommendationKey: ObservedField<string>
  }
}

export interface ComparableCompany {
  ticker: string
  observation: ObservationMeta
  fields: Record<string, ObservedField<number | string>>
}

export interface FinanceDataProvider {
  securityReference(ticker: string, signal?: AbortSignal): Promise<SecurityReference>
  fundamentals(ticker: string, signal?: AbortSignal): Promise<Fundamentals>
  marketData(
    ticker: string,
    options?: { period?: string; interval?: string; signal?: AbortSignal },
  ): Promise<MarketData>
  estimates(ticker: string, signal?: AbortSignal): Promise<EstimateSnapshot>
  comparables(tickers: string[], signal?: AbortSignal): Promise<ComparableCompany[]>
}
