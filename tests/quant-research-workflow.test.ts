import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { sha256, type JsonObject } from '@finance2dsh/research-core'
import { ResearchWorkspace } from '@finance2dsh/research-workspace'
import { runQuantResearch, type QuantComputation } from '@finance2dsh/research-workflow'

const dataset = { schemaVersion: '2', snapshotId: 'fixture', asOf: '2024-01-05T17:00:00Z', provenance: 'synthetic fixture', synthetic: true, bars: [1] }
const spec = { schemaVersion: '2', purpose: 'research-diagnostic' }
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-native-workflow-'))
  const store = new ResearchWorkspace({ root })
  let runs = 0
  let fail = false
  const compute: QuantComputation = async (operation, input) => {
    if (operation === 'validate-dataset') return { dataset: input.dataset!, datasetId: sha256(input.dataset) }
    if (operation === 'validate-spec') return { spec: input.spec! }
    if (operation === 'catalog' || operation === 'schema') return { operation }
    runs++
    if (fail) throw new Error('interrupted')
    const artifacts = { models: [], predictions: [], factors: [], diagnostics: {}, correlations: [], modelDiagnostics: {},
      backtest: { equity: [], orders: [], fills: [], decisions: [] }, benchmark: { metrics: {} } }
    return { id: sha256(input), engine: { name: 'fixture' }, datasetHash: sha256(input.dataset), specHash: sha256(input.spec), promotionEligible: false,
      status: 'complete', summary: { status: 'complete', synthetic: true, promotionEligible: false, warnings: [] }, ...artifacts,
      artifactHashes: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, sha256(value)])) }
  }
  const options = { store, compute, identity: { codeVersion: 'fixture', codeContentHash: sha256({ code: 1 }) }, now: () => new Date('2026-09-12T00:00:00Z') }
  return { root, store, options, runs: () => runs, fail: (value: boolean) => { fail = value } }
}

describe('canonical quant research workflow', () => {
  it('registers immutable datasets/results and returns the same completed request', async () => {
    const env = setup()
    try {
      const imported = await runQuantResearch(env.options, { action: 'import', dataset })
      const args = { action: 'run', caseId: imported.caseId!, expectedRevision: imported.revision!, datasetId: imported.datasetId!, spec }
      const first = await runQuantResearch(env.options, args)
      expect(first).toMatchObject({ replay: false, promotionEligible: false })
      const again = await runQuantResearch(env.options, { ...args, expectedRevision: first.revision! })
      expect(again.runId).toBe(first.runId)
      expect(again.replay).toBe(true)
      expect(env.runs()).toBe(1)
      const state = env.store.open(String(imported.caseId))
      expect(state.runManifests[0]?.status).toBe('complete')
      expect(state.modelRuns.map(run => run.model)).toEqual(expect.arrayContaining(['quant-registration', 'quant-experiment', 'quant-dataset']))
      const page = await runQuantResearch(env.options, { action: 'get', caseId: imported.caseId!, runId: first.runId!, section: 'fills', limit: 20 })
      expect(page).toMatchObject({ total: 0, items: [] })
      const list = await runQuantResearch(env.options, { action: 'list' })
      expect(list.total).toBe(1)
    } finally { fs.rmSync(env.root, { recursive: true, force: true }) }
  })

  it('requires explicit same-task resume and keeps failure evidence', async () => {
    const env = setup()
    try {
      const imported = await runQuantResearch(env.options, { action: 'import', dataset })
      const args: JsonObject = { action: 'run', caseId: imported.caseId!, expectedRevision: imported.revision!, datasetId: imported.datasetId!, spec }
      env.fail(true)
      await expect(runQuantResearch(env.options, args)).rejects.toThrow('interrupted')
      let state = env.store.open(String(imported.caseId))
      expect(state.decisions[0]?.kind).toBe('quant-attempt-failed')
      await expect(runQuantResearch(env.options, { ...args, expectedRevision: state.revision })).rejects.toThrow(/resume/u)
      env.fail(false)
      state = env.store.open(String(imported.caseId))
      const resumed = await runQuantResearch(env.options, { ...args, expectedRevision: state.revision, resume: true })
      expect(resumed.status).toBe('complete')
      expect(env.store.open(String(imported.caseId)).modelRuns.filter(run => run.model === 'quant-registration')).toHaveLength(1)
    } finally { fs.rmSync(env.root, { recursive: true, force: true }) }
  })

  it('rejects stale revision, cross-case reads, tampering and concurrent writers', async () => {
    const env = setup()
    try {
      const imported = await runQuantResearch(env.options, { action: 'import', dataset })
      const caseId = String(imported.caseId)
      await expect(runQuantResearch(env.options, { action: 'run', caseId, expectedRevision: 0, datasetId: imported.datasetId!, spec })).rejects.toThrow(/revision/u)
      let release!: () => void
      const lock = env.store.withRunLock(caseId, () => new Promise<void>(resolve => { release = resolve }))
      await expect(env.store.withRunLock(caseId, async () => 1)).rejects.toThrow(/locked/u)
      release()
      await lock
      const other = env.store.create({ subject: { kind: 'topic', topic: 'other' }, mandate: 'isolation', asOf: '2024-01-05' })
      await expect(runQuantResearch(env.options, { action: 'run', caseId: other.case.caseId, expectedRevision: 0, datasetId: imported.datasetId!, spec })).rejects.toThrow(/not registered/u)
      const state = env.store.open(caseId)
      const model = state.modelRuns.find(run => run.model === 'quant-dataset')!
      fs.appendFileSync(path.join(env.store.casePath(caseId), String(model.parameters.artifact)), ' ')
      expect(() => env.store.open(caseId)).toThrow(/hash mismatch/u)
    } finally { fs.rmSync(env.root, { recursive: true, force: true }) }
  })
})
