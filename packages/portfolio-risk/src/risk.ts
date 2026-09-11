import { canonicalInstrumentId, type InstrumentId } from '@finance2dsh/core'
import type { ContentHash } from '@finance2dsh/research-core'

import type {
  Cne6ModelSnapshot,
  CovarianceQuality,
  FactorExposure,
  FactorRiskContribution,
  HoldingPosition,
  HoldingPositionInput,
  HoldingRiskContribution,
  HoldingsSnapshot,
  MarginalRiskChange,
  MarginalRiskResult,
  PortfolioCoverage,
  PortfolioRiskIssue,
  PortfolioRiskMetrics,
  PortfolioRiskReconciliation,
  PortfolioRiskResult,
  ProposedPortfolio,
  ReconciliationCheck,
  RiskQualityStatus,
  RiskResultMetadata,
  ScenarioDefinition,
  ScenarioStressResult,
} from './contracts.js'
import { canonicalJson, holdingId, holdingKey, holdingsSnapshotHash, portfolioHash } from './identity.js'

const DEFAULT_TOLERANCE = 1e-10
const HASH_RE = /^sha256:[0-9a-f]{64}$/u

export interface PortfolioRiskOptions {
  readonly minimumPositionCoverage?: number
  readonly minimumMarketValueCoverage?: number
  readonly reconciliationTolerance?: number
}

interface PreparedModel {
  readonly model: Cne6ModelSnapshot
  readonly securityIndex: ReadonlyMap<string, number>
  readonly factorIndex: ReadonlyMap<string, number>
  readonly validationIssues: readonly PortfolioRiskIssue[]
  readonly computedStockReconciliationError: number
}

interface PreparedPortfolio {
  readonly positions: readonly HoldingPosition[]
  readonly weights: readonly number[]
  readonly mappedIndexes: readonly (number | null)[]
  readonly coverage: PortfolioCoverage
  readonly issues: readonly PortfolioRiskIssue[]
}

interface Calculation {
  readonly metrics: PortfolioRiskMetrics
  readonly reconciliation: PortfolioRiskReconciliation
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function dot(left: readonly number[], right: readonly number[]): number {
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += (left[index] as number) * (right[index] as number)
  return total
}

function matVec(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  return matrix.map(row => dot(row, vector))
}

function maximumDifference(left: readonly number[], right: readonly number[]): number {
  let maximum = 0
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] as number) - (right[index] as number)))
  }
  return maximum
}

function check(difference: number, tolerance: number): ReconciliationCheck {
  return { status: difference <= tolerance ? 'ok' : 'failed', difference, tolerance }
}

function failedReconciliation(tolerance: number): PortfolioRiskReconciliation {
  const notRun: ReconciliationCheck = { status: 'not-run', difference: null, tolerance }
  return { holdings: notRun, exposure: notRun, covariance: notRun, risk: notRun, status: 'failed' }
}

function immutableCopy<T>(value: T): T {
  const copy = JSON.parse(canonicalJson(value)) as T
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item as Record<string, unknown>)) freeze(child)
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}

function maxAsymmetry(matrix: readonly (readonly number[])[]): number {
  let maximum = 0
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < row; column += 1) {
      maximum = Math.max(maximum, Math.abs((matrix[row]?.[column] as number) - (matrix[column]?.[row] as number)))
    }
  }
  return maximum
}

function stockCovarianceError(model: Cne6ModelSnapshot): number {
  let maximum = 0
  for (let row = 0; row < model.securities.length; row += 1) {
    const left = model.securities[row] as Cne6ModelSnapshot['securities'][number]
    for (let column = 0; column < model.securities.length; column += 1) {
      const right = model.securities[column] as Cne6ModelSnapshot['securities'][number]
      const expected = dot(left.exposures, matVec(model.factorCovariance, right.exposures))
        + (row === column ? left.specificRisk ** 2 : 0)
      maximum = Math.max(maximum, Math.abs(expected - (model.stockCovariance[row]?.[column] as number)))
    }
  }
  return maximum
}

