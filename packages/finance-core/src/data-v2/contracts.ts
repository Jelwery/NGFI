/** Canonical market and venue identifiers stay extensible for future providers. */
export type Market = 'CN' | 'HK' | 'US' | (string & {})
export type Exchange =
  | 'SSE'
  | 'SZSE'
  | 'BSE'
  | 'HKEX'
  | 'NASDAQ'
  | 'NYSE'
  | (string & {})
export type AssetType =
  | 'equity'
  | 'index'
  | 'etf'
  | 'fund'
  | 'option'
  | 'bond'
  | (string & {})

export interface InstrumentId {
  market: Market
  exchange: Exchange
  symbol: string
  assetType: AssetType
}

export interface InstrumentReferenceV2 {
  id: InstrumentId
  canonical: string
  name: DataField<string>
  quoteCurrency: DataField<string>
  providerSymbols: Record<string, string>
  cik?: string
  figi?: string
  isin?: string
}

export const DATA_CAPABILITIES = [
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

export type DataCapability = typeof DATA_CAPABILITIES[number]

/** Status for a field or complete provider response. */
export const DATA_STATUSES = [
  'available',
  'missing',
  'not-applicable',
  'no-data',
  'unsupported',
  'unauthorized',
  'insufficient-permission',
  'rate-limited',
  'provider-error',
  'schema-drift',
  'stale',
  'partial',
] as const

/** A backwards-compatible superset of the original FieldStatus contract. */
export type DataStatus = typeof DATA_STATUSES[number]

export type FieldStatusV2 = DataStatus
export type DataFieldStatus = DataStatus

export interface DataField<T> {
  status: DataStatus
  value: T | null
  note?: string
}

export type ObservedFieldV2<T> = DataField<T>

export const SOURCE_KINDS = [
  'official',
  'licensed',
  'community',
  'public-web',
  'derived',
  'user',
] as const

export type SourceKind = typeof SOURCE_KINDS[number]

export const ADJUSTMENT_MODES = ['none', 'qfq', 'hfq'] as const
export type AdjustmentMode = typeof ADJUSTMENT_MODES[number]

export type FallbackOutcome = 'selected' | 'success' | 'failed' | 'skipped' | 'rejected'

export interface FallbackAttempt {
  provider: string
  outcome: FallbackOutcome | (string & {})
  reason?: string
  qualityTier?: string
  qualityDowngrade?: boolean
}

export interface DerivedDataLineage {
  inputRefs: string[]
  algorithm: string
  algorithmVersion: string
  methodology?: string
}

export interface DataProvenance {
  /** Provider selected by the caller, when the request was not automatic. */
  requestedProvider?: string
  /** Actual provider. Kept alongside provider for explicit routing provenance. */
  actualProvider: string
  provider: string
  upstreamSource: string
  sourceKind: SourceKind
  sourceUrl?: string
  fetchedAt: string
  observedAt?: string
  publishedAt?: string
  availableAt?: string
  fiscalPeriod?: string
  timezone?: string
  currency?: string
  unit?: string
  adjustment?: AdjustmentMode
  upstreamVersion?: string
  upstreamCommit?: string
  fallbackChain: FallbackAttempt[]
  qualityTier?: string
  qualityDowngrade?: boolean
  derived?: DerivedDataLineage
}

export interface CapabilityRequest<
  P = Readonly<Record<string, unknown>>,
> {
  capability: DataCapability
  market: Market
  instrument?: InstrumentId
  asOf?: string
  params?: P
  signal?: AbortSignal
}

export interface CanonicalDataResult<T> {
  status: DataStatus
  data: T | null
  provenance: DataProvenance
  warnings: string[]
}

export type CanonicalResult<T> = CanonicalDataResult<T>

export const PROVIDER_HEALTH_STATUSES = [
  'healthy',
  'degraded',
  'unavailable',
  'dormant',
  'unauthorized',
  'unsupported-platform',
  'circuit-open',
] as const

export type ProviderHealthStatus = typeof PROVIDER_HEALTH_STATUSES[number]

export interface ProviderHealth {
  providerId: string
  status: ProviderHealthStatus
  checkedAt: string
  message?: string
  retryAfterMs?: number
  capabilities?: Partial<Record<DataCapability, ProviderHealthStatus>>
}

export interface InstrumentReferenceProvider {
  instrumentReference(
    request: CapabilityRequest,
  ): Promise<CanonicalDataResult<InstrumentReferenceV2>>
}

export interface QuoteProvider {
  quote<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface MarketBarsProvider {
  marketBars<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface OrderBookProvider {
  orderBook<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface FundamentalsProvider {
  fundamentalsV2<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface CorporateActionsProvider {
  corporateActions<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface DisclosureProvider {
  disclosures<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface ResearchConsensusProvider {
  researchConsensus<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface CapitalFlowProvider {
  capitalFlow<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface MarketSignalProvider {
  marketSignal<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface IndustryClassificationProvider {
  industryClassification<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface IndexProvider {
  indexData<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface MacroProvider {
  macroData<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface TradingCalendarProvider {
  tradingCalendar<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}

export interface RiskDataProvider {
  riskData<T = unknown>(request: CapabilityRequest): Promise<CanonicalDataResult<T>>
}
