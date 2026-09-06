import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { portfolioHash } from '@finance2dsh/portfolio-risk'
import { createPortfolioTools } from '@finance2dsh/dsh-tools'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const positions = [{
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' },
  quantity: 100, marketValue: 1000, currency: 'CNY', account: 'main',
}]

function fixture() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-portfolio-tools-'))
  roots.push(runtimeRoot)
  const tools = createPortfolioTools({ runtimeRoot })
  return (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!
    .execute(args as never, { signal: new AbortController().signal } as never) as Promise<any>
}

function model(stockCovariance = [[0.0006]]) {
  return {
    schemaVersion: '1', model: 'CNE6', modelVersion: 'fixture@1', asOf: '2026-09-05',
    currency: 'CNY', covariancePeriod: 'daily', factors: [{ name: 'COUNTRY', kind: 'country' }],
    securities: [{ instrument: positions[0]!.instrument, modelCode: 'sh.600000', exposures: [1], specificRisk: 0.01 }],
    factorCovariance: [[0.0005]], stockCovariance,
    coverage: { universeCount: 1, exposureCount: 1, specificRiskCount: 1 },
    inputHash: portfolioHash({ model: 1 }),
    quality: {
      status: 'ok', symmetric: true, positiveSemidefinite: true, maxAsymmetry: 0,
      minEigenvalue: 0.0005, maxEigenvalue: 0.0005, conditionNumber: 1,
      stockReconciliationMaxError: 0, issues: [],
    },
  }
}

describe('portfolio DSH tools', () => {
  it('requires staged then hash-confirmed holdings and preserves revisions', async () => {
    const execute = fixture()
    const staged = await execute('finance_holdings', {
      action: 'stage-json', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 0,
      as_of: '2026-09-05', base_currency: 'CNY', content: JSON.stringify(positions),
    })
    expect(staged).toMatchObject({ revision: 1, snapshot: { status: 'staged' } })
    await expect(execute('finance_holdings', {
      action: 'confirm', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 1,
      expected_snapshot_hash: portfolioHash({ wrong: true }),
    })).rejects.toMatchObject({ code: 'snapshot-conflict' })
    const confirmed = await execute('finance_holdings', {
      action: 'confirm', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 1,
      expected_snapshot_hash: staged.snapshot.snapshotHash,
    })
    expect(confirmed).toMatchObject({ revision: 2, snapshot: { status: 'confirmed' } })
    await expect(execute('finance_holdings', {
      action: 'confirm', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 2,
      expected_snapshot_hash: staged.snapshot.snapshotHash,
    })).resolves.toMatchObject({ revision: 2, changed: false, snapshot: { status: 'confirmed' } })
  })

  it('rejects formal risk for staged holdings and fails closed on covariance reconciliation', async () => {
    const execute = fixture()
    const staged = await execute('finance_holdings', {
      action: 'stage-json', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 0,
      as_of: '2026-09-05', base_currency: 'CNY', content: JSON.stringify(positions),
    })
    const rejected = await execute('finance_portfolio_risk', {
      action: 'snapshot', workspace_id: 'risk', portfolio_id: 'core-cn', model: model(),
    })
    expect(rejected).toMatchObject({ status: 'rejected', risk: null })
    expect(rejected.issues).toContainEqual(expect.objectContaining({ code: 'holdings-not-confirmed' }))
    await execute('finance_holdings', {
      action: 'confirm', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 1,
      expected_snapshot_hash: staged.snapshot.snapshotHash,
    })
    const invalid = await execute('finance_portfolio_risk', {
      action: 'snapshot', workspace_id: 'risk', portfolio_id: 'core-cn', model: model([[0.5]]),
    })
    expect(invalid).toMatchObject({ status: 'rejected', risk: null, metadata: { qualityStatus: 'unreconciled' } })
    expect(invalid.issues).toContainEqual(expect.objectContaining({ code: 'reconciliation-failed' }))
  })

  it('returns reconciled snapshot, marginal, and stress results only for confirmed holdings', async () => {
    const execute = fixture()
    const staged = await execute('finance_holdings', {
      action: 'stage-json', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 0,
      as_of: '2026-09-05', base_currency: 'CNY', content: JSON.stringify(positions),
    })
    await execute('finance_holdings', {
      action: 'confirm', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 1,
      expected_snapshot_hash: staged.snapshot.snapshotHash,
    })
    await expect(execute('finance_portfolio_risk', {
      action: 'snapshot', workspace_id: 'risk', portfolio_id: 'core-cn', model: model(),
    })).resolves.toMatchObject({ status: 'ok', reconciliation: { status: 'ok' } })
    await expect(execute('finance_portfolio_risk', {
      action: 'marginal', workspace_id: 'risk', portfolio_id: 'core-cn', model: model(),
      proposal: { portfolioId: 'core-cn', asOf: '2026-09-05', baseCurrency: 'CNY', positions },
    })).resolves.toMatchObject({ status: 'ok', totalRiskChange: 0 })
    await expect(execute('finance_portfolio_risk', {
      action: 'stress', workspace_id: 'risk', portfolio_id: 'core-cn', model: model(),
      scenario: { id: 'country-down', shocks: [{ factor: 'COUNTRY', shock: -0.1 }] },
    })).resolves.toMatchObject({ status: 'ok', portfolioReturn: -0.1, portfolioValueImpact: -100 })
  })
})