function isPositiveSemidefinite(matrix: readonly (readonly number[])[], tolerance: number): boolean {
  const n = matrix.length
  const lower = Array.from({ length: n }, () => Array<number>(n).fill(0))
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row]?.[column] as number
      for (let inner = 0; inner < column; inner += 1) {
        value -= (lower[row]?.[inner] as number) * (lower[column]?.[inner] as number)
      }
      if (row === column) {
        if (value < -tolerance) return false
        lower[row]![column] = Math.sqrt(Math.max(value, 0))
      } else {
        const pivot = lower[column]?.[column] as number
        if (pivot > tolerance) lower[row]![column] = value / pivot
        else if (Math.abs(value) > tolerance) return false
      }
    }
  }
  return true
}

function invalidModelIssue(message: string): PortfolioRiskIssue {
  return { code: 'invalid-model', message }
}

function prepareModel(model: Cne6ModelSnapshot, tolerance: number): PreparedModel {
  const issues: PortfolioRiskIssue[] = []
  if (model.schemaVersion !== '1' || model.model !== 'CNE6' || typeof model.modelVersion !== 'string' || model.modelVersion.trim() === '') {
    issues.push(invalidModelIssue('model identity or version is invalid'))
  }
  if (model.currency !== 'CNY' || model.covariancePeriod !== 'daily') issues.push(invalidModelIssue('CNE6 model must use CNY daily covariance'))
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(model.asOf) || !Number.isFinite(Date.parse(`${model.asOf}T00:00:00Z`))) {
    issues.push(invalidModelIssue('model asOf must be an ISO calendar date'))
  }
  if (!HASH_RE.test(model.inputHash)) issues.push(invalidModelIssue('model inputHash is invalid'))
  const factorCount = model.factors.length
  const securityCount = model.securities.length
  const factorNames = model.factors.map(factor => factor.name)
  if (factorCount === 0 || factorNames.some(name => name.trim() === '') || new Set(factorNames).size !== factorCount) {
    issues.push(invalidModelIssue('factor names must be non-empty and unique'))
  }
  if (model.factors.some(factor => !['country', 'industry', 'style'].includes(factor.kind))) {
    issues.push(invalidModelIssue('factor kinds are invalid'))
  }
  if (model.factorCovariance.length !== factorCount
    || model.factorCovariance.some(row => row.length !== factorCount || row.some(value => !finite(value)))) {
    issues.push(invalidModelIssue('factor covariance shape or values are invalid'))
  }
  if (model.stockCovariance.length !== securityCount
    || model.stockCovariance.some(row => row.length !== securityCount || row.some(value => !finite(value)))) {
    issues.push(invalidModelIssue('stock covariance shape or values are invalid'))
  }
  const securityIndex = new Map<string, number>()
  for (let index = 0; index < securityCount; index += 1) {
    const security = model.securities[index] as Cne6ModelSnapshot['securities'][number]
    let identity = ''
    try { identity = canonicalInstrumentId(security.instrument) } catch { issues.push(invalidModelIssue(`security ${index} has an invalid instrument`)) }
    if (identity !== '' && securityIndex.has(identity)) issues.push(invalidModelIssue(`duplicate model security: ${identity}`))
    else if (identity !== '') securityIndex.set(identity, index)
    if (security.exposures.length !== factorCount || security.exposures.some(value => !finite(value))) {
      issues.push(invalidModelIssue(`security ${index} has invalid exposures`))
    }
    if (!finite(security.specificRisk) || security.specificRisk <= 0) issues.push(invalidModelIssue(`security ${index} has invalid specific risk`))
  }
  if (model.coverage.universeCount < securityCount
    || model.coverage.exposureCount !== securityCount
    || model.coverage.specificRiskCount !== securityCount) {
    issues.push(invalidModelIssue('model coverage counts are inconsistent with securities'))
  }
  let computedStockReconciliationError = Number.POSITIVE_INFINITY
  if (issues.length === 0) {
    if (maxAsymmetry(model.factorCovariance) > tolerance || maxAsymmetry(model.stockCovariance) > tolerance) {
      issues.push({ code: 'covariance-quality', message: 'factor or stock covariance is not symmetric' })
    }
    if (!isPositiveSemidefinite(model.factorCovariance, tolerance)) issues.push({ code: 'covariance-quality', message: 'factor covariance is not positive semidefinite' })
    computedStockReconciliationError = stockCovarianceError(model)
    if (computedStockReconciliationError > tolerance) {
      issues.push({ code: 'reconciliation-failed', message: `stock covariance does not reconcile; max error ${computedStockReconciliationError}` })
    }
  }
  if (model.quality.status === 'invalid' || !model.quality.symmetric || !model.quality.positiveSemidefinite) {
    issues.push({ code: 'covariance-quality', message: `model covariance quality is ${model.quality.status}: ${model.quality.issues.join('; ')}` })
  }
  const factorIndex = new Map(factorNames.map((name, index) => [name, index]))
  return { model, securityIndex, factorIndex, validationIssues: issues, computedStockReconciliationError }
}

