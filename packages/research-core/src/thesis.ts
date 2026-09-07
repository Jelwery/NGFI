import type { Assumption, Claim, ContentHash, Evidence } from './contracts.js'
import { canonicalJson, sha256 } from './identity.js'
import { validateAssumption, validateClaim, validateEvidence } from './validation.js'

export const THESIS_DIMENSIONS = [
  'core-assumptions',
  'valuation-anchors',
  'red-lines',
  'management-capital-allocation',
  'competitive-advantage',
] as const

export type ThesisDimension = typeof THESIS_DIMENSIONS[number]
export const THESIS_ASSESSMENTS = ['supporting', 'neutral', 'adverse', 'unknown'] as const
export type ThesisAssessment = typeof THESIS_ASSESSMENTS[number]

export interface ThesisDimensionSnapshot {
  dimension: ThesisDimension
  thesisKey: string
  assessment: ThesisAssessment
  claimRefs: string[]
  assumptionRefs: string[]
  evidenceRefs: string[]
  priceEvidenceRefs: string[]
  summary: string
}

export interface ThesisSnapshot {
  schemaVersion: 1
  id: ContentHash
  caseId: string
  asOf: string
  createdAt: string
  dimensions: ThesisDimensionSnapshot[]
  claims: Claim[]
  assumptions: Assumption[]
  evidence: Evidence[]
}

export type ThesisSnapshotInput = Omit<ThesisSnapshot, 'schemaVersion' | 'id'>

export class ThesisValidationError extends TypeError {
  constructor(readonly path: string, message: string) {
    super(path + ': ' + message)
    this.name = 'ThesisValidationError'
  }
}

function fail(path: string, message: string): never {
  throw new ThesisValidationError(path, message)
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'expected a non-empty string')
  return value
}

function validTimestamp(value: unknown, path: string): string {
  const text = nonEmpty(value, path)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)
      || !Number.isFinite(Date.parse(text))) {
    fail(path, 'expected an RFC 3339 timestamp')
  }
  return text
}

function validDate(value: unknown, path: string): string {
  const text = nonEmpty(value, path)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text)
  if (match === null || !Number.isFinite(Date.parse(text + 'T00:00:00Z'))
      || new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) !== text) {
    fail(path, 'expected an ISO calendar date')
  }
  return text
}

function uniqueById<T extends { id: string }>(items: readonly T[], path: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    if (result.has(item.id)) fail(path, 'duplicate id ' + item.id)
    result.set(item.id, item)
  }
  return result
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  const result = value.map((item, index) => nonEmpty(item, path + '[' + index + ']'))
  if (new Set(result).size !== result.length) fail(path, 'duplicate references are not allowed')
  return result
}

function snapshotIdentity(input: ThesisSnapshotInput): ContentHash {
  return sha256({ schemaVersion: 1, ...input })
}

