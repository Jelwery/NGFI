import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DataCapability, InstrumentId } from '@finance2dsh/core'
import {
  ASHARE_FEATURES, AStockProvider, getAshareFeature,
  type AshareFeatureDefinition,
} from '../packages/finance-data-service/src/providers/astock/index.js'
import { createAshareFinanceTools } from '../packages/dsh-finance-tools/src/ashare-tools.js'

const root = process.cwd()
const fixtureRoot = join(root, 'tests/fixtures/a-stock-data')
const noDataRoot = join(fixtureRoot, 'feature-cases/no-data')
const schemaRoot = join(fixtureRoot, 'feature-cases/schema-drift')
const manifest = JSON.parse(readFileSync(
  join(root, 'packages/finance-data-service/providers/astock/upstream/capability-manifest.json'), 'utf8',
)) as {
  summary: { statusCounts: Record<string, number> }
  capabilities: Array<{
    id: string
    status: string
    auth: string
    upstreamCallables: string[]
    runtimeMappings: Array<Record<string, unknown>>
  }>
}
const instrument: InstrumentId = {
  market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity',
}
const runner = join(root, 'packages/finance-data-service/providers/astock/python/runner.py')
const limits = { maxRecords: 1_000, maxDateSpanDays: 3_660, maxOutputBytes: 4 * 1024 * 1024, networkTimeoutMs: 10_000 }

function provider(selectedRoot: string): AStockProvider {
  return new AStockProvider({
    source: 'fixture', fixtureRoot: selectedRoot, projectRoot: root,
    pythonExecutable: 'python3', pythonArgs: [], minRequestIntervalMs: 0,
  })
}

function requestFor(feature: AshareFeatureDefinition, limit = 1) {
  const selected = feature.variants[0]!
  return {
    capability: selected.dataCapability as DataCapability,
    market: 'CN' as const,
    ...(['instrument', 'index'].includes(feature.scope) ? { instrument } : {}),
    params: { featureId: feature.featureId, variant: selected.id, limit },
  }
}

const featureVariants = ASHARE_FEATURES.flatMap(feature => feature.variants.map(variant => ({ feature, variant })))

function runFixtureBatch(
  selectedRoot: string,
  entries: Array<{ feature: AshareFeatureDefinition; variant?: AshareFeatureDefinition['variants'][number] }>,
) {
  const requests = entries.map(({ feature, variant }, index) => {
    const request = requestFor(feature)
    request.params.variant = variant?.id ?? request.params.variant
    request.capability = variant?.dataCapability ?? request.capability
    return {
      version: '1', id: String(index), operation: request.capability, source: 'fixture',
      params: { ...request.params, ...('instrument' in request ? { instrument: request.instrument } : {}) },
      limits, fixtureRoot: selectedRoot,
    }
  })
  const child = spawnSync('python3', [runner], {
    cwd: root, input: requests.map(value => JSON.stringify(value)).join('\n') + '\n',
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  })
  expect(child.status, child.stderr).toBe(0)
  const responses = child.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line) as {
    ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown>
  })
  expect(responses).toHaveLength(entries.length)
  return responses
}