function emptyCoverage(positions: readonly HoldingPosition[]): PortfolioCoverage {
  const marketValue = positions.reduce((sum, position) => sum + position.marketValue, 0)
  return {
    positionCount: positions.length, mappedPositionCount: 0, positionCoverage: 0,
    marketValue, mappedMarketValue: 0, marketValueCoverage: 0,
    unmappedInstruments: positions.map(position => position.instrument),
  }
}

function preparePortfolio(
  snapshot: HoldingsSnapshot,
  prepared: PreparedModel,
  minimumPositionCoverage: number,
  minimumMarketValueCoverage: number,
): PreparedPortfolio {
  const issues: PortfolioRiskIssue[] = []
  const positions = snapshot.positions
  if (snapshot.status !== 'confirmed') issues.push({ code: 'holdings-not-confirmed', message: 'only confirmed holdings may enter formal risk calculations' })
  if (snapshot.asOf !== prepared.model.asOf) issues.push({ code: 'as-of-mismatch', message: `holdings as-of ${snapshot.asOf} does not match model as-of ${prepared.model.asOf}` })
  const currencyConflicts = positions.filter(position => position.currency !== snapshot.baseCurrency || position.currency !== prepared.model.currency)
  if (currencyConflicts.length > 0 || snapshot.baseCurrency !== prepared.model.currency) {
    issues.push({ code: 'currency-conflict', message: 'portfolio-risk V1 does not perform FX conversion', instruments: currencyConflicts.map(item => item.instrument) })
  }
  const totalMarketValue = positions.reduce((sum, position) => sum + position.marketValue, 0)
  const validHoldings = positions.length > 0 && finite(totalMarketValue) && totalMarketValue > 0
    && positions.every(position => finite(position.marketValue) && position.marketValue > 0 && finite(position.quantity) && position.quantity > 0)
  const expectedHash = holdingsSnapshotHash(snapshot)
  if (!validHoldings || !HASH_RE.test(snapshot.inputHash) || !HASH_RE.test(snapshot.snapshotHash)
    || snapshot.totalMarketValue !== totalMarketValue || snapshot.snapshotHash !== expectedHash) {
    issues.push({ code: 'invalid-holdings', message: 'holdings values, total, or snapshot hash are invalid' })
  }
  const mappedIndexes = positions.map(position => prepared.securityIndex.get(canonicalInstrumentId(position.instrument)) ?? null)
  const unmapped = positions.filter((_position, index) => mappedIndexes[index] === null)
  if (unmapped.length > 0) issues.push({ code: 'unmapped-security', message: 'one or more holdings are absent from the CNE6 universe', instruments: unmapped.map(item => item.instrument) })
  const mappedMarketValue = positions.reduce((sum, position, index) => sum + (mappedIndexes[index] === null ? 0 : position.marketValue), 0)
  const mappedPositionCount = mappedIndexes.filter(index => index !== null).length
  const coverage: PortfolioCoverage = {
    positionCount: positions.length, mappedPositionCount, positionCoverage: positions.length === 0 ? 0 : mappedPositionCount / positions.length,
    marketValue: totalMarketValue, mappedMarketValue, marketValueCoverage: totalMarketValue > 0 ? mappedMarketValue / totalMarketValue : 0,
    unmappedInstruments: unmapped.map(item => item.instrument),
  }
  if (coverage.positionCoverage < minimumPositionCoverage || coverage.marketValueCoverage < minimumMarketValueCoverage) {
    issues.push({ code: 'coverage-insufficient', message: `coverage ${coverage.positionCoverage}/${coverage.marketValueCoverage} is below required ${minimumPositionCoverage}/${minimumMarketValueCoverage}` })
  }
  const weights = positions.map(position => totalMarketValue > 0 ? position.marketValue / totalMarketValue : 0)
  return { positions, weights, mappedIndexes, coverage, issues }
}

