import {
  canonicalJson,
  validateAssumption,
  validateClaim,
  validateEvidence,
  validateGap,
  validateModelRun,
} from '@finance2dsh/research-core'
import { auditResearchReport } from '@finance2dsh/research-audit'

import {
  type RunWorkflowOptions,
  type StageResult,
  type WorkflowDossier,
  type WorkflowRunState,
  type WorkflowStageDefinition,
  type WorkflowStageState,
} from './contracts.js'
import { validateWorkflowDefinition, workflowStagesInDependencyOrder } from './registry.js'

export class WorkflowRunError extends Error {
  constructor(readonly code: 'invalid-resume' | 'invalid-stage-result', message: string) {
    super(message)
    this.name = 'WorkflowRunError'
  }
}

function emptyDossier(options: RunWorkflowOptions): WorkflowDossier {
  return {
    evidence: structuredClone(options.caseState.evidence),
    assumptions: structuredClone(options.caseState.assumptions),
    claims: structuredClone(options.caseState.claims),
    modelRuns: structuredClone(options.caseState.modelRuns),
    memo: options.caseState.memo,
    gaps: [],
  }
}

function createRun(options: RunWorkflowOptions): WorkflowRunState {
  return {
    workflowId: options.definition.id,
    workflowVersion: options.definition.version,
    caseId: options.caseState.case.caseId,
    workspaceRevision: options.caseState.revision,
    state: 'running',
    stages: Object.fromEntries(options.definition.stages.map(stage => [stage.id, {
      stageId: stage.id,
      state: 'pending' as const,
      attempts: [],
    }])),
    dossier: emptyDossier(options),
  }
}

function resumeRun(options: RunWorkflowOptions): WorkflowRunState {
  const resume = options.resume!
  if (resume.workflowId !== options.definition.id || resume.workflowVersion !== options.definition.version) {
    throw new WorkflowRunError('invalid-resume', 'Resume state belongs to another workflow definition')
  }
  if (resume.caseId !== options.caseState.case.caseId || resume.workspaceRevision !== options.caseState.revision) {
    throw new WorkflowRunError('invalid-resume', 'Resume state belongs to another case revision')
  }
  const expectedStages = new Set(options.definition.stages.map(stage => stage.id))
  if (Object.keys(resume.stages).length !== expectedStages.size
      || Object.keys(resume.stages).some(stage => !expectedStages.has(stage))) {
    throw new WorkflowRunError('invalid-resume', 'Resume state has a different stage set')
  }
  const next = structuredClone(resume)
  next.state = 'running'
  delete next.outcome
  const retryFinalGate = next.audit?.passed === false
  delete next.audit
  for (const stage of Object.values(next.stages)) {
    if (stage.state === 'running' || stage.outcome === 'failed'
        || (retryFinalGate && stage.stageId === options.definition.finalStage)) {
      stage.state = 'pending'
      delete stage.outcome
      delete stage.result
    }
  }
  next.dossier = emptyDossier(options)
  for (const stage of workflowStagesInDependencyOrder(options.definition)) {
    const completed = next.stages[stage.id]!
    if (completed.state !== 'done') continue
    if (completed.result === undefined || completed.outcome === undefined) {
      throw new WorkflowRunError('invalid-resume', 'Completed stage has no accepted result: ' + stage.id)
    }
    next.dossier = mergeResult(
      next.dossier,
      validateStageResult(stage, completed.result, stage.id === options.definition.finalStage),
    )
  }
  return next
}

function missingRequirements(stage: WorkflowStageDefinition, result: StageResult): string[] {
  const availableCapabilities = new Set(result.capabilities)
  const gapCapabilities = new Set(result.gaps.flatMap(gap => gap.attemptedCapabilities))
  const usableCalculations = new Set(result.modelRuns.flatMap(run => (
    run.output.status === 'ok' ? [run.model] : []
  )))
  const gapOperations = new Set(result.gaps.map(gap => gap.operation))
  const missing: string[] = []
  for (const capability of stage.requiredCapabilities) {
    if (!availableCapabilities.has(capability) && !gapCapabilities.has(capability)) {
      missing.push('capability:' + capability)
    }
  }
  for (const calculation of stage.requiredCalculations) {
    if (!usableCalculations.has(calculation) && !gapOperations.has(calculation)) {
      missing.push('calculation:' + calculation)
    }
  }
  if (result.outcome === 'complete' && result.gaps.length > 0) missing.push('complete-with-gaps')
  if (result.outcome === 'incomplete' && result.gaps.length === 0) missing.push('incomplete-without-gap')
  return missing
}

