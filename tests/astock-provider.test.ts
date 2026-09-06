import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeAshareInstrument } from '@finance2dsh/core'
import { createDefaultAshareDataComposition } from '../packages/dsh-finance-tools/src/ashare-composition.js'
import {
  AStockProvider,
  ASTOCK_CAPABILITIES,
  createAStockProviderRegistration,
} from '../packages/finance-provider-astock/src/index.js'

const projectRoot = process.cwd()
const providerRoot = join(projectRoot, 'packages/finance-provider-astock')
const fixtureRoot = join(projectRoot, 'tests/fixtures/a-stock-data')
const pythonRunner = join(providerRoot, 'python/runner.py')

function fixtureProvider(options: ConstructorParameters<typeof AStockProvider>[0] = {}): AStockProvider {
  return new AStockProvider({
    source: 'fixture',
    fixtureRoot,
    projectRoot,
    ...options,
  })
}

const securities = [
  { input: '600519.SH', exchange: 'SSE', symbol: '600519', assetType: 'equity', name: '贵州茅台' },
  { input: '000001.SZ', exchange: 'SZSE', symbol: '000001', assetType: 'equity', name: '平安银行' },
  { input: '920021.BJ', exchange: 'BSE', symbol: '920021', assetType: 'equity', name: '北交所样本' },
  { input: '000300.SH', exchange: 'SSE', symbol: '000300', assetType: 'index', name: '沪深300' },
  { input: '399006.SZ', exchange: 'SZSE', symbol: '399006', assetType: 'index', name: '创业板指' },
  { input: '510050.SH', exchange: 'SSE', symbol: '510050', assetType: 'etf', name: '上证50ETF' },
] as const

function requestInstrument(item: typeof securities[number]) {
  return {
    market: 'CN' as const,
    capability: 'instrument-reference' as const,
    params: { symbol: item.input, assetType: item.assetType },
  }
}

function instrument(item: typeof securities[number]) {
  return {
    market: 'CN' as const,
    exchange: item.exchange,
    symbol: item.symbol,
    assetType: item.assetType,
  }
}