function qualityStatus(issues: readonly PortfolioRiskIssue[], covarianceQuality?: CovarianceQuality): RiskQualityStatus {
  if (issues.some(issue => issue.code === 'reconciliation-failed')) return 'unreconciled'
  if (issues.some(issue => issue.code === 'invalid-model' || issue.code === 'covariance-quality' || issue.code === 'invalid-holdings')) return 'invalid'
  if (issues.some(issue => issue.code === 'coverage-insufficient' || issue.code === 'unmapped-security')) return 'insufficient'
  if (issues.length > 0) return 'degraded'
  if (covarianceQuality?.status === 'warning') return 'degraded'
  return 'ok'
}

function metadata(
  model: Cne6ModelSnapshot, coverage: PortfolioCoverage, inputHash: ContentHash, issues: readonly PortfolioRiskIssue[],
): RiskResultMetadata {
  return {
    model: 'CNE6', modelVersion: model.modelVersion, asOf: model.asOf, coverage, inputHash,
    qualityStatus: qualityStatus(issues, model.quality) === 'ok' && model.sourceQuality?.quality_flag !== 'good'
      ? 'degraded' : qualityStatus(issues, model.quality), covarianceQuality: model.quality,
    sourceQuality: model.sourceQuality ?? { quality_flag: 'unverified', coverage: null },
    descriptorQuality: model.descriptorQuality ?? {},
  }
}

function calculate(prepared: PreparedModel, portfolio: PreparedPortfolio, tolerance: number): Calculation {
  const factorCount = prepared.model.factors.length
  const exposure = Array<number>(factorCount).fill(0)
  const securityCovariance = Array<number>(portfolio.positions.length).fill(0)
  const securityWeights = new Map<number, number>()
  for (let positionIndex = 0; positionIndex < portfolio.positions.length; positionIndex += 1) {
    const modelIndex = portfolio.mappedIndexes[positionIndex] as number
    const security = prepared.model.securities[modelIndex] as Cne6ModelSnapshot['securities'][number]
    const weight = portfolio.weights[positionIndex] as number
    for (let factor = 0; factor < factorCount; factor += 1) {
      exposure[factor] = (exposure[factor] as number) + weight * (security.exposures[factor] as number)
    }
    securityWeights.set(modelIndex, (securityWeights.get(modelIndex) ?? 0) + weight)
  }
  const specificVariance = [...securityWeights].reduce((total, [modelIndex, weight]) => {
    const security = prepared.model.securities[modelIndex] as Cne6ModelSnapshot['securities'][number]
    return total + (weight * security.specificRisk) ** 2
  }, 0)
  const factorMarginal = matVec(prepared.model.factorCovariance, exposure)
  const factorVariance = dot(exposure, factorMarginal)
  const totalVariance = factorVariance + specificVariance
  const totalRisk = Math.sqrt(Math.max(totalVariance, 0))
  const factorExposures: FactorExposure[] = prepared.model.factors.map((factor, index) => ({
    factor: factor.name, kind: factor.kind, exposure: exposure[index] as number,
  }))
  const factorContributions: FactorRiskContribution[] = factorExposures.map((factor, index) => ({
    ...factor, varianceContribution: factor.exposure * (factorMarginal[index] as number),
  }))
  const holdingContributions: HoldingRiskContribution[] = portfolio.positions.map((position, positionIndex) => {
    const modelIndex = portfolio.mappedIndexes[positionIndex] as number
    const security = prepared.model.securities[modelIndex] as Cne6ModelSnapshot['securities'][number]
    const weight = portfolio.weights[positionIndex] as number
    const factorCovariance = dot(security.exposures, factorMarginal)
    const covariance = factorCovariance + (securityWeights.get(modelIndex) as number) * security.specificRisk ** 2
    securityCovariance[positionIndex] = covariance
    return {
      holdingId: position.id, instrument: position.instrument, account: position.account, weight,
      marginalVariance: 2 * covariance,
      marginalVolatility: totalRisk > 0 ? covariance / totalRisk : 0,
      varianceContribution: weight * covariance,
      volatilityContribution: totalRisk > 0 ? weight * covariance / totalRisk : 0,
    }
  })
  const stockVariance = portfolio.weights.reduce((total, leftWeight, row) => (
    total + portfolio.weights.reduce((rowTotal, rightWeight, column) => {
      const modelRow = portfolio.mappedIndexes[row] as number
      const modelColumn = portfolio.mappedIndexes[column] as number
      return rowTotal + leftWeight * rightWeight * (prepared.model.stockCovariance[modelRow]?.[modelColumn] as number)
    }, 0)
  ), 0)
  const holdingsCheck = check(Math.max(
    Math.abs(portfolio.weights.reduce((sum, weight) => sum + weight, 0) - 1),
    Math.abs(portfolio.positions.reduce((sum, position) => sum + position.marketValue, 0) - portfolio.coverage.marketValue),
  ), tolerance)
  const exposureCheck = check(maximumDifference(
    exposure,
    Array.from({ length: factorCount }, (_unused, factor) => portfolio.positions.reduce((sum, _position, index) => {
      const security = prepared.model.securities[portfolio.mappedIndexes[index] as number] as Cne6ModelSnapshot['securities'][number]
      return sum + (portfolio.weights[index] as number) * (security.exposures[factor] as number)
    }, 0)),
  ), tolerance)
  const covarianceCheck = check(Math.max(prepared.computedStockReconciliationError, Math.abs(stockVariance - totalVariance)), tolerance)
  const riskDifference = Math.max(
    Math.abs(totalVariance - factorVariance - specificVariance),
    Math.abs(totalVariance - holdingContributions.reduce((sum, item) => sum + item.varianceContribution, 0)),
  )
  const riskCheck = check(riskDifference, tolerance)
  const reconciliation: PortfolioRiskReconciliation = {
    holdings: holdingsCheck, exposure: exposureCheck, covariance: covarianceCheck, risk: riskCheck,
    status: [holdingsCheck, exposureCheck, covarianceCheck, riskCheck].every(item => item.status === 'ok') ? 'ok' : 'failed',
  }
  return {
    metrics: {
      totalVariance, factorVariance, specificVariance, totalRisk,
      factorRisk: Math.sqrt(Math.max(factorVariance, 0)), specificRisk: Math.sqrt(Math.max(specificVariance, 0)),
      exposures: factorExposures, factorContributions, holdingContributions,
    },
    reconciliation,
  }
}