function validateStageResult(stage: WorkflowStageDefinition, result: StageResult, isFinalStage: boolean): StageResult {
  if (!['complete', 'incomplete', 'failed'].includes(result.outcome)) {
    throw new WorkflowRunError('invalid-stage-result', 'Stage ' + stage.id + ' returned an invalid outcome')
  }
  result.evidence.forEach(validateEvidence)
  result.assumptions.forEach(validateAssumption)
  result.claims.forEach(validateClaim)
  result.modelRuns.forEach(validateModelRun)
  for (const gap of result.gaps) validateGap(gap)
  const missing = missingRequirements(stage, result)
  if (missing.length > 0) {
    throw new WorkflowRunError(
      'invalid-stage-result',
      'Stage ' + stage.id + ' does not satisfy its contract: ' + missing.join(', '),
    )
  }
  if (isFinalStage && result.outcome !== 'failed' && (result.report ?? '').trim() === '') {
    throw new WorkflowRunError('invalid-stage-result', 'The final stage must produce a non-empty report')
  }
  return structuredClone(result)
}

function mergeById<T extends { id: string }>(existing: readonly T[], additions: readonly T[], label: string): T[] {
  const result = existing.map(item => structuredClone(item))
  const byId = new Map(result.map(item => [item.id, item]))
  for (const item of additions) {
    const previous = byId.get(item.id)
    if (previous !== undefined) {
      if (canonicalJson(previous) !== canonicalJson(item)) {
        throw new WorkflowRunError('invalid-stage-result', label + ' id collision: ' + item.id)
      }
      continue
    }
    const copy = structuredClone(item)
    byId.set(copy.id, copy)
    result.push(copy)
  }
  return result
}

function mergeResult(dossier: WorkflowDossier, result: StageResult): WorkflowDossier {
  return {
    evidence: mergeById(dossier.evidence, result.evidence, 'evidence'),
    assumptions: mergeById(dossier.assumptions, result.assumptions, 'assumption'),
    claims: mergeById(dossier.claims, result.claims, 'claim'),
    modelRuns: mergeById(dossier.modelRuns, result.modelRuns, 'model run'),
    memo: result.report ?? dossier.memo,
    gaps: [...dossier.gaps, ...structuredClone(result.gaps)],
  }
}

function stageDependenciesDone(stage: WorkflowStageDefinition, state: WorkflowRunState): boolean {
  return stage.dependsOn.every(dependency => state.stages[dependency]?.state === 'done')
}

function failureResult(stage: WorkflowStageDefinition, detail: string): StageResult {
  return {
    outcome: 'failed',
    capabilities: [],
    evidence: [],
    assumptions: [],
    claims: [],
    modelRuns: [],
    gaps: [{
      operation: stage.id,
      reasonCode: 'error',
      detail,
      attemptedCapabilities: [...stage.requiredCapabilities],
    }],
  }
}

/**
 * Execute registered stages with an injected executor. This is orchestration
 * state management only; it deliberately owns no agent or model loop.
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunState> {
  const definition = validateWorkflowDefinition(options.definition)
  const state = options.resume === undefined ? createRun(options) : resumeRun(options)
  const now = options.now ?? (() => new Date())

  for (const stage of workflowStagesInDependencyOrder(definition)) {
    const current = state.stages[stage.id]!
    if (current.state === 'done') continue
    if (!stageDependenciesDone(stage, state)) {
      state.state = 'paused'
      return structuredClone(state)
    }
    current.state = 'running'
    let accepted: StageResult | undefined
    for (let localAttempt = 1; localAttempt <= stage.maxAttempts; localAttempt += 1) {
      const attempt = current.attempts.length + 1
      const startedAt = now().toISOString()
      try {
        const result = validateStageResult(stage, await options.executor({
          definition: structuredClone(definition),
          stage: structuredClone(stage),
          caseState: structuredClone(options.caseState),
          workflow: structuredClone(state),
          attempt,
        }), stage.id === definition.finalStage)
        const finishedAt = now().toISOString()
        current.attempts.push({
          attempt,
          startedAt,
          finishedAt,
          outcome: result.outcome,
          gaps: structuredClone(result.gaps),
          ...(result.notes === undefined ? {} : { notes: result.notes }),
        })
        if (result.outcome !== 'failed') {
          accepted = result
          break
        }
      } catch (error) {
        const finishedAt = now().toISOString()
        const message = error instanceof Error ? error.message : String(error)
        const failed = failureResult(stage, message)
        current.attempts.push({
          attempt,
          startedAt,
          finishedAt,
          outcome: 'failed',
          gaps: failed.gaps,
          error: message,
        })
      }
    }
    if (accepted === undefined) {
      current.state = 'pending'
      current.outcome = 'failed'
      state.state = 'paused'
      return structuredClone(state)
    }
    state.dossier = mergeResult(state.dossier, accepted)
    current.state = 'done'
    current.outcome = accepted.outcome
    current.result = accepted
  }

  const finalStage = state.stages[definition.finalStage]!
  const audit = auditResearchReport({
    ...options.audit,
    report: state.dossier.memo,
    evidence: state.dossier.evidence,
    assumptions: state.dossier.assumptions,
    claims: state.dossier.claims,
    modelRuns: state.dossier.modelRuns,
    gaps: state.dossier.gaps,
    requiredSections: definition.requiredReportSections,
  })
  state.audit = audit
  state.state = 'done'
  state.outcome = finalStage.outcome === 'complete'
    && Object.values(state.stages).every(stage => stage.outcome === 'complete')
    && audit.passed
    ? 'complete'
    : 'incomplete'
  return structuredClone(state)
}
