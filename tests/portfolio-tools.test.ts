import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { portfolioHash } from '@finance2dsh/portfolio-risk'
import { evidenceId } from '@finance2dsh/research-core'
import { ResearchWorkspace } from '@finance2dsh/research-workspace'
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
  it('persists optimization evidence and reuses only a matching confirmed draft', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-optimize-audit-'))
    roots.push(runtimeRoot)
    const project = path.join(process.cwd(), 'packages/combinatorial-optimization')
    const input = JSON.parse(execFileSync(path.join(project, '.venv/bin/python'), ['-c',
      'import json,runpy; m=runpy.run_path("quant_tests/test_optimizer.py"); print(json.dumps(m["example_input"]()))'], { cwd: project, encoding: 'utf8' }))
    const tools = createPortfolioTools({ runtimeRoot, quantProjectRoot: project })
    const execute = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!
      .execute(args as never, { signal: new AbortController().signal } as never) as Promise<any>
    const staged = await execute('finance_holdings', {
      action: 'stage-json', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 0,
      as_of: '2026-01-06', base_currency: 'CNY', content: JSON.stringify(positions),
    })
    await execute('finance_holdings', { action: 'confirm', workspace_id: 'risk', portfolio_id: 'core-cn',
      expected_revision: 1, expected_snapshot_hash: staged.snapshot.snapshotHash })
    const store = new ResearchWorkspace({ root: path.join(runtimeRoot, 'research/risk') })
    const state = store.create({ subject: { kind: 'portfolio', portfolioId: 'core-cn' }, mandate: 'Dry-run rank allocation',
      asOf: '2026-01-06', createdAt: '2026-01-06T01:00:00.000Z' })
    const content = { kind: 'structured' as const, subject: state.case.subject, field: 'scores', value: [1, -1], quality: 'high' as const,
      sourceRef: { provider: 'fixture', upstream: 'scores-v1', sourceKind: 'user' as const, availableAt: '2026-01-06T01:00:00.000Z', retrievedAt: '2026-01-06T01:00:00.000Z' }, limitations: [] }
    const ev = { id: evidenceId(content), ...content }
    const appended = store.appendEvidence(state.case.caseId, state.revision, [ev])
    const artifact = store.writeArtifact(state.case.caseId, appended.revision, 'mandate.json', JSON.stringify(input.mandate))
    input.assets[0].quantity = 100
    input.assets[0].sellableQuantity = 100
    input.cash = 99000
    for (const asset of input.assets) asset.evidenceRefs = [ev.id]
    delete input.inputHash
    input.inputHash = portfolioHash(input)
    const args = { workspace_id: 'risk', case_id: state.case.caseId, portfolio_id: 'core-cn',
      expected_revision: artifact.revision, holdings_snapshot_hash: staged.snapshot.snapshotHash, mandate_artifact: artifact.path, input }
    const optimized = await execute('finance_portfolio_optimize', args)
    expect(optimized.result.status).toBe('ok')
    expect(optimized.result.continuous.alpha).toEqual({ 'CN:SSE:600000:equity': 1, 'CN:SZSE:000001:equity': -1 })
    const saved = store.open(state.case.caseId)
    expect(saved.modelRuns).toHaveLength(1)
    expect(saved.evidence.some(item => item.id === optimized.evidenceId)).toBe(true)
    const planArgs = { workspace_id: 'risk', case_id: state.case.caseId, portfolio_id: 'core-cn', expected_revision: saved.revision,
      holdings_snapshot_hash: staged.snapshot.snapshotHash, optimization_run_id: optimized.modelRunId }
    const plan = await execute('finance_rebalance_plan', planArgs)
    expect(plan).toMatchObject({ dryRun: true, optimizationRunId: optimized.modelRunId, plan: optimized.result.repaired })
    await expect(execute('finance_portfolio_optimize', { ...args, dry_run: false })).rejects.toThrow('dry-run')
    await expect(execute('finance_rebalance_plan', { ...planArgs, expected_revision: plan.revision, holdings_snapshot_hash: 'sha256:wrong' })).rejects.toThrow('holdings')
    await expect(execute('finance_portfolio_optimize', { ...args, expected_revision: plan.revision, mandate_artifact: '../escape.json' })).rejects.toThrow('registered')
  }, 30_000)

  it('binds cash and sellable quantities to the confirmed account state', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-account-state-'))
    roots.push(runtimeRoot)
    const project = path.join(process.cwd(), 'packages/combinatorial-optimization')
    const input = JSON.parse(execFileSync(path.join(project, '.venv/bin/python'), ['-c',
      'import json,runpy; m=runpy.run_path("quant_tests/test_optimizer.py"); print(json.dumps(m["example_input"]()))'], { cwd: project, encoding: 'utf8' }))
    const tools = createPortfolioTools({ runtimeRoot, quantProjectRoot: project })
    const execute = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!
      .execute(args as never, { signal: new AbortController().signal } as never) as Promise<any>
    const accountState = { cash: 99000, cashAvailableAt: '2026-01-06T01:00:00.000Z', valuationAt: '2026-01-06T01:00:00.000Z' }
    const positionsWithSellable = [{ ...positions[0], sellableQuantity: 100 }]
    const staged = await execute('finance_holdings', {
      action: 'stage-json', workspace_id: 'risk', portfolio_id: 'core-cn', expected_revision: 0,
      as_of: '2026-01-06', base_currency: 'CNY', content: JSON.stringify(positionsWithSellable), account_state: accountState,
    })
    await execute('finance_holdings', { action: 'confirm', workspace_id: 'risk', portfolio_id: 'core-cn',
      expected_revision: 1, expected_snapshot_hash: staged.snapshot.snapshotHash })
    const store = new ResearchWorkspace({ root: path.join(runtimeRoot, 'research/risk') })
    const state = store.create({ subject: { kind: 'portfolio', portfolioId: 'core-cn' }, mandate: 'Dry-run rank allocation',
      asOf: '2026-01-06', createdAt: '2026-01-06T01:00:00.000Z' })
    const content = { kind: 'structured' as const, subject: state.case.subject, field: 'scores', value: [1, -1], quality: 'high' as const,
      sourceRef: { provider: 'fixture', upstream: 'scores-v1', sourceKind: 'user' as const, availableAt: '2026-01-06T01:00:00.000Z', retrievedAt: '2026-01-06T01:00:00.000Z' }, limitations: [] }
    const ev = { id: evidenceId(content), ...content }
    const appended = store.appendEvidence(state.case.caseId, state.revision, [ev])
    const artifact = store.writeArtifact(state.case.caseId, appended.revision, 'mandate.json', JSON.stringify(input.mandate))
    input.assets[0].quantity = 100
    input.assets[0].sellableQuantity = 100
    input.cash = 99000
    input.cashAvailableAt = accountState.cashAvailableAt
    for (const asset of input.assets) asset.evidenceRefs = [ev.id]
    delete input.inputHash
    input.inputHash = portfolioHash(input)
    const args = { workspace_id: 'risk', case_id: state.case.caseId, portfolio_id: 'core-cn',
      expected_revision: artifact.revision, holdings_snapshot_hash: staged.snapshot.snapshotHash, mandate_artifact: artifact.path, input }
    const optimized = await execute('finance_portfolio_optimize', args)
    expect(optimized.result.status).toBe('ok')
    // Cash that disagrees with the confirmed account state is rejected.
    const badCash = { ...input, cash: 88000 }
    delete badCash.inputHash
    badCash.inputHash = portfolioHash(badCash)
    await expect(execute('finance_portfolio_optimize', { ...args, expected_revision: store.open(state.case.caseId).revision, input: badCash }))
      .rejects.toThrow('cash differs from confirmed account state')
  }, 30_000)

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
