import { canonicalJson, evidenceId, modelRunId, researchRunId, sha256, type ContentHash, type JsonObject, type ModelRun } from '@finance2dsh/research-core'
import { ResearchWorkspace, type ResearchCaseState } from '@finance2dsh/research-workspace'

export type QuantComputation = (operation: 'catalog' | 'schema' | 'validate-dataset' | 'validate-spec' | 'run', input: JsonObject, signal?: AbortSignal) => Promise<JsonObject>
export interface QuantResearchOptions {
  store: ResearchWorkspace
  compute: QuantComputation
  identity: JsonObject
  now?: () => Date
}

const HASH = /^sha256:[0-9a-f]{64}$/u
const SECTIONS = ['summary', 'spec', 'models', 'predictions', 'factors', 'diagnostics', 'factorSummary', 'correlations', 'modelDiagnostics', 'equity', 'orders', 'fills', 'decisions', 'benchmark'] as const

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  canonicalJson(value)
  return value as JsonObject
}
function hash(value: unknown, label: string): ContentHash {
  if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError(`${label} must be a sha256 identity`)
  return value as ContentHash
}
function revision(state: ResearchCaseState, expected: unknown): void {
  if (!Number.isSafeInteger(expected) || expected !== state.revision) throw new Error('research revision conflict')
}

export async function runQuantResearch(options: QuantResearchOptions, request: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  if ((request.action === 'run' || request.action === 'import') && typeof request.caseId === 'string') {
    return options.store.withRunLock(request.caseId, () => dispatchQuantResearch(options, request, signal))
  }
  return dispatchQuantResearch(options, request, signal)
}

