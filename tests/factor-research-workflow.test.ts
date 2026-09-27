import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256, type JsonObject } from '@finance2dsh/research-core'
import { ResearchDomain, ResearchWorkspace } from '@finance2dsh/research-workspace'
import { runQuantResearch, type QuantComputation } from '@finance2dsh/research-workflow'

const dataset = { asOf: '2024-01-01T00:00:00Z', synthetic: true, provenance: 'fixture', bars: [] }
const registration = { train: { start: '2024-01-01', end: '2024-02-01' },
  validation: { start: '2024-02-02', end: '2024-03-01' }, test: { start: '2024-03-02', end: '2024-04-01' }, factors: [] }

describe('factor research governance', () => {
  it('freezes controls and experiment specification and exposes stored attribution with bounded pages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-factor-attribution-'))
    const store = new ResearchWorkspace({ root: path.join(root, 'workspace') })
    const data = { ...dataset, schemaVersion: '3', calendar: [], cne6Models: [] }
    const factor = { id: 'alpha' }
    const controls = { controls: ['industry'], weighting: 'uniform', horizon: 5, maximumCondition: 1_000_000 }
    const spec = { schemaVersion: '3', factors: [{ id: 'dependency' }, factor], modelFeatures: ['alpha'] }
    const plan = { ...registration, factors: [factor], styleControls: [controls], experimentSpec: spec }
    let calls = 0
    const compute: QuantComputation = async (operation, input) => {
      if (operation === 'validate-dataset') return { dataset: input.dataset!, datasetId: sha256(input.dataset) }
      if (operation === 'validate-spec') return { spec: input.spec! }
      if (operation === 'validate-evaluation') return { registration: input.registration!, partition: {
        market: 'CN', securities: ['CN:SSE:600000:equity'], ...plan.test } }
      if (operation === 'factor-evaluate') return { promotionEligible: false, stage: 'development', datasetId: sha256(data),
        registrationId: sha256(plan), status: 'complete',
        selection: { selected: ['alpha'] }, decisions: [{ factor: 'alpha', status: 'selected' }],
        train: { '5': { alpha: { meanRankIc: 0.2, daily: [{ date: 'fixture' }] } } },
        validation: { '5': { alpha: { meanRankIc: 0.1, daily: [] } } } }
      if (operation === 'style-explain') return { promotionEligible: false, status: 'complete', days: [{ date: 'fixture' }] }
      if (operation === 'run') {
        calls++
        const events = fs.readdirSync(path.join(root, 'domain')).map(file => JSON.parse(fs.readFileSync(path.join(root, 'domain', file), 'utf8')))
        expect(events.some(event => event.kind === 'consume')).toBe(true)
        const artifacts = { models: [], predictions: [], factors: [], diagnostics: {}, correlations: [], modelDiagnostics: {},
          backtest: { equity: [], orders: [], fills: [], decisions: [] }, benchmark: { metrics: {} },
          modelAttribution: { status: 'complete', rows: [{ prediction: 0.01 }], groupDiagnostics: [], promotionEligible: false },
          returnAttribution: { status: 'blocked', daily: [], promotionEligible: false } }
        return { id: sha256(input), datasetHash: sha256(data), specHash: sha256(spec), engine: {}, promotionEligible: false,
          status: 'complete', summary: { status: 'complete', promotionEligible: false, warnings: [] }, ...artifacts,
          artifactHashes: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, sha256(value)])) }
      }
      throw new Error(`Unexpected ${operation}`)
    }
    const options = { store, compute, identity: {}, researchDomainRoot: path.join(root, 'domain') }
    try {
      const imported = await runQuantResearch(options, { action: 'import', dataset: data })
      const caseId = String(imported.caseId)
      const write = (request: JsonObject) => runQuantResearch(options, { ...request, caseId, expectedRevision: store.open(caseId).revision })
      const development = await write({ action: 'factor-evaluate', datasetId: imported.datasetId!, registration: plan })
      const explanation = { factors: [factor], factor: 'alpha', partition: plan.train, ...controls }
      await expect(write({ action: 'factor-explain', evaluationId: development.evaluationId!, request: { ...explanation, controls: [] } })).rejects.toThrow('controls must be frozen')
      expect((await write({ action: 'factor-explain', evaluationId: development.evaluationId!, request: explanation })).status).toBe('complete')
      const comparison = await runQuantResearch(options, { action: 'factor-compare', caseId, evaluationId: development.evaluationId!, limit: 1 })
      expect(comparison).toMatchObject({ total: 1, items: [{ factor: 'alpha', train: { '5': { meanRankIc: 0.2 } } }] })
      const args = { action: 'run', datasetId: imported.datasetId!, spec, evaluationId: development.evaluationId! }
      await expect(write({ ...args, spec: { ...spec, changed: true } })).rejects.toThrow('preregistered')
      const result = await write(args)
      expect((await write(args)).replay).toBe(true)
      expect(calls).toBe(1)
      const query = { action: 'attribute', caseId, runId: result.runId!, kind: 'model' }
      expect(await runQuantResearch(options, query)).toMatchObject({ rowCount: 1, status: 'complete' })
      expect(await runQuantResearch(options, { ...query, section: 'rows', limit: 1 })).toMatchObject({ total: 1, items: [{ prediction: 0.01 }] })
      await expect(runQuantResearch(options, { ...query, section: 'rows', limit: 201 })).rejects.toThrow('pagination')
      await expect(runQuantResearch(options, { ...query, kind: 'unregistered' })).rejects.toThrow('kind')
      await expect(runQuantResearch(options, { ...query, section: 'source' })).rejects.toThrow('section')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('persists frozen selection, consumes before test invocation, resumes and verifies artifacts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-factor-'))
    const store = new ResearchWorkspace({ root: path.join(root, 'workspace') })
    let fail = true, testCalls = 0
    const compute: QuantComputation = async (operation, input) => {
      if (operation === 'validate-dataset') return { dataset: input.dataset!, datasetId: sha256(input.dataset) }
      if (operation === 'validate-evaluation') return { registration: input.registration!, partition: {
        market: 'CN', securities: ['CN:SSE:600000:equity'], ...registration.test } }
      if (operation === 'factor-catalog') return { operators: [] }
      if (operation === 'factor-evaluate') {
        const selection = { registrationId: sha256(input.registration), datasetId: sha256(input.dataset),
          selected: ['alpha'], directions: { alpha: -1 } }
        if (input.stage === 'test') {
          testCalls++
          expect(input.frozen).toEqual(selection)
          const events = fs.readdirSync(path.join(root, 'domain')).map(file =>
            JSON.parse(fs.readFileSync(path.join(root, 'domain', file), 'utf8')))
          expect(events.some(event => event.kind === 'consume')).toBe(true)
          if (fail) throw new Error('interrupted')
        }
        return { selection, stage: input.stage!, datasetId: sha256(input.dataset), registrationId: sha256(input.registration),
          promotionEligible: false, status: 'complete', diagnostics: [{ factor: 'alpha', meanRankIc: 0.1 }] }
      }
      throw new Error(`Unexpected operation ${operation}`)
    }
    const options = { store, compute, identity: { codeVersion: 'fixture' }, researchDomainRoot: path.join(root, 'domain') }
    try {
      expect(await runQuantResearch(options, { action: 'factor-catalog' })).toEqual({ operators: [] })
      expect(store.listCases()).toEqual([])
      const imported = await runQuantResearch(options, { action: 'import', dataset })
      const caseId = String(imported.caseId)
      const args: JsonObject = { action: 'factor-evaluate', caseId, datasetId: imported.datasetId!, registration }
      const run = (extra: JsonObject = {}) => runQuantResearch(options, { ...args, expectedRevision: store.open(caseId).revision, ...extra })
      const before = store.open(caseId).revision
      await expect(run({ stage: 'developmnt' })).rejects.toThrow('Unknown evaluation stage')
      expect(store.open(caseId).revision).toBe(before)
      expect(fs.existsSync(path.join(root, 'domain')) && fs.readdirSync(path.join(root, 'domain')).length > 0).toBe(false)
      await expect(run({ stage: 'test' })).rejects.toThrow('stored development selection')
      expect(store.open(caseId).revision).toBe(before)
      const development = await run()
      await expect(run({ expectedRevision: 0 })).rejects.toThrow('revision')
      await expect(run({ stage: 'test' })).rejects.toThrow('interrupted')
      const failure = store.open(caseId).decisions.find(row => row.kind === 'quant-factor-attempt-failed')!
      expect(failure).toMatchObject({ rationale: 'interrupted', details: { operation: 'factor-evaluate' } })
      expect(store.open(caseId).modelRuns.some(row => row.model === 'quant-factor-attempt' &&
        row.parameters.requestHash === failure.details?.requestHash && failure.refs.includes(row.id))).toBe(true)
      await expect(run({ stage: 'test' })).rejects.toThrow('Resume')
      const other = { ...options, store: new ResearchWorkspace({ root: path.join(root, 'other') }) }
      const importedOther = await runQuantResearch(other, { action: 'import', dataset: { ...dataset, provenance: 'new snapshot' } })
      await expect(runQuantResearch(other, { ...args, caseId: importedOther.caseId!, datasetId: importedOther.datasetId!,
        expectedRevision: importedOther.revision! })).rejects.toThrow('overlaps')
      fail = false
      const completed = await run({ stage: 'test', resume: true })
      expect(completed.status).toBe('complete')
      expect((await run({ stage: 'test' })).replay).toBe(true)
      expect(testCalls).toBe(2)
      const page = await runQuantResearch(options, { action: 'factor-get', caseId, runId: completed.runId!, section: 'diagnostics', limit: 1 })
      expect(page).toMatchObject({ total: 1, items: [{ factor: 'alpha', meanRankIc: 0.1 }] })
      await expect(runQuantResearch(options, { action: 'factor-get', caseId, runId: completed.runId!, limit: 201 })).rejects.toThrow('pagination')
      expect((await runQuantResearch(options, { action: 'factor-compare', caseId })).total).toBe(2)
      await expect(runQuantResearch(options, { action: 'factor-explain', caseId, expectedRevision: store.open(caseId).revision,
        evaluationId: development.evaluationId!, request: { factors: [], partition: registration.test } })).rejects.toThrow('development partitions')
      const result = store.open(caseId).modelRuns.find(run => run.parameters.requestHash === completed.runId && run.model === 'quant-factor-result')!
      fs.appendFileSync(path.join(store.casePath(caseId), String(result.parameters.artifact)), ' ')
      await expect(runQuantResearch(options, { action: 'factor-get', caseId, runId: completed.runId! })).rejects.toThrow('hash mismatch')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('detects overlapping samples independently of snapshot identity and validates the event chain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-domain-'))
    try {
      const domain = new ResearchDomain(root)
      const partition = { market: 'CN', securities: ['a', 'b'], start: '2024-03-01', end: '2024-04-01' }
      const owner = sha256({ task: 1 })
      domain.reserve(owner, partition, [{ ...partition, start: '2024-01-01', end: '2024-02-01' }])
      domain.reserve(owner, partition, [{ ...partition, start: '2024-01-01', end: '2024-02-01' }])
      expect(() => domain.reserve(sha256({ task: 2 }), { ...partition, securities: ['b', 'c'] }, [])).toThrow('overlaps')
      expect(() => domain.reserve(sha256({ task: 3 }), { ...partition, start: '2024-01-05', end: '2024-01-20' }, [])).toThrow('overlaps')
      expect(() => domain.reserve(owner, { ...partition, end: '2024-05-01' }, [])).toThrow('changed')
      domain.reserve(sha256({ task: 4 }), { ...partition, securities: ['c'] }, [])
      const historical = { ...partition, start: '2023-01-01', end: '2023-12-31' }
      domain.observe(sha256({ task: 'historical' }), historical)
      domain.observe(sha256({ task: 'historical' }), historical)
      expect(() => domain.reserve(sha256({ task: 'reuse-history' }), historical, [])).toThrow('overlaps')
      domain.consume(owner)
      domain.consume(owner)
      expect(() => domain.assertReadable(partition)).toThrow('locked')
      expect(() => domain.consume(sha256({ task: 5 }))).toThrow('not reserved')
      const file = fs.readdirSync(root).sort()[0]!
      fs.writeFileSync(path.join(root, file), '{}')
      expect(() => domain.consume(owner)).toThrow('integrity')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
