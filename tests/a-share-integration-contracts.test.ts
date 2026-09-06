import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CapabilityRequest, CanonicalDataResult } from '@finance2dsh/core'
import { FinanceDataService } from '../packages/finance-data-service/src/index.js'
import { createAStockProviderRegistration } from '../packages/finance-provider-astock/src/index.js'
import {
  createDefaultAshareDataComposition,
} from '../packages/dsh-finance-tools/src/ashare-composition.js'
import { createAshareFinanceTools } from '../packages/dsh-finance-tools/src/ashare-tools.js'

const exec = { signal: new AbortController().signal } as ToolRunContext
const canonical = 'CN:SSE:600519:EQUITY'
const fixtureRoot = join(process.cwd(), 'tests/fixtures/a-stock-data')

function tool(name: string, execute: (request: CapabilityRequest) => Promise<CanonicalDataResult<unknown>>) {
  const tools = createAshareFinanceTools({
    service: { execute: execute as never },
    approvedProviderIds: ['a-stock-public'],
    catalog: async () => [],
  })
  const selected = tools.find(candidate => candidate.name === name)
  expect(selected).toBeDefined()
  return selected!
}

describe('curated A-share tool contracts', () => {
  it('advertises only intervals implemented by the default public bars route', () => {
    const selected = tool('finance_cn_bars', async () => { throw new Error('not used') })
    const properties = selected.parameters.properties as Record<string, unknown>
    expect(properties.interval).toMatchObject({ enum: ['1d'] })
  })

  it('maps an as-of quote to a stable quote snapshot with historical provenance', async () => {
    let captured: CapabilityRequest | undefined
    const selected = tool('finance_cn_quote', async request => {
      captured = request
      return {
        status: 'available',
        data: {
          instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
          interval: '1d',
          adjustment: 'none',
          bars: [{
            date: '2026-09-04',
            open: 1400,
            high: 1420,
            low: 1390,
            close: 1410,
            preClose: 1400,
            volume: 10_000,
            turnover: 14_100_000,
          }],
          returned: 1,
          truncated: false,
        },
        provenance: {
          provider: 'a-stock-public',
          actualProvider: 'a-stock-public',
          upstreamSource: 'fixture',
          sourceKind: 'user',
          fetchedAt: '2026-09-05T00:00:00Z',
          observedAt: '2026-09-04',
          adjustment: 'none',
          fallbackChain: [],
        },
        warnings: [],
      }
    })

    const result = await selected.execute({ instrument: canonical, as_of: '2026-09-04' }, exec) as {
      data: Record<string, unknown>
      provenance: Record<string, unknown>
      warnings: string[]
    }
    expect(captured).toMatchObject({
      capability: 'market-bars',
      asOf: '2026-09-04',
      params: {
        startDate: '2026-09-04',
        endDate: '2026-09-04',
        interval: '1d',
        adjustment: 'none',
        limit: 1,
      },
    })
    expect(result.data).toMatchObject({
      instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      tradingDate: '2026-09-04',
      observedAt: '2026-09-04',
      currency: 'CNY',
      fields: {
        name: { status: 'missing', value: null },
        open: { status: 'available', value: 1400 },
        high: { status: 'available', value: 1420 },
        low: { status: 'available', value: 1390 },
        last: { status: 'available', value: 1410 },
        previousClose: { status: 'available', value: 1400 },
        volume: { status: 'available', value: 10_000 },
        turnover: { status: 'available', value: 14_100_000 },
      },
    })
    expect(result.data).not.toHaveProperty('bars')
    expect(result.provenance).toMatchObject({
      actualProvider: 'a-stock-public',
      observedAt: '2026-09-04',
      adjustment: 'none',
      derived: { algorithm: 'daily-bar-to-quote-snapshot', algorithmVersion: '1' },
    })
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/historical.*daily bar/i)]))
  })

  it('fails closed when a successful bars provider returns an incompatible payload', async () => {
    const selected = tool('finance_cn_quote', async () => ({
      status: 'available',
      data: { dataset: 'prices', rows: [{ date: '2026-09-04', close: 1410 }] },
      provenance: {
        provider: 'a-stock-public', actualProvider: 'a-stock-public',
        upstreamSource: 'fixture', sourceKind: 'user', fetchedAt: '2026-09-05T00:00:00Z',
        adjustment: 'none', fallbackChain: [],
      },
      warnings: [],
    }))

    await expect(selected.execute({ instrument: canonical, as_of: '2026-09-04' }, exec))
      .rejects.toMatchObject({ kind: 'schema-drift', retryable: false })
  })

  it('normalizes a current provider quote to the same stable quote shape', async () => {
    const selected = tool('finance_cn_quote', async request => ({
      status: 'available',
      data: {
        instrument: request.instrument,
        providerSymbol: '600519',
        observedAt: '2026-09-04T07:00:00+08:00',
        lastPrice: 1410,
        previousClose: 1400,
        open: 1402,
        high: 1420,
        low: 1390,
        volume: 10_000,
        amount: 14_100_000,
        bid1: 1409,
        ask1: 1411,
      },
      provenance: {
        provider: 'tdx-community',
        actualProvider: 'tdx-community',
        upstreamSource: 'tdx-community',
        sourceKind: 'community',
        fetchedAt: '2026-09-04T07:00:01Z',
        observedAt: '2026-09-04T07:00:00+08:00',
        currency: 'CNY',
        fallbackChain: [],
      },
      warnings: [],
    }))

    const result = await selected.execute({ instrument: canonical }, exec) as { data: Record<string, unknown> }
    expect(result.data).toMatchObject({
      tradingDate: '2026-09-04',
      observedAt: '2026-09-04T07:00:00+08:00',
      currency: 'CNY',
      fields: {
        name: { status: 'missing', value: null },
        last: { status: 'available', value: 1410 },
        previousClose: { status: 'available', value: 1400 },
        turnover: { status: 'available', value: 14_100_000 },
      },
    })
    expect(result.data).not.toHaveProperty('lastPrice')
  })

  it('supports a requested fiscal period through the default public fundamentals route', async () => {
    const service = new FinanceDataService().register(createAStockProviderRegistration({
      source: 'fixture',
      fixtureRoot,
      projectRoot: process.cwd(),
      pythonExecutable: 'python3',
      pythonArgs: [],
      minRequestIntervalMs: 0,
    }))
    const selected = createAshareFinanceTools({
      service,
      approvedProviderIds: ['a-stock-public'],
      catalog: async () => [],
    }).find(candidate => candidate.name === 'finance_cn_fundamentals')
    expect(selected).toBeDefined()

    const result = await selected!.execute({
      instrument: canonical,
      report_period: '2025-12-31',
      as_of: '2026-04-01',
      source: 'a-stock-public',
    }, exec) as { status: string; data: { periods: Array<{ fiscalPeriod: string }> } }
    expect(result.status).toBe('available')
    expect(result.data.periods.map(period => period.fiscalPeriod)).toEqual(['2025-12-31'])
  })

  it('fetches enough public fundamentals before filtering an older fiscal period and aligns provenance', async () => {
    let captured: CapabilityRequest | undefined
    const periods = [
      { fiscalPeriod: '2025-12-31', publishedAt: '2026-03-30', availableAt: '2026-03-30' },
      { fiscalPeriod: '2010-12-31', publishedAt: '2011-03-30', availableAt: '2011-03-30' },
    ]
    const selected = tool('finance_cn_fundamentals', async request => {
      captured = request
      const requestedLimit = (request.params as { limit: number }).limit
      const returned = periods.slice(0, requestedLimit)
      return {
        status: 'available',
        data: { periods: returned, returned: returned.length, truncated: returned.length < periods.length },
        provenance: {
          provider: 'a-stock-public',
          actualProvider: 'a-stock-public',
          upstreamSource: 'fixture',
          sourceKind: 'user',
          fetchedAt: '2026-09-05T00:00:00Z',
          fiscalPeriod: '2025-12-31',
          publishedAt: '2026-03-30',
          availableAt: '2026-03-30',
          fallbackChain: [],
        },
        warnings: [],
      }
    })

    const result = await selected.execute({
      instrument: canonical,
      report_period: '2010-12-31',
      limit: 1,
      source: 'a-stock-public',
    }, exec) as {
      status: string
      data: { periods: Array<{ fiscalPeriod: string }>; returned: number }
      provenance: Record<string, unknown>
    }

    expect(captured?.params).toMatchObject({ limit: 1_000 })
    expect(captured?.params).not.toHaveProperty('period')
    expect(result.status).toBe('available')
    expect(result.data).toMatchObject({ returned: 1, periods: [{ fiscalPeriod: '2010-12-31' }] })
    expect(result.provenance).toMatchObject({
      fiscalPeriod: '2010-12-31',
      publishedAt: '2011-03-30',
      availableAt: '2011-03-30',
    })
  })

  it('pushes fiscal period and range filters into a TuShare request before truncation', async () => {
    let captured: CapabilityRequest | undefined
    const tools = createAshareFinanceTools({
      service: {
        execute: (async (request: CapabilityRequest) => {
          captured = request
          return {
            status: 'available',
            data: {
              periods: [{
                fiscalPeriod: '2010-12-31',
                announcedAt: '2011-03-30',
                availableAt: '2011-03-30',
              }],
            },
            provenance: {
              provider: 'tushare-mcp',
              actualProvider: 'tushare-mcp',
              upstreamSource: 'https://example.invalid/mcp',
              sourceKind: 'official',
              fetchedAt: '2026-09-05T00:00:00Z',
              fiscalPeriod: '2010-12-31',
              availableAt: '2011-03-30',
              fallbackChain: [],
            },
            warnings: [],
          }
        }) as never,
      },
      approvedProviderIds: ['tushare-mcp'],
      catalog: async () => [],
    })
    const selected = tools.find(candidate => candidate.name === 'finance_cn_fundamentals')
    expect(selected).toBeDefined()

    await selected!.execute({
      instrument: canonical,
      report_period: '2010-12-31',
      start_date: '2010-01-01',
      end_date: '2010-12-31',
      limit: 1,
      source: 'tushare-mcp',
    }, exec)

    expect(captured?.params).toEqual({
      period: '2010-12-31',
      startDate: '2010-01-01',
      endDate: '2010-12-31',
      limit: 1,
    })
  })

  it.each([
    ['finance_cn_fundamentals', { instrument: canonical, dataset: 'corporate-actions' }],
    ['finance_cn_disclosures', {
      instrument: canonical, document_type: 'research-consensus',
      start_date: '2026-09-01', end_date: '2026-09-04',
    }],
    ['finance_cn_market_activity', { instrument: canonical, capability: 'capital-flow' }],
    ['finance_cn_macro_index', { capability: 'macro' }],
  ])('returns canonical unsupported for unavailable long-tail surface %s', async (name, args) => {
    const selected = tool(name, async () => { throw new Error('must not call provider') })
    await expect(selected.execute(args, exec)).rejects.toMatchObject({
      kind: 'unsupported',
      retryable: false,
    })
  })

  it('rejects pagination beyond the first page until providers expose a canonical cursor', async () => {
    const selected = tool('finance_cn_bars', async () => { throw new Error('must not call provider') })
    await expect(selected.execute({
      instrument: canonical,
      start_date: '2026-09-01',
      end_date: '2026-09-04',
      adjustment: 'none',
      page: 2,
    }, exec)).rejects.toThrow(/page values above 1/)
  })

  it('accepts page one without leaking provider-specific pagination', async () => {
    let captured: CapabilityRequest | undefined
    const selected = tool('finance_cn_bars', async request => {
      captured = request
      return {
        status: 'no-data',
        data: null,
        provenance: {
          provider: 'a-stock-public', actualProvider: 'a-stock-public',
          upstreamSource: 'fixture', sourceKind: 'user', fetchedAt: '2026-09-05T00:00:00Z', fallbackChain: [],
        },
        warnings: [],
      }
    })
    await selected.execute({
      instrument: canonical, start_date: '2026-09-01', end_date: '2026-09-04',
      adjustment: 'none', page: 1,
    }, exec)
    expect(captured?.params).not.toHaveProperty('page')
  })
})

