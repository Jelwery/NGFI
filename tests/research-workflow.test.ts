import { describe, expect, it } from 'vitest'
import {
  evidenceId,
  modelRunId,
  researchCaseId,
  type Evidence,
  type ModelRun,
  type ResearchCase,
  type StructuredEvidence,
} from '@finance2dsh/research-core'
import type { ResearchCaseState } from '@finance2dsh/research-workspace'
import {
  COMPANY_RESEARCH_V1,
  WorkflowDefinitionError,
  WorkflowRegistry,
  runWorkflow,
  validateWorkflowDefinition,
  type StageResult,
  type WorkflowDefinition,
} from '@finance2dsh/research-workflow'

const clock = '2026-09-06T08:00:00.000Z'
const subject = {
  kind: 'instrument' as const,
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
}

function caseState(): ResearchCaseState {
  const content = {
    subject,
    mandate: 'Assess earnings durability',
    asOf: '2026-09-06',
    status: 'active' as const,
    createdAt: clock,
    updatedAt: clock,
  }
  const researchCase: ResearchCase = { caseId: researchCaseId(content), ...content }
  return {
    revision: 3,
    case: researchCase,
    evidence: [],
    assumptions: [],
    claims: [],
    modelRuns: [],
    memo: '',
    decisions: [],
    runManifests: [],
    fileHashes: {},
  }
}

function evidence(): Evidence {
  const content: Omit<StructuredEvidence, 'id'> = {
    kind: 'structured',
    subject,
    field: 'revenue',
    value: 181_200_000_000,
    period: 'FY2025',
    unit: 'CNY',
    quality: 'high',
    sourceRef: {
      provider: 'annual-report',
      upstream: 'annual-report',
      sourceKind: 'official',
      retrievedAt: clock,
    },
    limitations: [],
  }
  return { id: evidenceId(content), ...content }
}

function valuation(inputRef: string): ModelRun {
  const content: Omit<ModelRun, 'id'> = {
    model: 'valuation',
    version: '1.0.0',
    inputRefs: [{ kind: 'evidence', id: inputRef }],
    parameters: {},
    output: { status: 'ok', value: { value: 37.3977, display: '37.40倍' } },
    warnings: [],
    createdAt: clock,
  }
  return { id: modelRunId(content), ...content }
}

function stageResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    outcome: 'complete',
    capabilities: [],
    evidence: [],
    assumptions: [],
    claims: [],
    modelRuns: [],
    gaps: [],
    ...overrides,
  }
}

describe('workflow registry and company-research-v1', () => {
  it('registers the canonical company stages in dependency order', () => {
    const registry = new WorkflowRegistry()
    registry.register(COMPANY_RESEARCH_V1)
    const registered = registry.get('company-research-v1')

    expect(registered.stages.map(stage => stage.id)).toEqual([
      'scope', 'fundamentals', 'valuation', 'risks', 'memo',
    ])
    expect(registered.stages.slice(1).map(stage => stage.dependsOn)).toEqual([
      ['scope'], ['fundamentals'], ['valuation'], ['risks'],
    ])
  })

  it('rejects unknown dependencies, duplicate stages, and dependency cycles', () => {
    const base: WorkflowDefinition = {
      id: 'invalid', version: '1', finalStage: 'a', requiredReportSections: [],
      stages: [{ id: 'a', dependsOn: [], requiredCapabilities: [], requiredCalculations: [], maxAttempts: 1 }],
    }
    expect(() => validateWorkflowDefinition({
      ...base,
      stages: [...base.stages, { ...base.stages[0]! }],
    })).toThrow(WorkflowDefinitionError)
    expect(() => validateWorkflowDefinition({
      ...base,
      stages: [{ ...base.stages[0]!, dependsOn: ['missing'] }],
    })).toThrow(/unknown dependency/u)
    expect(() => validateWorkflowDefinition({
      ...base,
      stages: [
        { ...base.stages[0]!, dependsOn: ['b'] },
        { ...base.stages[0]!, id: 'b', dependsOn: ['a'] },
      ],
    })).toThrow(/cycle/u)
  })
})

