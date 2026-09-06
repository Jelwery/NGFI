import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityRequest, InstrumentId } from '@finance2dsh/core'
import { FinanceDataService } from '../packages/finance-data-service/src/index.js'
import {
  TDX_COMMUNITY_PROVIDER_ID,
  TDX_OFFICIAL_PROVIDER_ID,
  TdxCommunityProvider,
  TdxOfficialProvider,
} from '../packages/finance-provider-tdx/src/index.js'

const FIXTURE_RUNNER = join(process.cwd(), 'tests/fixtures/tdx/runner.py')
const PROCESS_TREE_RUNNER = join(process.cwd(), 'tests/fixtures/tdx/process-tree-runner.mjs')
const COOPERATIVE_PROCESS_TREE_RUNNER = join(
  process.cwd(),
  'tests/fixtures/tdx/cooperative-process-tree-runner.mjs',
)
const MIXED_PROCESS_TREE_RUNNER = join(
  process.cwd(),
  'tests/fixtures/tdx/mixed-process-tree-runner.mjs',
)
const NATURAL_EXIT_PROCESS_TREE_RUNNER = join(
  process.cwd(),
  'tests/fixtures/tdx/natural-exit-process-tree-runner.mjs',
)
const NOW = Date.parse('2026-09-05T00:00:00Z')
const SSE_EQUITY: InstrumentId = {
  market: 'CN',
  exchange: 'SSE',
  symbol: '600519',
  assetType: 'equity',
}
const CSI_300: InstrumentId = {
  market: 'CN',
  exchange: 'SSE',
  symbol: '000300',
  assetType: 'index',
}

function community(
  overrides: ConstructorParameters<typeof TdxCommunityProvider>[0] = {},
): TdxCommunityProvider {
  return new TdxCommunityProvider({
    servers: [
      { host: '127.0.0.1', port: 7709 },
      { host: '127.0.0.2', port: 7709 },
      { host: '127.0.0.3', port: 7709 },
      { host: '127.0.0.4', port: 7709 },
    ],
    runnerCommand: ['python3', FIXTURE_RUNNER],
    now: () => NOW,
    ...overrides,
  })
}

function barsRunner(rows: readonly Record<string, unknown>[]): readonly string[] {
  return [
    process.execPath,
    '-e',
    [
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', chunk => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(input)",
      "  const rows = JSON.parse(process.argv[1]).map(row => ({",
      "    ...row, vol: request.params.offset, amount: request.params.count,",
      "  }))",
      "  process.stdout.write(JSON.stringify({ version: '1', ok: true, data: rows, meta: { attempts: 1, serverIndex: 0 } }))",
      "})",
    ].join('\n'),
    JSON.stringify(rows),
  ]
}

const INLINE_QUOTE_RUNNER = [
  "process.stdout.write(JSON.stringify({",
  "  version: '1', ok: true,",
  "  data: { datetime: '2026-09-04T15:00:00+08:00', price: 12.34 },",
  "  meta: { attempts: 1, serverIndex: 0 },",
  "}))",
].join('\n')

interface ProcessTree {
  parentPid: number
  childPid: number
}