export function createThesisSnapshot(input: ThesisSnapshotInput): ThesisSnapshot {
  const claims = input.claims.map(validateClaim)
  const assumptions = input.assumptions.map(validateAssumption)
  const evidence = input.evidence.map(validateEvidence)
  const claimById = uniqueById(claims, '$.claims')
  const assumptionById = uniqueById(assumptions, '$.assumptions')
  const evidenceById = uniqueById(evidence, '$.evidence')
  for (const [index, claim] of claims.entries()) {
    for (const ref of [...claim.evidenceRefs, ...claim.counterEvidenceRefs]) {
      if (!evidenceById.has(ref)) fail('$.claims[' + index + ']', 'unknown evidence ' + ref)
    }
  }
  for (const [index, assumption] of assumptions.entries()) {
    for (const ref of assumption.evidenceRefs) {
      if (!evidenceById.has(ref)) fail('$.assumptions[' + index + ']', 'unknown evidence ' + ref)
    }
  }
  nonEmpty(input.caseId, '$.caseId')
  validDate(input.asOf, '$.asOf')
  validTimestamp(input.createdAt, '$.createdAt')
  if (input.dimensions.length !== THESIS_DIMENSIONS.length) {
    fail('$.dimensions', 'expected exactly the five thesis dimensions')
  }
  const seen = new Set<ThesisDimension>()
  const dimensions = input.dimensions.map((entry, index): ThesisDimensionSnapshot => {
    const path = '$.dimensions[' + index + ']'
    if (!THESIS_DIMENSIONS.includes(entry.dimension)) fail(path + '.dimension', 'unknown thesis dimension')
    if (seen.has(entry.dimension)) fail(path + '.dimension', 'duplicate thesis dimension')
    seen.add(entry.dimension)
    if (!THESIS_ASSESSMENTS.includes(entry.assessment)) fail(path + '.assessment', 'unknown assessment')
    nonEmpty(entry.thesisKey, path + '.thesisKey')
    nonEmpty(entry.summary, path + '.summary')
    const claimRefs = stringArray(entry.claimRefs, path + '.claimRefs')
    const assumptionRefs = stringArray(entry.assumptionRefs, path + '.assumptionRefs')
    const evidenceRefs = stringArray(entry.evidenceRefs, path + '.evidenceRefs')
    const priceEvidenceRefs = stringArray(entry.priceEvidenceRefs, path + '.priceEvidenceRefs')
    for (const ref of claimRefs) if (!claimById.has(ref)) fail(path + '.claimRefs', 'unknown claim ' + ref)
    for (const ref of assumptionRefs) if (!assumptionById.has(ref)) fail(path + '.assumptionRefs', 'unknown assumption ' + ref)
    for (const ref of evidenceRefs) if (!evidenceById.has(ref)) fail(path + '.evidenceRefs', 'unknown evidence ' + ref)
    const dimensionEvidence = new Set(evidenceRefs)
    for (const ref of claimRefs) {
      const claim = claimById.get(ref)!
      for (const evidenceRef of [...claim.evidenceRefs, ...claim.counterEvidenceRefs]) {
        if (!dimensionEvidence.has(evidenceRef)) {
          fail(path + '.evidenceRefs', 'must include evidence ' + evidenceRef + ' used by claim ' + ref)
        }
      }
    }
    for (const ref of assumptionRefs) {
      for (const evidenceRef of assumptionById.get(ref)!.evidenceRefs) {
        if (!dimensionEvidence.has(evidenceRef)) {
          fail(path + '.evidenceRefs', 'must include evidence ' + evidenceRef + ' used by assumption ' + ref)
        }
      }
    }
    for (const ref of priceEvidenceRefs) {
      if (!evidenceRefs.includes(ref)) fail(path + '.priceEvidenceRefs', 'price evidence must also be in evidenceRefs')
    }
    if (entry.dimension !== 'valuation-anchors' && priceEvidenceRefs.length > 0) {
      fail(path + '.priceEvidenceRefs', 'price evidence belongs only to valuation-anchors')
    }
    if (entry.assessment !== 'unknown'
        && claimRefs.length + assumptionRefs.length + evidenceRefs.length === 0) {
      fail(path, 'a known assessment requires at least one structured reference')
    }
    return {
      dimension: entry.dimension,
      thesisKey: entry.thesisKey,
      assessment: entry.assessment,
      claimRefs,
      assumptionRefs,
      evidenceRefs,
      priceEvidenceRefs,
      summary: entry.summary,
    }
  })
  const normalized: ThesisSnapshotInput = {
    caseId: input.caseId,
    asOf: input.asOf,
    createdAt: input.createdAt,
    dimensions,
    claims,
    assumptions,
    evidence,
  }
  return { schemaVersion: 1, id: snapshotIdentity(normalized), ...normalized }
}

export function validateThesisSnapshot(value: ThesisSnapshot): ThesisSnapshot {
  const { schemaVersion, id, ...input } = value
  if (schemaVersion !== 1) fail('$.schemaVersion', 'unsupported thesis snapshot schema')
  const valid = createThesisSnapshot(input)
  if (id !== valid.id) fail('$.id', 'does not match canonical thesis snapshot id')
  return valid
}

export function thesisSnapshotCanonicalJson(snapshot: ThesisSnapshot): string {
  return canonicalJson(validateThesisSnapshot(snapshot))
}
