import { describe, expect, it } from 'vitest'
import {
  assumptionId,
  canonicalJson,
  claimId,
  evidenceId,
  modelRunId,
  researchCaseId,
  researchRunId,
  sourceRefFromProvenance,
  validateAssumption,
  validateClaim,
  validateEvidence,
  validateGap,
  validateModelRun,
  validateResearchCase,
  validateResearchRunManifest,
  validateSourceRef,
  type Assumption,
  type Claim,
  type Evidence,
  type ModelRun,
  type RangeAssumption,
  type ResearchCase,
  type ResearchRunManifest,
  type SourceRef,
  type StructuredEvidence,
} from '@finance2dsh/research-core'
import type { DataProvenance } from '@finance2dsh/core'

const subject = {
  kind: 'instrument' as const,
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
}

const provenance: DataProvenance = {
  requestedProvider: 'auto',
  actualProvider: 'astock',
  provider: 'astock',
  upstreamSource: 'sse',
  sourceKind: 'official',
  sourceUrl: 'https://example.test/filing/600519',
  fetchedAt: '2026-09-06T08:00:00+08:00',
  observedAt: '2025-12-31',
  publishedAt: '2026-03-30T10:00:00+08:00',
  availableAt: '2026-03-30T10:05:00+08:00',
  fiscalPeriod: '2025-12-31',
  timezone: 'Asia/Shanghai',
  currency: 'CNY',
  unit: 'CNY',
  adjustment: 'none',
  upstreamVersion: '2026-09-05',
  upstreamCommit: '09e8404a33ba0d05e036e01207be4701c61d692c',
  fallbackChain: [{ provider: 'astock', outcome: 'success', qualityTier: 'official' }],
  qualityTier: 'official',
  qualityDowngrade: false,
  derived: {
    inputRefs: ['raw:sse-600519-2025'],
    algorithm: 'fundamentals-normalizer',
    algorithmVersion: '1.0.0',
    methodology: 'reported value',
  },
}

function source(): SourceRef {
  return sourceRefFromProvenance(provenance, {
    hash: `sha256:${'a'.repeat(64)}`,
  })
}

function evidence(): Evidence {
  const content: Omit<StructuredEvidence, 'id'> = {
    kind: 'structured',
    subject,
    field: 'revenue',
    value: { reported: 181_200_000_000, scope: 'consolidated' },
    period: 'FY2025',
    unit: 'CNY',
    currency: 'CNY',
    quality: 'high',
    sourceRef: source(),
    limitations: ['Unaudited restatements may arrive later'],
  }
  return { id: evidenceId(content), ...content }
}

function assumption(evidenceRef: string): Assumption {
  const content: Omit<RangeAssumption, 'id'> = {
    kind: 'range',
    name: 'Revenue growth',
    range: { lower: 0.06, upper: 0.1 },
    unit: 'ratio',
    scenario: 'base',
    rationale: 'Anchored to reported growth with a normalization haircut',
    evidenceRefs: [evidenceRef],
    owner: 'analyst',
    version: 1,
  }
  return { id: assumptionId(content), ...content }
}

function modelRun(evidenceRef: string, assumptionRef: string): ModelRun {
  const content: Omit<ModelRun, 'id'> = {
    model: 'dcf',
    version: '1.2.0',
    inputRefs: [
      { kind: 'evidence', id: evidenceRef },
      { kind: 'assumption', id: assumptionRef },
      { kind: 'claim', id: `claim-${'d'.repeat(64)}` },
    ],
    parameters: { scenario: 'base', forecastYears: 5 },
    output: { status: 'ok', value: { enterpriseValue: 2_300_000_000_000 } },
    warnings: [],
    createdAt: '2026-09-06T08:30:00+08:00',
  }
  return { id: modelRunId(content), ...content }
}

