import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { FINANCE_TOOL_ALLOWLIST } from '../packages/dsh-finance-bundle/src/policy.js'
import {
  FinanceDataError,
  type CanonicalDataResult,
  type InstrumentReferenceV2,
} from '@finance2dsh/core'
import {
  FinanceDataService,
  type CapabilityAdapter,
} from '../packages/finance-data-service/src/index.js'
import {
  createAStockProviderRegistration,
  type AStockBars,
  type AStockDisclosures,
  type AStockFundamentals,
  type AStockTradingCalendar,
} from '../packages/finance-data-service/src/providers/astock/index.js'

const skillRoot = join(process.cwd(), 'skills/a-share-data-research')
const fixtureRoot = join(process.cwd(), 'tests/fixtures/a-stock-data')
const toolNames = [
  'finance_data_catalog',
  'finance_cn_instrument',
  'finance_cn_quote',
  'finance_cn_bars',
  'finance_cn_fundamentals',
  'finance_cn_disclosures',
  'finance_cn_market_activity',
  'finance_cn_macro_index',
] as const
const referenceNames = ['capability-routing', 'source-policy'] as const

interface SkillEval {
  id: number
  prompt: string
  expected_output: string
  files: string[]
  expectations: string[]
}

function fixtureDataService(): FinanceDataService {
  return new FinanceDataService().register(createAStockProviderRegistration({
    source: 'fixture',
    fixtureRoot,
    projectRoot: process.cwd(),
    pythonExecutable: 'python3',
    pythonArgs: [],
    minRequestIntervalMs: 0,
  }))
}