function proposalSnapshot(proposal: ProposedPortfolio): HoldingsSnapshot {
  const positions: HoldingPosition[] = proposal.positions.map(position => ({
    ...position,
    account: position.account?.trim() || 'default',
    currency: position.currency.trim().toUpperCase(),
    instrument: { ...position.instrument },
    id: holdingId(proposal.portfolioId, position),
  })).sort((left, right) => left.id.localeCompare(right.id))
  const duplicate = positions.find((position, index) => positions.findIndex(item => holdingKey(item) === holdingKey(position)) !== index)
  if (duplicate !== undefined) throw new TypeError(`duplicate proposed holding: ${holdingKey(duplicate)}`)
  const inputHash = portfolioHash({ proposal })
  const semantic = { portfolioId: proposal.portfolioId, asOf: proposal.asOf, baseCurrency: proposal.baseCurrency, positions, inputHash }
  return { ...semantic, status: 'confirmed', totalMarketValue: positions.reduce((sum, item) => sum + item.marketValue, 0), snapshotHash: holdingsSnapshotHash(semantic) }
}

function rejectResult(
  model: Cne6ModelSnapshot, coverage: PortfolioCoverage, inputHash: ContentHash, issues: readonly PortfolioRiskIssue[], tolerance: number,
): PortfolioRiskResult {
  return { status: 'rejected', metadata: metadata(model, coverage, inputHash, issues), issues, reconciliation: failedReconciliation(tolerance), risk: null }
}

export class Cne6PortfolioRiskFacade {
  readonly model: Cne6ModelSnapshot
  readonly #prepared: PreparedModel
  readonly #positionCoverage: number
  readonly #marketValueCoverage: number
  readonly #tolerance: number
  readonly #optionsHash: ContentHash