describe('research-core deterministic identity', () => {
  it('sorts object keys recursively while preserving array order', () => {
    const left = { z: 1, nested: { b: true, a: 'x' }, ordered: ['first', 'second'] }
    const reordered = { ordered: ['first', 'second'], nested: { a: 'x', b: true }, z: 1 }
    const reversedArray = { ordered: ['second', 'first'], nested: { a: 'x', b: true }, z: 1 }

    expect(canonicalJson(left)).toBe(canonicalJson(reordered))
    expect(evidenceId(left as never)).toBe(evidenceId(reordered as never))
    expect(evidenceId(left as never)).not.toBe(evidenceId(reversedArray as never))
  })

  it('changes ids when a semantic evidence field changes', () => {
    const first = evidence()
    const { id: _discarded, ...content } = first
    const changed = { ...content, unit: 'CNY millions' }

    expect(evidenceId(content)).not.toBe(evidenceId(changed))
  })

  it('uses only immutable case and run identity fields', () => {
    const caseIdentity = {
      subject,
      mandate: 'Assess earnings durability',
      asOf: '2026-09-06',
      createdAt: '2026-09-06T08:00:00Z',
    }
    expect(researchCaseId({ ...caseIdentity, status: 'draft' } as never)).toBe(researchCaseId(caseIdentity))

    const runIdentity = {
      caseId: `case-${'a'.repeat(64)}`,
      asOf: '2026-09-06',
      startedAt: '2026-09-06T08:00:00Z',
    }
    expect(researchRunId({ ...runIdentity, status: 'running' } as never)).toBe(researchRunId(runIdentity))
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite numbers before hashing: %s',
    value => expect(() => canonicalJson({ value })).toThrow(/Non-finite number/u),
  )
})

describe('research-core strict runtime validation', () => {
  it('validates all stable domain objects', () => {
    const ev = evidence()
    const asm = assumption(ev.id)
    const run = modelRun(ev.id, asm.id)
    const claimContent: Omit<Claim, 'id'> = {
      text: 'Reported revenue supports durable growth.',
      status: 'supported',
      confidenceLabel: 'medium',
      evidenceRefs: [ev.id],
      counterEvidenceRefs: [],
      falsifiers: ['Two consecutive periods below 3% organic growth'],
    }
    const claim: Claim = { id: claimId(claimContent), ...claimContent }
    const caseContent = {
      subject,
      mandate: 'Assess earnings durability',
      asOf: '2026-09-06',
      status: 'active' as const,
      createdAt: '2026-09-06T08:00:00+08:00',
      updatedAt: '2026-09-06T09:00:00+08:00',
    }
    const researchCase: ResearchCase = {
      caseId: researchCaseId(caseContent),
      ...caseContent,
    }
    const manifestContent = {
      caseId: researchCase.caseId,
      asOf: '2026-09-06',
      startedAt: '2026-09-06T08:00:00+08:00',
      finishedAt: '2026-09-06T09:00:00+08:00',
      codeVersion: 'git:abcdef0',
      configVersion: 'research-config@1',
      configHash: `sha256:${'b'.repeat(64)}` as const,
      modelVersion: 'gpt-test@2026-09-06',
      artifactHashes: { 'memo.md': `sha256:${'c'.repeat(64)}` as const },
      status: 'incomplete' as const,
      gaps: [{
        operation: 'load research consensus',
        reasonCode: 'unsupported' as const,
        detail: 'No approved provider implements the capability',
        attemptedCapabilities: ['research-consensus' as const],
      }],
    }
    const manifest: ResearchRunManifest = {
      runId: researchRunId(manifestContent),
      ...manifestContent,
    }

    expect(validateSourceRef(source())).toEqual(source())
    expect(validateEvidence(ev)).toEqual(ev)
    expect(validateAssumption(asm)).toEqual(asm)
    expect(validateClaim(claim)).toEqual(claim)
    expect(validateModelRun(run)).toEqual(run)
    expect(validateResearchCase(researchCase)).toEqual(researchCase)
    expect(validateGap(manifest.gaps[0])).toEqual(manifest.gaps[0])
    expect(validateResearchRunManifest(manifest)).toEqual(manifest)
  })

  it('preserves the complete finance-core DataProvenance without loss', () => {
    const ref = source()
    expect(ref.provenance).toEqual(provenance)
    expect(validateSourceRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref)
  })

  it('maps provenance that has no provider URL without inventing a locator', () => {
    const { sourceUrl: _sourceUrl, ...withoutUrl } = provenance
    const ref = sourceRefFromProvenance(withoutUrl)

    expect(ref).not.toHaveProperty('url')
    expect(ref).not.toHaveProperty('hash')
    expect(ref.provenance).toEqual(withoutUrl)
  })

  it.each([
    ['invalid date', () => {
      const caseContent = {
        subject, mandate: 'x', asOf: '2026-02-30', status: 'draft' as const,
        createdAt: '2026-09-06T08:00:00Z', updatedAt: '2026-09-06T08:00:00Z',
      }
      return validateResearchCase({ caseId: researchCaseId(caseContent), ...caseContent })
    }],
    ['unknown status', () => validateClaim({
      id: `claim-${'a'.repeat(64)}`, text: 'x', status: 'certain', confidenceLabel: 'high',
      evidenceRefs: [], counterEvidenceRefs: [], falsifiers: [],
    })],
    ['unknown property', () => validateEvidence({ ...evidence(), surprise: true })],
    ['empty reference', () => {
      const ev = evidence()
      const { id: _discarded, ...content } = ev
      const invalid = { ...content, kind: 'calculation', modelRunRef: '' }
      return validateEvidence({ id: evidenceId(invalid as never), ...invalid })
    }],
    ['NaN', () => {
      const ev = evidence()
      const { id: _discarded, ...content } = ev
      const invalid = { ...content, value: Number.NaN }
      return validateEvidence({ id: `ev-${'a'.repeat(64)}`, ...invalid })
    }],
    ['missing structured value represented as null', () => {
      const ev = evidence()
      const { id: _discarded, ...content } = ev
      const invalid = { ...content, value: null }
      return validateEvidence({ id: evidenceId(invalid as never), ...invalid })
    }],
    ['Infinity outside a value field', () => validateModelRun({
      ...modelRun(evidence().id, `asm-${'a'.repeat(64)}`),
      warnings: [Number.POSITIVE_INFINITY],
    })],
  ])('rejects %s', (_label, run) => {
    expect(run).toThrow()
  })

  it('keeps Evidence and Assumption discriminants non-interchangeable', () => {
    const ev = evidence()
    const asm = assumption(ev.id)
    expect(() => validateEvidence(asm)).toThrow(/expected one of: structured, filing, web, user, calculation/u)
    expect(() => validateAssumption(ev)).toThrow(/expected one of: point, range/u)
  })

  it('rejects a valid-looking but stale content id', () => {
    expect(() => validateEvidence({ ...evidence(), unit: 'CNY millions' })).toThrow(/does not match canonical content id/u)
  })
})
