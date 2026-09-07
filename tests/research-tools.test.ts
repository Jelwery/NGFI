import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  createThesisSnapshot,
  evidenceId,
  modelRunId,
  researchRunId,
  type Evidence,
  type ModelRun,
  type ResearchRunManifest,
} from '@finance2dsh/research-core'
import { createResearchTools } from '@finance2dsh/dsh-tools'

const clock = '2026-09-06T08:00:00.000Z'
const subject = {
  kind: 'instrument' as const,
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-research-tools-'))
  roots.push(runtimeRoot)
  const tools = createResearchTools({ runtimeRoot })
  const execute = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(candidate => candidate.name === name)
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    return tool.execute(args as never, { signal: new AbortController().signal } as never) as Promise<any>
  }
  return { runtimeRoot, tools, execute }
}

async function createCase(execute: ReturnType<typeof fixture>['execute']) {
  return execute('finance_research_case', {
    action: 'create', workspace_id: 'primary', subject, mandate: 'Assess earnings durability',
    as_of: '2026-09-06', status: 'active', created_at: clock,
  })
}

function evidence(): Evidence {
  const content = {
    kind: 'structured' as const, subject, field: 'revenue', value: 181_200_000_000,
    period: 'FY2025', unit: 'CNY', currency: 'CNY', quality: 'high' as const,
    sourceRef: {
      provider: 'fixture', upstream: 'annual-report', sourceKind: 'official' as const,
      publishedAt: '2026-03-30T02:00:00.000Z', availableAt: '2026-03-30T02:05:00.000Z',
      retrievedAt: clock,
    },
    limitations: [],
  }
  return { id: evidenceId(content), ...content }
}