  constructor(model: Cne6ModelSnapshot, options: PortfolioRiskOptions = {}) {
    this.#positionCoverage = options.minimumPositionCoverage ?? 1
    this.#marketValueCoverage = options.minimumMarketValueCoverage ?? 1
    this.#tolerance = options.reconciliationTolerance ?? DEFAULT_TOLERANCE
    for (const [name, value] of [['minimumPositionCoverage', this.#positionCoverage], ['minimumMarketValueCoverage', this.#marketValueCoverage]] as const) {
      if (!finite(value) || value < 0 || value > 1) throw new TypeError(`${name} must be in [0, 1]`)
    }
    if (!finite(this.#tolerance) || this.#tolerance <= 0) throw new TypeError('reconciliationTolerance must be positive')
    this.#optionsHash = portfolioHash({
      minimumPositionCoverage: this.#positionCoverage,
      minimumMarketValueCoverage: this.#marketValueCoverage,
      reconciliationTolerance: this.#tolerance,
    })
    this.model = immutableCopy(model)
    this.#prepared = prepareModel(this.model, this.#tolerance)
  }

  portfolioRisk(holdings: HoldingsSnapshot): PortfolioRiskResult {
    const inputHash = portfolioHash({ operation: 'portfolio-risk', holdings: holdings.snapshotHash, model: this.model.inputHash, options: this.#optionsHash })
    let portfolio: PreparedPortfolio
    try {
      portfolio = preparePortfolio(holdings, this.#prepared, this.#positionCoverage, this.#marketValueCoverage)
    } catch (error) {
      const issues = [...this.#prepared.validationIssues, { code: 'invalid-holdings' as const, message: error instanceof Error ? error.message : 'invalid holdings' }]
      return rejectResult(this.model, emptyCoverage(holdings.positions), inputHash, issues, this.#tolerance)
    }
    const issues = [...this.#prepared.validationIssues, ...portfolio.issues]
    if (issues.length > 0) return rejectResult(this.model, portfolio.coverage, inputHash, issues, this.#tolerance)
    const calculation = calculate(this.#prepared, portfolio, this.#tolerance)
    if (calculation.reconciliation.status === 'failed') {
      const failed = [...issues, { code: 'reconciliation-failed' as const, message: 'holdings, exposure, covariance, or risk reconciliation failed' }]
      return { status: 'rejected', metadata: metadata(this.model, portfolio.coverage, inputHash, failed), issues: failed, reconciliation: calculation.reconciliation, risk: null }
    }
    return { status: 'ok', metadata: metadata(this.model, portfolio.coverage, inputHash, issues), issues, reconciliation: calculation.reconciliation, risk: calculation.metrics }
  }

  marginalRisk(holdings: HoldingsSnapshot, proposal: ProposedPortfolio): MarginalRiskResult {
    const before = this.portfolioRisk(holdings)
    let afterSnapshot: HoldingsSnapshot
    try { afterSnapshot = proposalSnapshot(proposal) } catch (error) {
      const issues = [...before.issues, { code: 'invalid-proposal' as const, message: error instanceof Error ? error.message : 'invalid proposal' }]
      return { status: 'rejected', metadata: { ...before.metadata, inputHash: portfolioHash({ operation: 'marginal-risk', before: holdings.snapshotHash, proposal, model: this.model.inputHash, options: this.#optionsHash }), qualityStatus: qualityStatus(issues, this.model.quality) }, issues, before: before.risk, after: null, totalRiskChange: null, changes: [] }
    }
    const after = this.portfolioRisk(afterSnapshot)
    const inputHash = portfolioHash({ operation: 'marginal-risk', before: holdings.snapshotHash, after: afterSnapshot.snapshotHash, model: this.model.inputHash, options: this.#optionsHash })
    const issues = [...before.issues, ...after.issues]
    if (proposal.portfolioId !== holdings.portfolioId || proposal.asOf !== holdings.asOf || proposal.baseCurrency !== holdings.baseCurrency) {
      issues.push({ code: 'invalid-proposal', message: 'proposal identity, as-of, and base currency must match confirmed holdings' })
    }
    if (before.status === 'rejected' || after.status === 'rejected' || issues.length > 0 || before.risk === null || after.risk === null) {
      return { status: 'rejected', metadata: { ...after.metadata, inputHash, qualityStatus: qualityStatus(issues, this.model.quality) }, issues, before: before.risk, after: after.risk, totalRiskChange: null, changes: [] }
    }
    const beforeByKey = new Map(before.risk.holdingContributions.map(item => [holdingKey({ instrument: item.instrument, account: item.account }), item]))
    const afterByKey = new Map(after.risk.holdingContributions.map(item => [holdingKey({ instrument: item.instrument, account: item.account }), item]))
    const positions = [...holdings.positions, ...afterSnapshot.positions]
    const keys = [...new Set(positions.map(holdingKey))].sort()
    const positionByKey = new Map(positions.map(position => [holdingKey(position), position]))
    const changes: MarginalRiskChange[] = keys.map(key => {
      const prior = beforeByKey.get(key)
      const next = afterByKey.get(key)
      const position = positionByKey.get(key) as HoldingPosition
      return {
        instrument: position.instrument, account: position.account, beforeWeight: prior?.weight ?? 0, afterWeight: next?.weight ?? 0,
        beforeMarginalVolatility: prior?.marginalVolatility ?? null, afterMarginalVolatility: next?.marginalVolatility ?? null,
        marginalVolatilityChange: prior === undefined || next === undefined ? null : next.marginalVolatility - prior.marginalVolatility,
      }
    })
    return { status: 'ok', metadata: { ...after.metadata, inputHash }, issues, before: before.risk, after: after.risk, totalRiskChange: after.risk.totalRisk - before.risk.totalRisk, changes }
  }

  stress(holdings: HoldingsSnapshot, scenario: ScenarioDefinition): ScenarioStressResult {
    const base = this.portfolioRisk(holdings)
    const inputHash = portfolioHash({ operation: 'scenario-stress', holdings: holdings.snapshotHash, model: this.model.inputHash, options: this.#optionsHash, scenario })
    const issues = [...base.issues]
    const shocks = new Map<string, number>()
    for (const item of scenario.shocks) {
      if (!this.#prepared.factorIndex.has(item.factor)) issues.push({ code: 'unknown-factor', message: `scenario factor is not in the model: ${item.factor}`, factors: [item.factor] })
      else if (!finite(item.shock)) issues.push({ code: 'invalid-proposal', message: `scenario shock for ${item.factor} must be finite`, factors: [item.factor] })
      else if (shocks.has(item.factor)) issues.push({ code: 'invalid-proposal', message: `scenario factor is duplicated: ${item.factor}`, factors: [item.factor] })
      else shocks.set(item.factor, item.shock)
    }
    if (scenario.id.trim() === '' || scenario.shocks.length === 0) issues.push({ code: 'invalid-proposal', message: 'scenario id and at least one explicit factor shock are required' })
    if (base.status === 'rejected' || base.risk === null || issues.length > 0) {
      return { status: 'rejected', metadata: { ...base.metadata, inputHash, qualityStatus: qualityStatus(issues, this.model.quality) }, issues, scenarioId: scenario.id, portfolioReturn: null, portfolioValueImpact: null, factorImpacts: [], positionImpacts: [] }
    }
    const factorImpacts = [...shocks].map(([factor, shock]) => {
      const exposure = base.risk!.exposures.find(item => item.factor === factor)?.exposure as number
      return { factor, exposure, shock, returnImpact: exposure * shock }
    })
    const positionImpacts = holdings.positions.map(position => {
      const modelIndex = this.#prepared.securityIndex.get(canonicalInstrumentId(position.instrument)) as number
      const security = this.model.securities[modelIndex] as Cne6ModelSnapshot['securities'][number]
      const returnImpact = [...shocks].reduce((sum, [factor, shock]) => sum + (security.exposures[this.#prepared.factorIndex.get(factor) as number] as number) * shock, 0)
      return { holdingId: position.id, instrument: position.instrument, returnImpact, valueImpact: position.marketValue * returnImpact }
    })
    const portfolioReturn = factorImpacts.reduce((sum, item) => sum + item.returnImpact, 0)
    const portfolioValueImpact = positionImpacts.reduce((sum, item) => sum + item.valueImpact, 0)
    return { status: 'ok', metadata: { ...base.metadata, inputHash }, issues, scenarioId: scenario.id, portfolioReturn, portfolioValueImpact, factorImpacts, positionImpacts }
  }
}
