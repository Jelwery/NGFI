import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStrategyTools, resolveQuantUvExecutable } from '@finance2dsh/dsh-tools'

const project = join(process.cwd(), 'packages/quant-research')
const directories: string[] = []

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ngfi-quant-integration-')))
  directories.push(root)
  const tool = createStrategyTools({ quantProjectRoot: project, runtimeRoot: root })
    .find(item => item.name === 'finance_quant_research')!
  const execute = (args: Record<string, unknown>, signal = new AbortController().signal) => (
    tool.execute(args as never, { signal } as never) as Promise<any>
  )
  return execute
}

function fixture() {
  return JSON.parse(execFileSync(resolveQuantUvExecutable({ quantProjectRoot: project }), [
    'run', '--project', project, '--frozen', '--offline', 'python', '-c',
    'import json; from ngfi_quant.research_cli import demo_input; print(json.dumps(demo_input()))',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })) as [Record<string, unknown>, Record<string, unknown>]
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('native NGFI quant workflow through the DSH Python bridge', () => {
  it('imports, trains, optimizes, backtests and paginates immutable experiments', async () => {
    const execute = setup()
    const catalog = await execute({ action: 'catalog' })
    expect(catalog.engine).toBe('ngfi-factor-graph')
    expect(catalog.factors).toHaveLength(12)
    expect(JSON.stringify(catalog).toLowerCase()).not.toContain('localquant')
    const schema = await execute({ action: 'schema' })
    expect(schema.dataset.$defs.FeatureObservation.required).toContain('availableAt')
    const [dataset, spec] = fixture()
    const imported = await execute({ action: 'import', workspace_id: 'alpha', dataset })
    const run = await execute({ action: 'run', workspace_id: 'alpha', dataset_id: imported.datasetId, spec })
    expect(run).toMatchObject({
      status: 'complete', promotionEligible: false, completeFolds: 4,
      modelKind: 'ridge', optimizerMethod: 'mean-variance',
    })
    expect(run.metrics.fillCount).toBeGreaterThan(0)
    expect(run.modelMetrics.samples).toBeGreaterThan(0)
    const page = await execute({ action: 'get', workspace_id: 'alpha', run_id: run.runId, section: 'predictions', offset: 1, limit: 2 })
    expect(page.total).toBe(39)
    expect(page.items).toHaveLength(2)
    expect(await execute({ action: 'list', workspace_id: 'alpha' })).toMatchObject({ total: 1, datasetCount: 1 })
    await expect(execute({ action: 'get', workspace_id: 'beta', run_id: run.runId })).rejects.toThrow(/does not exist/u)
  }, 120_000)

  it('rejects traversal, unsupported parameters and cancellation before execution', async () => {
    const execute = setup()
    await expect(execute({ action: 'list', workspace_id: '../../outside' })).rejects.toThrow(/workspace_id/u)
    await expect(execute({ action: 'catalog', command: 'whoami' })).rejects.toThrow(/unsupported/u)
    await expect(execute({ action: 'run', workspace_id: 'alpha' })).rejects.toThrow(/missing parameters/u)
    const controller = new AbortController()
    controller.abort()
    await expect(execute({ action: 'catalog' }, controller.signal)).rejects.toThrow()
  }, 30_000)
})