describe('research DSH tools', () => {
  it('uses bounded workspace ids and preserves optimistic revision and idempotence semantics', async () => {
    const { runtimeRoot, execute } = fixture()
    await expect(execute('finance_research_case', {
      action: 'create', workspace_id: '../escape', subject, mandate: 'x', as_of: '2026-09-06',
    })).rejects.toThrow(/workspace_id/u)
    expect(fs.existsSync(path.join(runtimeRoot, 'escape'))).toBe(false)

    const created = await createCase(execute)
    await expect(createCase(execute)).resolves.toEqual(created)
    const saved = await execute('finance_research_ledger', {
      action: 'save-memo', workspace_id: 'primary', case_id: created.case.caseId,
      expected_revision: 0, memo: '# Memo\n',
    })
    expect(saved).toEqual({ revision: 1, changed: true })
    await expect(execute('finance_research_ledger', {
      action: 'save-memo', workspace_id: 'primary', case_id: created.case.caseId,
      expected_revision: 0, memo: '# stale\n',
    })).rejects.toMatchObject({ code: 'revision-conflict' })
    await expect(execute('finance_research_ledger', {
      action: 'save-memo', workspace_id: 'primary', case_id: created.case.caseId,
      expected_revision: 1, memo: '# Memo\n',
    })).resolves.toEqual({ revision: 1, changed: false })
  })

  it('creates a frozen replay from immutable run artifacts and rejects tampering', async () => {
    const { runtimeRoot, execute } = fixture()
    const created = await createCase(execute)
    const caseId = created.case.caseId as string
    const runId = researchRunId({ caseId, asOf: '2026-09-06', startedAt: clock })
    const artifact = await execute('finance_research_ledger', {
      action: 'write-artifact', workspace_id: 'primary', case_id: caseId, expected_revision: 0,
      artifact_path: `${runId}/report.md`, artifact_content: '# Audited report\n',
    })
    const manifest: ResearchRunManifest = {
      runId, caseId, asOf: '2026-09-06', startedAt: clock, finishedAt: '2026-09-06T08:01:00.000Z',
      codeVersion: 'git:test', configVersion: 'company-research-v1',
      configHash: `sha256:${'b'.repeat(64)}`, modelVersion: 'fixture',
      artifactHashes: { [artifact.path]: artifact.hash }, status: 'complete', gaps: [],
    }
    await execute('finance_research_ledger', {
      action: 'save-run-manifest', workspace_id: 'primary', case_id: caseId,
      expected_revision: artifact.revision, payload: manifest,
    })
    const snapshot = await execute('finance_research_snapshot', {
      action: 'create', workspace_id: 'primary', snapshot_id: 'approved', case_id: caseId,
      run_id: runId, created_at: clock,
    })
    await expect(execute('finance_research_snapshot', {
      action: 'verify', workspace_id: 'primary', snapshot_id: 'approved',
    })).resolves.toEqual(snapshot)
    await expect(execute('finance_research_snapshot', {
      action: 'create', workspace_id: 'primary', snapshot_id: 'approved', case_id: caseId,
      run_id: runId, created_at: clock,
    })).resolves.toEqual(snapshot)
    const receipt = await execute('finance_research_snapshot', {
      action: 'seed', workspace_id: 'primary', snapshot_id: 'approved', created_at: clock,
    })
    await expect(execute('finance_research_snapshot', {
      action: 'verify-seeded', workspace_id: 'primary', snapshot_id: 'approved', receipt,
    })).resolves.toMatchObject({ case: { caseId }, revision: 2 })
    await expect(execute('finance_research_snapshot', {
      action: 'seed', workspace_id: 'primary', snapshot_id: 'approved', created_at: clock,
    })).resolves.toEqual(receipt)
    const snapshotRoot = path.join(runtimeRoot, 'research-snapshots', 'primary', 'approved')
    fs.writeFileSync(path.join(snapshotRoot, caseId, artifact.path), 'tampered')
    await expect(execute('finance_research_snapshot', {
      action: 'verify', workspace_id: 'primary', snapshot_id: 'approved',
    })).rejects.toMatchObject({ code: 'snapshot-invalid' })
  })

  it('keeps failed report audits from becoming complete workflow outcomes', async () => {
    const { execute } = fixture()
    const created = await createCase(execute)
    const ev = evidence()
    const modelContent: Omit<ModelRun, 'id'> = {
      model: 'valuation', version: '1.0.0', inputRefs: [{ kind: 'evidence', id: ev.id }],
      parameters: {}, output: { status: 'ok', value: { enterpriseValue: 100 } },
      warnings: [], createdAt: clock,
    }
    const model = { id: modelRunId(modelContent), ...modelContent }
    const stage = (overrides: Record<string, unknown> = {}) => ({
      outcome: 'complete', capabilities: [], evidence: [], assumptions: [], claims: [],
      modelRuns: [], gaps: [], ...overrides,
    })
    const result = await execute('finance_research_workflow', {
      action: 'run', workspace_id: 'primary', case_id: created.case.caseId,
      stage_results: {
        scope: stage({ capabilities: ['instrument-reference'] }),
        fundamentals: stage({ capabilities: ['fundamentals', 'disclosures'], evidence: [ev] }),
        valuation: stage({ capabilities: ['quote'], modelRuns: [model] }),
        risks: stage({ capabilities: ['disclosures'] }),
        memo: stage({ report: [
          '## Scope', `Unsupported number 999 [${ev.id}].`,
          '## Fundamentals', `Revenue is documented [${ev.id}].`,
          '## Valuation', `A model exists [${model.id}].`,
          '## Risks', `Evidence remains limited [${ev.id}].`,
        ].join('\n') }),
      },
    })
    expect(result).toMatchObject({ state: 'done', outcome: 'incomplete', audit: { passed: false } })
  })

  it('preserves insufficient thesis drift and explicit adversarial executor unavailability', async () => {
    const { execute } = fixture()
    const current = createThesisSnapshot({
      caseId: `case-${'a'.repeat(64)}`, asOf: '2026-09-06', createdAt: clock,
      dimensions: [
        'core-assumptions', 'valuation-anchors', 'red-lines',
        'management-capital-allocation', 'competitive-advantage',
      ].map(dimension => ({
        dimension, thesisKey: dimension, assessment: 'unknown', claimRefs: [],
        assumptionRefs: [], evidenceRefs: [], priceEvidenceRefs: [], summary: 'Evidence unavailable.',
      })) as never,
      claims: [], assumptions: [], evidence: [],
    })
    await expect(execute('finance_thesis_drift', { current })).resolves.toMatchObject({
      baselineAvailable: false, outcome: 'insufficient',
    })
    await expect(execute('finance_adversarial_review', {
      workspace_id: 'primary', snapshot_id: 'approved', review_id: 'review-1',
    })).rejects.toThrow('adversarial DSH executor is unavailable')
  })
})
