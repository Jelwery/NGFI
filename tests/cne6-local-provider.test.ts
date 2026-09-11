import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, cp, mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CNE6_LOCAL_CAPABILITIES,
  Cne6LocalProvider,
  type Cne6Fundamentals,
} from '../packages/finance-data-service/src/providers/cne6/index.js'

const repositoryRoot = process.cwd()
const projectRoot = resolve(repositoryRoot, 'packages/combinatorial-optimization')
const fixtureMaker = resolve(repositoryRoot, 'tests/fixtures/cne6-local/make_fixture.py')
const hangRunner = resolve(repositoryRoot, 'tests/fixtures/cne6-local/hang.py')
const hostileRunner = resolve(repositoryRoot, 'tests/fixtures/cne6-local/hostile-failure.py')
const malformedRunner = resolve(repositoryRoot, 'tests/fixtures/cne6-local/malformed-success.py')
const closedStdinRunner = resolve(repositoryRoot, 'tests/fixtures/cne6-local/close-stdin-and-hang.py')
const secretMarker = 'fixture-secret-that-must-not-leak'
let temporaryRoot: string
let fixtureRoot: string

function makeFixture(root: string, ...options: string[]): void {
  execFileSync('uv', [
    'run', '--project', projectRoot, 'python', fixtureMaker, root, ...options,
  ], { cwd: repositoryRoot, stdio: 'pipe' })
}

