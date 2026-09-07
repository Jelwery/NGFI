import type {
  Assumption,
  Claim,
  Evidence,
  Gap,
  ModelRun,
  ResearchRunManifest,
} from '@finance2dsh/research-core'

export const AUDIT_FINDING_CODES = [
  'empty-report',
  'missing-section',
  'missing-citation',
  'invalid-citation',
  'unbound-number',
  'missing-display',
  'duplicate-id',
  'missing-input-ref',
  'calculation-cycle',
  'unhandled-source-conflict',
  'status-gap-mismatch',
] as const

export type AuditFindingCode = typeof AUDIT_FINDING_CODES[number]
export type AuditFindingSeverity = 'error' | 'warning'

export interface AuditFinding {
  code: AuditFindingCode
  severity: AuditFindingSeverity
  message: string
  line?: number
  section?: string
  refs: string[]
  token?: string
}

export interface SourceConflictValue {
  evidenceId: string
  provider: string
  value: Evidence['value']
}

export interface SourceConflict {
  id: string
  factKey: string
  evidenceRefs: string[]
  values: SourceConflictValue[]
}

export interface SourceConflictResolution {
  conflictId: string
  evidenceRefs: string[]
  rationale: string
}

export interface NumberLexicon {
  ignoredPatterns: readonly RegExp[]
  unitScales: Readonly<Record<string, number>>
  percentSuffixes: readonly string[]
  subjectCodes?: readonly string[]
}

export interface NumberToken {
  raw: string
  numeric: number
  normalizedValues: number[]
  index: number
}

export interface NumberBindingFinding {
  line: number
  section?: string
  token: string
  refs: string[]
  reason: 'unbound' | 'missing-display'
}

export interface NumberFidelityResult {
  checked: number
  bound: number
  findings: NumberBindingFinding[]
}

export interface AuditReviewSample {
  line: number
  token: string
  refs: string[]
}

export interface ResearchAuditInput {
  report: string
  evidence: readonly Evidence[]
  assumptions?: readonly Assumption[]
  claims?: readonly Claim[]
  modelRuns: readonly ModelRun[]
  requiredSections?: readonly string[]
  gaps?: readonly Gap[]
  manifest?: ResearchRunManifest
  conflictResolutions?: readonly SourceConflictResolution[]
  lexicon?: NumberLexicon
  sampleSize?: number
  sampleSeed?: string
}

export interface ResearchAuditResult {
  passed: boolean
  allowedStatus: 'complete' | 'incomplete'
  findings: AuditFinding[]
  conflicts: SourceConflict[]
  numberFidelity: NumberFidelityResult
  reviewSample: AuditReviewSample[]
}
