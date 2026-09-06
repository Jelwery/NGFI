import type { Assumption, Claim, Evidence, JsonValue } from './contracts.js'
import { canonicalJson } from './identity.js'
import {
  THESIS_DIMENSIONS,
  type ThesisAssessment,
  type ThesisDimension,
  type ThesisDimensionSnapshot,
  type ThesisSnapshot,
  validateThesisSnapshot,
} from './thesis.js'

export type ThesisDriftOutcome = 'improved' | 'unchanged' | 'weakened' | 'insufficient'
export type ThesisChangeKind = 'fact' | 'price' | 'wording'

export interface ThesisDimensionDrift {
  dimension: ThesisDimension
  thesisKey: string
  outcome: ThesisDriftOutcome
  changeKinds: ThesisChangeKind[]
  changedEvidenceRefs: string[]
  reason: string
}

export interface ThesisDrift {
  caseId: string
  baselineSnapshotId?: ThesisSnapshot['id']
  currentSnapshotId: ThesisSnapshot['id']
  baselineAvailable: boolean
  outcome: ThesisDriftOutcome
  dimensions: ThesisDimensionDrift[]
}

interface SnapshotIndex {
  evidence: Map<string, Evidence>
  assumptions: Map<string, Assumption>
  claims: Map<string, Claim>
}

function index(snapshot: ThesisSnapshot): SnapshotIndex {
  return {
    evidence: new Map(snapshot.evidence.map(item => [item.id, item])),
    assumptions: new Map(snapshot.assumptions.map(item => [item.id, item])),
    claims: new Map(snapshot.claims.map(item => [item.id, item])),
  }
}

function evidenceSignature(item: Evidence): string {
  return canonicalJson({
    kind: item.kind,
    subject: item.subject,
    field: item.field ?? null,
    value: item.value ?? null,
    excerpt: item.value === undefined ? item.excerpt ?? null : null,
    period: item.period ?? null,
    unit: item.unit ?? null,
    currency: item.currency ?? null,
  })
}

function assumptionSignature(item: Assumption): string {
  return canonicalJson(item.kind === 'point'
    ? { kind: item.kind, name: item.name, value: item.value, unit: item.unit ?? null, scenario: item.scenario }
    : { kind: item.kind, name: item.name, range: item.range, unit: item.unit ?? null, scenario: item.scenario })
}

function claimMeaningSignature(item: Claim): string {
  return canonicalJson({ status: item.status, confidenceLabel: item.confidenceLabel, falsifiers: item.falsifiers })
}

function signatures<T>(refs: readonly string[], byId: ReadonlyMap<string, T>, project: (value: T) => string): string[] {
  return refs.map(ref => project(byId.get(ref)!)).sort()
}

