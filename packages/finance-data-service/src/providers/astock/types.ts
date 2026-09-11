import type {
  AdjustmentMode,
  DataField,
  InstrumentId,
} from '@finance2dsh/core'

export const ASTOCK_PROVIDER_ID = 'a-stock-public' as const
export const ASTOCK_PROTOCOL_VERSION = '1' as const

export const ASTOCK_CAPABILITIES = [
  'instrument-reference',
  'quote',
  'market-bars',
  'order-book',
  'fundamentals',
  'corporate-actions',
  'disclosures',
  'research-consensus',
  'capital-flow',
  'market-signal',
  'industry-classification',
  'index',
  'macro',
  'trading-calendar',
  'risk-data',
] as const

export type AStockCapability = typeof ASTOCK_CAPABILITIES[number]
export type AStockSource = 'fixture' | 'public-web'

/** Stable detail codes layered on top of finance-core's routing taxonomy. */
export const ASTOCK_ERROR_CODES = [
  'invalid-request',
  'input-limit',
  'output-limit',
  'unsupported-operation',
  'unsupported-source',
  'no-data',
  'unauthorized',
  'insufficient-permission',
  'rate-limited',
  'provider-error',
  'schema-drift',
  'fixture-schema',
  'protocol-error',
  'spawn-error',
  'process-error',
  'timeout',
  'transport',
  'aborted',
] as const

export type AStockErrorCode = typeof ASTOCK_ERROR_CODES[number]

export interface AStockProviderOptions {
  source?: AStockSource
  /** Required only for deterministic recorded-fixture execution. */
  fixtureRoot?: string
  projectRoot?: string
  pythonRunner?: string
  pythonExecutable?: string
  pythonArgs?: string[]
  /** Parent environment used only as input to the child allowlist. */
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  killGraceMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxRecords?: number
  maxDateSpanDays?: number
  networkTimeoutMs?: number
  /** Minimum delay between starts for this provider instance. */
  minRequestIntervalMs?: number
}

export interface AStockFeatureParams {
  featureId: string
  variant?: string
  limit?: number
  instrument?: InstrumentId
  asOf?: string
  startDate?: string
  endDate?: string
  tradeDate?: string
  interval?: '1m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1wk' | '1mo'
  adjustment?: AdjustmentMode
  officialProvider?: 'csi' | 'cni'
  industryCode?: string
  boardType?: 'industry' | 'concept' | 'region'
  period?: string
  year?: number
  page?: number
  lookbackDays?: number
  forwardDays?: number
  category?: string
  statement?: 'lrb' | 'fzb' | 'llb'
  searchText?: string
  channel?: 'report' | 'announcement' | 'news'
  underlying?: string
  optionCode?: string
  optionType?: 'call' | 'put'
}

export interface AStockInstrumentParams {
  symbol: string
  exchange?: 'SSE' | 'SZSE' | 'BSE'
  assetType?: 'equity' | 'index' | 'etf' | 'fund' | 'bond'
}

export interface AStockBarsParams {
  startDate: string
  endDate: string
  adjustment?: AdjustmentMode
  interval?: '1d'
  limit?: number
}

export interface AStockFundamentalsParams {
  limit?: number
  statement?: 'income'
}

export interface AStockDisclosuresParams {
  startDate: string
  endDate: string
  limit?: number
}

export interface AStockIndexParams {
  limit?: number
  officialProvider?: 'csi' | 'cni'
}

export interface AStockCalendarParams {
  exchange: 'SSE' | 'SZSE' | 'BSE'
  startDate: string
  endDate: string
  limit?: number
}

export interface AStockQuote {
  instrument: InstrumentId
  tradingDate: string
  observedAt: string
  currency: 'CNY'
  fields: {
    name: DataField<string>
    open: DataField<number>
    high: DataField<number>
    low: DataField<number>
    last: DataField<number>
    previousClose: DataField<number>
    volume: DataField<number>
    turnover: DataField<number>
  }
}

export interface AStockBar {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  turnover: number | null
}

export interface AStockBars {
  instrument: InstrumentId
  interval: '1d'
  adjustment: AdjustmentMode
  startDate: string
  endDate: string
  bars: AStockBar[]
  returned: number
  truncated: boolean
}

export interface AStockFundamentalPeriod {
  fiscalPeriod: string
  publishedAt: string | null
  availableAt: string | null
  currency: 'CNY'
  unit: string
  scope: 'consolidated' | 'parent'
  fields: Record<string, DataField<number>>
}

export interface AStockFundamentals {
  instrument: InstrumentId
  periods: AStockFundamentalPeriod[]
  returned: number
  truncated: boolean
  pitSafe: boolean
}

export interface AStockDisclosure {
  id: string
  title: string
  category: string
  publishedAt: string
  documentRef: string
}

export interface AStockDisclosures {
  instrument: InstrumentId
  items: AStockDisclosure[]
  returned: number
  truncated: boolean
}

export interface AStockIndexConstituent {
  instrument: InstrumentId
  name: string
  weight: DataField<number>
}

export interface AStockIndexData {
  instrument: InstrumentId
  asOf: string
  constituents: AStockIndexConstituent[]
  returned: number
  truncated: boolean
}

export interface AStockTradingDay {
  date: string
  isTradingDay: boolean
  session: string | null
}

export interface AStockTradingCalendar {
  exchange: 'SSE' | 'SZSE' | 'BSE'
  startDate: string
  endDate: string
  days: AStockTradingDay[]
  returned: number
  truncated: boolean
}
