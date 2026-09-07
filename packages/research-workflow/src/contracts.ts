import type {
  Assumption,
  Claim,
  Evidence,
  Gap,
  ModelRun,
} from '@finance2dsh/research-core'
import type { ResearchAuditInput, ResearchAuditResult } from '@finance2dsh/research-audit'
import type { ResearchCaseState } from '@finance2dsh/research-workspace'

export interface WorkflowStageDefinition {
  id: string
  dependsOn: string[]
  requiredCapabilities: Gap['attemptedCapabilities']
  requiredCalculations: string[]
  maxAttempts: number
}

export interface WorkflowDefinition {
  id: string
  version: string
  stages: WorkflowStageDefinition[]
  finalStage: string
  requiredReportSections: string[]
}

export type StageOutcome = 'complete' | 'incomplete' | 'failed'

export interface StageResult {
  outcome: StageOutcome
  capabilities: Gap['attemptedCapabilities']
  evidence: Evidence[]
  assumptions: Assumption[]
  claims: Claim[]
  modelRuns: ModelRun[]
  gaps: Gap[]
  report?: string
  notes?: string
}

export interface StageAttempt {
  attempt: number
  startedAt: string
  finishedAt: string
  outcome: StageOutcome
  gaps: Gap[]
  error?: string
  notes?: string
}

export interface WorkflowStageState {
  stageId: string
  state: 'pending' | 'running' | 'done'
  attempts: StageAttempt[]
  outcome?: StageOutcome
  result?: StageResult
}

export type WorkflowDossier = Pick<
  ResearchCaseState,
  'evidence' | 'assumptions' | 'claims' | 'modelRuns' | 'memo'
> & { gaps: Gap[] }

export interface WorkflowRunState {
  workflowId: string
  workflowVersion: string
  caseId: string
  workspaceRevision: number
  state: 'running' | 'paused' | 'done'
  outcome?: StageOutcome
  stages: Record<string, WorkflowStageState>
  dossier: WorkflowDossier
  audit?: ResearchAuditResult
}

export interface StageExecutionContext {
  definition: WorkflowDefinition
  stage: WorkflowStageDefinition
  caseState: ResearchCaseState
  workflow: WorkflowRunState
  attempt: number
}

export type StageExecutor = (context: StageExecutionContext) => StageResult | Promise<StageResult>

export interface RunWorkflowOptions {
  definition: WorkflowDefinition
  caseState: ResearchCaseState
  executor: StageExecutor
  resume?: WorkflowRunState
  audit?: Omit<
    ResearchAuditInput,
    'report' | 'evidence' | 'assumptions' | 'claims' | 'modelRuns' | 'gaps' | 'requiredSections'
  >
  now?: () => Date
}