function provider(dataRoot = fixtureRoot, options: Record<string, unknown> = {}): Cne6LocalProvider {
  return new Cne6LocalProvider({
    projectRoot,
    dataRoot,
    ...(options as ConstructorParameters<typeof Cne6LocalProvider>[0]),
  })
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(path, 'utf8'))
    } catch {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    }
  }
  throw new Error('closed-stdin runner did not publish its pid')
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  return !processExists(pid)
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'cne6-local-provider-'))
  fixtureRoot = join(temporaryRoot, 'published')
  makeFixture(fixtureRoot)
})

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe('Cne6LocalProvider committed-artifact contract', () => {
  it('inspects the report and verifies every published asset hash', async () => {
    const inspection = await provider().inspect()

    expect(inspection).toMatchObject({
      providerId: 'cne6-local',
      status: 'degraded',
      partial: true,
      failed: ['000002'],
      requested: ['600519', '000001', '000002'],
      units: { price: 'CNY', volume: 'share', turnover: 'CNY' },
      coverage: { market_cap: 1, industry: 1, fundamentals: 0.5 },
      pitGrade: 'partial',
      build: { runKey: 'fixture' },
    })
    expect(Object.keys(inspection.hash).sort()).toEqual([
      'benchmark', 'dividends', 'fundamentals', 'industry', 'market-cap', 'prices',
    ])
    expect(inspection.hash.prices).toBe(inspection.assets.prices.sha256)
    expect(inspection.aggregateHash).toMatch(/^[0-9a-f]{64}$/)
    expect(inspection.reportHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('filters available_date without claiming unverified fundamentals are PIT-safe', async () => {
    const result = await provider().query({
      dataset: 'fundamentals',
      asOf: '2025-12-31',
      columns: ['code', 'report_date', 'available_date', 'revenue'],
      limit: 10,
    })

    expect(result.pitGrade).toBe('partial')
    expect(result.asOf).toBe('2025-12-31')
    expect(result.rows).toEqual([
      {
        code: 'sh.600519',
        report_date: '2024-12-31',
        available_date: '2025-04-01',
        revenue: 100,
      },
      {
        code: 'sz.000001',
        report_date: '2024-12-31',
        available_date: '2025-03-20',
        revenue: 50,
      },
    ])
  })

  it('filters market history by start/end/asOf without claiming full PIT safety', async () => {
    const result = await provider().query({
      dataset: 'prices',
      codes: ['SH.600519'],
      startDate: '2026-01-05',
      endDate: '2026-01-06',
      asOf: '2026-01-05',
      columns: ['code', 'date', 'close'],
      limit: 10,
    })

    expect(result.pitGrade).toBe('market-history')
    expect(result.rows).toEqual([{ code: 'sh.600519', date: '2026-01-05', close: 102 }])
  })

  it.each([
    ['date-only end of day', '2026-01-05', true],
    ['one second before the Shanghai close', '2026-01-05T14:59:59+08:00', false],
    ['the Shanghai close', '2026-01-05T15:00:00+08:00', true],
    ['one second after the Shanghai close', '2026-01-05T15:00:01+08:00', true],
    ['the same close instant expressed on the prior offset date', '2026-01-04T23:00:00-08:00', true],
  ] as const)('applies %s when exposing a daily bar', async (_scenario, asOf, includesClose) => {
    const result = await provider().execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      asOf,
      params: {
        startDate: '2026-01-05', endDate: '2026-01-05',
        interval: '1d', adjustment: 'none', limit: 10,
      },
    })

    if (!includesClose) {
      expect(result).toMatchObject({ status: 'no-data', data: null })
      return
    }
    expect(result).toMatchObject({
      status: 'partial',
      data: { bars: [{ date: '2026-01-05', close: 102, preClose: 101 }] },
      provenance: { adjustment: 'none', unit: 'price:CNY;volume:share;turnover:CNY' },
    })
    expect(result.provenance.observedAt).toMatch(/T/u)
    expect(Date.parse(result.provenance.observedAt ?? '')).toBe(
      Date.parse('2026-01-05T15:00:00+08:00'),
    )
  })

  it.each([
    ['market-bars', '2026-01-02', {
      startDate: '2026-01-02', endDate: '2026-01-02',
      interval: '1d', adjustment: 'none', limit: 10,
    }],
    ['fundamentals', '2025-03-19', { limit: 10 }],
  ] as const)(
    'distinguishes failed, out-of-scope, and covered empty %s results',
    async (capability, asOf, params) => {
      const local = provider()
      const executeFor = (exchange: 'SSE' | 'SZSE', symbol: string) => local.execute({
        capability,
        market: 'CN',
        instrument: { market: 'CN', exchange, symbol, assetType: 'equity' },
        asOf,
        params: { ...params },
      })

      await expect(executeFor('SZSE', '000002')).resolves.toMatchObject({
        status: 'provider-error',
        data: null,
        provenance: { provider: 'cne6-local', actualProvider: 'cne6-local' },
      })
      await expect(executeFor('SSE', '600000')).resolves.toMatchObject({
        status: 'unsupported',
        data: null,
        provenance: { provider: 'cne6-local', actualProvider: 'cne6-local' },
      })
      await expect(executeFor('SZSE', '000001')).resolves.toMatchObject({
        status: 'no-data',
        data: null,
        provenance: { provider: 'cne6-local', actualProvider: 'cne6-local' },
      })
    },
  )

  it.each([
    ['covered plus out-of-scope', ['sh.600519', 'sh.600000'], true],
    ['covered plus failed', ['sh.600519', 'sz.000002'], false],
  ] as const)(
    'does not silently classify a %s batch as available or no-data',
    async (label, codes, complete) => {
      const dataRoot = complete
        ? join(temporaryRoot, `batch-${label.replaceAll(' ', '-')}`)
        : fixtureRoot
      if (complete) makeFixture(dataRoot, '--no-partial')
      const result = await provider(dataRoot).execute({
        capability: 'risk-data',
        market: 'CN',
        params: { dataset: 'market-cap', codes: [...codes], limit: 10 },
      })

      expect(['available', 'no-data']).not.toContain(result.status)
      expect(result.status).toBe('partial')
    },
  )

  it('marks a batch partial when the selected dataset omits one covered symbol', async () => {
    const dataRoot = join(temporaryRoot, 'batch-dataset-gap')
    makeFixture(dataRoot, '--no-partial')

    const result = await provider(dataRoot).execute({
      capability: 'risk-data',
      market: 'CN',
      params: { dataset: 'dividends', codes: ['sh.600519', 'sz.000001'], limit: 10 },
    })

    expect(result).toMatchObject({
      status: 'partial',
      data: { rows: [{ code: 'sh.600519' }] },
    })
  })

  it('keeps a fully covered batch available when the caller projects out code', async () => {
    const dataRoot = join(temporaryRoot, 'batch-projected-code')
    makeFixture(dataRoot, '--no-partial')

    const result = await provider(dataRoot).execute({
      capability: 'risk-data',
      market: 'CN',
      params: {
        dataset: 'market-cap',
        codes: ['sh.600519', 'sz.000001'],
        columns: ['total_market_cap'],
        limit: 10,
      },
    })

    expect(result).toMatchObject({
      status: 'available',
      data: {
        rows: [
          { total_market_cap: 100_000 },
          { total_market_cap: 50_000 },
        ],
      },
    })
    expect((result.data as { rows: unknown[] }).rows.every(row => (row as object).hasOwnProperty('code'))).toBe(false)
  })

  it.each([
    ['all failed', ['sz.000002', 'bj.920021'], 'provider-error'],
    ['all outside published coverage', ['sh.600000', 'sz.000003'], 'unsupported'],
  ] as const)(
    'classifies a homogeneous %s batch before the partial fallback',
    async (_scenario, codes, expectedStatus) => {
      const dataRoot = join(temporaryRoot, `homogeneous-${expectedStatus}`)
      makeFixture(dataRoot, ...(expectedStatus === 'unsupported' ? ['--no-partial'] : []))
      if (expectedStatus === 'provider-error') {
        const reportPath = join(dataRoot, 'quality-report.json')
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>
        report.requestedSymbols = ['600519', '000001', '000002', '920021']
        report.failedSymbols = ['000002', '920021']
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      }

      const result = await provider(dataRoot).execute({
        capability: 'risk-data',
        market: 'CN',
        params: { dataset: 'market-cap', codes: [...codes], limit: 10 },
      })

      expect(result).toMatchObject({ status: expectedStatus, data: null })
    },
  )

  it('reads one immutable snapshot selected through an atomically replaceable CURRENT file', async () => {
    const dataRoot = join(temporaryRoot, 'versioned-root')
    const partialStage = join(temporaryRoot, 'versioned-partial-stage')
    const completeStage = join(temporaryRoot, 'versioned-complete-stage')
    makeFixture(partialStage)
    makeFixture(completeStage, '--no-partial')
    const partialReport = await readFile(join(partialStage, 'quality-report.json'))
    const completeReport = await readFile(join(completeStage, 'quality-report.json'))
    const partialId = createHash('sha256').update(partialReport).digest('hex')
    const completeId = createHash('sha256').update(completeReport).digest('hex')
    await mkdir(join(dataRoot, 'snapshots'), { recursive: true })
    await rename(partialStage, join(dataRoot, 'snapshots', partialId))
    await rename(completeStage, join(dataRoot, 'snapshots', completeId))
    await writeFile(join(dataRoot, 'CURRENT'), `${partialId}\n`, 'utf8')

    await expect(provider(dataRoot).inspect()).resolves.toMatchObject({
      status: 'degraded',
      partial: true,
    })

    const nextPointer = join(dataRoot, '.CURRENT.next')
    await writeFile(nextPointer, `${completeId}\n`, 'utf8')
    await rename(nextPointer, join(dataRoot, 'CURRENT'))

    await expect(provider(dataRoot).inspect()).resolves.toMatchObject({
      status: 'ready',
      partial: false,
    })
    await expect(provider(fixtureRoot).inspect()).resolves.toMatchObject({
      status: 'degraded',
      partial: true,
    })
  })

  it('fails closed instead of falling back to legacy assets when CURRENT is malformed', async () => {
    const dataRoot = join(temporaryRoot, 'malformed-current')
    makeFixture(dataRoot)
    await mkdir(join(dataRoot, 'snapshots'), { recursive: true })
    await writeFile(join(dataRoot, 'CURRENT'), '../reference\n', 'utf8')

    await expect(provider(dataRoot).inspect()).rejects.toMatchObject({
      kind: 'unsafe-path',
      retryable: false,
    })
  })

  it.each([
    ['missing', '--without-units'],
    ['invalid', '--invalid-units'],
  ] as const)('fails closed on %s published unit metadata', async (label, option) => {
    const incompatible = join(temporaryRoot, `${label}-units`)
    makeFixture(incompatible, option)

    await expect(provider(incompatible).inspect()).rejects.toMatchObject({
      kind: 'invalid-report',
      retryable: false,
    })
  })

  it('rejects unsupported historical snapshots, columns, limits, and staging roots', () => {
    expect(() => provider().query({ dataset: 'market-cap', asOf: '2026-01-01' }))
      .toThrowError(expect.objectContaining({ kind: 'pit-unsafe' }))
    expect(() => provider().query({ dataset: 'prices', columns: ['../secret'] }))
      .toThrowError(expect.objectContaining({ kind: 'invalid-request' }))
    expect(() => provider().query({ dataset: 'prices', limit: 100_001 }))
      .toThrowError(RangeError)
    expect(() => provider(join(temporaryRoot, 'staging', 'runs', 'published')))
      .toThrowError(expect.objectContaining({ kind: 'unsafe-path' }))
  })

  it('rejects size/hash tampering before reading parquet rows', async () => {
    const tampered = join(temporaryRoot, 'tampered')
    await cp(fixtureRoot, tampered, { recursive: true })
    await appendFile(join(tampered, 'reference/price_history.parquet'), 'tamper')

    await expect(provider(tampered).inspect()).rejects.toMatchObject({
      kind: 'integrity-error',
      retryable: false,
    })
  })

  it('rejects symlinked assets even when they point inside reference', async () => {
    const linked = join(temporaryRoot, 'linked')
    await cp(fixtureRoot, linked, { recursive: true })
    const price = join(linked, 'reference/price_history.parquet')
    const target = join(linked, 'reference/actual-price.parquet')
    await cp(price, target)
    await unlink(price)
    await symlink(target, price)

    await expect(provider(linked).inspect()).rejects.toMatchObject({ kind: 'unsafe-path' })
  })

  it('marks missing available_date unsafe and refuses an as_of query', async () => {
    const unsafe = join(temporaryRoot, 'without-available-date')
    makeFixture(unsafe, '--without-available-date')
    const local = provider(unsafe)

    await expect(local.inspect()).resolves.toMatchObject({ pitGrade: 'unsafe' })
    await expect(local.query({ dataset: 'fundamentals', asOf: '2025-12-31' }))
      .rejects.toMatchObject({ kind: 'pit-unsafe', retryable: false })

    const current = await local.execute({
      capability: 'fundamentals',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      params: { limit: 10 },
    })
    expect(current).toMatchObject({
      status: 'partial',
      data: {
        pitSafe: false,
        periods: [
          { fiscalPeriod: '2024-12-31', publishedAt: null, availableAt: null },
          { fiscalPeriod: '2023-12-31', publishedAt: null, availableAt: null },
        ],
      },
    })
    expect(current.provenance).not.toHaveProperty('publishedAt')
    expect(current.provenance).not.toHaveProperty('availableAt')
  })

  it('enforces timeout and pre-aborted cancellation around the isolated runner', async () => {
    const timed = provider(fixtureRoot, { pythonRunner: hangRunner, timeoutMs: 10 })
    await expect(timed.inspect()).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    const controller = new AbortController()
    controller.abort()
    await expect(provider().inspect(controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
      retryable: false,
    })

    const runningController = new AbortController()
    const running = provider(fixtureRoot, { pythonRunner: hangRunner, timeoutMs: 5_000 })
      .inspect(runningController.signal)
    setTimeout(() => runningController.abort(), 10)
    await expect(running).rejects.toMatchObject({ kind: 'aborted', retryable: false })
  })

  it('terminates a long-lived runner when its stdin closes before the request is written', async () => {
    const runner = join(temporaryRoot, 'closed-stdin-runner.py')
    await cp(closedStdinRunner, runner)
    const pidPath = runner.replace(/\.py$/u, '.pid')
    const oversizedRoot = join(temporaryRoot, 'x'.repeat(256 * 1024))
    const local = provider(oversizedRoot, {
      pythonRunner: runner, timeoutMs: 5_000, killGraceMs: 10,
    })
    const pending = local.inspect()
    const settled = pending.catch(() => undefined)
    const pid = await waitForPid(pidPath)
    try {
      await expect(pending).rejects.toMatchObject({ kind: 'process-error', retryable: true })
      expect(await waitForProcessExit(pid)).toBe(true)
    } finally {
      if (processExists(pid)) process.kill(pid, 'SIGKILL')
      await settled
    }
  })

  it('rejects a malformed successful runner payload as a protocol error', async () => {
    await expect(provider(fixtureRoot, { pythonRunner: malformedRunner }).inspect())
      .rejects.toMatchObject({ kind: 'protocol-error', retryable: false })
  })

  it('pins default and explicitly configured bare uv executables at construction', () => {
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    const implicit = provider(fixtureRoot, { environment }) as unknown as { uvExecutable: string }
    const explicit = provider(fixtureRoot, { environment, uvExecutable: 'uv' }) as unknown as {
      uvExecutable: string
    }

    expect(isAbsolute(implicit.uvExecutable)).toBe(true)
    expect(isAbsolute(explicit.uvExecutable)).toBe(true)
    expect(explicit.uvExecutable).toBe(implicit.uvExecutable)

    const pinnedExecutable = explicit.uvExecutable
    environment.PATH = temporaryRoot
    expect(explicit.uvExecutable).toBe(pinnedExecutable)
  })

  it('uses a minimal child environment and hardened default uv and Python arguments', () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: 'fixture-locale',
      TMPDIR: temporaryRoot,
      HTTP_PROXY: 'http://proxy.invalid?' + 'token=' + secretMarker,
      HTTPS_PROXY: 'https://proxy.invalid?' + 'token=' + secretMarker,
      ALL_PROXY: 'socks5://proxy.invalid?' + 'token=' + secretMarker,
      UV_INDEX_URL: 'https://packages.invalid?' + 'token=' + secretMarker,
      PYTHONPATH: '/tmp/cne6-python-injection',
    }
    for (const key of [
      'CNE6_TEST_SECRET', 'OPENAI_API_KEY', 'TUSHARE_TOKEN', 'AWS_SECRET_ACCESS_KEY',
    ]) environment[key] = secretMarker
    const local = provider(fixtureRoot, { environment }) as unknown as {
      runnerEnv: NodeJS.ProcessEnv
      uvArgs: readonly string[]
    }

    expect(Object.keys(local.runnerEnv).sort()).toEqual([
      'PATH', 'LANG', 'TMPDIR',
      'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'PYTHONUTF8',
      'UV_CACHE_DIR', 'UV_NO_CONFIG', 'UV_NO_ENV_FILE',
    ].sort())
    expect(local.runnerEnv).toMatchObject({
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      UV_CACHE_DIR: join(projectRoot, '.uv-cache'),
      UV_NO_CONFIG: '1',
      UV_NO_ENV_FILE: '1',
    })
    expect(JSON.stringify(local.runnerEnv)).not.toContain(secretMarker)
    expect(local.uvArgs).toEqual([
      'run', '--frozen', '--no-sync', '--no-python-downloads', '--no-env-file', '--no-config',
      '--project', projectRoot, 'python', '-B', '-I',
    ])
  })

  it('returns fixed diagnostics without exposing hostile runner output or causes', async () => {
    const local = provider(fixtureRoot, { pythonRunner: hostileRunner })
    let thrown: unknown
    try {
      await local.inspect()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).toMatchObject({
      kind: 'provider-error',
      retryable: false,
      message: 'CNE6 local runner reported provider-error; runner emitted diagnostics',
    })
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined()
    expect(JSON.stringify(thrown)).not.toMatch(
      /fixture-secret|attacker\.invalid|Authorization|Cookie|token=/u,
    )

    const health = await local.health()
    expect(health).toMatchObject({
      providerId: 'cne6-local',
      status: 'unavailable',
      message: 'CNE6 local runner reported provider-error; runner emitted diagnostics',
    })
    expect(JSON.stringify(health)).not.toMatch(
      /fixture-secret|attacker\.invalid|Authorization|Cookie|token=/u,
    )
  })

  it('implements the core capability adapter contract', async () => {
    const local = provider()
    const bars = await local.execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      asOf: '2026-01-05',
      params: {
        startDate: '2026-01-01', endDate: '2026-01-06', interval: '1d', adjustment: 'none', limit: 10,
      },
    })
    expect(bars).toMatchObject({
      status: 'partial',
      data: {
        instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
        interval: '1d',
        adjustment: 'none',
        bars: [
          {
            date: '2026-01-02',
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            preClose: 100,
            volume: 10,
            turnover: 1000,
          },
          {
            date: '2026-01-05',
            open: 101,
            high: 103,
            low: 100,
            close: 102,
            preClose: 101,
            volume: 11,
            turnover: 1100,
          },
        ],
        returned: 2,
        truncated: false,
        startDate: '2026-01-02',
        endDate: '2026-01-05',
      },
      provenance: {
        provider: 'cne6-local',
        actualProvider: 'cne6-local',
        adjustment: 'none',
        observedAt: expect.stringContaining('T'),
        unit: 'price:CNY;volume:share;turnover:CNY',
      },
      warnings: [expect.stringContaining('partial')],
    })
    expect(bars.data).not.toHaveProperty('rows')
    expect(bars.provenance).not.toHaveProperty('availableAt')
    expect(Date.parse(bars.provenance.observedAt ?? '')).toBe(
      Date.parse('2026-01-05T15:00:00+08:00'),
    )

    const health = await local.health()
    expect(health).toMatchObject({
      providerId: 'cne6-local',
      status: 'degraded',
      capabilities: {
        'risk-data': 'degraded',
        fundamentals: 'degraded',
        'market-bars': 'degraded',
      },
    })
    expect(CNE6_LOCAL_CAPABILITIES).not.toContain('index')

    await expect(local.execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      params: { startDate: '2026-01-01', endDate: '2026-01-06', interval: '1wk', adjustment: 'none' },
    })).rejects.toMatchObject({ kind: 'unsupported', retryable: false })
    await expect(local.execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      params: { startDate: '2026-01-01', endDate: '2026-01-06', interval: '1d', adjustment: 'qfq' },
    })).rejects.toMatchObject({ kind: 'unsupported', retryable: false })
    await expect(local.execute({
      capability: 'fundamentals',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      params: { interval: '1d' },
    })).rejects.toMatchObject({ kind: 'unsupported', retryable: false })
    await expect(local.execute({
      capability: 'market-bars',
      market: 'CN',
      params: {
        codes: ['sh.600519'], startDate: '2026-01-01', endDate: '2026-01-06', adjustment: 'none',
      },
    })).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    await expect(local.execute({
      capability: 'index',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '000300', assetType: 'index' },
      params: { limit: 10 },
    })).rejects.toMatchObject({ kind: 'unsupported', retryable: false })
  })

  it('marks a complete artifact capability result available', async () => {
    const complete = join(temporaryRoot, 'complete')
    makeFixture(complete, '--no-partial')
    const result = await provider(complete).execute({
      capability: 'fundamentals',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      asOf: '2025-12-31',
      params: { limit: 10 },
    })
    expect(result).toMatchObject({
      status: 'available',
      data: {
        instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
        periods: [{
          fiscalPeriod: '2024-12-31',
          publishedAt: null,
          availableAt: '2025-04-01',
          currency: 'CNY',
          unit: null,
          scope: null,
          fields: {
            revenue: { status: 'available', value: 100 },
            netIncome: { status: 'available', value: 40 },
            preferredEquity: { status: 'missing', value: null },
          },
        }],
        returned: 1,
        truncated: false,
        pitSafe: false,
      },
      provenance: {
        fiscalPeriod: '2024-12-31',
        availableAt: '2025-04-01',
        currency: 'CNY',
      },
    })
    expect(result.data).not.toHaveProperty('rows')
    expect(result.provenance).not.toHaveProperty('publishedAt')
    expect(result.provenance).not.toHaveProperty('unit')
  })

  it.each([
    ['before Shanghai EOD', '2025-04-01T23:59:59.999+08:00', ['2023-12-31']],
    ['at the next Shanghai day', '2025-04-02T00:00:00+08:00', ['2024-12-31']],
  ] as const)(
    'treats date-only fundamentals availability as visible %s',
    async (_scenario, asOf, expectedPeriods) => {
      const result = await provider().execute<Cne6Fundamentals>({
        capability: 'fundamentals',
        market: 'CN',
        instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
        asOf,
        params: { limit: 10 },
      })

      expect(result.data?.periods.map(period => period.fiscalPeriod)).toEqual(expectedPeriods)
      if (asOf.startsWith('2025-04-01')) {
        expect(result.provenance).not.toHaveProperty('availableAt', '2025-04-01')
      }
    },
  )

  it('fails closed when a published price artifact mixes adjustment modes', async () => {
    const mixed = join(temporaryRoot, 'mixed-adjustments')
    makeFixture(mixed, '--mixed-price-sources')

    await expect(provider(mixed).execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      params: {
        startDate: '2026-01-01', endDate: '2026-01-06', interval: '1d', adjustment: 'none', limit: 10,
      },
    })).rejects.toMatchObject({ kind: 'unsupported', retryable: false })
  })

  it('does not expose a rebuild operation in the runner', () => {
    const request = JSON.stringify({
      version: '1',
      id: 'no-rebuild',
      operation: 'rebuild',
      dataRoot: fixtureRoot,
      params: {},
      limits: { maxRows: 10 },
    })
    const output = execFileSync('uv', [
      'run', '--project', projectRoot, 'python',
      resolve(repositoryRoot, 'packages/finance-data-service/providers/cne6/python/runner.py'),
    ], { cwd: repositoryRoot, input: `${request}\n`, encoding: 'utf8' })
    expect(JSON.parse(output)).toMatchObject({
      version: '1',
      id: 'no-rebuild',
      ok: false,
      error: { kind: 'unsupported-operation', retryable: false },
    })
  })
})