describe('A-share 60-capability registry', () => {
  it('has a closed 60-capability mapping with one optional-auth capability', () => {
    expect(ASHARE_FEATURES).toHaveLength(60)
    expect(new Set(ASHARE_FEATURES.map(item => item.featureId))).toHaveLength(60)
    expect(new Set(ASHARE_FEATURES.map(item => item.upstreamCapabilityId))).toHaveLength(60)
    expect(ASHARE_FEATURES.filter(item => item.auth === 'api-key').map(item => item.upstreamCapabilityId))
      .toEqual(['capability-008'])
    expect(manifest.summary.statusCounts).toEqual({
      'implemented-canonical': 14,
      'implemented-experimental': 45,
      'implemented-optional-auth': 1,
      'blocked-auth': 0,
      'deferred-policy': 0,
      unsupported: 0,
    })
  })

  it.each(ASHARE_FEATURES)('$upstreamCapabilityId maps every callable and runtime field', feature => {
    const capability = manifest.capabilities.find(item => item.id === feature.upstreamCapabilityId)
    expect(capability).toBeDefined()
    expect(new Set(feature.variants.map(item => item.upstreamCallable)))
      .toEqual(new Set(capability!.upstreamCallables))
    expect(capability!.runtimeMappings).toHaveLength(capability!.upstreamCallables.length)
    expect(capability!.runtimeMappings).toEqual(expect.arrayContaining(capability!.upstreamCallables.map(callable => (
      expect.objectContaining({
        upstreamCallable: callable, featureId: feature.featureId,
        fixture: feature.fixture, liveProbe: feature.liveProbe,
        contractTier: feature.contractTier,
      })
    ))))
  })

  it('exposes every variant from exactly one of the existing eight tools', () => {
    const tools = createAshareFinanceTools({
      service: { execute: async () => { throw new Error('not called') } },
      approvedProviderIds: ['a-stock-public'],
      catalog: async () => [],
      iwencaiConfigured: false,
    })
    expect(tools.map(tool => tool.name)).toHaveLength(8)
    for (const feature of ASHARE_FEATURES) {
      for (const variant of feature.variants) {
        const tool = tools.find(item => item.name === variant.toolName)
        expect(tool, `${feature.featureId}/${variant.id} tool`).toBeDefined()
        const properties = tool!.parameters.properties as Record<string, { enum?: readonly unknown[] }>
        expect(properties.feature?.enum, `${feature.featureId}/${variant.id} feature enum`).toContain(feature.featureId)
        expect(properties.dataset?.enum, `${feature.featureId}/${variant.id} dataset enum`).toContain(variant.dataset)
      }
    }
  })

  it.each(featureVariants)('$feature.upstreamCapabilityId/$variant.id dispatches through its curated tool', async ({ feature, variant }) => {
    let captured: { capability: string; params?: unknown } | undefined
    const tools = createAshareFinanceTools({
      service: {
        execute: async (request: { capability: string; params?: unknown }) => {
          captured = request
          return {
            status: 'available',
            data: {
              featureId: feature.featureId, schemaVersion: 1, scope: feature.scope,
              records: [{ value: 1 }], returned: 1, truncated: false,
              fieldUnits: { value: 'fixture-unit' }, limitations: ['fixture'],
            },
            provenance: {
              actualProvider: 'a-stock-public', provider: 'a-stock-public',
              upstreamSource: feature.sources[0]!, sourceKind: 'public-web',
              fetchedAt: '2026-09-04T08:00:00Z', fallbackChain: [],
            },
            warnings: [],
          }
        },
      } as never,
      approvedProviderIds: ['a-stock-public'], catalog: async () => [], iwencaiConfigured: true,
    })
    const selected = tools.find(item => item.name === variant.toolName)!
    const args: Record<string, unknown> = {
      feature: feature.featureId, variant: variant.id, dataset: variant.dataset,
      source: 'a-stock-public', limit: 1,
    }
    if (variant.toolName === 'finance_cn_instrument') args.query = '600519.SH'
    else if (['instrument', 'index', 'derivative'].includes(feature.scope)) {
      args.instrument = feature.scope === 'index' ? '000300.SH' : feature.scope === 'derivative' ? '510050.SH' : '600519.SH'
    }
    if (variant.toolName === 'finance_cn_bars') {
      args.start_date = '2026-09-01'; args.end_date = '2026-09-04'; args.adjustment = 'none'
    }
    await selected.execute(args, { signal: new AbortController().signal } as never)
    expect(captured).toMatchObject({
      capability: variant.dataCapability,
      params: { featureId: feature.featureId, variant: variant.id, limit: 1 },
    })
  })

  it('reports iWenCai as blocked-auth without exposing or requiring a credential', async () => {
    const tools = createAshareFinanceTools({
      service: { execute: async () => { throw new Error('not called') } },
      approvedProviderIds: ['a-stock-public'],
      catalog: async () => [{
        providerId: 'a-stock-public', capabilities: [], markets: ['CN'], qualityTier: 'fallback',
        authMode: 'none', priority: 10, routable: true,
        health: { providerId: 'a-stock-public', status: 'healthy', checkedAt: '2026-09-04T00:00:00Z' },
      }],
      iwencaiConfigured: false,
    })
    const catalog = tools.find(item => item.name === 'finance_data_catalog')!
    const result = await catalog.execute({ feature: 'disclosures.iwencai-semantic' }, { signal: new AbortController().signal } as never) as {
      features: Array<{ featureId: string; implementation: string; health: string }>
    }
    expect(result.features).toEqual([expect.objectContaining({
      featureId: 'disclosures.iwencai-semantic',
      implementation: 'implemented-optional-auth',
      health: 'blocked-auth',
    })])
    expect(JSON.stringify(result)).not.toContain('IWENCAI_API_KEY')
  })

  it('rejects unknown feature IDs before spawning and does not expose raw escape hatches', async () => {
    const selected = provider(fixtureRoot)
    await expect(selected.execute({
      capability: 'quote', market: 'CN', instrument,
      params: { featureId: 'raw.call', variant: 'default', limit: 1 },
    })).rejects.toThrow(/unsupported A-share feature/)
    await expect(selected.execute({
      capability: 'quote', market: 'CN', instrument,
      params: { featureId: 'quote.tencent', variant: 'default', limit: 1, url: 'https://example.com' },
    })).rejects.toThrow(/unsupported fields/)
  })
})