async function dispatchQuantResearch(options: QuantResearchOptions, request: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  signal?.throwIfAborted()
  const action = request.action
  const allowed: Record<string, string[]> = {
    catalog: ['action'], schema: ['action'],
    import: ['action', 'dataset', 'caseId', 'expectedRevision'],
    run: ['action', 'caseId', 'expectedRevision', 'datasetId', 'spec', 'resume'],
    get: ['action', 'caseId', 'runId', 'section', 'offset', 'limit'], list: ['action'],
  }
  if (typeof action !== 'string' || !allowed[action] || Object.keys(request).some(key => !allowed[action]!.includes(key))) throw new TypeError('Unknown research action or parameters')
  if (action === 'catalog' || action === 'schema') return options.compute(action, {}, signal)
  const store = options.store
  if (action === 'list') {
    const cases = store.listCases().map(caseId => store.open(caseId)).filter(state => state.modelRuns.some(run => run.model.startsWith('quant-')))
    return { cases: cases.slice(0, 200).map(state => ({ caseId: state.case.caseId, revision: state.revision,
      datasets: state.modelRuns.filter(run => run.model === 'quant-dataset').map(run => hash(run.parameters.datasetId, 'datasetId')),
      runs: state.modelRuns.filter(run => run.model === 'quant-experiment').map(run => hash(run.parameters.requestHash, 'requestHash')) })), total: cases.length }
  }
  const now = () => (options.now ?? (() => new Date()))().toISOString()
  let state: ResearchCaseState
  if (action === 'import') {
    const validated = await options.compute('validate-dataset', { dataset: record(request.dataset, 'dataset') }, signal)
    const dataset = record(validated.dataset, 'validated dataset')
    const datasetId = hash(validated.datasetId, 'datasetId')
    if (sha256(dataset) !== datasetId) throw new Error('Dataset canonical identity mismatch')
    if (request.caseId === undefined) {
      if (request.expectedRevision !== undefined) throw new TypeError('expectedRevision requires caseId')
      state = store.create({ subject: { kind: 'topic', topic: `quant-research:${datasetId}` }, mandate: 'Research diagnostic only; no promotion or live orders', asOf: String(dataset.asOf) })
    } else {
      state = store.open(String(request.caseId))
      revision(state, request.expectedRevision)
      if (state.modelRuns.some(run => run.model === 'quant-dataset' && run.parameters.datasetId === datasetId)) {
        return { caseId: state.case.caseId, revision: state.revision, datasetId, synthetic: dataset.synthetic!, replay: true }
      }
    }
    const caseId = state.case.caseId
    const artifact = store.writeArtifact(caseId, state.revision, `quant/datasets/${datasetId.slice(7)}.json`, canonicalJson(dataset))
    const createdAt = now()
    const source = { kind: 'structured' as const, subject: state.case.subject, field: 'frozen-quant-dataset',
      value: { datasetId, artifact: artifact.path, synthetic: dataset.synthetic! }, quality: 'unknown' as const,
      sourceRef: { provider: 'user', upstream: String(dataset.provenance), sourceKind: 'user' as const, retrievedAt: createdAt, hash: datasetId },
      limitations: ['Historical membership, source truth and availability require independent acceptance.'] }
    const evidence = { id: evidenceId(source), ...source }
    const appended = store.appendEvidence(caseId, artifact.revision, [evidence])
    const model: Omit<ModelRun, 'id'> = { model: 'quant-dataset', version: '2', createdAt, inputRefs: [{ kind: 'evidence', id: evidence.id }],
      parameters: { datasetId, artifact: artifact.path, artifactHash: artifact.hash }, output: { status: 'ok', value: { rows: (dataset.bars as unknown[]).length, synthetic: dataset.synthetic! } }, warnings: [] }
    const saved = store.saveModelRun(caseId, appended.revision, { id: modelRunId(model), ...model })
    return { caseId, revision: saved.revision, datasetId, synthetic: dataset.synthetic! }
  }
  if (typeof request.caseId !== 'string') throw new TypeError('caseId is required')
  const caseId = request.caseId
  state = store.open(caseId)
  if (action === 'get') return getResult(store, state, request)
  revision(state, request.expectedRevision)
  const datasetId = hash(request.datasetId, 'datasetId')
  const datasetRun = state.modelRuns.find(run => run.model === 'quant-dataset' && run.parameters.datasetId === datasetId)
  if (!datasetRun) throw new Error('Dataset is not registered in this case')
  const validated = await options.compute('validate-spec', { spec: record(request.spec, 'spec') }, signal)
  const spec = record(validated.spec, 'validated spec')
  const key = sha256({ datasetId, spec, identity: options.identity })
  const existing = state.modelRuns.find(run => run.model === 'quant-experiment' && run.parameters.requestHash === key)
  if (existing) {
    const savedRegistration = state.modelRuns.find(run => run.model === 'quant-registration' && run.parameters.requestHash === key)!
    const savedManifest = state.runManifests.find(run => run.runId === researchRunId({ caseId, asOf: state.case.asOf, startedAt: savedRegistration.createdAt }))
    const summary = record(existing.output.status === 'ok' ? existing.output.value : {}, 'summary')
    if (savedManifest?.status === 'running') store.saveRunManifest(caseId, state.revision, { ...savedManifest,
      status: summary.status === 'complete' ? 'complete' : 'incomplete', finishedAt: new Date(Math.max(Date.parse(now()), Date.parse(savedManifest.startedAt))).toISOString(),
      artifactHashes: existing.parameters.artifactHashes as Record<string, ContentHash> })
    return { ...summary, caseId, revision: store.open(caseId).revision, runId: key, replay: true }
  }
  const prior = state.modelRuns.find(run => run.model === 'quant-registration' && run.parameters.requestHash === key)
  if (prior && request.resume !== true) throw new Error('Experiment already registered; resume the same frozen task explicitly')
  if (!prior && request.resume === true) throw new Error('Cannot resume an unregistered experiment')
  let registration: ModelRun
  if (prior) registration = prior
  else {
    const latest = Math.max(0, ...state.runManifests.map(run => Date.parse(run.startedAt)))
    const createdAt = new Date(Math.max(Date.parse(now()), latest + 1)).toISOString()
    const content: Omit<ModelRun, 'id'> = { model: 'quant-registration', version: '2', createdAt,
      inputRefs: [{ kind: 'model-run', id: datasetRun.id }], parameters: { requestHash: key, datasetId, spec, identity: options.identity },
      output: { status: 'ok', value: { status: 'registered', promotionEligible: false } }, warnings: [] }
    registration = { id: modelRunId(content), ...content }
    store.saveModelRun(caseId, state.revision, registration)
  }
  const manifestId = researchRunId({ caseId, asOf: state.case.asOf, startedAt: registration.createdAt })
  state = store.open(caseId)
  let manifest = state.runManifests.find(run => run.runId === manifestId)
  if (!manifest) {
    manifest = { runId: manifestId, caseId, asOf: state.case.asOf, startedAt: registration.createdAt,
      codeVersion: String(options.identity.codeVersion), configVersion: 'quant-v2', configHash: sha256(spec), modelVersion: 'native-quant-v2',
      artifactHashes: {}, gaps: [], status: 'running' }
    store.saveRunManifest(caseId, state.revision, manifest)
  }
  const dataset = record(JSON.parse(store.readArtifact(caseId, String(datasetRun.parameters.artifact), hash(datasetRun.parameters.artifactHash, 'artifact hash')).toString('utf8')), 'dataset')
  if (sha256(dataset) !== datasetId) throw new Error('Dataset identity changed after registration')
  try {
    signal?.throwIfAborted()
    const result = await options.compute('run', { dataset, spec }, signal)
    if (result.datasetHash !== datasetId || result.specHash !== sha256(spec) || result.promotionEligible !== false) throw new Error('Computation identity or promotion boundary mismatch')
    const contentHashes = record(result.artifactHashes, 'artifactHashes')
    for (const [name, digest] of Object.entries(contentHashes)) {
      if (sha256(result[name]) !== digest) throw new Error(`Computation artifact mismatch: ${name}`)
    }
    const sections: JsonObject = { summary: record(result.summary, 'summary'), spec, models: result.models!, predictions: result.predictions!, factors: result.factors!,
      diagnostics: result.diagnostics!, correlations: result.correlations!, modelDiagnostics: result.modelDiagnostics!,
      equity: record(result.backtest, 'backtest').equity!, orders: record(result.backtest, 'backtest').orders!,
      fills: record(result.backtest, 'backtest').fills!, decisions: record(result.backtest, 'backtest').decisions!, benchmark: result.benchmark!,
      backtest: result.backtest!, computation: { id: result.id!, datasetHash: result.datasetHash!, specHash: result.specHash!, engine: result.engine!, artifactHashes: contentHashes } }
    const files: Record<string, ContentHash> = {}
    for (const [name, value] of Object.entries(sections)) {
      state = store.open(caseId)
      const saved = store.writeArtifact(caseId, state.revision, `quant/runs/${key.slice(7)}/${name}.json`, canonicalJson(value))
      files[saved.path] = saved.hash
    }
    state = store.open(caseId)
    const summary = record(result.summary, 'summary')
    const content: Omit<ModelRun, 'id'> = { model: 'quant-experiment', version: '2', createdAt: registration.createdAt,
      inputRefs: [{ kind: 'model-run', id: registration.id }], parameters: { requestHash: key, datasetId, specHash: sha256(spec), computationId: result.id!, artifactHashes: files, identity: options.identity },
      output: { status: 'ok', value: summary }, warnings: (summary.warnings as string[]) ?? [] }
    const saved = store.saveModelRun(caseId, state.revision, { id: modelRunId(content), ...content })
    if (manifest.status === 'running') store.saveRunManifest(caseId, saved.revision, { ...manifest,
      status: result.status === 'complete' ? 'complete' : 'incomplete', finishedAt: new Date(Math.max(Date.parse(now()), Date.parse(registration.createdAt))).toISOString(), artifactHashes: files })
    return { ...summary, caseId, revision: store.open(caseId).revision, runId: key, replay: false }
  } catch (error) {
    state = store.open(caseId)
    store.appendDecision(caseId, state.revision, { kind: 'quant-attempt-failed', actor: 'system', summary: 'Frozen quant execution interrupted or failed',
      rationale: error instanceof Error ? error.message : 'Unknown computation failure', refs: [registration.id], decidedAt: now(), details: { requestHash: key } })
    throw error
  }
}