describe('workflow runner', () => {
  it('runs scope through memo, retries a failed stage, and completes only after the WP04 gate', async () => {
    const ev = evidence()
    const model = valuation(ev.id)
    const calls: string[] = []
    let fundamentalsAttempts = 0
    const result = await runWorkflow({
      definition: COMPANY_RESEARCH_V1,
      caseState: caseState(),
      now: () => new Date(clock),
      audit: { lexicon: {
        ignoredPatterns: [/\b(?:19|20)\d{2}\b/gu],
        unitScales: { '': 1, 亿元: 1e8, '%': 1, 倍: 1 },
        percentSuffixes: ['%'],
        subjectCodes: ['600519'],
      } },
      executor: ({ stage }) => {
        calls.push(stage.id)
        if (stage.id === 'scope') return stageResult({ capabilities: ['instrument-reference'] })
        if (stage.id === 'fundamentals') {
          fundamentalsAttempts += 1
          if (fundamentalsAttempts === 1) throw new Error('temporary extraction failure')
          return stageResult({ capabilities: ['fundamentals', 'disclosures'], evidence: [ev] })
        }
        if (stage.id === 'valuation') {
          return stageResult({ capabilities: ['quote'], modelRuns: [model] })
        }
        if (stage.id === 'risks') return stageResult({ capabilities: ['disclosures'] })
        return stageResult({ report: [
          '## Scope',
          'Security remains in scope [' + ev.id + '].',
          '## Fundamentals',
          'Revenue was 1812亿元 [' + ev.id + '].',
          '## Valuation',
          'Valuation is 37.40倍 [' + model.id + '].',
          '## Risks',
          'Revenue concentration remains material [' + ev.id + '].',
        ].join('\n') })
      },
    })

    expect(calls).toEqual(['scope', 'fundamentals', 'fundamentals', 'valuation', 'risks', 'memo'])
    expect(result).toMatchObject({ state: 'done', outcome: 'complete', audit: { passed: true } })
    expect(result.stages.fundamentals?.attempts).toHaveLength(2)
    expect(result.stages.fundamentals?.state).toBe('done')
  })

  it('does not merge failed-attempt artifacts into the accepted dossier', async () => {
    const good = evidence()
    const bad = { ...evidence(), id: 'ev-' + '9'.repeat(64), value: 999 }
    let attempt = 0
    const workflow: WorkflowDefinition = {
      id: 'retry-isolation', version: '1', finalStage: 'collect', requiredReportSections: [],
      stages: [{
        id: 'collect', dependsOn: [], requiredCapabilities: [], requiredCalculations: [], maxAttempts: 2,
      }],
    }
    const result = await runWorkflow({
      definition: workflow,
      caseState: caseState(),
      executor: () => {
        attempt += 1
        return attempt === 1
          ? stageResult({ outcome: 'failed', evidence: [bad] })
          : stageResult({ evidence: [good], report: 'Valid [' + good.id + ']' })
      },
    })

    expect(result.dossier.evidence.map(item => item.id)).toEqual([good.id])
    expect(result.stages.collect?.attempts.map(item => item.outcome)).toEqual(['failed', 'complete'])
  })

  it('resumes at the failed stage without rerunning completed dependencies', async () => {
    const ev = evidence()
    const workflow: WorkflowDefinition = {
      id: 'resume-test', version: '1', finalStage: 'memo', requiredReportSections: [],
      stages: [
        { id: 'collect', dependsOn: [], requiredCapabilities: [], requiredCalculations: [], maxAttempts: 1 },
        { id: 'memo', dependsOn: ['collect'], requiredCapabilities: [], requiredCalculations: [], maxAttempts: 1 },
      ],
    }
    const firstCalls: string[] = []
    const paused = await runWorkflow({
      definition: workflow,
      caseState: caseState(),
      executor: ({ stage }) => {
        firstCalls.push(stage.id)
        if (stage.id === 'collect') return stageResult({ evidence: [ev] })
        throw new Error('memo renderer unavailable')
      },
    })
    expect(paused).toMatchObject({ state: 'paused', stages: { collect: { state: 'done' }, memo: { state: 'pending' } } })

    const resumedCalls: string[] = []
    const resumed = await runWorkflow({
      definition: workflow,
      caseState: caseState(),
      resume: paused,
      executor: ({ stage }) => {
        resumedCalls.push(stage.id)
        return stageResult({ report: 'Recovered memo [' + ev.id + ']' })
      },
    })
    expect(firstCalls).toEqual(['collect', 'memo'])
    expect(resumedCalls).toEqual(['memo'])
    expect(resumed).toMatchObject({ state: 'done', outcome: 'complete', audit: { passed: true } })
    expect(resumed.stages.memo?.attempts).toHaveLength(2)
  })

  it('rejects missing required capabilities or calculations unless an explicit gap explains them', async () => {
    const workflow: WorkflowDefinition = {
      id: 'requirements', version: '1', finalStage: 'only', requiredReportSections: [],
      stages: [{
        id: 'only',
        dependsOn: [],
        requiredCapabilities: ['fundamentals'],
        requiredCalculations: ['valuation'],
        maxAttempts: 1,
      }],
    }
    const invalid = await runWorkflow({
      definition: workflow,
      caseState: caseState(),
      executor: () => stageResult({ report: 'No data' }),
    })
    expect(invalid).toMatchObject({ state: 'paused', stages: { only: { outcome: 'failed' } } })
    expect(invalid.stages.only?.attempts[0]?.error).toMatch(/capability:fundamentals.*calculation:valuation/u)

    const disclosed = await runWorkflow({
      definition: workflow,
      caseState: caseState(),
      executor: () => stageResult({
        outcome: 'incomplete',
        report: 'No data',
        gaps: [
          {
            operation: 'valuation', reasonCode: 'missing', detail: 'No inputs', attemptedCapabilities: [],
          },
          {
            operation: 'fundamentals', reasonCode: 'unsupported', detail: 'No provider',
            attemptedCapabilities: ['fundamentals'],
          },
        ],
      }),
    })
    expect(disclosed).toMatchObject({ state: 'done', outcome: 'incomplete' })
  })

  it('cannot report complete when the final WP04 audit fails', async () => {
    const ev = evidence()
    const workflow: WorkflowDefinition = {
      id: 'audit-gated', version: '1', finalStage: 'memo', requiredReportSections: ['Summary'],
      stages: [{ id: 'memo', dependsOn: [], requiredCapabilities: [], requiredCalculations: [], maxAttempts: 1 }],
    }
    const result = await runWorkflow({
      definition: workflow,
      caseState: caseState(),
      executor: () => stageResult({ evidence: [ev], report: '## Summary\nRevenue was 1912亿元 [' + ev.id + '].' }),
    })
    expect(result).toMatchObject({ state: 'done', outcome: 'incomplete', audit: { passed: false } })
    expect(result.audit?.findings.map(item => item.code)).toContain('unbound-number')
  })
})
