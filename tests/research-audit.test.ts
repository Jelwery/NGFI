import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  evidenceId,
  modelRunId,
  researchRunId,
  type Evidence,
  type Gap,
  type ModelRun,
  type ResearchRunManifest,
  type StructuredEvidence,
} from '@finance2dsh/research-core'
import {
  auditResearchReport,
  checkNumberFidelity,
  createFinancialNumberLexicon,
  detectSourceConflicts,
} from '@finance2dsh/research-audit'

const subject = {
  kind: 'instrument' as const,
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
}
const clock = '2026-09-06T08:00:00.000Z'

function evidence(field: string, value: number, unit: string, provider = 'annual-report'): Evidence {
  const content: Omit<StructuredEvidence, 'id'> = {
    kind: 'structured',
    subject,
    field,
    value,
    period: 'FY2025',
    unit,
    quality: 'high',
    sourceRef: {
      provider,
      upstream: provider,
      sourceKind: 'official',
      retrievedAt: clock,
    },
    limitations: [],
  }
  return { id: evidenceId(content), ...content }
}

function calculation(inputRef: string): ModelRun {
  const content: Omit<ModelRun, 'id'> = {
    model: 'pe-ttm',
    version: '1.0.0',
    inputRefs: [{ kind: 'evidence', id: inputRef }],
    parameters: {},
    output: { status: 'ok', value: { value: 37.397700293773134, display: '37.40倍' } },
    warnings: [],
    createdAt: clock,
  }
  return { id: modelRunId(content), ...content }
}

function completeManifest(gaps: Gap[] = []): ResearchRunManifest {
  const identity = {
    caseId: 'case-' + 'a'.repeat(64),
    asOf: '2026-09-06',
    startedAt: clock,
  }
  return {
    runId: researchRunId(identity),
    ...identity,
    finishedAt: '2026-09-06T08:01:00.000Z',
    codeVersion: 'git:test',
    configVersion: 'company-research-v1',
    configHash: ('sha256:' + 'b'.repeat(64)) as ResearchRunManifest['configHash'],
    modelVersion: 'fixture',
    artifactHashes: {},
    status: 'complete',
    gaps,
  }
}

function validFixture() {
  const revenue = evidence('revenue', 181_200_000_000, 'CNY')
  const margin = evidence('gross-margin', 0.123, 'ratio')
  const model = calculation(revenue.id)
  const report = [
    '# Company memo',
    '## Summary',
    'FY2025 revenue was 1812亿元 [' + revenue.id + '].',
    'Gross margin was 12.3% [' + margin.id + '].',
    'The valuation anchor is 37.40倍 [' + model.id + '].',
    'As of 2026-09-06, security 600519 remains in scope.',
    '## Risks',
    'Revenue concentration remains the key risk [' + revenue.id + '].',
  ].join('\n')
  return { revenue, margin, model, report }
}

describe('research report audit gate', () => {
  it('passes sections, citations, scaled numbers, percentages, and display values', () => {
    const fixture = validFixture()
    const input = {
      report: fixture.report,
      evidence: [fixture.revenue, fixture.margin],
      modelRuns: [fixture.model],
      requiredSections: ['Summary', 'Risks'],
      lexicon: createFinancialNumberLexicon(['600519']),
      sampleSize: 2,
      sampleSeed: 'stable',
    }
    const result = auditResearchReport({ ...input, manifest: completeManifest() })

    expect(result).toMatchObject({ passed: true, allowedStatus: 'complete' })
    expect(result.findings).toEqual([])
    expect(result.numberFidelity).toMatchObject({ checked: 3, bound: 3, findings: [] })
    expect(result.reviewSample).toHaveLength(2)
    expect(auditResearchReport(input).reviewSample).toEqual(result.reviewSample)
  })

  it('rejects a tampered number even when the cited evidence id exists on the same line', () => {
    const fixture = validFixture()
    const result = auditResearchReport({
      report: fixture.report.replace('1812亿元', '1912亿元'),
      evidence: [fixture.revenue, fixture.margin],
      modelRuns: [fixture.model],
      requiredSections: ['Summary', 'Risks'],
      lexicon: createFinancialNumberLexicon(['600519']),
    })

    expect(result.passed).toBe(false)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'unbound-number', token: '1912亿元', refs: [fixture.revenue.id],
    }))
  })

  it('rejects unknown citations, uncited numbers, missing sections, and reports with no evidence', () => {
    const fixture = validFixture()
    const unknown = 'ev-' + 'f'.repeat(64)
    const invalid = auditResearchReport({
      report: '# Memo\n## Summary\nRevenue was 1912亿元 [' + unknown + '].\nMargin was 12.3%.',
      evidence: [fixture.revenue],
      modelRuns: [],
      requiredSections: ['Summary', 'Risks'],
    })
    expect(new Set(invalid.findings.map(item => item.code))).toEqual(new Set([
      'missing-section', 'invalid-citation', 'unbound-number',
    ]))

    const emptyLedger = auditResearchReport({ report: '# Memo\nNo evidence.', evidence: [], modelRuns: [] })
    expect(emptyLedger.findings.map(item => item.code)).toContain('missing-citation')
  })

  it('does not mistake dates, fiscal periods, or the configured security code for numeric claims', () => {
    const fixture = validFixture()
    const result = checkNumberFidelity(
      'FY2025 / 2025Q4 / 2026-09-06 / 600519 [' + fixture.revenue.id + ']',
      [fixture.revenue],
      [],
      createFinancialNumberLexicon(['600519']),
    )
    expect(result).toEqual({ checked: 0, bound: 0, findings: [] })
  })

  it('requires calculation display text and rejects the raw floating-point output', () => {
    const fixture = validFixture()
    const report = '## Summary\nRaw output 37.397700293773134 [' + fixture.model.id
      + ']\n## Risks\nNone [' + fixture.revenue.id + ']'
    const result = auditResearchReport({
      report,
      evidence: [fixture.revenue],
      modelRuns: [fixture.model],
      requiredSections: ['Summary', 'Risks'],
    })
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'missing-display' }))
  })
})

