import { describe, expect, it } from 'vitest'
import {
  assumptionId,
  claimId,
  compareThesisSnapshots,
  createThesisSnapshot,
  evidenceId,
  THESIS_DIMENSIONS,
  ThesisValidationError,
  type Assumption,
  type Claim,
  type Evidence,
  type PointAssumption,
  type StructuredEvidence,
  type ThesisAssessment,
  type ThesisDimension,
  type ThesisSnapshot,
} from '@finance2dsh/research-core'

const subject = {
  kind: 'instrument' as const,
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
}
const caseId = 'case-' + 'a'.repeat(64)

function makeEvidence(field: string, value: number, period = '2026Q2'): Evidence {
  const content: Omit<StructuredEvidence, 'id'> = {
    kind: 'structured',
    subject,
    field,
    value,
    period,
    unit: field === 'price' ? 'CNY' : 'ratio',
    quality: 'high',
    sourceRef: {
      provider: field === 'price' ? 'exchange' : 'filing',
      upstream: field === 'price' ? 'quote' : 'quarterly-report',
      sourceKind: 'official',
      retrievedAt: '2026-09-06T08:00:00.000Z',
    },
    limitations: [],
  }
  return { id: evidenceId(content), ...content }
}

function makeAssumption(name: string, value: number, evidenceRef: string): Assumption {
  const content: Omit<PointAssumption, 'id'> = {
    kind: 'point',
    name,
    value,
    unit: 'ratio',
    scenario: 'base',
    rationale: 'Bound to the latest structured evidence',
    evidenceRefs: [evidenceRef],
    owner: 'analyst',
    version: 1,
  }
  return { id: assumptionId(content), ...content }
}

function makeClaim(text: string, evidenceRef: string): Claim {
  const content: Omit<Claim, 'id'> = {
    text,
    status: 'supported',
    confidenceLabel: 'medium',
    evidenceRefs: [evidenceRef],
    counterEvidenceRefs: [],
    falsifiers: ['Two consecutive periods below the threshold'],
  }
  return { id: claimId(content), ...content }
}

interface SnapshotOptions {
  coreText?: string
  coreAssessment?: ThesisAssessment
  managementValue?: number
  managementAssessment?: ThesisAssessment
  price?: number
  valuationAssessment?: ThesisAssessment
  summarySuffix?: string
}

function snapshot(options: SnapshotOptions = {}): ThesisSnapshot {
  const coreEvidence = makeEvidence('organic-growth', 0.12)
  const management = makeEvidence('buyback-yield', options.managementValue ?? 0.02)
  const moat = makeEvidence('market-share', 0.35)
  const redLine = makeEvidence('regulatory-breach-count', 0)
  const price = makeEvidence('price', options.price ?? 100)
  const coreAssumption = makeAssumption('Organic growth remains durable', 0.1, coreEvidence.id)
  const valuationAssumption = makeAssumption('Fair value discount rate', 0.09, price.id)
  const coreClaim = makeClaim(options.coreText ?? 'Demand remains durable.', coreEvidence.id)
  const managementClaim = makeClaim('Capital allocation remains disciplined.', management.id)
  const moatClaim = makeClaim('The distribution moat remains intact.', moat.id)
  const redLineClaim = makeClaim('No integrity red line has been triggered.', redLine.id)
  const suffix = options.summarySuffix ?? ''
  const dimensions = THESIS_DIMENSIONS.map(dimension => {
    const defaults = {
      dimension,
      thesisKey: dimension,
      assessment: 'supporting' as ThesisAssessment,
      claimRefs: [] as string[],
      assumptionRefs: [] as string[],
      evidenceRefs: [] as string[],
      priceEvidenceRefs: [] as string[],
      summary: dimension + ' is supported.' + suffix,
    }
    const overrides: Partial<typeof defaults> = dimension === 'core-assumptions'
      ? {
          assessment: options.coreAssessment ?? 'supporting',
          claimRefs: [coreClaim.id], assumptionRefs: [coreAssumption.id], evidenceRefs: [coreEvidence.id],
        }
      : dimension === 'valuation-anchors'
        ? {
            assessment: options.valuationAssessment ?? 'neutral',
            assumptionRefs: [valuationAssumption.id], evidenceRefs: [price.id], priceEvidenceRefs: [price.id],
          }
        : dimension === 'red-lines'
          ? { claimRefs: [redLineClaim.id], evidenceRefs: [redLine.id] }
          : dimension === 'management-capital-allocation'
            ? {
                assessment: options.managementAssessment ?? 'supporting',
                claimRefs: [managementClaim.id], evidenceRefs: [management.id],
              }
            : { claimRefs: [moatClaim.id], evidenceRefs: [moat.id] }
    return { ...defaults, ...overrides }
  })
  return createThesisSnapshot({
    caseId,
    asOf: '2026-09-06',
    createdAt: '2026-09-06T08:00:00.000Z',
    dimensions,
    claims: [coreClaim, managementClaim, moatClaim, redLineClaim],
    assumptions: [coreAssumption, valuationAssumption],
    evidence: [coreEvidence, management, moat, redLine, price],
  })
}