async function traceContents(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function waitForProcessTree(path: string, timeoutMs = 3_000): Promise<ProcessTree> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const trace = await traceContents(path)
    const parent = /^parent-ready:(\d+):(\d+)$/mu.exec(trace)
    const child = /^child-ready:(\d+)$/mu.exec(trace)
    if (parent !== null && child !== null && parent[2] === child[1]) {
      const parentPid = Number(parent[1])
      const childPid = Number(child[1])
      if (parentPid > 1 && childPid > 1 && parentPid !== process.pid && childPid !== process.pid) {
        return { parentPid, childPid }
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error(`TDX process-tree fixture was not ready; trace: ${await traceContents(path)}`)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    if (process.platform !== 'win32') {
      const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const state = probe.stdout.trim()
      if (probe.status !== 0 || state === '') return false
      // A killed descendant can remain briefly as an init-owned zombie. It is
      // no longer executable and therefore satisfies the no-live-process boundary.
      if (state.startsWith('Z')) return false
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pids: readonly number[], timeoutMs = 1_500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every(pid => !processExists(pid))) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  return pids.every(pid => !processExists(pid))
}

function killFixtureProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

describe('TDX community process safety boundaries', () => {
  it('does not hard-code a platform-specific /bin/ps path in the POSIX supervisor', async () => {
    const source = await readFile(
      join(process.cwd(), 'packages/finance-provider-tdx/src/index.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/spawnSync\(\s*['"]\/bin\/ps['"]/u)
  })

  it('resolves the default bare runner executable and uses hardened uv and Python arguments', () => {
    const packageRoot = resolve(process.cwd(), 'packages/finance-provider-tdx')
    const defaultProvider = new TdxCommunityProvider({
      servers: [{ host: '127.0.0.1', port: 7709 }],
      environment: { PATH: process.env.PATH },
    })
    const defaultRuntime = defaultProvider as unknown as { runnerCommand: readonly string[] }
    expect(isAbsolute(defaultRuntime.runnerCommand[0] ?? '')).toBe(true)
    expect(defaultRuntime.runnerCommand.slice(1)).toEqual([
      'run', '--frozen', '--no-sync', '--no-python-downloads', '--no-env-file', '--no-config',
      '--project', packageRoot, 'python', '-B', join(packageRoot, 'python/runner.py'),
    ])
  })

  it('resolves an explicitly configured bare runner executable before later PATH changes', async () => {
    const configuredProvider = community({
      environment: { PATH: dirname(process.execPath) },
      runnerCommand: [basename(process.execPath), '-e', INLINE_QUOTE_RUNNER],
    })
    const configuredRuntime = configuredProvider as unknown as {
      runnerCommand: readonly string[]
      runnerEnvironment: NodeJS.ProcessEnv
    }
    expect(isAbsolute(configuredRuntime.runnerCommand[0] ?? '')).toBe(true)
    expect(configuredRuntime.runnerCommand.slice(1)).toEqual(['-e', INLINE_QUOTE_RUNNER])
    configuredRuntime.runnerEnvironment.PATH = join(tmpdir(), 'tdx-runner-path-changed-after-construction')
    await expect(configuredProvider.quote(SSE_EQUITY)).resolves.toMatchObject({ status: 'available' })
    await configuredProvider.close()
  })

  it('uses a minimal child environment with fixed Python and uv isolation settings', () => {
    const packageRoot = resolve(process.cwd(), 'packages/finance-provider-tdx')
    const inheritedEnvironment = {
      PATH: '/safe/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LC_CTYPE: 'C.UTF-8',
      TMPDIR: '/safe/tmpdir', TMP: '/safe/tmp', TEMP: '/safe/temp',
      SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows',
    } as const
    const environment: NodeJS.ProcessEnv = {
      ...inheritedEnvironment,
      TDX_DATA_KEY: 'fixture-secret-that-must-not-leak',
      TDX_COMMUNITY_SERVERS: 'attacker.invalid:7709',
      OPENAI_API_KEY: 'fixture-secret-that-must-not-leak',
      ANTHROPIC_API_KEY: 'fixture-secret-that-must-not-leak',
      DEEPSEEK_API_KEY: 'fixture-secret-that-must-not-leak',
      LLM_API_KEY: 'fixture-secret-that-must-not-leak',
      NGFI_API_KEY: 'fixture-secret-that-must-not-leak',
      AWS_ACCESS_KEY_ID: 'fixture-secret-that-must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret-that-must-not-leak',
      AWS_SESSION_TOKEN: 'fixture-secret-that-must-not-leak',
      HTTP_PROXY: 'https://proxy.invalid',
      HTTPS_PROXY: 'https://proxy.invalid',
      ALL_PROXY: 'https://proxy.invalid',
      NO_PROXY: 'metadata.invalid',
      PYTHONHOME: '/attacker/python-home',
      PYTHONPATH: '/attacker/python-path',
      UV_CACHE_DIR: '/attacker/uv-cache',
      UV_INDEX_URL: 'https://packages.invalid?token=fixture-secret-that-must-not-leak',
      UV_EXTRA_INDEX_URL: 'https://packages.invalid/extra',
    }
    const provider = community({ environment })
    const runtime = provider as unknown as { runnerEnvironment: NodeJS.ProcessEnv }

    expect(Object.keys(runtime.runnerEnvironment).sort()).toEqual([
      ...Object.keys(inheritedEnvironment),
      'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'PYTHONUTF8',
      'UV_CACHE_DIR', 'UV_NO_CONFIG', 'UV_NO_ENV_FILE',
    ].sort())
    expect(runtime.runnerEnvironment).toMatchObject({
      ...inheritedEnvironment,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      UV_CACHE_DIR: join(packageRoot, '.uv-cache'),
      UV_NO_CONFIG: '1',
      UV_NO_ENV_FILE: '1',
    })
  })

  it.skipIf(process.platform === 'win32').each(['timeout', 'abort', 'close'] as const)(
    '%s terminates the detached runner process group with TERM then KILL',
    async mode => {
      const directory = await mkdtemp(join(tmpdir(), `finance2dsh-tdx-${mode}-`))
      const tracePath = join(directory, 'process-tree.trace')
      const provider = community({
        runnerCommand: [process.execPath, PROCESS_TREE_RUNNER, tracePath],
        timeoutMs: mode === 'timeout' ? 750 : 5_000,
        terminationGraceMs: 50,
      })
      let tree: ProcessTree | undefined
      const controller = new AbortController()
      const pending = provider.quote(SSE_EQUITY, controller.signal)
      const settled = pending.catch(() => undefined)
      try {
        tree = await waitForProcessTree(tracePath)
        if (mode === 'abort') controller.abort()
        if (mode === 'close') await provider.close()
        if (mode === 'timeout') {
          await expect(pending).rejects.toMatchObject({ kind: 'timeout' })
        } else if (mode === 'abort') {
          await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
        } else {
          await settled
        }

        expect(await waitForProcessExit([tree.parentPid, tree.childPid])).toBe(true)
        const trace = await traceContents(tracePath)
        expect(trace).toContain(`term:parent:${tree.parentPid}`)
        expect(trace).toContain(`term:child:${tree.childPid}`)
      } finally {
        controller.abort()
        if (tree !== undefined) {
          killFixtureProcess(tree.parentPid)
          killFixtureProcess(tree.childPid)
        }
        await provider.close()
        await settled
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'does not send delayed KILL to a process group that exited after TERM',
    async () => {
      const terminationGraceMs = 1_000
      const directory = await mkdtemp(join(tmpdir(), 'finance2dsh-tdx-cooperative-abort-'))
      const tracePath = join(directory, 'process-tree.trace')
      const provider = community({
        runnerCommand: [process.execPath, COOPERATIVE_PROCESS_TREE_RUNNER, tracePath],
        timeoutMs: 5_000,
        terminationGraceMs,
      })
      const controller = new AbortController()
      const pending = provider.quote(SSE_EQUITY, controller.signal)
      const settled = pending.catch(() => undefined)
      let tree: ProcessTree | undefined

      try {
        tree = await waitForProcessTree(tracePath)
        const activeTree = tree
        const killSpy = vi.spyOn(process, 'kill')
        try {
          controller.abort()
          await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
          expect(await waitForProcessExit(
            [activeTree.parentPid, activeTree.childPid],
            terminationGraceMs - 200,
          )).toBe(true)

          await new Promise(resolvePromise => setTimeout(resolvePromise, terminationGraceMs + 100))
          await provider.close()
          await settled

          expect(killSpy.mock.calls.some(
            ([pid, signal]) => pid === -activeTree.parentPid && signal === 'SIGKILL',
          )).toBe(false)
          const trace = await traceContents(tracePath)
          expect(trace).toContain(`term:parent:${activeTree.parentPid}`)
          expect(trace).toContain(`term:child:${activeTree.childPid}`)
        } finally {
          killSpy.mockRestore()
        }
      } finally {
        controller.abort()
        if (tree !== undefined) {
          killFixtureProcess(tree.parentPid)
          killFixtureProcess(tree.childPid)
        }
        await provider.close()
        await settled
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32').each(['timeout', 'abort', 'close'] as const)(
    '%s keeps the process group owned until a stubborn descendant is gone',
    async mode => {
      const directory = await mkdtemp(join(tmpdir(), `finance2dsh-tdx-mixed-${mode}-`))
      const tracePath = join(directory, 'process-tree.trace')
      const provider = community({
        runnerCommand: [process.execPath, MIXED_PROCESS_TREE_RUNNER, tracePath],
        timeoutMs: mode === 'timeout' ? 750 : 5_000,
        terminationGraceMs: 50,
      })
      const controller = new AbortController()
      const pending = provider.quote(SSE_EQUITY, controller.signal)
      const settled = pending.catch(() => undefined)
      let tree: ProcessTree | undefined
      try {
        tree = await waitForProcessTree(tracePath)
        if (mode === 'abort') controller.abort()
        if (mode === 'close') await provider.close()
        if (mode === 'timeout') await expect(pending).rejects.toMatchObject({ kind: 'timeout' })
        else if (mode === 'abort') await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
        else await settled
        expect(await waitForProcessExit([tree.parentPid, tree.childPid])).toBe(true)
        const trace = await traceContents(tracePath)
        expect(trace).toContain(`term:parent:${tree.parentPid}`)
        expect(trace).toContain(`term:child:${tree.childPid}`)
      } finally {
        controller.abort()
        if (tree !== undefined) {
          killFixtureProcess(tree.parentPid)
          killFixtureProcess(tree.childPid)
        }
        await provider.close()
        await settled
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32').each([
    ['successful', 0, 'available'],
    ['nonzero', 23, 'provider-error'],
  ] as const)(
    'cleans descendants after a %s runner exits naturally while preserving its result',
    async (_scenario, exitCode, expectedOutcome) => {
      const directory = await mkdtemp(join(tmpdir(), `finance2dsh-tdx-natural-${exitCode}-`))
      const tracePath = join(directory, 'process-tree.trace')
      const provider = community({
        runnerCommand: [process.execPath, NATURAL_EXIT_PROCESS_TREE_RUNNER, tracePath, String(exitCode)],
        timeoutMs: 1_500,
        terminationGraceMs: 50,
      })

      try {
        const pending = provider.quote(SSE_EQUITY).then(
          value => ({ status: 'fulfilled' as const, value }),
          error => ({ status: 'rejected' as const, error }),
        )
        await waitForProcessTree(tracePath)
        if (expectedOutcome === 'available') {
          await expect(pending).resolves.toMatchObject({
            status: 'fulfilled',
            value: { status: 'available', data: { lastPrice: 12.34 } },
          })
        } else {
          await expect(pending).resolves.toMatchObject({
            status: 'rejected',
            error: {
              kind: 'provider-error',
              message: 'tdx-community runner exited with code 23',
            },
          })
        }
        const trace = await traceContents(tracePath)
        expect(trace).toMatch(/^term:child:\d+$/mu)
        expect(trace).not.toContain('self-timeout:')
      } finally {
        await provider.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})

describe('TDX optional providers', () => {
  it('keeps official and community identities separate and blocks missing official credentials', async () => {
    const official = new TdxOfficialProvider({ environment: {}, now: () => NOW })
    const communityProvider = new TdxCommunityProvider({ environment: {}, now: () => NOW })

    expect(official.providerId).toBe(TDX_OFFICIAL_PROVIDER_ID)
    expect(communityProvider.providerId).toBe(TDX_COMMUNITY_PROVIDER_ID)
    expect(official.providerId).not.toBe(communityProvider.providerId)
    await expect(official.health()).resolves.toEqual({
      providerId: 'tdx-official',
      status: 'dormant',
      checkedAt: '2026-09-05T00:00:00.000Z',
      message: 'blocked: missing TDX_DATA_KEY',
      capabilities: { quote: 'dormant', 'market-bars': 'dormant' },
      reason: 'missing-credential',
      authMode: 'api-key',
      details: {
        requiredEnvironment: ['TDX_DATA_KEY'],
        officialTransportEnabled: false,
        liveVerified: false,
        transport: 'remote-service',
        platform: process.platform,
      },
    })
    await expect(official.execute({ capability: 'quote', market: 'CN' }))
      .rejects.toMatchObject({ kind: 'unauthorized', retryable: false, provider: 'tdx-official' })
    await expect(communityProvider.health()).resolves.toMatchObject({
      providerId: 'tdx-community',
      status: 'dormant',
      message: 'blocked: missing TDX_COMMUNITY_SERVERS',
      capabilities: { quote: 'dormant', 'market-bars': 'dormant' },
    })
  })

  it.each([
    ['without credentials', undefined],
    ['with credentials', 'tdx-test-secret-that-must-not-leak'],
  ] as const)('gives unsupported local-client platform precedence %s', async (_case, dataKey) => {
    const provider = new TdxOfficialProvider({
      environment: {},
      ...(dataKey === undefined ? {} : { dataKey }),
      transport: 'local-client',
      platform: 'darwin',
      now: () => NOW,
    })
    const health = await provider.health()

    expect(health).toMatchObject({
      providerId: 'tdx-official',
      status: 'unsupported-platform',
      checkedAt: '2026-09-05T00:00:00.000Z',
      reason: 'unsupported-platform',
      capabilities: { quote: 'unsupported-platform', 'market-bars': 'unsupported-platform' },
      authMode: 'api-key',
      details: {
        platform: 'darwin',
        transport: 'local-client',
        officialTransportEnabled: false,
        liveVerified: false,
      },
    })
    await expect(provider.execute({ capability: 'quote', market: 'CN' })).rejects.toMatchObject({
      kind: 'unsupported',
      retryable: false,
      provider: 'tdx-official',
      details: { reason: 'unsupported-platform' },
    })
    if (dataKey !== undefined) expect(JSON.stringify(health)).not.toContain(dataKey)
  })

  it('keeps the configured official remote service dormant until live verification', async () => {
    const health = await new TdxOfficialProvider({
      dataKey: 'configured-secret',
      platform: 'linux',
      now: () => NOW,
    }).health()
    expect(health).toMatchObject({
      status: 'dormant',
      reason: 'not-live-verified',
      capabilities: { quote: 'dormant', 'market-bars': 'dormant' },
      details: { transport: 'remote-service', liveVerified: false },
    })
  })

  it('maps only verified community quote and unadjusted bar capabilities from a v1 fixture', async () => {
    const provider = community({ maxServerAttempts: 2 })
    const quote = await provider.quote(SSE_EQUITY)
    const bars = await provider.marketBars(SSE_EQUITY, { interval: '1d', offset: 0, count: 2 })

    expect(quote).toMatchObject({
      status: 'available',
      data: {
        instrument: SSE_EQUITY,
        providerSymbol: '600519.SH',
        observedAt: '2026-09-04T07:00:00.000Z',
        lastPrice: 1,
        amount: 2,
      },
      provenance: {
        provider: 'tdx-community',
        actualProvider: 'tdx-community',
        upstreamSource: 'tdx-community',
        sourceKind: 'community',
        fetchedAt: '2026-09-05T00:00:00.000Z',
      },
    })
    expect(bars).toMatchObject({
      status: 'available',
      data: {
        providerSymbol: '600519.SH',
        interval: '1d',
        adjustment: 'none',
        bars: [
          { observedAt: '2026-09-03T07:00:00.000Z', close: 12 },
          { observedAt: '2026-09-04T07:00:00.000Z', close: 12.34 },
        ],
      },
      provenance: {
        provider: 'tdx-community',
        sourceKind: 'community',
        adjustment: 'none',
        observedAt: '2026-09-04T07:00:00.000Z',
      },
    })
    expect(JSON.stringify([quote, bars])).not.toContain('tdx-official')
    await provider.close()
  })

  it('routes community quotes with the required unadjusted A-share provenance', async () => {
    const provider = community()
    const service = new FinanceDataService().register({
      providerId: provider.providerId,
      adapter: provider,
      capabilities: provider.capabilities,
      markets: provider.markets,
      qualityTier: 'fallback',
      authMode: provider.authMode,
    })

    const quote = await service.execute({
      capability: 'quote',
      market: 'CN',
      instrument: SSE_EQUITY,
    }, { provider: provider.providerId, fallback: false, cache: false })

    expect(quote).toMatchObject({
      status: 'available',
      provenance: { provider: 'tdx-community', adjustment: 'none' },
    })
    await provider.close()
  })

  it('accepts curated daily range params, derives a bounded count, and filters returned bars', async () => {
    const provider = community({
      runnerCommand: barsRunner([
        { datetime: '2026-09-02T15:00:00+08:00', open: 10, high: 12, low: 9, close: 11 },
        { datetime: '2026-09-03T15:00:00+08:00', open: 11, high: 13, low: 10, close: 12 },
        { datetime: '2026-09-04T15:00:00+08:00', open: 12, high: 14, low: 11, close: 13 },
      ]),
    })

    const result = await provider.execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: SSE_EQUITY,
      params: {
        startDate: '2026-09-03',
        endDate: '2026-09-04',
        interval: '1d',
        adjustment: 'none',
        limit: 10,
      },
    })

    expect(result).toMatchObject({
      status: 'available',
      data: {
        interval: '1d',
        adjustment: 'none',
        bars: [
          { observedAt: '2026-09-03T07:00:00.000Z', close: 12, amount: 3 },
          { observedAt: '2026-09-04T07:00:00.000Z', close: 13, amount: 3 },
        ],
      },
      provenance: { observedAt: '2026-09-04T07:00:00.000Z', adjustment: 'none' },
    })
    await provider.close()
  })

  it('applies the asOf cutoff to canonical daily ranges', async () => {
    const provider = community({
      runnerCommand: barsRunner([
        { datetime: '2026-09-03T15:00:00+08:00', close: 12 },
        { datetime: '2026-09-04T15:00:00+08:00', close: 13 },
      ]),
    })

    const result = await provider.execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: SSE_EQUITY,
      asOf: '2026-09-04T14:59:59+08:00',
      params: {
        startDate: '2026-09-03',
        endDate: '2026-09-04',
        interval: '1d',
        adjustment: 'none',
        limit: 10,
      },
    })

    expect(result.data).toMatchObject({
      bars: [{ observedAt: '2026-09-03T07:00:00.000Z', close: 12 }],
    })
    expect(result.provenance.observedAt).toBe('2026-09-03T07:00:00.000Z')
    await provider.close()
  })

  it('preserves low-level offset/count access and verified intraday intervals', async () => {
    const provider = community({
      runnerCommand: barsRunner([
        { datetime: '2026-09-04T14:00:00+08:00', open: 11, high: 13, low: 10, close: 12 },
      ]),
    })

    const result = await provider.marketBars(SSE_EQUITY, { interval: '1h', offset: 7, count: 2 })

    expect(result.data).toMatchObject({
      interval: '1h',
      bars: [{ observedAt: '2026-09-04T06:00:00.000Z', volume: 7, amount: 2 }],
    })
    await provider.close()
  })

  it('classifies unsupported canonical adjustments for fallback', async () => {
    const provider = community()
    const request: CapabilityRequest = {
      capability: 'market-bars',
      market: 'CN',
      instrument: SSE_EQUITY,
      params: {
        startDate: '2026-09-03',
        endDate: '2026-09-04',
        interval: '1d',
        adjustment: 'qfq',
        limit: 10,
      },
    }
    await expect(provider.execute(request)).rejects.toMatchObject({ kind: 'unsupported', retryable: false })

    const fallback = vi.fn(async () => ({
      status: 'available' as const,
      data: { source: 'fallback' },
      provenance: {
        provider: 'fallback',
        actualProvider: 'fallback',
        upstreamSource: 'fixture',
        sourceKind: 'user' as const,
        fetchedAt: '2026-09-05T00:00:00.000Z',
        adjustment: 'qfq' as const,
        fallbackChain: [],
      },
      warnings: [],
    }))
    const service = new FinanceDataService()
      .register({
        providerId: provider.providerId, adapter: provider, capabilities: provider.capabilities,
        markets: provider.markets, qualityTier: 'fallback', authMode: provider.authMode, priority: 20,
      })
      .register({
        providerId: 'fallback', adapter: { execute: fallback as never }, capabilities: ['market-bars'],
        markets: ['CN'], qualityTier: 'fallback', authMode: 'none', priority: 10,
      })

    const routed = await service.execute(request, { cache: false })
    expect(routed).toMatchObject({
      status: 'available',
      data: { source: 'fallback' },
      provenance: {
        actualProvider: 'fallback',
        fallbackChain: [
          { provider: 'tdx-community', outcome: 'failed', reason: expect.stringMatching(/^unsupported:/u) },
          { provider: 'fallback', outcome: 'success' },
        ],
      },
    })
    expect(fallback).toHaveBeenCalledOnce()
    await provider.close()
  })

  it('returns no-data instead of substituting a recent bar for an absent target date', async () => {
    const provider = community({
      runnerCommand: barsRunner([
        { datetime: '2026-09-04T15:00:00+08:00', open: 12, high: 14, low: 11, close: 13 },
      ]),
    })
    await expect(provider.execute({
      capability: 'market-bars',
      market: 'CN',
      instrument: SSE_EQUITY,
      asOf: '2026-09-02',
      params: {
        startDate: '2026-09-02',
        endDate: '2026-09-02',
        interval: '1d',
        adjustment: 'none',
        limit: 1,
      },
    })).rejects.toMatchObject({ kind: 'no-data', retryable: false })
    await provider.close()
  })

  it('rejects duplicate daily observations and unknown canonical params', async () => {
    const provider = community({
      runnerCommand: barsRunner([
        { datetime: '2026-09-04T15:00:00+08:00', close: 12 },
        { datetime: '2026-09-04T15:00:00+08:00', close: 13 },
      ]),
    })
    const request = {
      capability: 'market-bars' as const,
      market: 'CN',
      instrument: SSE_EQUITY,
      params: {
        startDate: '2026-09-04',
        endDate: '2026-09-04',
        interval: '1d',
        adjustment: 'none',
        limit: 1,
      },
    }

    await expect(provider.execute(request)).rejects.toMatchObject({ kind: 'schema-drift', retryable: false })
    await expect(provider.execute({
      ...request,
      params: { ...request.params, cursor: 'not-allowed' },
    })).rejects.toMatchObject({ kind: 'invalid-request', retryable: false })
    await provider.close()
  })

  it('fails closed for malformed or ambiguous canonical date range params', async () => {
    const provider = community()
    const base = {
      capability: 'market-bars' as const,
      market: 'CN',
      instrument: SSE_EQUITY,
    }

    await expect(provider.execute({
      ...base,
      params: { startDate: '2026-09-04', adjustment: 'none', interval: '1d', limit: 1 },
    })).rejects.toMatchObject({ kind: 'invalid-request' })
    await expect(provider.execute({
      ...base,
      params: {
        startDate: '2026-09-03', endDate: '2026-09-04', adjustment: 'none',
        interval: '1d', limit: 1, offset: 0,
      },
    })).rejects.toMatchObject({ kind: 'invalid-request' })
    await expect(provider.execute({
      ...base,
      params: {
        startDate: '2023-01-01', endDate: '2023-01-02', adjustment: 'none', interval: '1d', limit: 1,
      },
    })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(provider.marketBars(SSE_EQUITY, {
      interval: '1d',
      cursor: 'not-allowed',
    } as never)).rejects.toMatchObject({ kind: 'invalid-request' })
    await provider.close()
  })

  it('rotates configured servers and caps each runner request at three candidates', async () => {
    const provider = community({ maxServerAttempts: 3 })
    const first = await provider.quote(SSE_EQUITY)
    const second = await provider.quote(SSE_EQUITY)

    expect(first.data).toMatchObject({ lastPrice: 1, amount: 3 })
    expect(second.data).toMatchObject({ lastPrice: 2, amount: 3 })
    const third = await provider.quote(SSE_EQUITY)
    const fourth = await provider.quote(SSE_EQUITY)
    expect(third.data).toMatchObject({ lastPrice: 3, amount: 3 })
    expect(fourth.data).toMatchObject({ lastPrice: 4, amount: 3 })
    await provider.close()
  })

  it('rejects capabilities, parameters, exchanges, and bar ranges outside the verified allowlist', async () => {
    const provider = community()
    const unsupported: CapabilityRequest = {
      capability: 'fundamentals',
      market: 'CN',
      instrument: SSE_EQUITY,
    }
    await expect(provider.execute(unsupported)).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(provider.execute({
      capability: 'quote',
      market: 'CN',
      instrument: SSE_EQUITY,
      params: { url: 'https://example.invalid' },
    })).rejects.toMatchObject({ kind: 'invalid-request' })
    await expect(provider.quote({ ...SSE_EQUITY, exchange: 'BSE', symbol: '920021' }))
      .rejects.toMatchObject({ kind: 'unsupported' })
    await expect(provider.quote(CSI_300)).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(provider.marketBars(SSE_EQUITY, { count: 801 }))
      .rejects.toMatchObject({ kind: 'invalid-request' })
    await provider.close()
  })

  it('returns an explicit unsupported-platform state before starting the runner', async () => {
    const provider = community({ platform: 'aix' })
    await expect(provider.health()).resolves.toMatchObject({
      status: 'unsupported-platform',
      reason: 'unsupported-platform',
      capabilities: { quote: 'unsupported-platform', 'market-bars': 'unsupported-platform' },
      details: { platform: 'aix' },
    })
    await expect(provider.quote(SSE_EQUITY)).rejects.toMatchObject({ kind: 'unsupported' })
    await provider.close()
  })

  it('does not claim Windows support before subprocess cancellation is verified there', async () => {
    const provider = community({ platform: 'win32' })
    await expect(provider.health()).resolves.toMatchObject({
      status: 'unsupported-platform',
      reason: 'unsupported-platform',
      message: 'tdx-community subprocess cancellation has not been verified on Windows',
      details: { platform: 'win32' },
    })
    await expect(provider.quote(SSE_EQUITY)).rejects.toMatchObject({ kind: 'unsupported' })
    await provider.close()
  })

  it.each([
    ['malformed.example', 4 * 1024 * 1024, 'runner returned malformed JSON'],
    ['version.example', 4 * 1024 * 1024, 'unsupported tdx-community runner protocol version'],
    ['output.example', 64, 'runner output exceeded limit'],
  ])('fails closed for %s runner output', async (host, maxOutputBytes, message) => {
    const provider = community({ servers: [{ host, port: 7709 }], maxOutputBytes })
    await expect(provider.quote(SSE_EQUITY)).rejects.toMatchObject({
      kind: 'schema-drift',
      retryable: false,
      message: expect.stringContaining(message),
    })
    await provider.close()
  })

  it('rejects a valid success envelope when the runner exits nonzero', async () => {
    const provider = community({ servers: [{ host: 'nonzero.example', port: 7709 }] })
    await expect(provider.quote(SSE_EQUITY)).rejects.toMatchObject({
      kind: 'provider-error',
      retryable: true,
      message: 'tdx-community runner exited with code 23',
    })
    await provider.close()
  })

  it('terminates a timed-out runner and supports abort cancellation', async () => {
    const timed = community({
      servers: [{ host: 'hang.example', port: 7709 }],
      timeoutMs: 50,
      terminationGraceMs: 20,
    })
    await expect(timed.quote(SSE_EQUITY)).rejects.toMatchObject({ kind: 'timeout', retryable: true })
    await timed.close()

    const aborted = community({
      servers: [{ host: 'hang.example', port: 7709 }],
      timeoutMs: 5_000,
      terminationGraceMs: 20,
    })
    const controller = new AbortController()
    const pending = aborted.quote(SSE_EQUITY, controller.signal)
    setTimeout(() => controller.abort(), 30)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    await aborted.close()
    await expect(aborted.health()).resolves.toMatchObject({ status: 'unavailable', reason: 'closed' })
    await expect(aborted.quote(SSE_EQUITY)).rejects.toMatchObject({ kind: 'provider-error' })
  })

  it('bounds real runner server reselection and disconnects every attempted client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'finance2dsh-tdx-runner-'))
    const trace = join(directory, 'trace.txt')
    try {
      const request = {
        version: '1',
        operation: 'quote',
        params: {
          instrument: { market: 1, exchange: 'SSE', symbol: '600519', assetType: 'equity' },
        },
        servers: [
          { host: 'fail-one.example', port: 7709 },
          { host: 'error-two.example', port: 7709 },
          { host: 'good-three.example', port: 7709 },
          { host: 'never-four.example', port: 7709 },
        ],
        maxServerAttempts: 3,
        connectTimeoutMs: 100,
      }
      const result = spawnSync('python3', [
        join(process.cwd(), 'packages/finance-provider-tdx/python/runner.py'),
      ], {
        input: JSON.stringify(request),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: join(process.cwd(), 'tests/fixtures/tdx'),
          TDX_FIXTURE_TRACE: trace,
        },
      })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        version: '1',
        ok: true,
        data: { price: 12.34 },
        meta: { attempts: 3, serverIndex: 2 },
      })
      const lifecycle = await readFile(trace, 'utf8')
      expect(lifecycle).toContain('connect:fail-one.example:7709:0.1')
      expect(lifecycle).toContain('disconnect:fail-one.example')
      expect(lifecycle).toContain('connect:error-two.example:7709:0.1')
      expect(lifecycle).toContain('disconnect:error-two.example')
      expect(lifecycle).toContain('connect:good-three.example:7709:0.1')
      expect(lifecycle).toContain('disconnect:good-three.example')
      expect(lifecycle).not.toContain('never-four.example')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects non-whitelisted runner operations before importing pytdx', () => {
    const result = spawnSync('python3', [
      join(process.cwd(), 'packages/finance-provider-tdx/python/runner.py'),
    ], {
      input: JSON.stringify({
        version: '1',
        operation: 'eval',
        params: {},
        servers: [{ host: '127.0.0.1', port: 7709 }],
        maxServerAttempts: 1,
        connectTimeoutMs: 100,
      }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      version: '1',
      ok: false,
      error: { kind: 'invalid-request', message: 'unsupported operation', retryable: false },
    })
    expect(result.stderr).not.toContain('ModuleNotFoundError')
  })

  it('uses the dedicated pytdx index-bars operation for verified index history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'finance2dsh-tdx-index-'))
    const trace = join(directory, 'trace.txt')
    try {
      const result = spawnSync('python3', [
        join(process.cwd(), 'packages/finance-provider-tdx/python/runner.py'),
      ], {
        input: JSON.stringify({
          version: '1',
          operation: 'market-bars',
          params: {
            instrument: { market: 1, exchange: 'SSE', symbol: '000300', assetType: 'index' },
            interval: '1d',
            offset: 0,
            count: 1,
          },
          servers: [{ host: 'good.example', port: 7709 }],
          maxServerAttempts: 1,
          connectTimeoutMs: 100,
        }),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: join(process.cwd(), 'tests/fixtures/tdx'),
          TDX_FIXTURE_TRACE: trace,
        },
      })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: [{ datetime: '2026-09-04T15:00:00+08:00', close: 4020 }],
      })
      expect(await readFile(trace, 'utf8')).toContain('index-bars:4:1:000300:0:1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('ships its isolated runner and rejects unsafe server configuration', async () => {
    await expect(access(join(process.cwd(), 'packages/finance-provider-tdx/python/runner.py'))).resolves.toBeUndefined()
    await expect(access(join(process.cwd(), 'packages/finance-provider-tdx/pyproject.toml'))).resolves.toBeUndefined()
    expect(() => community({ servers: ['https://example.com:7709'] })).toThrow(/host:port/)
    expect(() => community({ maxServerAttempts: 4 })).toThrow(/1 to 3/)
    expect(() => community({ connectTimeoutMs: 99 })).toThrow(/100 to 30000/)
  })
})