describe('A-share data research skill', () => {
  it('has valid discoverable frontmatter and stays a thin entrypoint', async () => {
    const content = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(content)
    expect(match).not.toBeNull()
    const frontmatter = parse(match?.[1] ?? '') as { name: string; description: string }
    expect(frontmatter.name).toBe('a-share-data-research')
    expect(frontmatter.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    expect(frontmatter.description.length).toBeGreaterThan(80)
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024)
    expect(frontmatter.description).toMatch(/A 股|沪深北/u)
    expect(content.split(/\r?\n/u).length).toBeLessThan(120)
  })

  it('routes only through all eight curated tools after instrument normalization', async () => {
    const content = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    for (const tool of toolNames) expect(content).toContain('`' + tool + '`')
    const documentedTools = [...content.matchAll(/`(finance_(?:data|cn)_[a-z_]+)`/gu)]
      .map(match => match[1])
    expect(new Set(documentedTools)).toEqual(new Set(toolNames))
    expect(content.indexOf('finance_cn_instrument')).toBeLessThan(content.indexOf('finance_cn_quote'))
    expect(content).toContain('先规范化证券')
    expect(content).not.toMatch(/raw[_ -]?mcp|通用任意/u)
  })

  it('keeps every documented curated tool in the runtime allowlist', () => {
    const allowed = new Set<string>(FINANCE_TOOL_ALLOWLIST)
    for (const tool of toolNames) expect(allowed.has(tool), `${tool} must be allowlisted`).toBe(true)
  })

  it('links the two detailed references and preserves research discipline', async () => {
    const content = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    for (const reference of referenceNames) {
      expect(content).toContain(`references/${reference}.md`)
      await expect(access(join(skillRoot, 'references', reference + '.md'))).resolves.toBeUndefined()
    }
    const references = await Promise.all(referenceNames.map(name =>
      readFile(join(skillRoot, 'references', name + '.md'), 'utf8')))
    const corpus = [content, ...references].join('\n')
    for (const required of [
      'official', 'licensed', 'community', 'public-web', 'Asia/Shanghai',
      'qfq', 'hfq', '币种', '单位', '报告期', '公告日', 'available_date',
      'fallback', 'requestedProvider', 'actualProvider', 'provenance', 'insufficient-points',
    ]) expect(corpus).toContain(required)
    expect(corpus).toContain('不静默平均')
    expect(corpus).toContain('不能据此证明个体心理状态')
    expect(corpus).toContain('不提供个性化投资建议')
    expect(corpus).toContain('insufficient-permission')
  })

  it('contains no credentials, credential-shaped literals, or scraping implementation', async () => {
    const paths = [
      join(skillRoot, 'SKILL.md'),
      ...referenceNames.map(name => join(skillRoot, 'references', name + '.md')),
      join(skillRoot, 'evals/evals.json'),
    ]
    const corpus = (await Promise.all(paths.map(path => readFile(path, 'utf8')))).join('\n')
    expect(corpus).not.toMatch(/(?:token|api[_-]?key|secret|authorization|cookie)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/iu)
    expect(corpus).not.toMatch(/https?:\/\/[^\s]*[?&](?:token|api[_-]?key|access[_-]?token)=/iu)
    expect(corpus).not.toMatch(/(?:requests\.get|axios\.|fetch\(|curl\s|python\s+-c|child_process)/u)
    expect(corpus).not.toContain('04634fa7')
  })

  it('ships five realistic evals with objective assertions and broad routing coverage', async () => {
    const data = JSON.parse(await readFile(join(skillRoot, 'evals/evals.json'), 'utf8')) as {
      skill_name: string
      evals: SkillEval[]
    }
    expect(data.skill_name).toBe('a-share-data-research')
    expect(data.evals).toHaveLength(5)
    expect(new Set(data.evals.map(item => item.id)).size).toBe(data.evals.length)
    for (const item of data.evals) {
      expect(item.prompt.length).toBeGreaterThan(30)
      expect(item.expected_output.length).toBeGreaterThan(30)
      expect(item.files).toEqual([])
      expect(item.expectations.length).toBeGreaterThanOrEqual(3)
    }
    const corpus = data.evals.map(item => `${item.prompt} ${item.expected_output} ${item.expectations.join(' ')}`).join('\n')
    for (const tool of toolNames) expect(corpus).toContain(tool)
    for (const topic of ['K 线', '财务', '公告', '指数', '交易日历', 'PMI', '资金流']) {
      expect(corpus).toContain(topic)
    }
  })
})

describe('A-share data research pipelines', () => {
  it('normalizes an instrument before bars and rejects observations after the as-of date', async () => {
    const service = fixtureDataService()
    const reference = await service.execute<InstrumentReferenceV2>({
      capability: 'instrument-reference',
      market: 'CN',
      params: { symbol: '600519.SH', assetType: 'equity' },
    })
    expect(reference.data).toMatchObject({
      canonical: 'CN:SSE:600519:EQUITY',
      id: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
    })

    const instrument = reference.data?.id
    expect(instrument).toBeDefined()
    const bars = await service.execute<AStockBars>({
      capability: 'market-bars',
      market: 'CN',
      instrument,
      asOf: '2026-08-28',
      params: {
        startDate: '2026-08-27',
        endDate: '2026-08-28',
        adjustment: 'none',
        interval: '1d',
        limit: 10,
      },
    })
    expect(bars.data).toMatchObject({
      instrument,
      adjustment: 'none',
      startDate: '2026-08-27',
      endDate: '2026-08-28',
      returned: 2,
    })
    expect(bars.provenance).toMatchObject({
      actualProvider: 'a-stock-public',
      observedAt: '2026-08-28',
      timezone: 'Asia/Shanghai',
      currency: 'CNY',
      adjustment: 'none',
    })

    const historical = await service.execute<AStockBars>({
      capability: 'market-bars',
      market: 'CN',
      instrument,
      asOf: '2026-08-27',
      params: {
        startDate: '2026-08-27',
        endDate: '2026-08-28',
        adjustment: 'none',
        interval: '1d',
        limit: 10,
      },
    }, { cache: false })
    expect(historical.data).toMatchObject({
      startDate: '2026-08-27',
      endDate: '2026-08-27',
      returned: 1,
      bars: [expect.objectContaining({ date: '2026-08-27' })],
    })
    expect(historical.provenance.observedAt).toBe('2026-08-27')
  })

  it('keeps period, publication, availability, and document references across fundamentals and disclosures', async () => {
    const service = fixtureDataService()
    const reference = await service.execute<InstrumentReferenceV2>({
      capability: 'instrument-reference',
      market: 'CN',
      params: { symbol: '600519.SH', assetType: 'equity' },
    })
    const instrument = reference.data?.id
    expect(instrument).toBeDefined()

    const fundamentals = await service.execute<AStockFundamentals>({
      capability: 'fundamentals',
      market: 'CN',
      instrument,
      asOf: '2026-04-01',
      params: { statement: 'income', limit: 10 },
    })
    const disclosures = await service.execute<AStockDisclosures>({
      capability: 'disclosures',
      market: 'CN',
      instrument,
      asOf: '2026-04-01',
      params: { startDate: '2026-01-01', endDate: '2026-04-01', limit: 10 },
    })

    expect(fundamentals.data).toMatchObject({ instrument, pitSafe: true, returned: 2 })
    expect(fundamentals.data?.periods[0]).toMatchObject({
      fiscalPeriod: '2025-12-31',
      publishedAt: '2026-03-30',
      availableAt: '2026-03-30',
      currency: 'CNY',
      unit: 'CNY',
      scope: 'consolidated',
    })
    expect(fundamentals.provenance).toMatchObject({
      fiscalPeriod: '2025-12-31',
      publishedAt: '2026-03-30',
      availableAt: '2026-03-30',
    })
    expect(disclosures.data).toMatchObject({ instrument, returned: 1, truncated: false })
    expect(disclosures.data?.items[0]).toMatchObject({
      category: 'annual-report',
      publishedAt: '2026-03-30T10:00:00+08:00',
      documentRef: 'sse://disclosure/sse-600519-2026-001',
    })
    expect(disclosures.data?.items[0]).not.toHaveProperty('body')
    expect(disclosures.provenance).toMatchObject({
      actualProvider: 'a-stock-public',
      publishedAt: '2026-03-30T10:00:00+08:00',
      timezone: 'Asia/Shanghai',
    })
  })

  it('routes the macro/index surface to a trading calendar without fabricating an instrument', async () => {
    const calendar = await fixtureDataService().execute<AStockTradingCalendar>({
      capability: 'trading-calendar',
      market: 'CN',
      asOf: '2026-08-30',
      params: {
        exchange: 'SSE',
        startDate: '2026-08-27',
        endDate: '2026-08-30',
        limit: 10,
      },
    })

    expect(calendar.data).toMatchObject({
      exchange: 'SSE',
      startDate: '2026-08-27',
      endDate: '2026-08-30',
      returned: 4,
      truncated: false,
    })
    expect(calendar.data?.days).toEqual([
      expect.objectContaining({ date: '2026-08-27', isTradingDay: true }),
      expect.objectContaining({ date: '2026-08-28', isTradingDay: true }),
      { date: '2026-08-29', isTradingDay: false, session: null },
      { date: '2026-08-30', isTradingDay: false, session: null },
    ])
    expect(calendar.provenance).toMatchObject({
      actualProvider: 'a-stock-public',
      observedAt: '2026-08-30',
      timezone: 'Asia/Shanghai',
    })
  })

  it('caches identical market-activity queries and exposes redacted rate-limit diagnostics', async () => {
    const instrument = { market: 'CN', exchange: 'SZSE', symbol: '300750', assetType: 'equity' } as const
    const sensitiveMarker = ['market', 'activity', 'sensitive', 'value'].join('-')
    let calls = 0
    let rateLimited = false
    const adapter: CapabilityAdapter = {
      async execute<T>(): Promise<CanonicalDataResult<T>> {
        calls += 1
        if (rateLimited) {
          throw new FinanceDataError(`upstream throttled Bearer ${sensitiveMarker}`, 'rate-limited', {
            provider: 'activity-fixture',
            retryAfterMs: 60_000,
          })
        }
        return {
          status: 'available',
          data: { instrument, tradingDate: '2026-08-28', netMainInflow: 123_000_000 } as T,
          provenance: {
            actualProvider: 'activity-fixture',
            provider: 'activity-fixture',
            upstreamSource: 'recorded-activity-fixture',
            sourceKind: 'community',
            fetchedAt: '2026-08-28T08:10:00.000Z',
            observedAt: '2026-08-28T15:00:00+08:00',
            timezone: 'Asia/Shanghai',
            currency: 'CNY',
            unit: 'CNY',
            fallbackChain: [],
          },
          warnings: [],
        }
      },
    }
    const service = new FinanceDataService({
      cachePolicies: { 'capital-flow': { ttlMs: 60_000, staleTtlMs: 60_000 } },
      defaultRetry: { maxAttempts: 1 },
    }).register({
      providerId: 'activity-fixture',
      adapter,
      capabilities: ['capital-flow'],
      markets: ['CN'],
      qualityTier: 'standard',
      authMode: 'none',
      retry: { maxAttempts: 1 },
    })
    const activityRequest = {
      capability: 'capital-flow' as const,
      market: 'CN' as const,
      instrument,
      params: { date: '2026-08-28', metric: 'main-flow' },
    }

    const first = await service.execute(activityRequest)
    const cached = await service.execute(activityRequest)
    expect(first.provenance).toMatchObject({
      actualProvider: 'activity-fixture',
      upstreamSource: 'recorded-activity-fixture',
      sourceKind: 'community',
    })
    expect(cached).toMatchObject({
      status: 'available',
      provenance: {
        actualProvider: 'activity-fixture',
        fallbackChain: [expect.objectContaining({
          provider: 'activity-fixture',
          outcome: 'success',
          reason: 'fresh memory cache',
        })],
      },
    })
    expect(calls).toBe(1)

    rateLimited = true
    let failure: unknown
    try {
      await service.execute({
        ...activityRequest,
        params: { date: '2026-08-27', metric: 'main-flow' },
      }, { cache: false })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      kind: 'rate-limited',
      retryable: true,
      details: {
        fallbackChain: [expect.objectContaining({
          provider: 'activity-fixture',
          outcome: 'failed',
          reason: expect.stringContaining('rate-limited'),
        })],
      },
    })
    expect(JSON.stringify(failure)).not.toContain(sensitiveMarker)
    expect(calls).toBe(2)
  })
})