describe('A-share feature fixture matrix', () => {
  const successes = runFixtureBatch(fixtureRoot, featureVariants)
  it.each(featureVariants.map((entry, index) => ({ ...entry, response: successes[index]! })))
    ('$feature.upstreamCapabilityId/$variant.id success has provenance, units and truncation', ({ feature, response }) => {
      expect(response).toMatchObject({
        ok: true,
        data: {
          status: 'available',
          data: {
            featureId: feature.featureId, schemaVersion: 1, scope: feature.scope,
            returned: 1, truncated: true,
            fieldUnits: { sample_date: 'ISO-8601', value: 'fixture-unit' },
          },
          provenance: {
            actualProvider: 'a-stock-public', upstreamSource: 'recorded-feature-success-fixture',
            sourceKind: 'user', unit: 'declared-in-fieldUnits', fallbackChain: [],
          },
        },
      })
      expect((response.data as { warnings: string[] }).warnings.length).toBeGreaterThan(0)
    })

  const emptyResponses = runFixtureBatch(noDataRoot, ASHARE_FEATURES.map(feature => ({ feature })))
  it.each(ASHARE_FEATURES.map((feature, index) => ({ feature, response: emptyResponses[index]! })))
    ('$feature.upstreamCapabilityId rejects a validated empty fixture as no-data', ({ response }) => {
      expect(response).toMatchObject({ ok: false, error: { kind: 'no-data', code: 'no-data', retryable: false } })
    })

  const schemaResponses = runFixtureBatch(schemaRoot, ASHARE_FEATURES.map(feature => ({ feature })))
  it.each(ASHARE_FEATURES.map((feature, index) => ({ feature, response: schemaResponses[index]! })))
    ('$feature.upstreamCapabilityId fails closed on fixture schema drift', ({ response }) => {
      expect(response).toMatchObject({ ok: false, error: { kind: 'schema-drift', code: 'fixture-schema', retryable: false } })
    })

  it.each(ASHARE_FEATURES)('$upstreamCapabilityId enforces its max limit before spawning', async feature => {
    await expect(provider(fixtureRoot).execute(requestFor(feature, feature.maxLimit + 1)))
      .rejects.toThrow(`limit must be an integer from 1 through ${feature.maxLimit}`)
    expect(getAshareFeature(feature.featureId).maxLimit).toBe(feature.maxLimit)
  })
})