function getResult(store: ResearchWorkspace, state: ResearchCaseState, request: JsonObject): JsonObject {
  const runId = hash(request.runId, 'runId')
  const run = state.modelRuns.find(item => item.model === 'quant-experiment' && item.parameters.requestHash === runId)
  if (!run) throw new Error('Experiment not found in this case')
  const section = request.section ?? 'summary'
  if (typeof section !== 'string' || !(SECTIONS as readonly string[]).includes(section)) throw new TypeError('Unknown result section')
  const offset = request.offset ?? 0
  const limit = request.limit ?? 50
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new TypeError('Invalid pagination')
  const fileSection = section === 'factorSummary' ? 'diagnostics' : section
  const relative = `artifacts/quant/runs/${runId.slice(7)}/${fileSection}.json`
  const hashes = record(run.parameters.artifactHashes, 'artifactHashes')
  let value = JSON.parse(store.readArtifact(state.case.caseId, relative, hash(hashes[relative], 'artifact hash')).toString('utf8'))
  if (section === 'factorSummary') value = Object.entries(value).map(([factor, item]) => {
    const { daily, ...summary } = item as Record<string, unknown>
    return { factor, ...summary }
  })
  if (section === 'diagnostics') value = Object.entries(value).flatMap(([factor, item]) =>
    ((item as { daily: Record<string, unknown>[] }).daily).map(row => ({ factor, ...row })))
  if (section === 'benchmark') value = value.metrics
  if (Array.isArray(value)) return { runId, section, total: value.length, offset: offset as number, items: value.slice(offset as number, (offset as number) + (limit as number)) }
  return { runId, section, value }
}