function changedCurrentEvidence(
  beforeRefs: readonly string[],
  afterRefs: readonly string[],
  before: SnapshotIndex,
  after: SnapshotIndex,
): string[] {
  const beforeSignatures = new Set(signatures(beforeRefs, before.evidence, evidenceSignature))
  return afterRefs.filter(ref => !beforeSignatures.has(evidenceSignature(after.evidence.get(ref)!)))
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function assessmentDirection(before: ThesisAssessment, after: ThesisAssessment): ThesisDriftOutcome {
  if (before === 'unknown' || after === 'unknown') return 'insufficient'
  const rank: Record<Exclude<ThesisAssessment, 'unknown'>, number> = {
    adverse: -1,
    neutral: 0,
    supporting: 1,
  }
  if (rank[after] > rank[before]) return 'improved'
  if (rank[after] < rank[before]) return 'weakened'
  return 'unchanged'
}

function compareDimension(
  beforeEntry: ThesisDimensionSnapshot,
  afterEntry: ThesisDimensionSnapshot,
  before: SnapshotIndex,
  after: SnapshotIndex,
): ThesisDimensionDrift {
  if (beforeEntry.thesisKey !== afterEntry.thesisKey) {
    return {
      dimension: afterEntry.dimension,
      thesisKey: afterEntry.thesisKey,
      outcome: 'insufficient',
      changeKinds: [],
      changedEvidenceRefs: [],
      reason: 'The structured thesis key changed, so the snapshots are not comparable.',
    }
  }
  const beforePrice = new Set(beforeEntry.priceEvidenceRefs)
  const afterPrice = new Set(afterEntry.priceEvidenceRefs)
  const beforeFactRefs = beforeEntry.evidenceRefs.filter(ref => !beforePrice.has(ref))
  const afterFactRefs = afterEntry.evidenceRefs.filter(ref => !afterPrice.has(ref))
  const factChangedRefs = changedCurrentEvidence(beforeFactRefs, afterFactRefs, before, after)
  const priceChangedRefs = changedCurrentEvidence(beforeEntry.priceEvidenceRefs, afterEntry.priceEvidenceRefs, before, after)
  const factEvidenceChanged = !arraysEqual(
    signatures(beforeFactRefs, before.evidence, evidenceSignature),
    signatures(afterFactRefs, after.evidence, evidenceSignature),
  )
  const priceEvidenceChanged = !arraysEqual(
    signatures(beforeEntry.priceEvidenceRefs, before.evidence, evidenceSignature),
    signatures(afterEntry.priceEvidenceRefs, after.evidence, evidenceSignature),
  )
  const factChanged = factEvidenceChanged
    || !arraysEqual(
      signatures(beforeEntry.assumptionRefs, before.assumptions, assumptionSignature),
      signatures(afterEntry.assumptionRefs, after.assumptions, assumptionSignature),
    )
    || !arraysEqual(
      signatures(beforeEntry.claimRefs, before.claims, claimMeaningSignature),
      signatures(afterEntry.claimRefs, after.claims, claimMeaningSignature),
    )
  const priceChanged = priceEvidenceChanged
  const wordingChanged = beforeEntry.summary !== afterEntry.summary
    || !arraysEqual(
      beforeEntry.claimRefs.map(ref => before.claims.get(ref)!.text).sort(),
      afterEntry.claimRefs.map(ref => after.claims.get(ref)!.text).sort(),
    )
  const changeKinds: ThesisChangeKind[] = []
  if (factChanged) changeKinds.push('fact')
  if (priceChanged) changeKinds.push('price')
  if (wordingChanged) changeKinds.push('wording')

  const direction = assessmentDirection(beforeEntry.assessment, afterEntry.assessment)
  const changedEvidenceRefs = [...new Set([...factChangedRefs, ...priceChangedRefs])]
  if (direction === 'improved' || direction === 'weakened') {
    const applicableChange = factChanged || (afterEntry.dimension === 'valuation-anchors' && priceChanged)
    if (!applicableChange || changedEvidenceRefs.length === 0) {
      return {
        dimension: afterEntry.dimension,
        thesisKey: afterEntry.thesisKey,
        outcome: 'insufficient',
        changeKinds,
        changedEvidenceRefs,
        reason: 'A directional drift requires new or changed evidence for this dimension.',
      }
    }
  }
  return {
    dimension: afterEntry.dimension,
    thesisKey: afterEntry.thesisKey,
    outcome: direction,
    changeKinds,
    changedEvidenceRefs,
    reason: direction === 'unchanged'
      ? (changeKinds.length === 0 ? 'No structured thesis input changed.' : 'Structured changes did not alter the assessment.')
      : 'The assessment moved from ' + beforeEntry.assessment + ' to ' + afterEntry.assessment + '.',
  }
}

function overallOutcome(dimensions: readonly ThesisDimensionDrift[]): ThesisDriftOutcome {
  if (dimensions.some(item => item.outcome === 'weakened')) return 'weakened'
  if (dimensions.some(item => item.outcome === 'insufficient')) return 'insufficient'
  if (dimensions.some(item => item.outcome === 'improved')) return 'improved'
  return 'unchanged'
}

/** Compare structured thesis references; report prose is intentionally not an input. */
export function compareThesisSnapshots(
  baseline: ThesisSnapshot | undefined,
  currentValue: ThesisSnapshot,
): ThesisDrift {
  const current = validateThesisSnapshot(currentValue)
  if (baseline === undefined) {
    return {
      caseId: current.caseId,
      currentSnapshotId: current.id,
      baselineAvailable: false,
      outcome: 'insufficient',
      dimensions: THESIS_DIMENSIONS.map(dimension => ({
        dimension,
        thesisKey: current.dimensions.find(item => item.dimension === dimension)!.thesisKey,
        outcome: 'insufficient',
        changeKinds: [],
        changedEvidenceRefs: [],
        reason: 'No baseline thesis snapshot is available.',
      })),
    }
  }
  const before = validateThesisSnapshot(baseline)
  if (before.caseId !== current.caseId) throw new TypeError('Thesis snapshots belong to different research cases')
  const beforeIndex = index(before)
  const afterIndex = index(current)
  const dimensions = THESIS_DIMENSIONS.map(dimension => compareDimension(
    before.dimensions.find(item => item.dimension === dimension)!,
    current.dimensions.find(item => item.dimension === dimension)!,
    beforeIndex,
    afterIndex,
  ))
  return {
    caseId: current.caseId,
    baselineSnapshotId: before.id,
    currentSnapshotId: current.id,
    baselineAvailable: true,
    outcome: overallOutcome(dimensions),
    dimensions,
  }
}