describe('optional provider composition', () => {
  it('keeps public data available when optional provider configuration is malformed', async () => {
    const composition = createDefaultAshareDataComposition({
      env: { TDX_COMMUNITY_SERVERS: 'https://not-a-host-port' },
      cne6: { dataRoot: join(process.cwd(), 'packages/combinatorial-optimization/data/staging') },
    })
    try {
      const catalog = await composition.catalog()
      expect(catalog.find(entry => entry.providerId === 'a-stock-public')).toMatchObject({
        routable: true,
      })
      expect(catalog.find(entry => entry.providerId === 'tdx-community')).toMatchObject({
        routable: false,
        health: { status: 'unavailable' },
      })
      expect(catalog.find(entry => entry.providerId === 'cne6-local')).toMatchObject({
        routable: false,
        health: { status: 'unavailable' },
      })
    } finally {
      await composition.close()
    }
  })

  it('keeps public data routable when optional TuShare configuration is invalid', async () => {
    const composition = createDefaultAshareDataComposition({
      env: { TUSHARE_MCP_URL: 'https://unapproved.example.invalid/mcp' },
      astock: {
        source: 'fixture', fixtureRoot, projectRoot: process.cwd(),
        pythonExecutable: 'python3', pythonArgs: [], minRequestIntervalMs: 0,
      },
      cne6: { dataRoot: join(process.cwd(), 'packages/combinatorial-optimization/data/staging') },
    })
    try {
      const catalog = await composition.catalog()
      expect(catalog.find(entry => entry.providerId === 'tushare-mcp')).toMatchObject({
        routable: false,
        health: { status: 'unavailable' },
      })
      const result = await composition.service.execute({
        capability: 'instrument-reference',
        market: 'CN',
        instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
      })
      expect(result).toMatchObject({
        status: 'available',
        provenance: { actualProvider: 'a-stock-public' },
      })
    } finally {
      await composition.close()
    }
  })
})

