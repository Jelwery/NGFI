import type {
  DataCapability,
  DataProvenance,
  InstrumentId,
  SourceKind,
} from '@finance2dsh/core'

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export type NonNullJsonValue = Exclude<JsonValue, null>
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type ContentHash = `sha256:${string}`

export const RESEARCH_CASE_STATUSES = ['draft', 'active', 'completed', 'archived'] as const
export type ResearchCaseStatus = typeof RESEARCH_CASE_STATUSES[number]

export type ResearchSubject =
  | { kind: 'instrument'; instrument: InstrumentId }
  | { kind: 'portfolio'; portfolioId: string }
  | { kind: 'topic'; topic: string }

export interface ResearchCase {
  caseId: string
  subject: ResearchSubject
  mandate: string
  asOf: string
  status: ResearchCaseStatus
  createdAt: string
  updatedAt: string
}

/**
 * A research-facing source projection. `provenance` retains the complete
 * canonical data envelope when the source originated in finance-core.
 */
export interface SourceRef {
  provider: string
  upstream: string
  sourceKind: SourceKind
  url?: string
  hash?: ContentHash
  observedAt?: string
  publishedAt?: string
  availableAt?: string
  retrievedAt: string
  provenance?: DataProvenance
}

export const EVIDENCE_QUALITIES = ['high', 'medium', 'low', 'unknown', 'conflicted'] as const
export type EvidenceQuality = typeof EVIDENCE_QUALITIES[number]

interface EvidenceBase {
  id: string
  subject: ResearchSubject
  period?: string
  unit?: string
  currency?: string
  quality: EvidenceQuality
  sourceRef: SourceRef
  limitations: string[]
}

export interface StructuredEvidence extends EvidenceBase {
  kind: 'structured'
  field: string
  value: NonNullJsonValue
  excerpt?: string
}

export interface FilingEvidence extends EvidenceBase {
  kind: 'filing'
  excerpt: string
  field?: string
  value?: JsonValue
}

export interface WebEvidence extends EvidenceBase {
  kind: 'web'
  excerpt: string
  field?: string
  value?: JsonValue
}

export interface UserEvidence extends EvidenceBase {
  kind: 'user'
  excerpt: string
  field?: string
  value?: JsonValue
}

export interface CalculationEvidence extends EvidenceBase {
  kind: 'calculation'
  field: string
  value: NonNullJsonValue
  modelRunRef: string
  excerpt?: string
}

export type Evidence =
  | StructuredEvidence
  | FilingEvidence
  | WebEvidence
  | UserEvidence
  | CalculationEvidence

export const ASSUMPTION_OWNERS = ['user', 'analyst', 'model', 'system'] as const
export type AssumptionOwner = typeof ASSUMPTION_OWNERS[number]

interface AssumptionBase {
  id: string
  name: string
  unit?: string
  scenario: string
  rationale: string
  evidenceRefs: string[]
  owner: AssumptionOwner
  version: number
}

export interface PointAssumption extends AssumptionBase {
  kind: 'point'
  value: NonNullJsonValue
}

export interface RangeAssumption extends AssumptionBase {
  kind: 'range'
  range: { lower?: number; upper?: number }
}

/** Facts and analyst assumptions deliberately have separate public types. */
export type Assumption = PointAssumption | RangeAssumption

export const CLAIM_STATUSES = ['hypothesis', 'supported', 'contested', 'refuted', 'inconclusive'] as const
export type ClaimStatus = typeof CLAIM_STATUSES[number]

export const CONFIDENCE_LABELS = ['low', 'medium', 'high', 'unknown'] as const
export type ConfidenceLabel = typeof CONFIDENCE_LABELS[number]

export interface Claim {
  id: string
  text: string
  status: ClaimStatus
  confidenceLabel: ConfidenceLabel
  evidenceRefs: string[]
  counterEvidenceRefs: string[]
  falsifiers: string[]
}

export const RESEARCH_REF_KINDS = ['evidence', 'assumption', 'claim', 'model-run'] as const
export type ResearchRefKind = typeof RESEARCH_REF_KINDS[number]

export type ModelInputRef =
  | { kind: 'evidence'; id: string }
  | { kind: 'assumption'; id: string }
  | { kind: 'claim'; id: string }
  | { kind: 'model-run'; id: string }

export type ModelRunOutput =
  | { status: 'ok'; value: NonNullJsonValue }
  | { status: 'missing'; reason: string; details?: JsonObject }
  | { status: 'unfillable'; reason: string; details?: JsonObject }
  | { status: 'insufficient'; reason: string; details?: JsonObject }
  | { status: 'not-meaningful'; reason: string; details?: JsonObject }
  | { status: 'error'; reason: string; details?: JsonObject }

export interface ModelRun {
  id: string
  model: string
  version: string
  inputRefs: ModelInputRef[]
  parameters: JsonObject
  output: ModelRunOutput
  warnings: string[]
  createdAt: string
}

export const GAP_REASON_CODES = [
  'missing',
  'unfillable',
  'insufficient',
  'not-meaningful',
  'error',
  'unsupported',
  'unauthorized',
  'stale',
  'optional-skipped',
] as const
export type GapReasonCode = typeof GAP_REASON_CODES[number]

export interface Gap {
  operation: string
  reasonCode: GapReasonCode
  detail: string
  attemptedCapabilities: DataCapability[]
}

interface ResearchRunManifestBase {
  runId: string
  caseId: string
  asOf: string
  startedAt: string
  codeVersion: string
  configVersion: string
  configHash: ContentHash
  modelVersion: string
  artifactHashes: Record<string, ContentHash>
  gaps: Gap[]
}

export interface RunningResearchRunManifest extends ResearchRunManifestBase {
  status: 'running'
}

export interface FinishedResearchRunManifest extends ResearchRunManifestBase {
  status: 'complete' | 'incomplete' | 'failed' | 'stale'
  finishedAt: string
}

export type ResearchRunManifest = RunningResearchRunManifest | FinishedResearchRunManifest
