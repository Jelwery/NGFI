import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { assertBacktestRun, backtestRunId, type BacktestRun } from '@finance2dsh/strategy-core'

const python = [
  'import json',
  'from ngfi_quant import *',
  'i=Instrument("CN","SSE","600000")',
  'cal=("2026-01-05","2026-01-06","2026-01-07")',
  'px=(9.8,10.0,10.5)',
  'bars=tuple(AShareBar(d,i,f"{d}T07:00:01+00:00",p,p+0.2,p-0.2,p,px[n-1] if n else 9.5) for n,(d,p) in enumerate(zip(cal,px)))',
  'cost=AShareCostModel("zero-cost","1.0.0",0,0,0,0,0)',
  'meta=BacktestMetadata("snapshot:contract",stable_hash({"dataset":1}),"2026-01-08T00:00:00+00:00",stable_hash({"strategy":1}),stable_hash({"config":1}),stable_hash({"execution":1}),Instrument("CN","SSE","000300","index"),stable_hash({"benchmark":1}),"2026-02-01T00:00:00+00:00","2026-02-01T00:00:01+00:00")',
  'request=BacktestRequest(cal,bars,(CandidateSignal(stable_hash({"signal":1}),i,"2026-01-05"),),cost,PortfolioConfig(100000,1,0.5,1),meta)',
  'print(json.dumps(run_research_backtest(request).run,separators=(",",":"),sort_keys=True))',
].join(';')

describe('quant-research BacktestRun bridge', () => {
  it('emits the exact strategy-core BacktestRun contract and identity', () => {
    const project = path.join(process.cwd(), 'packages/quant-research')
    const output = execFileSync('uv', [
      'run', '--offline', '--frozen', '--project', project, 'python', '-c', python,
    ], {
      encoding: 'utf8',
      env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(process.cwd(), '.uv-cache') },
    })
    const run = JSON.parse(output) as BacktestRun
    expect(() => assertBacktestRun(run)).not.toThrow()
    expect(run.id).toBe(backtestRunId(run))
    expect(run.engineTier).toBe('research')
  })
})
