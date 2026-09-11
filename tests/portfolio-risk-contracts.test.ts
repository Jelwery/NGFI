import { describe, expect, it } from 'vitest'

import {
  Cne6PortfolioRiskFacade,
  HoldingsStoreError,
  InMemoryHoldingsStore,
  importHoldingsCsv,
  importHoldingsJson,
  portfolioHash,
  type Cne6ModelSnapshot,
  type HoldingsSnapshot,
  type ReadyHoldingsImport,
} from '@finance2dsh/portfolio-risk'

const context = { portfolioId: 'core-cn', asOf: '2026-09-05', baseCurrency: 'CNY' }
const positions = [
  {
    instrument: { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' },
    quantity: 60, marketValue: 600, currency: 'CNY', account: 'main', name: '浦发银行',
  },
  {
    instrument: { market: 'CN', exchange: 'SZSE', symbol: '000001', assetType: 'equity' },
    quantity: 40, marketValue: 400, currency: 'CNY', account: 'main', name: '平安银行',
  },
]

function readyImport(input = positions): ReadyHoldingsImport {
  const result = importHoldingsJson(JSON.stringify(input), context)
  if (result.status !== 'ready') throw new Error(`fixture import failed: ${JSON.stringify(result.errors)}`)
  return result
}

function confirmedHoldings(input = positions): HoldingsSnapshot {
  const store = new InMemoryHoldingsStore()
  const staged = store.stage(readyImport(input), 0)
  return store.confirm(staged.revision, staged.snapshot!.snapshotHash).snapshot as HoldingsSnapshot
}

function model(): Cne6ModelSnapshot {
  return {
    schemaVersion: '1', model: 'CNE6', modelVersion: 'cne6-engine@0.1.0', asOf: '2026-09-05',
    currency: 'CNY', covariancePeriod: 'daily',
    factors: [
      { name: 'COUNTRY', kind: 'country' },
      { name: '银行', kind: 'industry' },
      { name: 'Size', kind: 'style' },
    ],
    securities: [
      { instrument: positions[0]!.instrument, modelCode: 'sh.600000', exposures: [1, 1, 1], specificRisk: 0.01 },
      { instrument: positions[1]!.instrument, modelCode: 'sz.000001', exposures: [1, 0, -1], specificRisk: 0.02 },
    ],
    factorCovariance: [
      [0.0004, 0, 0],
      [0, 0.0001, 0],
      [0, 0, 0.000225],
    ],
    stockCovariance: [
      [0.000825, 0.000175],
      [0.000175, 0.001025],
    ],
    coverage: { universeCount: 2, exposureCount: 2, specificRiskCount: 2 },
    inputHash: portfolioHash({ cne6: 'fixture-v1' }),
    sourceQuality: { quality_flag: 'good', coverage: 1 },
    quality: {
      status: 'ok', symmetric: true, positiveSemidefinite: true, maxAsymmetry: 0,
      minEigenvalue: 0.0001, maxEigenvalue: 0.001128, conditionNumber: 4,
      stockReconciliationMaxError: 0, issues: [],
    },
  }
}

describe('holdings import contracts', () => {
  it('imports equivalent CSV and JSON positions with canonical identifiers', () => {
    const json = readyImport()
    const csv = importHoldingsCsv([
      'market,exchange,symbol,assetType,quantity,marketValue,currency,account,name',
      'CN,SSE,600000,equity,60,600,CNY,main,浦发银行',
      'CN,SZSE,000001,equity,40,400,CNY,main,平安银行',
    ].join('\n'), context)

    expect(csv.status).toBe('ready')
    if (csv.status !== 'ready') return
    expect(csv.positions).toEqual(json.positions)
    expect(json.positions[0]).toMatchObject({
      id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' },
    })
  })

  it('returns atomic, structured errors for malformed imports and duplicates', () => {
    const malformed = importHoldingsJson('{', context)
    expect(malformed).toMatchObject({ status: 'invalid', positions: [], errors: [{ code: 'invalid-syntax' }] })

    const invalidNumbers = importHoldingsCsv([
      'market,exchange,symbol,assetType,quantity,marketValue,currency',
      'CN,SSE,600000,equity,NaN,-1,CNY',
    ].join('\n'), context)
    expect(invalidNumbers.status).toBe('invalid')
    expect(invalidNumbers.errors.map(item => item.code)).toEqual(['invalid-number', 'invalid-number'])
    expect(invalidNumbers.positions).toEqual([])

    const duplicate = importHoldingsJson(JSON.stringify([positions[0], positions[0]]), context)
    expect(duplicate.status).toBe('invalid')
    expect(duplicate.errors).toContainEqual(expect.objectContaining({ code: 'duplicate-holding', row: 2 }))
    expect(duplicate.positions).toEqual([])
  })

  it('rejects unknown fields, missing columns, invalid instruments, and currencies', () => {
    const unknown = importHoldingsJson(JSON.stringify([{ ...positions[0], brokerOrder: true }]), context)
    expect(unknown.errors).toContainEqual(expect.objectContaining({ code: 'unknown-field', field: 'brokerOrder' }))

    const missing = importHoldingsCsv('market,exchange,symbol\nCN,SSE,600000', context)
    expect(missing.errors.map(item => item.field)).toEqual(expect.arrayContaining(['assetType', 'quantity', 'marketValue', 'currency']))

    const invalid = importHoldingsJson(JSON.stringify([{
      ...positions[0], currency: 'CN',
      instrument: { ...positions[0]!.instrument, symbol: '600 000' },
    }]), context)
    expect(invalid.errors.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-instrument', 'invalid-currency']))
  })

  it('produces a formatting-independent JSON input hash and semantic snapshot hash', () => {
    const compact = readyImport()
    const reorderedText = JSON.stringify(positions.map(position => ({
      currency: position.currency, marketValue: position.marketValue, quantity: position.quantity,
      instrument: { assetType: position.instrument.assetType, symbol: position.instrument.symbol, exchange: position.instrument.exchange, market: position.instrument.market },
      name: position.name, account: position.account,
    })), null, 2)
    const reordered = importHoldingsJson(reorderedText, context)
    expect(reordered.status).toBe('ready')
    expect(reordered.inputHash).toBe(compact.inputHash)

    const store = new InMemoryHoldingsStore()
    const staged = store.stage(compact, 0)
    const confirmed = store.confirm(staged.revision, staged.snapshot!.snapshotHash)
    expect(confirmed.snapshot?.snapshotHash).toBe(staged.snapshot?.snapshotHash)
  })

  it('confirms cash, valuation, and sellable quantities as one account-state unit', () => {
    const accountState = { cash: 1500.5, cashAvailableAt: '2026-09-05T08:00:00Z', valuationAt: '2026-09-05T08:00:00Z' }
    const withState = importHoldingsJson(JSON.stringify([
      { ...positions[0], sellableQuantity: 20 }, { ...positions[1], sellableQuantity: 40 },
    ]), { ...context, accountState })
    expect(withState.status).toBe('ready')
    if (withState.status !== 'ready') return
    expect(withState.accountState).toEqual(accountState)
    expect(withState.positions[0]?.sellableQuantity).toBe(20)
    // Cash and sellable quantities change the snapshot hash: they are part of the
    // confirmed unit, not free inputs a later step can override.
    const store = new InMemoryHoldingsStore()
    const staged = store.stage(withState, 0)
    expect(staged.snapshot?.snapshotHash).not.toBe(readyImport().inputHash)
    const bumped = importHoldingsJson(JSON.stringify([
      { ...positions[0], sellableQuantity: 20 }, { ...positions[1], sellableQuantity: 40 },
    ]), { ...context, accountState: { ...accountState, cash: 1600 } })
    const otherStore = new InMemoryHoldingsStore()
    const otherStaged = (bumped.status === 'ready') ? otherStore.stage(bumped, 0) : null
    expect(otherStaged?.snapshot?.snapshotHash).not.toBe(staged.snapshot?.snapshotHash)
  })

  it('rejects invalid account state and sellable quantities that exceed holdings', () => {
    expect(importHoldingsJson(JSON.stringify([{ ...positions[0], sellableQuantity: 999 }]), context))
      .toMatchObject({ status: 'invalid', errors: expect.arrayContaining([expect.objectContaining({ field: 'sellableQuantity' })]) })
    expect(() => importHoldingsJson(JSON.stringify([positions[0]]), {
      ...context, accountState: { cash: -1, cashAvailableAt: '2026-09-05T08:00:00Z', valuationAt: '2026-09-05T08:00:00Z' },
    })).toThrow(/accountState.cash/u)
    expect(() => importHoldingsJson(JSON.stringify([positions[0]]), {
      ...context, accountState: { cash: 1, cashAvailableAt: 'not-a-date', valuationAt: '2026-09-05T08:00:00Z' },
    })).toThrow(/accountState.cashAvailableAt/u)
  })
})

describe('staged and confirmed holdings store', () => {
  it('uses optimistic revisions, idempotent staging, and explicit confirmation', () => {
    const store = new InMemoryHoldingsStore()
    const first = store.stage(readyImport(), 0)
    expect(first).toMatchObject({ revision: 1, changed: true, snapshot: { status: 'staged' } })
    expect(store.stage(readyImport(), 1)).toMatchObject({ revision: 1, changed: false })
    expect(() => store.confirm(0, first.snapshot!.snapshotHash)).toThrowError(HoldingsStoreError)
    expect(() => store.confirm(1, portfolioHash({ stale: true }))).toThrow(/snapshot conflict/u)

    const confirmed = store.confirm(1, first.snapshot!.snapshotHash)
    expect(confirmed).toMatchObject({ revision: 2, changed: true, snapshot: { status: 'confirmed' } })
    expect(store.snapshot()).toMatchObject({ revision: 2, staged: null, confirmed: { status: 'confirmed' } })
    expect(() => store.confirm(2, confirmed.snapshot!.snapshotHash)).toThrow(/no staged holdings/u)
  })

  it('discards only staged data and does not mutate caller-owned snapshots', () => {
    const store = new InMemoryHoldingsStore()
    const staged = store.stage(readyImport(), 0)
    const external = store.snapshot()
    ;(external.staged!.positions[0]!.instrument as { symbol: string }).symbol = '999999'
    expect(store.snapshot().staged!.positions[0]!.instrument.symbol).toBe('000001')
    expect(store.discard(staged.revision)).toMatchObject({ revision: 2, changed: true })
    expect(store.discard(2)).toEqual({ revision: 2, changed: false, snapshot: null })
  })
})

describe('CNE6 portfolio risk facade', () => {
  it('rejects staged holdings before calculating formal risk', () => {
    const store = new InMemoryHoldingsStore()
    const staged = store.stage(readyImport(), 0).snapshot as HoldingsSnapshot
    const result = new Cne6PortfolioRiskFacade(model()).portfolioRisk(staged)
    expect(result).toMatchObject({
      status: 'rejected', risk: null, metadata: { modelVersion: 'cne6-engine@0.1.0', asOf: context.asOf },
      reconciliation: { status: 'failed' },
    })
    expect(result.reconciliation.holdings).toEqual({ status: 'not-run', difference: null, tolerance: 1e-10 })
    expect(() => JSON.stringify(result)).not.toThrow()
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'holdings-not-confirmed' }))
  })

  it('reports industry/style exposures and reconciled factor, specific, total, and holding risk', () => {
    const result = new Cne6PortfolioRiskFacade(model()).portfolioRisk(confirmedHoldings())
    expect(result.status).toBe('ok')
    expect(result.metadata).toMatchObject({
      model: 'CNE6', modelVersion: 'cne6-engine@0.1.0', asOf: '2026-09-05',
      qualityStatus: 'ok', coverage: { positionCoverage: 1, marketValueCoverage: 1 },
      inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    })
    expect(result.reconciliation).toEqual({
      holdings: { status: 'ok', difference: 0, tolerance: 1e-10 },
      exposure: { status: 'ok', difference: 0, tolerance: 1e-10 },
      covariance: { status: 'ok', difference: expect.closeTo(0, 12), tolerance: 1e-10 },
      risk: { status: 'ok', difference: expect.closeTo(0, 12), tolerance: 1e-10 },
      status: 'ok',
    })
    expect(result.risk?.exposures).toEqual([
      { factor: 'COUNTRY', kind: 'country', exposure: expect.closeTo(1, 12) },
      { factor: '银行', kind: 'industry', exposure: expect.closeTo(0.6, 12) },
      { factor: 'Size', kind: 'style', exposure: expect.closeTo(0.2, 12) },
    ])
    expect(result.risk?.factorVariance).toBeCloseTo(0.000445, 12)
    expect(result.risk?.specificVariance).toBeCloseTo(0.0001, 12)
    expect(result.risk?.totalVariance).toBeCloseTo(0.000545, 12)
    expect(result.risk?.holdingContributions.reduce((sum, item) => sum + item.varianceContribution, 0)).toBeCloseTo(0.000545, 12)
  })

  it('fails closed with explicit unmapped, currency, coverage, as-of, and covariance issues', () => {
    const base = confirmedHoldings()
    const stagedStore = new InMemoryHoldingsStore()
    const unmappedImport = readyImport([positions[0]!, {
      ...positions[1]!, instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
    }])
    const staged = stagedStore.stage(unmappedImport, 0)
    const unmapped = stagedStore.confirm(staged.revision, staged.snapshot!.snapshotHash).snapshot as HoldingsSnapshot
    const coverageResult = new Cne6PortfolioRiskFacade(model()).portfolioRisk(unmapped)
    expect(coverageResult.status).toBe('rejected')
    expect(coverageResult.issues.map(item => item.code)).toEqual(expect.arrayContaining(['unmapped-security', 'coverage-insufficient']))
    expect(coverageResult.metadata.coverage).toMatchObject({ mappedPositionCount: 1, positionCoverage: 0.5, marketValueCoverage: 0.6 })

    const currency = { ...base, baseCurrency: 'USD', positions: base.positions.map(position => ({ ...position, currency: 'USD' })) }
    const currencySnapshot = { ...currency, snapshotHash: portfolioHash({ invalidated: true }) } as HoldingsSnapshot
    const currencyResult = new Cne6PortfolioRiskFacade(model()).portfolioRisk(currencySnapshot)
    expect(currencyResult.issues.map(item => item.code)).toEqual(expect.arrayContaining(['currency-conflict', 'invalid-holdings']))

    const stale = { ...base, asOf: '2026-09-04' }
    const staleResult = new Cne6PortfolioRiskFacade(model()).portfolioRisk(stale)
    expect(staleResult.issues.map(item => item.code)).toEqual(expect.arrayContaining(['as-of-mismatch', 'invalid-holdings']))

    const inconsistentModel = model()
    ;(inconsistentModel.stockCovariance[0] as number[])[0] = 0.5
    const covarianceResult = new Cne6PortfolioRiskFacade(inconsistentModel).portfolioRisk(base)
    expect(covarianceResult).toMatchObject({ status: 'rejected', risk: null, metadata: { qualityStatus: 'unreconciled' } })
    expect(covarianceResult.issues).toContainEqual(expect.objectContaining({ code: 'reconciliation-failed' }))
  })

  it('takes an immutable model copy and independently verifies covariance quality', () => {
    const mutable = model()
    const facade = new Cne6PortfolioRiskFacade(mutable)
    ;(mutable.factorCovariance[0] as number[])[0] = 99
    expect(facade.portfolioRisk(confirmedHoldings()).risk?.totalVariance).toBeCloseTo(0.000545, 12)
    expect(Object.isFrozen(facade.model)).toBe(true)

    const asymmetric = model()
    ;(asymmetric.factorCovariance[0] as number[])[1] = 0.001
    ;(asymmetric.stockCovariance[0] as number[])[1] = 0.001
    const result = new Cne6PortfolioRiskFacade(asymmetric).portfolioRisk(confirmedHoldings())
    expect(result.status).toBe('rejected')
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'covariance-quality', message: expect.stringContaining('not symmetric'),
    }))
  })

  it('compares marginal risk before and after a proposed rebalance', () => {
    const proposal = { ...context, positions: [
      { ...positions[0]!, quantity: 50, marketValue: 500 },
      { ...positions[1]!, quantity: 50, marketValue: 500 },
    ] }
    const result = new Cne6PortfolioRiskFacade(model()).marginalRisk(confirmedHoldings(), proposal)
    expect(result.status).toBe('ok')
    expect(result.before?.totalVariance).toBeCloseTo(0.000545, 12)
    expect(result.after?.totalVariance).toBeCloseTo(0.00055, 12)
    expect(result.totalRiskChange).toBeCloseTo(Math.sqrt(0.00055) - Math.sqrt(0.000545), 12)
    expect(result.changes).toHaveLength(2)
    expect(result.changes.map(change => change.afterWeight)).toEqual([0.5, 0.5])
  })

  it('aggregates specific risk for the same security held in separate accounts', () => {
    const multiAccount = confirmedHoldings([
      { ...positions[0]!, quantity: 30, marketValue: 300, account: 'account-a' },
      { ...positions[0]!, quantity: 30, marketValue: 300, account: 'account-b' },
      positions[1]!,
    ])
    const result = new Cne6PortfolioRiskFacade(model()).portfolioRisk(multiAccount)
    expect(result.status).toBe('ok')
    expect(result.risk?.specificVariance).toBeCloseTo(0.0001, 12)
    expect(result.risk?.totalVariance).toBeCloseTo(0.000545, 12)
    expect(result.risk?.holdingContributions).toHaveLength(3)
    expect(result.reconciliation.status).toBe('ok')
  })

  it('applies only explicit factor shocks and attributes scenario impact to holdings', () => {
    const facade = new Cne6PortfolioRiskFacade(model())
    const result = facade.stress(confirmedHoldings(), {
      id: 'bank-size-selloff', shocks: [{ factor: '银行', shock: -0.05 }, { factor: 'Size', shock: -0.1 }],
    })
    expect(result).toMatchObject({
      status: 'ok', scenarioId: 'bank-size-selloff',
      metadata: { modelVersion: 'cne6-engine@0.1.0', asOf: '2026-09-05', qualityStatus: 'ok' },
    })
    expect(result.portfolioReturn).toBeCloseTo(-0.05, 12)
    expect(result.portfolioValueImpact).toBeCloseTo(-50, 12)
    expect(result.factorImpacts.map(item => ({ factor: item.factor, shock: item.shock }))).toEqual([
      { factor: '银行', shock: -0.05 }, { factor: 'Size', shock: -0.1 },
    ])
    expect(result.factorImpacts[0]?.exposure).toBeCloseTo(0.6, 12)
    expect(result.factorImpacts[0]?.returnImpact).toBeCloseTo(-0.03, 12)
    expect(result.factorImpacts[1]?.exposure).toBeCloseTo(0.2, 12)
    expect(result.factorImpacts[1]?.returnImpact).toBeCloseTo(-0.02, 12)
    expect(result.positionImpacts.find(item => item.instrument.symbol === '600000')?.valueImpact).toBeCloseTo(-90, 12)
    expect(result.positionImpacts.find(item => item.instrument.symbol === '000001')?.valueImpact).toBeCloseTo(40, 12)

    const unknown = facade.stress(confirmedHoldings(), { id: 'unknown', shocks: [{ factor: 'Momentum', shock: -0.1 }] })
    expect(unknown).toMatchObject({ status: 'rejected', portfolioReturn: null, metadata: { qualityStatus: 'degraded' } })
    expect(unknown.issues).toContainEqual(expect.objectContaining({ code: 'unknown-factor' }))
  })
})
