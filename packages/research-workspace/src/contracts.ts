import type {
  Assumption,
  Claim,
  ContentHash,
  Evidence,
  JsonObject,
  ModelRun,
  ResearchCase,
  ResearchCaseStatus,
  ResearchRunManifest,
  ResearchSubject,
} from '@finance2dsh/research-core'

export const RESEARCH_WORKSPACE_SCHEMA_VERSION = 1 as const
export const FROZEN_REPLAY_SCHEMA_VERSION = 1 as const

export interface CreateResearchCaseInput {
  subject: ResearchSubject
  mandate: string
  asOf: string
  status?: Exclude<ResearchCaseStatus, 'archived'>
  createdAt?: string
}

export interface ResearchCaseUpdate {
  status: Exclude<ResearchCaseStatus, 'archived'>
}

export type DecisionActor = 'user' | 'agent' | 'system'

export interface DecisionLogEntry {
  schemaVersion: typeof RESEARCH_WORKSPACE_SCHEMA_VERSION
  id: string
  kind: string
  actor: DecisionActor
  summary: string
  rationale?: string
  refs: string[]
  decidedAt: string
  details?: JsonObject
}

export type NewDecisionLogEntry = Omit<DecisionLogEntry, 'schemaVersion' | 'id'> & { id?: string }

export interface ResearchCaseFile {
  schemaVersion: typeof RESEARCH_WORKSPACE_SCHEMA_VERSION
  revision: number
  case: ResearchCase
  fileHashes: Record<string, ContentHash>
}

export interface PersistedCollection<T> {
  schemaVersion: typeof RESEARCH_WORKSPACE_SCHEMA_VERSION
  items: T[]
}

export interface ResearchCaseState {
  revision: number
  case: ResearchCase
  evidence: Evidence[]
  assumptions: Assumption[]
  claims: Claim[]
  modelRuns: ModelRun[]
  memo: string
  decisions: DecisionLogEntry[]
  runManifests: ResearchRunManifest[]
  fileHashes: Readonly<Record<string, ContentHash>>
}

export interface WorkspaceMutationResult {
  revision: number
  changed: boolean
}

export interface AppendResult extends WorkspaceMutationResult {
  appendedIds: string[]
}

export interface ArtifactWriteResult extends WorkspaceMutationResult {
  path: string
  hash: ContentHash
}

export interface ArtifactHashManifest {
  schemaVersion: typeof RESEARCH_WORKSPACE_SCHEMA_VERSION
  caseId: string
  runId: string
  createdAt: string
  files: Record<string, ContentHash>
  treeHash: ContentHash
}

export interface FrozenReplayManifest {
  schemaVersion: typeof FROZEN_REPLAY_SCHEMA_VERSION
  kind: 'ngfi-research-frozen-replay'
  caseId: string
  sourceRunId: string
  sourceRevision: number
  createdAt: string
  sourceManifestHash: ContentHash
  files: Record<string, ContentHash>
  treeHash: ContentHash
}

export interface FrozenReplayReceipt {
  schemaVersion: typeof FROZEN_REPLAY_SCHEMA_VERSION
  kind: 'ngfi-research-frozen-replay-seed'
  caseId: string
  sourceRunId: string
  sourceTreeHash: ContentHash
  seededAt: string
  files: Record<string, ContentHash>
}

export type StructuredChangeKind = 'added' | 'removed' | 'changed'

export interface StructuredValueChange {
  path: string
  kind: StructuredChangeKind
  before?: unknown
  after?: unknown
}

export interface ChangedRunArtifact {
  path: string
  beforePath: string
  afterPath: string
  beforeHash: ContentHash
  afterHash: ContentHash
  format: 'json' | 'jsonl' | 'opaque'
  changes?: StructuredValueChange[]
}

export interface ResearchRunDiff {
  caseId: string
  beforeRunId: string
  afterRunId: string
  manifestChanges: StructuredValueChange[]
  artifacts: {
    added: Array<{ path: string; actualPath: string; hash: ContentHash }>
    removed: Array<{ path: string; actualPath: string; hash: ContentHash }>
    changed: ChangedRunArtifact[]
    unchanged: string[]
  }
  summary: {
    added: number
    removed: number
    changed: number
    unchanged: number
  }
}