describe('AStockProvider recorded contract', () => {
  it('ships the isolated runner and advertises the curated core capabilities', async () => {
    await expect(access(pythonRunner)).resolves.toBeUndefined()
    expect(ASTOCK_CAPABILITIES).toEqual([
      'instrument-reference', 'quote', 'market-bars', 'fundamentals',
      'disclosures', 'index', 'trading-calendar',
    ])
    await expect(fixtureProvider().health()).resolves.toMatchObject({
      providerId: 'a-stock-public',
      status: 'healthy',
    })
    expect(createAStockProviderRegistration({ source: 'fixture', fixtureRoot, projectRoot })).toMatchObject({
      providerId: 'a-stock-public',
      capabilities: ASTOCK_CAPABILITIES,
      markets: ['CN'],
      qualityTier: 'fallback',
      authMode: 'none',
      rateLimit: { concurrency: 1 },
    })
  })

  it.each(securities)('normalizes and maps $input without leaking provider dialects', async item => {
    const result = await fixtureProvider().instrumentReference(requestInstrument(item))

    expect(result.status).toBe('available')
    expect(result.data).toMatchObject({
      id: instrument(item),
      canonical: `CN:${item.exchange}:${item.symbol}:${item.assetType.toUpperCase()}`,
      name: { status: 'available', value: item.name },
      quoteCurrency: { status: 'available', value: 'CNY' },
    })
    expect(result.provenance).toMatchObject({
      actualProvider: 'a-stock-public',
      provider: 'a-stock-public',
      upstreamSource: 'recorded-contract-fixture',
      sourceKind: 'user',
      timezone: 'Asia/Shanghai',
      currency: 'CNY',
    })
  })

  it.each(securities)('maps quote and daily bars for $input with explicit units and adjustment', async item => {
    const provider = fixtureProvider()
    const id = instrument(item)
    const quote = await provider.quote({ capability: 'quote', market: 'CN', instrument: id, params: {} })
    const bars = await provider.marketBars({
      capability: 'market-bars',
      market: 'CN',
      instrument: id,
      params: { startDate: '2026-08-27', endDate: '2026-08-28', adjustment: 'none', limit: 10 },
    })

    expect(quote.data).toMatchObject({
      instrument: id,
      tradingDate: '2026-08-28',
      currency: 'CNY',
      fields: { name: { status: 'available', value: item.name } },
    })
    expect(quote.provenance.unit).toBe('price:CNY;volume:lot;turnover:CNY')
    expect(quote.provenance.adjustment).toBe('none')
    expect(bars.data).toMatchObject({
      instrument: id,
      interval: '1d',
      adjustment: 'none',
      returned: 2,
      truncated: false,
    })
    expect(bars.data?.bars.map(bar => bar.date)).toEqual(['2026-08-27', '2026-08-28'])
    expect(bars.provenance.adjustment).toBe('none')
  })

  it('applies PIT availability and preserves missing financial values instead of coercing zero', async () => {
    const provider = fixtureProvider()
    const maotai = normalizeAshareInstrument('600519.SH')
    const pingan = normalizeAshareInstrument('000001.SZ')
    const asOfResult = await provider.fundamentalsV2({
      capability: 'fundamentals', market: 'CN', instrument: maotai, asOf: '2025-12-31', params: { limit: 10 },
    })
    const missingResult = await provider.fundamentalsV2({
      capability: 'fundamentals', market: 'CN', instrument: pingan, params: { limit: 10 },
    })

    expect(asOfResult.data?.periods).toHaveLength(1)
    expect(asOfResult.data?.periods[0]).toMatchObject({
      fiscalPeriod: '2024-12-31',
      availableAt: '2025-03-29',
      scope: 'consolidated',
    })
    expect(asOfResult.data?.pitSafe).toBe(true)
    expect(missingResult.data?.periods[0]?.fields.operatingCashFlow).toEqual({
      status: 'missing',
      value: null,
    })
  })

  it('accepts core asOf for market bars and excludes later observations', async () => {
    const result = await fixtureProvider().marketBars({
      capability: 'market-bars',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      asOf: '2026-08-27T23:59:59+08:00',
      params: { startDate: '2026-08-27', endDate: '2026-08-28', adjustment: 'none', limit: 10 },
    })

    expect(result.data).toMatchObject({
      startDate: '2026-08-27',
      endDate: '2026-08-27',
      returned: 1,
      truncated: false,
    })
    expect(result.data?.bars.map(bar => bar.date)).toEqual(['2026-08-27'])
  })

  it.each([
    ['timezone-less timestamp', '2026-08-28T10:00:00'],
    ['24:00 timestamp', '2026-08-28T24:00:00+08:00'],
  ])('rejects a non-canonical %s asOf before execution', async (_scenario, asOf) => {
    await expect(fixtureProvider().marketBars({
      capability: 'market-bars',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      asOf,
      params: { startDate: '2026-08-27', endDate: '2026-08-28', adjustment: 'none', limit: 10 },
    })).rejects.toMatchObject({
      kind: 'invalid-request',
      code: 'invalid-request',
      retryable: false,
    })
  })

  it.each([
    ['early morning in Shanghai', '2026-08-27T17:00:00Z', ['2026-08-27']],
    ['one second before the Shanghai close', '2026-08-28T14:59:59+08:00', ['2026-08-27']],
    ['the Shanghai close', '2026-08-28T15:00:00+08:00', ['2026-08-27', '2026-08-28']],
    ['the same close instant expressed on the prior offset date', '2026-08-27T23:00:00-08:00', ['2026-08-27', '2026-08-28']],
  ] as const)('applies %s when exposing daily bars', async (_scenario, asOf, expectedDates) => {
    const result = await fixtureProvider().marketBars({
      capability: 'market-bars',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      asOf,
      params: { startDate: '2026-08-27', endDate: '2026-08-28', adjustment: 'none', limit: 10 },
    })

    expect(result.data).toMatchObject({
      startDate: '2026-08-27',
      endDate: expectedDates.at(-1),
      returned: expectedDates.length,
      truncated: false,
    })
    expect(result.data?.bars.map(bar => bar.date)).toEqual(expectedDates)
  })

  it('applies disclosure asOf at timestamp precision before pagination', async () => {
    const result = await fixtureProvider({
      fixtureRoot: join(fixtureRoot, 'disclosures-as-of'),
    }).disclosures({
      capability: 'disclosures',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      asOf: '2026-08-28T10:00:00+08:00',
      params: { startDate: '2026-08-27', endDate: '2026-08-29', limit: 3 },
    })

    expect(result.data).toMatchObject({ returned: 3, truncated: false })
    expect(result.data?.items.map(item => item.id)).toEqual([
      'at-cutoff',
      'same-day-before-cutoff',
      'prior-day',
    ])
  })

  it('returns disclosure document references, index constituents, and exchange calendars', async () => {
    const provider = fixtureProvider()
    const equity = normalizeAshareInstrument('600519.SH')
    const index = normalizeAshareInstrument('000300.SH', { assetType: 'index' })
    const disclosures = await provider.disclosures({
      capability: 'disclosures', market: 'CN', instrument: equity,
      params: { startDate: '2026-01-01', endDate: '2026-12-31', limit: 1 },
    })
    const constituents = await provider.indexData({
      capability: 'index', market: 'CN', instrument: index, params: { limit: 1 },
    })
    const calendar = await provider.tradingCalendar({
      capability: 'trading-calendar', market: 'CN',
      params: { exchange: 'SSE', startDate: '2026-08-27', endDate: '2026-08-30', limit: 10 },
    })

    expect(disclosures.data).toMatchObject({ returned: 1, truncated: true })
    expect(disclosures.data?.items[0]?.documentRef).toMatch(/^sse:\/\/disclosure\//u)
    expect(disclosures.data?.items[0]).not.toHaveProperty('body')
    expect(constituents.data).toMatchObject({ asOf: '2026-08-28', returned: 1, truncated: true })
    expect(constituents.data?.constituents[0]?.instrument.symbol).toBe('600519')
    expect(calendar.data).toMatchObject({ exchange: 'SSE', returned: 4, truncated: false })
    expect(calendar.data?.days.map(day => day.isTradingDay)).toEqual([true, true, false, false])
  })

  it('uses the Asia/Shanghai date of an offset asOf instant for the trading calendar', async () => {
    const result = await fixtureProvider().tradingCalendar({
      capability: 'trading-calendar',
      market: 'CN',
      asOf: '2026-08-27T17:00:00Z',
      params: { exchange: 'SSE', startDate: '2026-08-27', endDate: '2026-08-30', limit: 10 },
    })

    expect(result.data).toMatchObject({
      exchange: 'SSE',
      startDate: '2026-08-27',
      endDate: '2026-08-28',
      returned: 2,
      truncated: false,
    })
    expect(result.data?.days.map(day => day.date)).toEqual(['2026-08-27', '2026-08-28'])
  })
})

describe('AStockProvider process and safety boundaries', () => {
  it('runs fixtures with an allowlisted child environment and no ambient provider secrets', async () => {
    const injectedEnvironment = {
      ASTOCK_TEST_SECRET: 'fixture-secret-that-must-not-leak',
      OPENAI_API_KEY: 'fixture-secret-that-must-not-leak',
      ANTHROPIC_API_KEY: 'fixture-secret-that-must-not-leak',
      DEEPSEEK_API_KEY: 'fixture-secret-that-must-not-leak',
      LLM_API_KEY: 'fixture-secret-that-must-not-leak',
      NGFI_API_KEY: 'fixture-secret-that-must-not-leak',
      NGFI_LLM_BASE_URL: 'https://llm.invalid?token=fixture-secret-that-must-not-leak',
      TUSHARE_TOKEN: 'fixture-secret-that-must-not-leak',
      TUSHARE_MCP_URL: 'https://tushare.invalid?token=fixture-secret-that-must-not-leak',
      TDX_DATA_KEY: 'fixture-secret-that-must-not-leak',
      TDX_COMMUNITY_SERVERS: 'host.invalid:7709',
      IFIND_MCP_CREDENTIAL: 'fixture-secret-that-must-not-leak',
      IFIND_MCP_URL: 'https://ifind.invalid?token=fixture-secret-that-must-not-leak',
      IWENCAI_API_KEY: 'fixture-secret-that-must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret-that-must-not-leak',
      HTTPS_PROXY: 'https://proxy.invalid?token=fixture-secret-that-must-not-leak',
      PYTHONPATH: '/tmp/astock-python-injection',
      UV_CACHE_DIR: '/tmp/astock-untrusted-cache',
      UV_INDEX_URL: 'https://packages.invalid?token=fixture-secret-that-must-not-leak',
    } as const
    const environment: NodeJS.ProcessEnv = { ...process.env, ...injectedEnvironment }
    const provider = fixtureProvider({
      pythonRunner: join(fixtureRoot, 'runtime-security-runner.py'),
      environment,
    })
    const runtime = provider as unknown as {
      pythonArgs: readonly string[]
      runnerEnv: NodeJS.ProcessEnv
    }
    const inherited = [
      'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR',
    ].filter(key => environment[key] !== undefined)
    expect(Object.keys(runtime.runnerEnv).sort()).toEqual([
      ...inherited,
      'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'PYTHONUTF8',
      'UV_CACHE_DIR', 'UV_NO_CONFIG', 'UV_NO_ENV_FILE',
    ].sort())
    expect(runtime.runnerEnv.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(runtime.runnerEnv.UV_CACHE_DIR).toBe(join(projectRoot, '.uv-cache'))
    expect(runtime.pythonArgs).toEqual([
      'run', '--frozen', '--no-sync', '--no-python-downloads', '--no-env-file', '--no-config',
      '--project', projectRoot, 'python',
    ])

    const result = await provider.quote({
      capability: 'quote',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      params: {},
    })

    expect(result).toMatchObject({
      status: 'available',
      data: { instrument: { symbol: '600519' } },
    })
  })

  it('resolves a configured runner executable before later PATH changes', async () => {
    const provider = fixtureProvider({ pythonExecutable: 'python3' })
    const runtime = provider as unknown as {
      pythonExecutable: string
      runnerEnv: NodeJS.ProcessEnv
    }
    expect(isAbsolute(runtime.pythonExecutable)).toBe(true)
    runtime.runnerEnv.PATH = fixtureRoot

    await expect(provider.quote({
      capability: 'quote',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      params: {},
    })).resolves.toMatchObject({ status: 'available' })
  })

  it('rejects fixed-endpoint redirects and strips URL credentials from provenance', async () => {
    const provider = new AStockProvider({
      source: 'public-web',
      projectRoot,
      pythonRunner: join(fixtureRoot, 'runtime-security-runner.py'),
      minRequestIntervalMs: 0,
    })
    const result = await provider.indexData({
      capability: 'index',
      market: 'CN',
      instrument: normalizeAshareInstrument('000300.SH', { assetType: 'index' }),
      params: { officialProvider: 'csi', limit: 1 },
    })

    expect(result.provenance.sourceUrl).toBe(
      'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/000300cons.xls',
    )
    expect(JSON.stringify(result)).not.toContain('fixture-secret-that-must-not-leak')
  })

  it('does not surface hostile runner diagnostics or URL tokens', async () => {
    const provider = fixtureProvider({ pythonRunner: join(fixtureRoot, 'diagnostic-runner.py') })
    let thrown: unknown
    try {
      await provider.quote({
        capability: 'quote',
        market: 'CN',
        instrument: normalizeAshareInstrument('600519.SH'),
        params: {},
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('runner emitted diagnostics')
    expect(message).not.toMatch(/fixture-secret|astock-diagnostic|attacker\.invalid|Authorization|Cookie/u)
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  it('routes an unadjusted fixture quote through the production A-share composition', async () => {
    const composition = createDefaultAshareDataComposition({
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        TMPDIR: process.env.TMPDIR,
      },
      projectRoot,
      astock: {
        source: 'fixture',
        fixtureRoot,
        projectRoot,
        minRequestIntervalMs: 0,
      },
      cne6: { dataRoot: join(projectRoot, 'tests/fixtures/cne6-local/unavailable') },
    })
    try {
      const result = await composition.service.execute({
        capability: 'quote',
        market: 'CN',
        instrument: normalizeAshareInstrument('600519.SH'),
        params: {},
      }, { provider: 'a-stock-public' })

      expect(result).toMatchObject({
        status: 'available',
        provenance: {
          provider: 'a-stock-public',
          actualProvider: 'a-stock-public',
          adjustment: 'none',
        },
      })
    } finally {
      await composition.close()
    }
  })

  it('enforces operation fields, date spans, record counts, and input bytes before spawning', async () => {
    const provider = fixtureProvider({ maxDateSpanDays: 31, maxRecords: 2 })
    const id = normalizeAshareInstrument('600519.SH')

    await expect(provider.execute({
      capability: 'quote', market: 'CN', instrument: id, params: { url: 'https://example.invalid' },
    })).rejects.toMatchObject({ kind: 'invalid-request', code: 'invalid-request', retryable: false })
    await expect(provider.marketBars({
      capability: 'market-bars', market: 'CN', instrument: id,
      params: { startDate: '2026-01-01', endDate: '2026-03-01', limit: 2 },
    })).rejects.toMatchObject({ kind: 'invalid-request', code: 'invalid-request' })
    await expect(provider.marketBars({
      capability: 'market-bars', market: 'CN', instrument: id,
      params: { startDate: '2026-08-27', endDate: '2026-08-28', limit: 3 },
    })).rejects.toThrow(/limit must be an integer from 1 through 2/u)
    await expect(fixtureProvider({ maxInputBytes: 64 }).quote({
      capability: 'quote', market: 'CN', instrument: id, params: {},
    })).rejects.toMatchObject({ code: 'input-limit', retryable: false })
  })

  it('enforces output bytes and classifies no-data separately from provider failure', async () => {
    const id = normalizeAshareInstrument('600519.SH')
    await expect(fixtureProvider({ maxOutputBytes: 256 }).quote({
      capability: 'quote', market: 'CN', instrument: id, params: {},
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'output-limit', retryable: false })

    await expect(fixtureProvider().quote({
      capability: 'quote', market: 'CN',
      instrument: { market: 'CN', exchange: 'SSE', symbol: '601999', assetType: 'equity' },
      params: {},
    })).rejects.toMatchObject({ kind: 'no-data', code: 'no-data', retryable: false })
  })

  it('cancels an active process and terminates a timed-out process', async () => {
    const slowRunner = join(fixtureRoot, 'slow-runner.py')
    const id = normalizeAshareInstrument('600519.SH')
    const controller = new AbortController()
    const cancelProvider = fixtureProvider({ pythonRunner: slowRunner, timeoutMs: 5_000, killGraceMs: 50 })
    const pending = cancelProvider.quote({
      capability: 'quote', market: 'CN', instrument: id, params: {}, signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 25)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', code: 'aborted', retryable: false })

    const timeoutProvider = fixtureProvider({ pythonRunner: slowRunner, timeoutMs: 25, killGraceMs: 50 })
    await expect(timeoutProvider.quote({
      capability: 'quote', market: 'CN', instrument: id, params: {},
    })).rejects.toMatchObject({ kind: 'timeout', code: 'timeout', retryable: true })
  })

  it('terminates the runner before settling a stdin write failure', async () => {
    const source = await readFile(
      join(projectRoot, 'packages/finance-provider-astock/src/provider.ts'),
      'utf8',
    )
    expect(source).toMatch(
      /child\.stdin\.on\('error', \(\) => \{\s*terminate\(\)\s*finish\(providerError\(/u,
    )
  })

  it('propagates request-level timeout and response limits to generated official requests', async () => {
    const provider = new AStockProvider({
      source: 'public-web',
      projectRoot,
      pythonRunner: join(fixtureRoot, 'official-limits-runner.py'),
      minRequestIntervalMs: 0,
      networkTimeoutMs: 137,
      maxOutputBytes: 4096,
    })
    await expect(provider.indexData({
      capability: 'index', market: 'CN',
      instrument: normalizeAshareInstrument('000300.SH', { assetType: 'index' }),
      params: { officialProvider: 'csi', limit: 1 },
    })).resolves.toMatchObject({ status: 'available' })
  })

  it('rejects malformed NDJSON and fails closed on recorded and public source schema drift', async () => {
    const id = normalizeAshareInstrument('600519.SH')
    await expect(fixtureProvider({ pythonRunner: join(fixtureRoot, 'malformed-runner.py') }).quote({
      capability: 'quote', market: 'CN', instrument: id, params: {},
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'protocol-error', retryable: false })

    await expect(fixtureProvider({ fixtureRoot: join(fixtureRoot, 'schema-drift') }).quote({
      capability: 'quote', market: 'CN', instrument: id, params: {},
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'fixture-schema', retryable: false })

    const publicProvider = new AStockProvider({
      source: 'public-web', projectRoot, pythonRunner: join(fixtureRoot, 'public-schema-runner.py'),
      minRequestIntervalMs: 0,
    })
    await expect(publicProvider.quote({
      capability: 'quote', market: 'CN', instrument: id, params: {},
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'schema-drift', retryable: false })
    await expect(publicProvider.fundamentalsV2({
      capability: 'fundamentals', market: 'CN', instrument: id, params: { limit: 1 },
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'schema-drift', retryable: false })
    await expect(publicProvider.disclosures({
      capability: 'disclosures', market: 'CN', instrument: id,
      params: { startDate: '2026-01-01', endDate: '2026-12-31', limit: 1 },
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'schema-drift', retryable: false })
    await expect(publicProvider.indexData({
      capability: 'index', market: 'CN',
      instrument: normalizeAshareInstrument('000300.SH', { assetType: 'index' }),
      params: { officialProvider: 'csi', limit: 1 },
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'schema-drift', retryable: false })
    await expect(publicProvider.tradingCalendar({
      capability: 'trading-calendar', market: 'CN',
      params: { exchange: 'SSE', startDate: '2026-08-28', endDate: '2026-08-28', limit: 1 },
    })).rejects.toMatchObject({ kind: 'schema-drift', code: 'schema-drift', retryable: false })
  })

  it('rejects malformed nested canonical data from an otherwise valid subprocess envelope', async () => {
    const provider = fixtureProvider({
      pythonRunner: join(fixtureRoot, 'nested-canonical-schema-runner.py'),
    })

    await expect(provider.quote({
      capability: 'quote',
      market: 'CN',
      instrument: normalizeAshareInstrument('600519.SH'),
      params: {},
    })).rejects.toMatchObject({
      kind: 'schema-drift',
      code: 'protocol-error',
      retryable: false,
    })
  })

  it('maps real public source contracts for fundamentals, disclosures, official index, and calendar', async () => {
    const provider = new AStockProvider({
      source: 'public-web',
      projectRoot,
      pythonRunner: join(fixtureRoot, 'public-contract-runner.py'),
      pythonExecutable: join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      pythonArgs: [],
      minRequestIntervalMs: 0,
    })
    const equity = normalizeAshareInstrument('600519.SH')
    const index = normalizeAshareInstrument('000300.SH', { assetType: 'index' })
    const quote = await provider.quote({
      capability: 'quote', market: 'CN', instrument: equity, params: {},
    })
    const fundamentals = await provider.fundamentalsV2({
      capability: 'fundamentals', market: 'CN', instrument: equity,
      asOf: '2026-04-01', params: { statement: 'income', limit: 2 },
    })
    const disclosures = await provider.disclosures({
      capability: 'disclosures', market: 'CN', instrument: equity,
      params: { startDate: '2026-01-01', endDate: '2026-12-31', limit: 2 },
    })
    const constituents = await provider.indexData({
      capability: 'index', market: 'CN', instrument: index,
      params: { officialProvider: 'csi', limit: 2 },
    })
    const calendar = await provider.tradingCalendar({
      capability: 'trading-calendar', market: 'CN',
      params: { exchange: 'SSE', startDate: '2026-08-28', endDate: '2026-08-28', limit: 2 },
    })

    expect(quote.data).toMatchObject({
      tradingDate: '2026-08-28',
      observedAt: '2026-08-27T17:00:00Z',
    })
    expect(quote.provenance).toMatchObject({
      upstreamSource: 'eastmoney-public-web',
      adjustment: 'none',
    })
    expect(fundamentals.data).toMatchObject({ returned: 1, pitSafe: true })
    expect(fundamentals.data?.periods[0]).toMatchObject({
      fiscalPeriod: '2025-12-31',
      publishedAt: '2026-03-30',
      fields: { '营业收入': { status: 'available', value: 181200000000 } },
    })
    expect(fundamentals.provenance.upstreamSource).toBe('sina-public-web-finance')
    expect(disclosures.data?.items[0]).toMatchObject({ id: 'official-001', category: '年度报告' })
    expect(disclosures.provenance.upstreamSource).toBe('cninfo-public-disclosures')
    expect(constituents.data).toMatchObject({ asOf: '2026-08-28', returned: 1 })
    expect(constituents.data?.constituents[0]?.instrument).toMatchObject({ symbol: '600519', exchange: 'SSE' })
    expect(constituents.provenance).toMatchObject({ upstreamSource: 'csi-official-index', sourceKind: 'official' })
    expect(calendar.data).toMatchObject({ exchange: 'SSE', returned: 1 })
    expect(calendar.provenance).toMatchObject({ upstreamSource: 'szse-official-calendar', sourceKind: 'official' })
  })

  it('uses versioned one-response-per-request NDJSON and rejects non-whitelisted calls', () => {
    const limits = { maxRecords: 10, maxDateSpanDays: 31, maxOutputBytes: 4096, networkTimeoutMs: 1000 }
    const input = [
      { version: '2', id: 'wrong-version', operation: 'quote', source: 'public-web', params: {}, limits },
      { version: '1', id: 'unknown-op', operation: 'python-eval', source: 'public-web', params: {}, limits },
      { version: '1', id: 'arbitrary-url', operation: 'quote', source: 'public-web', params: { url: 'https://example.invalid' }, limits },
    ].map(value => JSON.stringify(value)).join('\n') + '\n'
    const child = spawnSync('python3', [pythonRunner], { cwd: projectRoot, input, encoding: 'utf8' })
    const responses = child.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line) as Record<string, unknown>)

    expect(responses).toHaveLength(3)
    expect(responses[0]).toMatchObject({ version: '1', id: 'wrong-version', ok: false, error: { code: 'invalid-request' } })
    expect(responses[1]).toMatchObject({ version: '1', id: 'unknown-op', ok: false, error: { code: 'unsupported-operation' } })
    expect(responses[2]).toMatchObject({ version: '1', id: 'arbitrary-url', ok: false, error: { code: 'invalid-request' } })
    expect(child.stderr).toBe('')
  })

  it('rejects an oversized NDJSON request at the runner boundary', () => {
    const oversized = `${JSON.stringify({ id: 'oversized', padding: 'x'.repeat(300_000) })}\n`
    const child = spawnSync('python3', [pythonRunner], { cwd: projectRoot, input: oversized, encoding: 'utf8' })
    const response = JSON.parse(child.stdout) as { error: { code: string }; ok: boolean }
    expect(response).toMatchObject({ ok: false, error: { code: 'input-limit' } })
  })

  it('keeps fixture metadata free of credentials and validates every fixture envelope', async () => {
    const names = [
      'instrument-reference.json', 'quote.json', 'market-bars.json', 'fundamentals.json',
      'disclosures.json', 'index.json', 'trading-calendar.json',
    ]
    for (const name of names) {
      const raw = await readFile(join(fixtureRoot, name), 'utf8')
      expect(raw).not.toMatch(/authorization|cookie|api[_-]?key|token/i)
      expect(JSON.parse(raw)).toMatchObject({
        schemaVersion: 'ngfi-a-stock-fixture-1',
        capturedAt: '2026-08-28T08:00:00Z',
      })
    }
  })
})
