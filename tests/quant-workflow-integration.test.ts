import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStrategyTools, executeQuantResearch, quantArtifactComputation } from '@finance2dsh/dsh-tools'
import { ResearchWorkspace } from '@finance2dsh/research-workspace'

const project = path.join(process.cwd(), 'packages/combinatorial-optimization')

describe('native quant Python integration', () => {
  it('uses real Python, shared workspace and governed tool for the complete workflow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-native-integration-'))
    const options = { quantProjectRoot: project, runtimeRoot: root }
    const signal = new AbortController().signal
    try {
      const tool = createStrategyTools(options).find(item => item.name === 'finance_quant_research')!
      const execute = (args: Record<string, unknown>) => tool.execute(args as never, { signal } as never) as Promise<any>
      const catalog = await execute({ action: 'catalog' })
      expect(catalog.operators).toHaveLength(17)
      expect(fs.existsSync(path.join(root, 'research'))).toBe(false)
      const schema = await execute({ action: 'schema' })
      expect(schema.spec.properties.purpose.const).toBe('research-diagnostic')
      const demo = await quantArtifactComputation(options, 'demo', {}, signal)
      const imported = await execute({ action: 'import', workspace_id: 'alpha', dataset: demo.dataset })
      const result = await execute({ action: 'run', workspace_id: 'alpha', case_id: imported.caseId,
        expected_revision: imported.revision, dataset_id: imported.datasetId, spec: demo.spec })
      expect(result).toMatchObject({ status: 'complete', synthetic: true, promotionEligible: false, strategyValidationStatus: 'blocked' })
      const page = await execute({ action: 'get', workspace_id: 'alpha', case_id: imported.caseId,
        run_id: result.runId, section: 'fills', limit: 2 })
      expect(page.items).toHaveLength(2)
      expect(page.total).toBeGreaterThan(2)
      const diagnostics = await execute({ action: 'get', workspace_id: 'alpha', case_id: imported.caseId,
        run_id: result.runId, section: 'diagnostics', limit: 2 })
      expect(diagnostics.items).toHaveLength(2)
      expect(diagnostics.total).toBeGreaterThan(2)
      const benchmark = await execute({ action: 'get', workspace_id: 'alpha', case_id: imported.caseId,
        run_id: result.runId, section: 'benchmark' })
      expect(benchmark.value).toHaveProperty('totalReturn')
      await expect(execute({ action: 'catalog', dataset: {} })).rejects.toThrow(/additional parameters/u)
      await expect(execute({ action: 'get', workspace_id: 'other', case_id: imported.caseId, run_id: result.runId })).rejects.toThrow(/not found/u)
      await expect(execute({ action: 'catalog', file: '/tmp/data' })).rejects.toThrow(/unsupported/u)
      const state = new ResearchWorkspace({ root: path.join(root, 'research/alpha') }).open(imported.caseId)
      expect(state.runManifests[0]?.status).toBe('complete')
      expect(fs.existsSync(path.join(root, 'quant-research'))).toBe(false)
      const again = await executeQuantResearch(options, 'alpha', { action: 'run', caseId: imported.caseId,
        expectedRevision: state.revision, datasetId: imported.datasetId, spec: demo.spec! }, signal)
      expect(again).toMatchObject({ replay: true, runId: result.runId })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 90_000)

  it('rejects an aborted computation without starting work', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(quantArtifactComputation({ quantProjectRoot: project }, 'catalog', {}, controller.signal)).rejects.toThrow(/abort/u)
  })
})
