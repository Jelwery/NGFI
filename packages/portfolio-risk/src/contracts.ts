import type { InstrumentId } from '@finance2dsh/core'
import type { ContentHash } from '@finance2dsh/research-core'

export type HoldingsImportFormat = 'csv' | 'json'
export type HoldingsSnapshotStatus = 'staged' | 'confirmed'
export type RiskQualityStatus = 'ok' | 'degraded' | 'insufficient' | 'invalid' | 'unreconciled'

export interface HoldingPositionInput {
  readonly instrument: InstrumentId
  readonly quantity: number
  readonly marketValue: number
  readonly currency: string
  readonly account?: string
  readonly name?: string
  /** T+1 available-to-sell quantity; when present it must satisfy 0 <= value <= quantity. */
  readonly sellableQuantity?: number
}

export interface HoldingPosition extends HoldingPositionInput {
  readonly id: ContentHash
  readonly account: string
}

/**
 * Account-level state confirmed together with the positions as one unit. Cash,
 * its availability, and the valuation timestamp are hashed into the snapshot so
 * a downstream optimizer cannot confirm only quantities and then receive free
 * cash or sellable quantities from a separate input.
 */
export interface PortfolioAccountState {
  /** Base-currency cash, cent precision, non-negative. */
  readonly cash: number
  /** When the cash figure became known/available. */
  readonly cashAvailableAt: string
  /** When the whole account state (positions + cash) was valued. */
  readonly valuationAt: string
}

export type HoldingsImportIssueCode =
  | 'invalid-syntax'
  | 'invalid-shape'
  | 'missing-field'
  | 'unknown-field'
  | 'invalid-instrument'
  | 'invalid-number'
  | 'invalid-currency'
  | 'duplicate-holding'

export interface HoldingsImportIssue {
  readonly code: HoldingsImportIssueCode
  readonly message: string
  readonly row?: number
  readonly field?: string
}

interface HoldingsImportBase {
  readonly format: HoldingsImportFormat
  readonly portfolioId: string
  readonly asOf: string
  readonly baseCurrency: string
  readonly accountState?: PortfolioAccountState
  readonly inputHash: ContentHash
}

export interface ReadyHoldingsImport extends HoldingsImportBase {
  readonly status: 'ready'
  readonly positions: readonly HoldingPosition[]
  readonly errors: readonly []
}

export interface InvalidHoldingsImport extends HoldingsImportBase {
  readonly status: 'invalid'
  readonly positions: readonly []
  readonly errors: readonly HoldingsImportIssue[]
}

export type HoldingsImportResult = ReadyHoldingsImport | InvalidHoldingsImport

export interface HoldingsSnapshot {
  readonly status: HoldingsSnapshotStatus
  readonly portfolioId: string
  readonly asOf: string
  readonly baseCurrency: string
  readonly accountState?: PortfolioAccountState
  readonly positions: readonly HoldingPosition[]
  readonly totalMarketValue: number
  readonly inputHash: ContentHash
  /** Stable across staged -> confirmed because lifecycle state is excluded. */
  readonly snapshotHash: ContentHash
}

export interface HoldingsBookSnapshot {
  readonly revision: number
  readonly staged: HoldingsSnapshot | null
  readonly confirmed: HoldingsSnapshot | null
}

export interface HoldingsMutationResult {
  readonly revision: number
  readonly changed: boolean
  readonly snapshot: HoldingsSnapshot | null
}

export interface HoldingsStore {
  snapshot(): HoldingsBookSnapshot
  stage(input: ReadyHoldingsImport, expectedRevision: number): HoldingsMutationResult
  confirm(expectedRevision: number, expectedSnapshotHash: ContentHash): HoldingsMutationResult
  discard(expectedRevision: number): HoldingsMutationResult
}

export type Cne6FactorKind = 'country' | 'industry' | 'style'

export interface Cne6Factor {
  readonly name: string
  readonly kind: Cne6FactorKind
}

export interface Cne6SecurityRisk {
  readonly instrument: InstrumentId
  readonly modelCode: string
  readonly exposures: readonly number[]
  /** Daily idiosyncratic volatility. */
  readonly specificRisk: number
}

export interface CovarianceQuality {
  readonly status: 'ok' | 'warning' | 'invalid'
  readonly symmetric: boolean
  readonly positiveSemidefinite: boolean
  readonly maxAsymmetry: number
  readonly minEigenvalue: number
  readonly maxEigenvalue: number
  readonly conditionNumber: number | null
  readonly stockReconciliationMaxError: number
  readonly issues: readonly string[]
}

export interface Cne6ModelCoverage {
  readonly universeCount: number
  readonly exposureCount: number
  readonly specificRiskCount: number
}

/** JSON-safe, read-only projection of an existing CNE6 pipeline result. */
export interface Cne6ModelSnapshot {
  readonly schemaVersion: '1'
  readonly model: 'CNE6'
  readonly modelVersion: string
  readonly asOf: string
  readonly currency: 'CNY'
  readonly covariancePeriod: 'daily'
  readonly factors: readonly Cne6Factor[]
  readonly securities: readonly Cne6SecurityRisk[]
  readonly factorCovariance: readonly (readonly number[])[]
  readonly stockCovariance: readonly (readonly number[])[]
  readonly coverage: Cne6ModelCoverage
  readonly inputHash: ContentHash
  readonly quality: CovarianceQuality
  readonly sourceQuality?: { readonly quality_flag: string; readonly coverage: number | null; readonly status?: string; readonly proxyFlags?: readonly string[] }
  readonly descriptorQuality?: Readonly<Record<string, unknown>>
  readonly dataQuality?: Readonly<Record<string, unknown>>
  readonly availableAt?: string
}