describe('research ledger and source gates', () => {
  it('rejects missing input references and calculation cycles', () => {
    const fixture = validFixture()
    const firstId = 'model-' + '1'.repeat(64)
    const secondId = 'model-' + '2'.repeat(64)
    const first: ModelRun = { ...fixture.model, id: firstId, inputRefs: [{ kind: 'model-run', id: secondId }] }
    const second: ModelRun = { ...fixture.model, id: secondId, inputRefs: [{ kind: 'model-run', id: firstId }] }
    const missing: ModelRun = {
      ...fixture.model,
      id: 'model-' + '3'.repeat(64),
      inputRefs: [{ kind: 'evidence', id: 'ev-' + '9'.repeat(64) }],
    }
    const result = auditResearchReport({
      report: fixture.report,
      evidence: [fixture.revenue, fixture.margin],
      modelRuns: [fixture.model, first, second, missing],
      lexicon: createFinancialNumberLexicon(['600519']),
    })

    expect(result.findings.map(item => item.code)).toContain('missing-input-ref')
    expect(result.findings.map(item => item.code)).toContain('calculation-cycle')
  })

  it('requires an explicit resolution covering every side of a cross-source conflict', () => {
    const fixture = validFixture()
    const alternate = evidence('revenue', 182_000_000_000, 'CNY', 'exchange-filing')
    const conflicts = detectSourceConflicts([fixture.revenue, alternate])
    expect(conflicts).toHaveLength(1)

    const unresolved = auditResearchReport({
      report: fixture.report,
      evidence: [fixture.revenue, fixture.margin, alternate],
      modelRuns: [fixture.model],
      lexicon: createFinancialNumberLexicon(['600519']),
    })
    expect(unresolved.findings).toContainEqual(expect.objectContaining({ code: 'unhandled-source-conflict' }))

    const resolved = auditResearchReport({
      report: fixture.report,
      evidence: [fixture.revenue, fixture.margin, alternate],
      modelRuns: [fixture.model],
      conflictResolutions: [{
        conflictId: conflicts[0]!.id,
        evidenceRefs: conflicts[0]!.evidenceRefs,
        rationale: 'Use the audited annual report and retain the exchange discrepancy.',
      }],
      lexicon: createFinancialNumberLexicon(['600519']),
    })
    expect(resolved.findings.map(item => item.code)).not.toContain('unhandled-source-conflict')
  })

  it('keeps gaps and terminal status consistent before allowing complete', () => {
    const fixture = validFixture()
    const gap: Gap = {
      operation: 'research-consensus',
      reasonCode: 'unsupported',
      detail: 'No configured provider',
      attemptedCapabilities: ['research-consensus'],
    }
    const result = auditResearchReport({
      report: fixture.report,
      evidence: [fixture.revenue, fixture.margin],
      modelRuns: [fixture.model],
      manifest: completeManifest([gap]),
      gaps: [],
      lexicon: createFinancialNumberLexicon(['600519']),
    })
    expect(result).toMatchObject({ passed: false, allowedStatus: 'incomplete' })
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'status-gap-mismatch' }))
  })

  it('locks the unit-scaling fixture expectations', () => {
    const fixturePath = path.join(process.cwd(), 'evals/research-audit/fixtures/number-fidelity-cases.json')
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
      cases: Array<{ evidenceValue: number; reportToken: string; expectedBound: boolean }>
    }
    for (const item of fixture.cases) {
      const source = evidence('fixture-value', item.evidenceValue, 'fixture')
      const result = checkNumberFidelity(item.reportToken + ' [' + source.id + ']', [source], [])
      expect(result.findings.length === 0).toBe(item.expectedBound)
    }
  })
})