describe('CNE6 tool-level canonical contracts', () => {
  const cne6ProjectRoot = resolve(process.cwd(), 'packages/combinatorial-optimization')
  const fixtureMaker = resolve(process.cwd(), 'tests/fixtures/cne6-local/make_fixture.py')
  let temporaryRoot: string
  let cne6FixtureRoot: string

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'cne6-tool-contract-'))
    cne6FixtureRoot = join(temporaryRoot, 'published')
    execFileSync('uv', [
      'run', '--project', cne6ProjectRoot, 'python', fixtureMaker, cne6FixtureRoot, '--no-partial',
    ], { cwd: process.cwd(), stdio: 'pipe' })
  })

  afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  function composition() {
    return createDefaultAshareDataComposition({
      env: { CNE6_DATA_ROOT: cne6FixtureRoot },
      projectRoot: process.cwd(),
      cne6: { projectRoot: cne6ProjectRoot },
    })
  }

  it('derives a non-null historical quote from canonical CNE6 daily bars', async () => {
    const backend = composition()
    try {
      const selected = createAshareFinanceTools(backend)
        .find(candidate => candidate.name === 'finance_cn_quote')
      expect(selected).toBeDefined()

      const result = await selected!.execute({
        instrument: canonical,
        as_of: '2026-01-05',
        source: 'cne6-local',
      }, exec) as {
        status: string
        data: null | { tradingDate: string; observedAt: string; fields: Record<string, unknown> }
        provenance: Record<string, unknown>
      }

      expect(result.status).toBe('available')
      expect(result.data).not.toBeNull()
      expect(result.data).toMatchObject({
        tradingDate: '2026-01-05',
        observedAt: expect.stringContaining('T'),
        fields: {
          open: { status: 'available', value: 101 },
          last: { status: 'available', value: 102 },
          previousClose: { status: 'available', value: 101 },
          volume: { status: 'available', value: 11 },
          turnover: { status: 'available', value: 1100 },
        },
      })
      expect(result.provenance).toMatchObject({
        actualProvider: 'cne6-local',
        observedAt: expect.stringContaining('T'),
        adjustment: 'none',
        unit: 'price:CNY;volume:share;turnover:CNY',
      })
      expect(Date.parse(result.data?.observedAt ?? '')).toBe(
        Date.parse('2026-01-05T15:00:00+08:00'),
      )
      expect(Date.parse(String(result.provenance.observedAt ?? ''))).toBe(
        Date.parse('2026-01-05T15:00:00+08:00'),
      )

      const missing = await selected!.execute({
        instrument: canonical,
        as_of: '2026-01-03',
        source: 'cne6-local',
      }, exec) as { status: string; data: unknown }
      expect(missing).toMatchObject({ status: 'no-data', data: null })
    } finally {
      await backend.close()
    }
  })

  it('uses Shanghai close visibility and offset conversion for historical quotes', async () => {
    const backend = composition()
    try {
      const selected = createAshareFinanceTools(backend)
        .find(candidate => candidate.name === 'finance_cn_quote')
      expect(selected).toBeDefined()

      const beforeClose = await selected!.execute({
        instrument: canonical,
        as_of: '2026-01-05T14:59:59+08:00',
        source: 'cne6-local',
      }, exec) as { status: string; data: unknown }
      expect(beforeClose).toMatchObject({ status: 'no-data', data: null })

      const atCloseFromPriorOffsetDate = await selected!.execute({
        instrument: canonical,
        as_of: '2026-01-04T23:00:00-08:00',
        source: 'cne6-local',
      }, exec) as {
        status: string
        data: null | { tradingDate: string; fields: Record<string, unknown> }
        provenance: Record<string, unknown>
      }
      expect(atCloseFromPriorOffsetDate).toMatchObject({
        status: 'available',
        data: {
          tradingDate: '2026-01-05',
          fields: { previousClose: { status: 'available', value: 101 } },
        },
        provenance: {
          actualProvider: 'cne6-local',
          unit: 'price:CNY;volume:share;turnover:CNY',
        },
      })
      expect(Date.parse(String(atCloseFromPriorOffsetDate.provenance.observedAt ?? ''))).toBe(
        Date.parse('2026-01-05T15:00:00+08:00'),
      )
    } finally {
      await backend.close()
    }
  })

  it('returns canonical CNE6 fundamental periods without leaking parquet rows', async () => {
    const backend = composition()
    try {
      const selected = createAshareFinanceTools(backend)
        .find(candidate => candidate.name === 'finance_cn_fundamentals')
      expect(selected).toBeDefined()

      const result = await selected!.execute({
        instrument: canonical,
        report_period: '2024-12-31',
        as_of: '2025-12-31',
        source: 'cne6-local',
      }, exec) as {
        status: string
        data: null | { periods: Array<Record<string, unknown>>; returned: number }
        provenance: Record<string, unknown>
      }

      expect(result.status).toBe('available')
      expect(result.data).not.toBeNull()
      expect(result.data).not.toHaveProperty('rows')
      expect(result.data).toMatchObject({
        returned: 1,
        periods: [{
          fiscalPeriod: '2024-12-31',
          publishedAt: null,
          availableAt: '2025-04-01',
          currency: 'CNY',
          unit: null,
          scope: null,
          fields: {
            revenue: { status: 'available', value: 100 },
            preferredEquity: { status: 'missing', value: null },
          },
        }],
      })
      expect(result.provenance).toMatchObject({
        actualProvider: 'cne6-local',
        fiscalPeriod: '2024-12-31',
        availableAt: '2025-04-01',
      })
    } finally {
      await backend.close()
    }
  })

  it('does not advertise the CNE6 benchmark series as canonical index data', async () => {
    const backend = composition()
    try {
      const entry = (await backend.catalog()).find(candidate => candidate.providerId === 'cne6-local')
      expect(entry).toBeDefined()
      expect(entry?.capabilities).not.toContain('index')

      const selected = createAshareFinanceTools(backend)
        .find(candidate => candidate.name === 'finance_cn_macro_index')
      expect(selected).toBeDefined()
      await expect(selected!.execute({
        capability: 'index',
        instrument: 'CN:SSE:000300:INDEX',
        source: 'cne6-local',
      }, exec)).rejects.toMatchObject({ kind: 'unsupported', retryable: false })
    } finally {
      await backend.close()
    }
  })
})

describe('repository command wiring', () => {
  it('invokes the explicit upstream sync command and points live scripts at existing files', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts['data:upstream:sync']).toMatch(/sync(?:\s|$)/u)
    for (const name of ['test:live:tdx', 'test:live:ifind', 'test:live:matrix']) {
      const match = /tests\/([^ ]+\.live\.test\.ts)/u.exec(manifest.scripts[name] ?? '')
      expect(match, `${name} should name a live test file`).not.toBeNull()
      expect(existsSync(join(process.cwd(), 'tests', match?.[1] ?? 'missing'))).toBe(true)
    }
  })
})