function dimension(result: ReturnType<typeof compareThesisSnapshots>, name: ThesisDimension) {
  return result.dimensions.find(item => item.dimension === name)!
}

describe('thesis snapshot validation', () => {
  it('creates a deterministic snapshot with exactly the five registered dimensions', () => {
    const first = snapshot()
    const second = snapshot()
    expect(first.id).toBe(second.id)
    expect(first.dimensions.map(item => item.dimension)).toEqual(THESIS_DIMENSIONS)
  })

  it('rejects missing dimensions and dangling structured references', () => {
    const valid = snapshot()
    const { schemaVersion: _schemaVersion, id: _id, ...input } = valid
    expect(() => createThesisSnapshot({ ...input, dimensions: input.dimensions.slice(0, 4) }))
      .toThrow(ThesisValidationError)
    expect(() => createThesisSnapshot({
      ...input,
      dimensions: input.dimensions.map(item => item.dimension === 'core-assumptions'
        ? { ...item, evidenceRefs: ['ev-' + '9'.repeat(64)] }
        : item),
    })).toThrow(/unknown evidence/u)
  })
})

describe('structured thesis drift', () => {
  it('classifies synonymous wording as wording-only and unchanged', () => {
    const baseline = snapshot({ coreText: 'Demand remains durable.' })
    const current = snapshot({ coreText: 'Customer demand continues to be resilient.' })
    const drift = compareThesisSnapshots(baseline, current)

    expect(drift.outcome).toBe('unchanged')
    expect(dimension(drift, 'core-assumptions')).toMatchObject({
      outcome: 'unchanged', changeKinds: ['wording'], changedEvidenceRefs: [],
    })
  })

  it('keeps business claims unchanged when only price changes while updating valuation', () => {
    const baseline = snapshot({ price: 100, valuationAssessment: 'neutral' })
    const current = snapshot({ price: 70, valuationAssessment: 'supporting' })
    const drift = compareThesisSnapshots(baseline, current)

    expect(drift.outcome).toBe('improved')
    expect(dimension(drift, 'valuation-anchors')).toMatchObject({ outcome: 'improved', changeKinds: ['price'] })
    expect(dimension(drift, 'valuation-anchors').changedEvidenceRefs).toHaveLength(1)
    expect(dimension(drift, 'core-assumptions')).toMatchObject({ outcome: 'unchanged', changeKinds: [] })
  })

  it('marks adverse factual evidence as weakened and cites the changed evidence', () => {
    const baseline = snapshot({ managementValue: 0.02, managementAssessment: 'supporting' })
    const current = snapshot({ managementValue: -0.03, managementAssessment: 'adverse' })
    const drift = compareThesisSnapshots(baseline, current)
    const management = dimension(drift, 'management-capital-allocation')

    expect(drift.outcome).toBe('weakened')
    expect(management).toMatchObject({ outcome: 'weakened', changeKinds: ['fact'] })
    expect(management.changedEvidenceRefs).toHaveLength(1)
    expect(current.evidence.some(item => item.id === management.changedEvidenceRefs[0])).toBe(true)
  })

  it('returns insufficient when a directional assessment has no changed evidence', () => {
    const baseline = snapshot({ coreAssessment: 'neutral' })
    const current = snapshot({ coreAssessment: 'supporting' })
    const drift = compareThesisSnapshots(baseline, current)

    expect(dimension(drift, 'core-assumptions')).toMatchObject({ outcome: 'insufficient', changedEvidenceRefs: [] })
    expect(drift.outcome).toBe('insufficient')
  })

  it('returns insufficient for every dimension when the baseline is missing', () => {
    const current = snapshot()
    const drift = compareThesisSnapshots(undefined, current)
    expect(drift).toMatchObject({ baselineAvailable: false, outcome: 'insufficient' })
    expect(new Set(drift.dimensions.map(item => item.outcome))).toEqual(new Set(['insufficient']))
  })
})