export type PortfolioRiskIssueCode =
  | 'holdings-not-confirmed'
  | 'invalid-holdings'
  | 'as-of-mismatch'
  | 'currency-conflict'
  | 'unmapped-security'
  | 'coverage-insufficient'
  | 'invalid-model'
  | 'covariance-quality'
  | 'reconciliation-failed'
  | 'invalid-proposal'
  | 'unknown-factor'

export interface PortfolioRiskIssue {
  readonly code: PortfolioRiskIssueCode
  readonly message: string
  readonly instruments?: readonly InstrumentId[]
  readonly factors?: readonly string[]
}

export interface PortfolioCoverage {
  readonly positionCount: number
  readonly mappedPositionCount: number
  readonly positionCoverage: number
  readonly marketValue: number
  readonly mappedMarketValue: number
  readonly marketValueCoverage: number
  readonly unmappedInstruments: readonly InstrumentId[]
}

export interface RiskResultMetadata {
  readonly model: 'CNE6'
  readonly modelVersion: string
  readonly asOf: string
  readonly coverage: PortfolioCoverage
  readonly inputHash: ContentHash
  readonly qualityStatus: RiskQualityStatus
  readonly covarianceQuality: CovarianceQuality
  readonly sourceQuality: Cne6ModelSnapshot['sourceQuality']
  readonly descriptorQuality: Readonly<Record<string, unknown>>
}

export interface FactorExposure {
  readonly factor: string
  readonly kind: Cne6FactorKind
  readonly exposure: number
}

export interface FactorRiskContribution extends FactorExposure {
  readonly varianceContribution: number
}

export interface HoldingRiskContribution {
  readonly holdingId: ContentHash
  readonly instrument: InstrumentId
  readonly account: string
  readonly weight: number
  readonly marginalVariance: number
  readonly marginalVolatility: number
  readonly varianceContribution: number
  readonly volatilityContribution: number
}

export interface ReconciliationCheck {
  readonly status: 'ok' | 'failed' | 'not-run'
  readonly difference: number | null
  readonly tolerance: number
}

export interface PortfolioRiskReconciliation {
  readonly holdings: ReconciliationCheck
  readonly exposure: ReconciliationCheck
  readonly covariance: ReconciliationCheck
  readonly risk: ReconciliationCheck
  readonly status: 'ok' | 'failed'
}

export interface PortfolioRiskMetrics {
  readonly totalVariance: number
  readonly factorVariance: number
  readonly specificVariance: number
  readonly totalRisk: number
  readonly factorRisk: number
  readonly specificRisk: number
  readonly exposures: readonly FactorExposure[]
  readonly factorContributions: readonly FactorRiskContribution[]
  readonly holdingContributions: readonly HoldingRiskContribution[]
}

export interface PortfolioRiskResult {
  readonly status: 'ok' | 'rejected'
  readonly metadata: RiskResultMetadata
  readonly issues: readonly PortfolioRiskIssue[]
  readonly reconciliation: PortfolioRiskReconciliation
  readonly risk: PortfolioRiskMetrics | null
}

export interface ProposedPortfolio {
  readonly portfolioId: string
  readonly asOf: string
  readonly baseCurrency: string
  readonly positions: readonly HoldingPositionInput[]
}

export interface MarginalRiskChange {
  readonly instrument: InstrumentId
  readonly account: string
  readonly beforeWeight: number
  readonly afterWeight: number
  readonly beforeMarginalVolatility: number | null
  readonly afterMarginalVolatility: number | null
  readonly marginalVolatilityChange: number | null
}

export interface MarginalRiskResult {
  readonly status: 'ok' | 'rejected'
  readonly metadata: RiskResultMetadata
  readonly issues: readonly PortfolioRiskIssue[]
  readonly before: PortfolioRiskMetrics | null
  readonly after: PortfolioRiskMetrics | null
  readonly totalRiskChange: number | null
  readonly changes: readonly MarginalRiskChange[]
}

export interface FactorShock {
  readonly factor: string
  /** Explicit factor return shock in decimal return units. */
  readonly shock: number
}

export interface ScenarioDefinition {
  readonly id: string
  readonly shocks: readonly FactorShock[]
}

export interface ScenarioPositionImpact {
  readonly holdingId: ContentHash
  readonly instrument: InstrumentId
  readonly returnImpact: number
  readonly valueImpact: number
}

export interface ScenarioStressResult {
  readonly status: 'ok' | 'rejected'
  readonly metadata: RiskResultMetadata
  readonly issues: readonly PortfolioRiskIssue[]
  readonly scenarioId: string
  readonly portfolioReturn: number | null
  readonly portfolioValueImpact: number | null
  readonly factorImpacts: readonly { factor: string; exposure: number; shock: number; returnImpact: number }[]
  readonly positionImpacts: readonly ScenarioPositionImpact[]
}
