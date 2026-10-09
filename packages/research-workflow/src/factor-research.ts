import { canonicalJson, evidenceId, modelRunId, sha256, type ContentHash, type JsonObject, type ModelRun } from '@finance2dsh/research-core'
import { ResearchDomain, type ResearchPartition } from '@finance2dsh/research-workspace'
import type { QuantResearchOptions } from './quant-research.js'

export const FACTOR_ACTIONS = ['factor-catalog', 'factor-register', 'factor-derive', 'factor-evaluate', 'factor-explain', 'factor-compare', 'factor-get'] as const
export function factorEvaluationStage(request: JsonObject): 'development' | 'test' {
  const stage = request.stage ?? 'development'
  if (stage !== 'development' && stage !== 'test') throw new TypeError('Unknown evaluation stage')
  return stage
}
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object')
  canonicalJson(value)
  return value as JsonObject
}

export async function runFactorResearch(options: QuantResearchOptions, request: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  const { store, compute } = options
  const action = String(request.action)
  const common = ['action', 'caseId']
  const allowed: Record<string, string[]> = {
    'factor-catalog': ['action'],
    'factor-register': [...common, 'expectedRevision', 'request', 'resume'],
    'factor-derive': [...common, 'expectedRevision', 'request', 'resume'],
    'factor-evaluate': [...common, 'expectedRevision', 'datasetId', 'registration', 'stage', 'resume'],
    'factor-explain': [...common, 'expectedRevision', 'evaluationId', 'request', 'resume'],
    'factor-compare': [...common, 'evaluationId', 'offset', 'limit'],
    'factor-get': [...common, 'runId', 'section', 'offset', 'limit'],
  }
  if (!allowed[action] || Object.keys(request).some(key => !allowed[action]!.includes(key))) throw new TypeError('Unknown factor action parameters')
  if (action === 'factor-catalog') return compute('factor-catalog', {}, signal)
  if (typeof request.caseId !== 'string') throw new TypeError('caseId is required')
  const caseId = request.caseId
  let state = store.open(caseId)
  const load = (run: ModelRun): JsonObject => object(JSON.parse(store.readArtifact(caseId,
    String(run.parameters.artifact), run.parameters.artifactHash as ContentHash).toString('utf8')))
  const page = (value: unknown): JsonObject => {
    const offset = request.offset ?? 0, limit = request.limit ?? 50
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) ||
        (limit as number) < 1 || (limit as number) > 200) throw new TypeError('Invalid pagination')
    const items = Array.isArray(value) ? value : Object.entries(object(value)).map(([key, value]) => ({ key, value }))
    return { total: items.length, offset: offset as number, items: items.slice(offset as number, (offset as number) + (limit as number)) }
  }
  if (action === 'factor-compare') {
    if (request.evaluationId !== undefined) {
      const evaluation = state.modelRuns.find(run => run.model === 'quant-factor-evaluation' && run.parameters.evaluationId === request.evaluationId)
      if (!evaluation) throw new Error('Evaluation not found')
      const runs = state.modelRuns.filter(run => run.model === 'quant-factor-result' && run.parameters.evaluationId === request.evaluationId
        && run.parameters.action === 'factor-evaluate')
      const compact = (diagnostics: unknown, factor: string): JsonObject => Object.fromEntries(Object.entries(object(diagnostics)).map(([horizon, values]) => {
        const { daily, ...metrics } = object(object(values)[factor] ?? {})
        return [horizon, metrics]
      }))
      const items = runs.flatMap<JsonObject>(run => {
        const result = load(run)
        if (run.parameters.stage === 'development') return (result.decisions as JsonObject[]).map(decision => ({
          ...decision, stage: 'development', runId: run.parameters.requestHash!, train: compact(result.train, String(decision.factor)),
          validation: compact(result.validation, String(decision.factor)),
        }))
        return (object(result.selection).selected as string[]).map(factor => ({ factor, stage: 'test',
          runId: run.parameters.requestHash!, diagnostics: compact(result.diagnostics, factor) }))
      })
      return { evaluationId: request.evaluationId, ...page(items), promotionEligible: false }
    }
    // Rebuild the small index only from workspace-verified immutable records.
    return page(state.modelRuns.filter(run => run.model === 'quant-factor-result').map(run => ({
      runId: run.parameters.requestHash!, action: run.parameters.action!, summary: run.output,
    })))
  }
  if (action === 'factor-get') {
    const run = state.modelRuns.find(run => run.model === 'quant-factor-result' && run.parameters.requestHash === request.runId)
    if (!run) throw new Error('Factor result not found')
    const result = load(run)
    let selected: unknown = result
    if (request.section !== undefined) {
      if (typeof request.section !== 'string') throw new TypeError('Unknown factor section')
      for (const segment of request.section.split('/')) {
        if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, segment)) throw new TypeError('Unknown factor section')
        selected = (selected as JsonObject)[segment]
      }
    }
    return page(selected)
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== state.revision) throw new Error('research revision conflict')
  const now = () => (options.now ?? (() => new Date()))().toISOString()
  const save = (model: string, parameters: JsonObject, value: JsonObject, inputRefs: ModelRun['inputRefs'] = []): ModelRun => {
    state = store.open(caseId)
    if (!inputRefs.length) {
      const source = { kind: 'structured' as const, subject: state.case.subject, field: 'factor-research-request',
        value: parameters, quality: 'unknown' as const, sourceRef: { provider: 'user', upstream: 'frozen-factor-request',
          sourceKind: 'user' as const, retrievedAt: now(), hash: sha256(parameters) }, limitations: ['Research hypothesis; not investment evidence.'] }
      const evidence = { id: evidenceId(source), ...source }
      if (!state.evidence.some(item => item.id === evidence.id)) store.appendEvidence(caseId, state.revision, [evidence])
      inputRefs = [{ kind: 'evidence', id: evidence.id }]
      state = store.open(caseId)
    }
    const content: Omit<ModelRun, 'id'> = { model, version: '3', createdAt: now(), inputRefs, parameters,
      output: { status: 'ok', value }, warnings: [] }
    const run = { id: modelRunId(content), ...content }
    store.saveModelRun(caseId, state.revision, run)
    return run
  }
  const datasetFor = (datasetId: unknown): JsonObject => {
    const run = state.modelRuns.find(run => run.model === 'quant-dataset' && run.parameters.datasetId === datasetId)
    if (!run) throw new Error('Dataset not registered in this case')
    const dataset = load(run)
    if (sha256(dataset) !== datasetId) throw new Error('Dataset identity mismatch')
    return dataset
  }
  let operation: Parameters<typeof compute>[0]
  let input: JsonObject
  let evaluation: ModelRun | undefined
  let owner: ContentHash | undefined
  const domain = options.researchDomainRoot ? new ResearchDomain(options.researchDomainRoot) : undefined
  if (action === 'factor-evaluate') {
    const stage = factorEvaluationStage(request)
    if (!domain) throw new Error('Factor evaluation requires a shared research domain')
    const dataset = datasetFor(request.datasetId)
    const validated = await compute('validate-evaluation', { dataset, registration: object(request.registration) }, signal)
    const registration = object(validated.registration)
    const evaluationId = sha256({ datasetId: request.datasetId!, registration, identity: options.identity })
    owner = sha256({ workspace: store.root, caseId, evaluationId })
    const partition = object(validated.partition)
    const test = partition as unknown as ResearchPartition
    const development = ['train', 'validation'].map(role => ({ ...test, ...object(registration[role]) })) as ResearchPartition[]
    evaluation = state.modelRuns.find(run => run.model === 'quant-factor-evaluation' && run.parameters.evaluationId === evaluationId)
    input = { dataset, registration, stage }
    if (stage === 'test') {
      const prior = store.open(caseId).modelRuns.find(run => run.model === 'quant-factor-result' &&
        run.parameters.evaluationId === evaluationId && run.parameters.stage === 'development')
      if (!prior) throw new Error('Test requires a stored development selection')
      input = { ...input, frozen: object(load(prior).selection) }
    }
    domain.reserve(owner, test, development)
    if (!evaluation) evaluation = save('quant-factor-evaluation', { evaluationId, datasetId: request.datasetId!, registration, identity: options.identity, owner },
      { status: 'registered', promotionEligible: false })
    operation = 'factor-evaluate'
  } else if (action === 'factor-explain') {
    evaluation = state.modelRuns.find(run => run.model === 'quant-factor-evaluation' && run.parameters.evaluationId === request.evaluationId)
    if (!evaluation || !domain) throw new Error('Explanation requires a registered evaluation and shared domain')
    const explanation = object(request.request)
    const registration = object(evaluation.parameters.registration)
    const partition = object(explanation.partition)
    if (!['train', 'validation'].some(role => {
      const split = object(registration[role])
      return String(partition.start) >= String(split.start) && String(partition.end) <= String(split.end)
    })) throw new Error('Explanation is restricted to registered development partitions')
    if (canonicalJson(explanation.factors) !== canonicalJson(registration.factors)) throw new Error('Explanation factors differ from registration')
    const controls = { controls: explanation.controls ?? ['industry'], weighting: explanation.weighting ?? 'uniform',
      horizon: explanation.horizon ?? 5, maximumCondition: explanation.maximumCondition ?? 1_000_000 }
    if (!((registration.styleControls ?? []) as JsonObject[]).some(plan => canonicalJson(plan) === canonicalJson(controls))) {
      throw new Error('Explanation controls must be frozen in the evaluation registration')
    }
    input = { dataset: datasetFor(evaluation.parameters.datasetId), request: explanation }
    operation = 'style-explain'
  } else {
    operation = action as 'factor-register' | 'factor-derive'
    input = { request: object(request.request) }
  }
  const key = sha256({ operation, input, identity: options.identity })
  state = store.open(caseId)
  const resultRun = state.modelRuns.find(run => run.model === 'quant-factor-result' && run.parameters.requestHash === key)
  if (resultRun) return { ...object(resultRun.output.status === 'ok' ? resultRun.output.value : {}), runId: key, caseId, revision: state.revision, replay: true }
  let attempt = state.modelRuns.find(run => run.model === 'quant-factor-attempt' && run.parameters.requestHash === key)
  if (attempt && request.resume !== true) throw new Error('Resume the same frozen factor task explicitly')
  if (!attempt && request.resume === true) throw new Error('Cannot resume an unregistered factor task')
  if (!attempt) attempt = save('quant-factor-attempt', { requestHash: key, operation, inputHash: sha256(input), identity: options.identity,
    ...(input.request ? { request: input.request } : {}), ...(input.stage ? { stage: input.stage } : {}) },
    { status: 'registered', promotionEligible: false }, evaluation ? [{ kind: 'model-run', id: evaluation.id }] : [])
  try {
    // Consumption is durable before invocation and remains consumed on failure.
    if (input.stage === 'test') domain!.consume(owner!)
    signal?.throwIfAborted()
    const result = await compute(operation, input, signal)
    if (result.promotionEligible !== false) throw new Error('Factor computation promotion boundary mismatch')
    if (operation === 'factor-evaluate' && (result.datasetId !== sha256(input.dataset) || result.registrationId !== sha256(input.registration) || result.stage !== input.stage)) throw new Error('Factor evaluation identity mismatch')
    state = store.open(caseId)
    const artifact = store.writeArtifact(caseId, state.revision, `quant/factors/${key.slice(7)}.json`, canonicalJson(result))
    const summary: JsonObject = { status: result.status ?? 'complete', promotionEligible: false,
      ...(result.familyId ? { familyId: result.familyId } : {}), ...(evaluation ? { evaluationId: evaluation.parameters.evaluationId! } : {}) }
    save('quant-factor-result', { requestHash: key, action, artifact: artifact.path, artifactHash: artifact.hash,
      ...(evaluation ? { evaluationId: evaluation.parameters.evaluationId! } : {}), ...(input.stage ? { stage: input.stage } : {}) },
    summary, [{ kind: 'model-run', id: attempt.id }])
    return { ...summary, caseId, runId: key, revision: store.open(caseId).revision, replay: false }
  } catch (error) {
    state = store.open(caseId)
    store.appendDecision(caseId, state.revision, { kind: 'quant-factor-attempt-failed', actor: 'system',
      summary: 'Frozen factor execution interrupted or failed',
      rationale: error instanceof Error ? error.message : 'Unknown computation failure',
      refs: [attempt.id], decidedAt: now(), details: { requestHash: key, operation } })
    throw error
  }
}
