import { describe, expect, it, vi } from 'vitest'
import { FinanceDataError, normalizeAshareInstrument } from '@finance2dsh/core'
import type { CanonicalDataResult, CapabilityRequest, DataStatus, SourceKind } from '@finance2dsh/core'
import {
  CircuitBreaker,
  FinanceDataService,
  MemoryCache,
  ProviderRegistry,
  ProviderRouter,
  RateLimiter,
  assertCapabilityRequestBoundary,
  redactSensitiveText,
  redactUrl,
  retryAfterMs,
  withRetry,
} from '../packages/finance-data-service/src/index.js'
import type {
  CapabilityAdapter,
  ProviderRegistration,
  ServiceCapabilityRequest,
} from '../packages/finance-data-service/src/index.js'

const request: CapabilityRequest = {
  capability: 'quote',
  market: 'CN',
  instrument: normalizeAshareInstrument('600519'),
  params: { fields: ['last', 'volume'] },
}

const CANONICAL_FALLBACK_STATUSES = [
  'no-data',
  'unsupported',
  'unauthorized',
  'insufficient-permission',
  'rate-limited',
  'provider-error',
  'schema-drift',
] as const satisfies readonly DataStatus[]

function result(
  providerId: string,
  data: unknown = { price: 100 },
  sourceKind: SourceKind = 'official',
): CanonicalDataResult<unknown> {
  return {
    status: 'available',
    data,
    provenance: {
      provider: providerId,
      actualProvider: providerId,
      upstreamSource: providerId,
      sourceKind,
      fetchedAt: '2026-09-05T08:00:00.000Z',
      adjustment: 'none',
      fallbackChain: [],
    },
    warnings: [],
  }
}

function statusResult(
  providerId: string,
  status: typeof CANONICAL_FALLBACK_STATUSES[number],
  data: unknown = null,
): CanonicalDataResult<unknown> {
  return { ...result(providerId, data), status }
}

type TestExecute = (request: CapabilityRequest) => Promise<CanonicalDataResult<unknown>>

function adapter(
  execute: TestExecute,
  health?: CapabilityAdapter['health'],
): CapabilityAdapter {
  return {
    execute: async <T>(capabilityRequest: ServiceCapabilityRequest) => (
      await execute(capabilityRequest as CapabilityRequest) as CanonicalDataResult<T>
    ),
    ...(health === undefined ? {} : { health }),
  }
}

function registration(
  providerId: string,
  execute: TestExecute,
  options: Partial<ProviderRegistration> = {},
): ProviderRegistration {
  return {
    providerId,
    adapter: adapter(execute),
    capabilities: ['quote'],
    markets: ['CN'],
    qualityTier: 'standard',
    authMode: 'none',
    retry: { maxAttempts: 1 },
    ...options,
  }
}

describe('provider registry and routing', () => {
  it('selects by capability, market, and priority', async () => {
    const registry = new ProviderRegistry()
      .register(registration('low', async () => result('low'), { priority: 1 }))
      .register(registration('high', async () => result('high'), { priority: 10 }))
      .register({
        ...registration('us-only', async () => result('us-only'), { priority: 100 }),
        markets: ['US'],
      })
    const routed = await new ProviderRouter(registry).route(request)
    expect(routed.provenance.actualProvider).toBe('high')
    expect(routed.provenance.fallbackChain).toEqual([{
      provider: 'high',
      outcome: 'success',
      qualityTier: 'standard',
    }])
  })

  it('skips capability-unavailable providers during automatic routing', async () => {
    const unavailableExecute = vi.fn(async () => result('unavailable-high', { price: 999 }))
    const healthyExecute = vi.fn(async () => result('healthy-low', { price: 101 }))
    const registry = new ProviderRegistry()
      .register(registration('unavailable-high', unavailableExecute, {
        priority: 10,
        adapter: adapter(unavailableExecute, async () => ({
          providerId: 'unavailable-high',
          status: 'healthy',
          checkedAt: '2026-09-05T00:00:00Z',
          capabilities: { quote: 'unavailable' },
        })),
      }))
      .register(registration('healthy-low', healthyExecute, {
        priority: 1,
        adapter: adapter(healthyExecute, async () => ({
          providerId: 'healthy-low',
          status: 'healthy',
          checkedAt: '2026-09-05T00:00:00Z',
          capabilities: { quote: 'healthy' },
        })),
      }))

    const routed = await new ProviderRouter(registry).route(request, {
      provider: 'auto',
      cache: false,
    })

    expect.soft(unavailableExecute).not.toHaveBeenCalled()
    expect.soft(healthyExecute).toHaveBeenCalledOnce()
    expect.soft(routed).toMatchObject({
      status: 'available',
      data: { price: 101 },
      provenance: { provider: 'healthy-low', actualProvider: 'healthy-low' },
    })
    expect(routed.provenance.fallbackChain).toEqual([
      expect.objectContaining({
        provider: 'unavailable-high',
        outcome: 'skipped',
        reason: expect.stringMatching(/unavailable/i),
      }),
      expect.objectContaining({ provider: 'healthy-low', outcome: 'success' }),
    ])
  })

  it('records requested, failed, and actual providers during fallback', async () => {
    const secret = '0123456789abcdefghijklmnop'
    const registry = new ProviderRegistry()
      .register(registration('primary', async () => {
        throw new FinanceDataError(`failed https://feed.test/api?token=${secret}`, 'transport')
      }, { priority: 10 }))
      .register(registration('fallback', async () => ({
        ...result('fallback', { price: 101 }, 'public-web'),
        provenance: {
          ...result('fallback').provenance,
          sourceKind: 'public-web',
          sourceUrl: `https://feed.test/api/token/${secret}?api_key=${secret}&symbol=600519`,
        },
      }), { priority: 1 }))

    const routed = await new ProviderRouter(registry).route(request, {
      provider: 'primary',
      fallback: true,
    })
    expect(routed.data).toEqual({ price: 101 })
    expect(routed.provenance).toMatchObject({
      requestedProvider: 'primary',
      actualProvider: 'fallback',
      provider: 'fallback',
    })
    expect(routed.provenance.fallbackChain.map(item => [item.provider, item.outcome])).toEqual([
      ['primary', 'failed'],
      ['fallback', 'success'],
    ])
    expect(JSON.stringify(routed)).not.toContain(secret)
    expect(routed.provenance.qualityDowngrade).toBe(false)
  })

  it.each(CANONICAL_FALLBACK_STATUSES)(
    'continues fallback after a canonical %s result',
    async status => {
      const fallback = vi.fn(async () => result('fallback', { price: 101 }))
      const registry = new ProviderRegistry()
        .register(registration('primary', async () => statusResult('primary', status), { priority: 10 }))
        .register(registration('fallback', fallback, { priority: 1 }))

      const routed = await new ProviderRouter(registry).route(request)

      expect(routed).toMatchObject({ status: 'available', data: { price: 101 } })
      expect(fallback).toHaveBeenCalledOnce()
      expect(routed.provenance.fallbackChain).toEqual([
        expect.objectContaining({
          provider: 'primary',
          outcome: 'rejected',
          reason: `canonical status ${status}`,
        }),
        expect.objectContaining({ provider: 'fallback', outcome: 'success' }),
      ])
    },
  )

  it.each(CANONICAL_FALLBACK_STATUSES)(
    'returns an explicit provider canonical %s result without implicit fallback',
    async status => {
      const fallback = vi.fn(async () => result('fallback'))
      const registry = new ProviderRegistry()
        .register(registration('primary', async () => ({
          ...statusResult('primary', status, { retained: true }),
          warnings: ['provider supplied canonical status'],
        })))
        .register(registration('fallback', fallback))

      const routed = await new ProviderRouter(registry).route(request, { provider: 'primary' })

      expect(routed).toMatchObject({
        status,
        data: { retained: true },
        warnings: ['provider supplied canonical status'],
        provenance: {
          requestedProvider: 'primary',
          provider: 'primary',
          actualProvider: 'primary',
        },
      })
      expect(routed.provenance.fallbackChain).toEqual([expect.objectContaining({
        provider: 'primary',
        outcome: 'selected',
        reason: `canonical status ${status}`,
      })])
      expect(fallback).not.toHaveBeenCalled()
    },
  )

  it('returns the last canonical non-success with complete routing provenance when candidates are exhausted', async () => {
    const registry = new ProviderRegistry()
      .register(registration('primary', async () => ({
        ...statusResult('primary', 'unauthorized'),
        warnings: ['primary credentials are unavailable'],
      }), { priority: 30 }))
      .register(registration('broken', async () => {
        throw new FinanceDataError('upstream connection failed', 'transport')
      }, { priority: 20 }))
      .register(registration('last', async () => ({
        ...statusResult('last', 'no-data', { reason: 'closed-market' }),
        provenance: {
          ...result('last').provenance,
          timezone: 'Asia/Shanghai',
          fallbackChain: [{ provider: 'upstream-child', outcome: 'failed', reason: 'empty response' }],
        },
        warnings: ['no observation at the requested time'],
      }), { priority: 10 }))

    const routed = await new ProviderRouter(registry).route(request, {
      provider: 'primary',
      fallback: true,
    })

    expect(routed).toMatchObject({
      status: 'no-data',
      data: { reason: 'closed-market' },
      warnings: ['no observation at the requested time'],
      provenance: {
        requestedProvider: 'primary',
        provider: 'last',
        actualProvider: 'last',
        timezone: 'Asia/Shanghai',
      },
    })
    expect(routed.provenance.fallbackChain).toEqual([
      expect.objectContaining({ provider: 'primary', outcome: 'rejected', reason: 'canonical status unauthorized' }),
      expect.objectContaining({ provider: 'broken', outcome: 'failed' }),
      expect.objectContaining({ provider: 'last', outcome: 'selected', reason: 'canonical status no-data' }),
      { provider: 'upstream-child', outcome: 'failed', reason: 'empty response' },
    ])
  })

  it('retains a canonical non-success when later candidates are malformed or throw', async () => {
    const registry = new ProviderRegistry()
      .register(registration('retained', async () => ({
        ...statusResult('retained', 'no-data', { retained: true }),
        warnings: ['retained canonical response'],
      }), { priority: 30 }))
      .register(registration('malformed', async () => result('wrong-provider'), { priority: 20 }))
      .register(registration('throwing', async () => {
        throw new FinanceDataError('upstream transport failed', 'transport')
      }, { priority: 10 }))

    const routed = await new ProviderRouter(registry).route(request)

    expect(routed).toMatchObject({
      status: 'no-data',
      data: { retained: true },
      warnings: ['retained canonical response'],
      provenance: { provider: 'retained', actualProvider: 'retained' },
    })
    expect(routed.provenance.fallbackChain.map(attempt => [attempt.provider, attempt.outcome])).toEqual([
      ['retained', 'selected'],
      ['malformed', 'failed'],
      ['throwing', 'failed'],
    ])
    expect(routed.provenance.fallbackChain[1]?.reason).toMatch(/^schema-drift:/)
    expect(routed.provenance.fallbackChain[2]?.reason).toMatch(/^transport:/)
  })

  it('marks a lower-tier fallback as a quality downgrade', async () => {
    const registry = new ProviderRegistry([
      registration('official', async () => {
        throw new FinanceDataError('offline', 'transport')
      }, { priority: 10, qualityTier: 'authoritative' }),
      registration('public', async () => result('public', {}, 'public-web'), {
        priority: 1,
        qualityTier: 'fallback',
      }),
    ])
    const routed = await new ProviderRouter(registry).route(request)
    expect(routed.provenance).toMatchObject({
      provider: 'public',
      qualityTier: 'fallback',
      qualityDowngrade: true,
    })
  })

  it('does not silently fall back from an explicitly selected provider by default', async () => {
    const fallback = vi.fn(async () => result('fallback'))
    const registry = new ProviderRegistry()
      .register(registration('primary', async () => {
        throw new FinanceDataError('offline', 'transport')
      }))
      .register(registration('fallback', fallback))
    await expect(new ProviderRouter(registry).route(request, { provider: 'primary' }))
      .rejects.toMatchObject({ kind: 'transport' })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('rejects mismatched provider identity and future-visible as-of data', async () => {
    const wrong = registration('expected', async () => result('imposter'))
    await expect(new FinanceDataService().register(wrong).execute(request))
      .rejects.toMatchObject({ kind: 'schema-drift' })

    const future = registration('future', async () => ({
      ...result('future'),
      provenance: {
        ...result('future').provenance,
        availableAt: '2026-09-06T00:00:00Z',
      },
    }))
    await expect(new FinanceDataService().register(future).execute({
      ...request,
      asOf: '2026-09-05T00:00:00Z',
    })).rejects.toMatchObject({ kind: 'schema-drift' })
  })

  it('uses the end of the requested market day for date-only as-of validation', async () => {
    const atBoundary = (providerId: string, availableAt: string) => ({
      ...result(providerId),
      provenance: { ...result(providerId).provenance, availableAt },
    })
    const chinaBoundary = new ProviderRegistry().register(registration(
      'china-boundary',
      async () => atBoundary('china-boundary', '2026-09-05T15:59:59.999Z'),
    ))
    await expect(new ProviderRouter(chinaBoundary).route({
      ...request,
      asOf: '2026-09-05',
    }, { cache: false })).resolves.toMatchObject({ status: 'available' })

    const chinaNextDay = new ProviderRegistry().register(registration(
      'china-next-day',
      async () => atBoundary('china-next-day', '2026-09-05T16:00:00.000Z'),
    ))
    await expect(new ProviderRouter(chinaNextDay).route({
      ...request,
      asOf: '2026-09-05',
    }, { cache: false })).rejects.toMatchObject({ kind: 'schema-drift' })

    const utcBoundary = new ProviderRegistry().register(registration(
      'utc-boundary',
      async () => atBoundary('utc-boundary', '2026-09-05T23:59:59.999Z'),
      { markets: ['US'] },
    ))
    await expect(new ProviderRouter(utcBoundary).route({
      capability: 'quote',
      market: 'US',
      asOf: '2026-09-05',
    }, { cache: false })).resolves.toMatchObject({ status: 'available' })
  })

  it('honors an explicit timestamp offset instead of applying date-only market semantics', async () => {
    const registry = new ProviderRegistry().register(registration('timestamp-boundary', async () => ({
      ...result('timestamp-boundary'),
      provenance: {
        ...result('timestamp-boundary').provenance,
        availableAt: '2026-09-05T15:59:59.000Z',
      },
    })))
    await expect(new ProviderRouter(registry).route({
      ...request,
      asOf: '2026-09-05T23:59:59+08:00',
    }, { cache: false })).resolves.toMatchObject({ status: 'available' })
  })

  it.each([
    '2026-02-30',
    '2026-09-05T00:00:00',
    '2026-09-05T00:00:00.000',
    '2026-09-05T24:00:00Z',
  ])('rejects non-strict asOf value %s', asOf => {
    expect(() => assertCapabilityRequestBoundary({
      ...request,
      asOf,
    })).toThrowError(expect.objectContaining({
      kind: 'invalid-request',
      retryable: false,
    }))
  })

  it('retries retryable result statuses but never retries schema drift', async () => {
    let calls = 0
    const registry = new ProviderRegistry().register(registration('limited', async () => {
      calls += 1
      if (calls === 1) return { ...result('limited'), status: 'rate-limited', data: null }
      return result('limited')
    }, { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }))
    await expect(new ProviderRouter(registry).route(request)).resolves.toMatchObject({ status: 'available' })
    expect(calls).toBe(2)

    calls = 0
    const drift = new ProviderRegistry().register(registration('drift', async () => {
      calls += 1
      return { ...result('drift'), provenance: { ...result('drift').provenance, provider: 'wrong' } }
    }, { retry: { maxAttempts: 3 } }))
    await expect(new ProviderRouter(drift).route(request)).rejects.toMatchObject({ kind: 'schema-drift' })
    expect(calls).toBe(1)
  })

  it.each(['rate-limited', 'provider-error'] as const)(
    'returns canonical %s after retry exhaustion for an explicit provider',
    async status => {
      const execute = vi.fn(async () => statusResult('retrying', status, { attempt: 'exhausted' }))
      const registry = new ProviderRegistry().register(registration('retrying', execute, {
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        circuitBreaker: { failureThreshold: 1, openDurationMs: 60_000, halfOpenMaxRequests: 1 },
      }))

      const routed = await new ProviderRouter(registry).route(request, { provider: 'retrying' })

      expect(execute).toHaveBeenCalledTimes(2)
      expect(routed).toMatchObject({ status, data: { attempt: 'exhausted' } })
      expect(registry.get('retrying')?.circuit.state).toBe('open')
    },
  )

  it('fails closed on non-JSON values and unexplained stale results', async () => {
    const dated = new ProviderRegistry().register(registration('dated', async () => (
      result('dated', { value: new Date('2026-09-05T00:00:00Z') })
    )))
    await expect(new ProviderRouter(dated).route(request)).rejects.toMatchObject({ kind: 'schema-drift' })

    const stale = new ProviderRegistry().register(registration('stale', async () => ({
      ...result('stale'),
      status: 'stale',
    })))
    await expect(new ProviderRouter(stale).route(request)).rejects.toMatchObject({ kind: 'schema-drift' })
  })

  it('reports health and open circuit state', async () => {
    const registry = new ProviderRegistry().register(registration('health', async () => result('health'), {
      adapter: adapter(
        async () => result('health'),
        async () => ({ providerId: 'health', status: 'degraded', checkedAt: '2026-09-05T00:00:00Z' }),
      ),
    }))
    expect((await registry.catalog())[0]?.health.status).toBe('degraded')
  })

  it('rejects duplicate and malformed registrations', () => {
    const registry = new ProviderRegistry().register(registration('unique', async () => result('unique')))
    expect(() => registry.register(registration('unique', async () => result('unique')))).toThrow(/already registered/)
    expect(() => new ProviderRegistry().register(registration('bad-retry', async () => result('bad-retry'), {
      retry: { maxAttempts: 0 },
    }))).toThrowError(expect.objectContaining({ kind: 'invalid-request' }))
  })
})

describe('memory cache semantics', () => {
  it('distinguishes fresh, stale, and expired values and clones them', () => {
    let now = 1_000
    const cache = new MemoryCache<{ nested: { count: number } }>({ now: () => now })
    cache.set('quote', { nested: { count: 1 } }, { ttlMs: 10, staleTtlMs: 20 })
    const fresh = cache.get('quote')
    expect(fresh.state).toBe('fresh')
    if (fresh.value !== undefined) fresh.value.nested.count = 99
    expect(cache.get('quote').value).toEqual({ nested: { count: 1 } })
    now = 1_010
    expect(cache.get('quote')).toMatchObject({ state: 'stale' })
    expect(cache.get('quote', true)).toMatchObject({ state: 'stale', value: { nested: { count: 1 } } })
    now = 1_030
    expect(cache.get('quote', true)).toEqual({ state: 'miss' })
  })

  it('returns stale only when explicitly allowed and live providers fail', async () => {
    let now = 0
    let fail = false
    const registry = new ProviderRegistry().register(registration('cached', async () => {
      if (fail) throw new FinanceDataError('offline', 'transport')
      return result('cached')
    }))
    const router = new ProviderRouter(registry, {
      now: () => now,
      cachePolicies: { quote: { ttlMs: 10, staleTtlMs: 100 } },
    })
    await router.route(request)
    now = 11
    fail = true
    await expect(router.route(request)).rejects.toMatchObject({ kind: 'transport' })
    const stale = await router.route(request, { allowStale: true })
    expect(stale.status).toBe('stale')
    expect(stale.warnings.join(' ')).toMatch(/explicitly returning stale/i)
    expect(stale.provenance.fallbackChain.at(-1)).toMatchObject({ provider: 'cached', outcome: 'selected' })
  })

  it('returns explicitly allowed stale data when health blocks a live retry', async () => {
    let now = 0
    let healthy = true
    const execute = vi.fn(async () => result('health-stale'))
    const health = vi.fn(async () => ({
      providerId: 'health-stale',
      status: healthy ? 'healthy' as const : 'unavailable' as const,
      checkedAt: '2026-09-05T00:00:00Z',
    }))
    const registry = new ProviderRegistry().register(registration('health-stale', execute, {
      adapter: adapter(execute, health),
    }))
    const router = new ProviderRouter(registry, {
      now: () => now,
      healthCacheTtlMs: 0,
      cachePolicies: { quote: { ttlMs: 10, staleTtlMs: 100 } },
    })
    await router.route(request)
    now = 11
    healthy = false

    await expect(router.route(request, { allowStale: true })).resolves.toMatchObject({
      status: 'stale', provenance: { actualProvider: 'health-stale' },
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not let a fresh cache entry bypass an automatic provider health block', async () => {
    let healthy = true
    const execute = vi.fn(async () => result('health-fresh'))
    const health = vi.fn(async () => ({
      providerId: 'health-fresh',
      status: healthy ? 'healthy' as const : 'unauthorized' as const,
      checkedAt: '2026-09-05T00:00:00Z',
    }))
    const registry = new ProviderRegistry().register(registration('health-fresh', execute, {
      adapter: adapter(execute, health),
    }))
    const router = new ProviderRouter(registry, {
      healthCacheTtlMs: 0,
      cachePolicies: { quote: { ttlMs: 100, staleTtlMs: 100 } },
    })

    await expect(router.route(request)).resolves.toMatchObject({ status: 'available' })
    healthy = false

    await expect(router.route(request)).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(execute).toHaveBeenCalledOnce()
    expect(health).toHaveBeenCalledTimes(2)
  })

  it('does not reuse cache after a provider id is unregistered and replaced', async () => {
    const oldExecute = vi.fn(async () => result('replaceable', { version: 'old' }))
    const newExecute = vi.fn(async () => result('replaceable', { version: 'new' }))
    const registry = new ProviderRegistry().register(registration('replaceable', oldExecute))
    const router = new ProviderRouter(registry)
    await expect(router.route(request)).resolves.toMatchObject({ data: { version: 'old' } })
    expect(registry.unregister('replaceable')).toBe(true)
    registry.register(registration('replaceable', newExecute))
    await expect(router.route(request)).resolves.toMatchObject({ data: { version: 'new' } })
    expect(oldExecute).toHaveBeenCalledOnce()
    expect(newExecute).toHaveBeenCalledOnce()
  })

  it('returns explicitly allowed stale data after an explicit provider transport failure', async () => {
    let now = 0
    let fail = false
    const registry = new ProviderRegistry().register(registration('explicit-cache', async () => {
      if (fail) throw new FinanceDataError('offline', 'transport')
      return result('explicit-cache')
    }))
    const router = new ProviderRouter(registry, {
      now: () => now,
      cachePolicies: { quote: { ttlMs: 10, staleTtlMs: 100 } },
    })

    await router.route(request, { provider: 'explicit-cache' })
    now = 11
    fail = true

    const stale = await router.route(request, {
      provider: 'explicit-cache',
      fallback: false,
      allowStale: true,
    })

    expect(stale.status).toBe('stale')
    expect(stale.provenance).toMatchObject({
      requestedProvider: 'explicit-cache',
      provider: 'explicit-cache',
      actualProvider: 'explicit-cache',
    })
    expect(stale.provenance.fallbackChain.map(attempt => attempt.outcome)).toEqual(['failed', 'selected'])
  })

  it('prefers a mid-flight abort over stale data when the adapter later reports transport failure', async () => {
    let now = 0
    let calls = 0
    let markStarted!: () => void
    let releaseFailure!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
    const registry = new ProviderRegistry().register(registration('abort-after-start', async () => {
      calls += 1
      if (calls === 1) return result('abort-after-start')
      markStarted()
      await failureGate
      throw new FinanceDataError('socket closed after cancellation', 'transport')
    }))
    const router = new ProviderRouter(registry, {
      now: () => now,
      cachePolicies: { quote: { ttlMs: 10, staleTtlMs: 100 } },
    })

    await router.route(request, { provider: 'abort-after-start' })
    now = 11
    const controller = new AbortController()
    const pending = router.route(
      { ...request, signal: controller.signal },
      { provider: 'abort-after-start', fallback: false, allowStale: true },
    )
    await started
    controller.abort()
    releaseFailure()

    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    expect(calls).toBe(2)
  })

  it('never returns stale cache data after the request is aborted', async () => {
    let now = 0
    const execute = vi.fn(async () => result('abort-stale'))
    const registry = new ProviderRegistry().register(registration('abort-stale', execute))
    const router = new ProviderRouter(registry, {
      now: () => now,
      cachePolicies: { quote: { ttlMs: 10, staleTtlMs: 100 } },
    })

    await router.route(request, { provider: 'abort-stale' })
    now = 11

    const controller = new AbortController()
    controller.abort()

    await expect(router.route(
      { ...request, signal: controller.signal },
      { provider: 'abort-stale', allowStale: true },
    )).rejects.toMatchObject({
      kind: 'aborted',
      retryable: false,
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('coalesces identical concurrent provider requests', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const registry = new ProviderRegistry().register(registration('coalesced', async () => {
      calls += 1
      await gate
      return result('coalesced')
    }))
    const router = new ProviderRouter(registry)
    const first = router.route(request)
    const second = router.route(request)
    await Promise.resolve()
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(calls).toBe(1)
  })

  it('does not coalesce requests carrying different abort signals', async () => {
    let calls = 0
    const registry = new ProviderRegistry().register(registration('abort-aware', async () => {
      calls += 1
      return result('abort-aware')
    }))
    const router = new ProviderRouter(registry)
    const first = new AbortController()
    const second = new AbortController()
    await Promise.all([
      router.route({ ...request, signal: first.signal }, { cache: false }),
      router.route({ ...request, signal: second.signal }, { cache: false }),
    ])
    expect(calls).toBe(2)
  })

  it('normalizes canonical identity for adapters and cache keys without mutating input', async () => {
    const execute = vi.fn(async (capabilityRequest: CapabilityRequest) => {
      expect(capabilityRequest).toMatchObject({
        market: 'CN',
        instrument: normalizeAshareInstrument('600519.SH'),
      })
      return result('canonical-cache')
    })
    const router = new ProviderRouter(
      new ProviderRegistry().register(registration('canonical-cache', execute)),
    )
    const noncanonicalRequest: CapabilityRequest = {
      ...request,
      market: 'cn',
      instrument: {
        market: 'cn',
        exchange: 'sse',
        symbol: '600519',
        assetType: 'EQUITY',
      },
    }
    const original = structuredClone(noncanonicalRequest)

    await router.route(noncanonicalRequest, { provider: 'canonical-cache' })
    await router.route(request, { provider: 'canonical-cache' })

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0].instrument).not.toBe(noncanonicalRequest.instrument)
    expect(noncanonicalRequest).toEqual(original)
  })
})

describe('retry, circuit breaker, and rate limiting', () => {
  it('retries transport/429 failures, respects Retry-After, and skips auth retries', async () => {
    const delays: number[] = []
    let calls = 0
    const value = await withRetry(async () => {
      calls += 1
      if (calls < 3) {
        throw new FinanceDataError('slow down', 'rate-limited', { retryAfterMs: 750 })
      }
      return 42
    }, { maxAttempts: 3, baseDelayMs: 100, jitterRatio: 0 }, {
      sleep: async delay => { delays.push(delay) },
    })
    expect(value).toBe(42)
    expect(delays).toEqual([750, 750])
    expect(retryAfterMs({ headers: { get: () => '2' } })).toBe(2_000)
    await withRetry(async () => {
      throw new FinanceDataError('server asks for a long delay', 'rate-limited', { retryAfterMs: 4_000 })
    }, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 }, {
      sleep: async delay => { delays.push(delay); throw new FinanceDataError('stop', 'aborted') },
    }).catch(() => undefined)
    expect(delays.at(-1)).toBe(4_000)

    calls = 0
    await expect(withRetry(async () => {
      calls += 1
      throw new FinanceDataError('bad key', 'unauthorized')
    }, { maxAttempts: 5 }, { sleep: async () => undefined })).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(calls).toBe(1)
  })

  it('opens after consecutive failures and closes after a successful half-open probe', async () => {
    let now = 0
    const breaker = new CircuitBreaker(
      { failureThreshold: 2, openDurationMs: 100, halfOpenMaxRequests: 1 },
      { now: () => now },
    )
    const failure = async () => { throw new FinanceDataError('down', 'transport') }
    await expect(breaker.execute(failure)).rejects.toThrow('down')
    await expect(breaker.execute(failure)).rejects.toThrow('down')
    expect(breaker.state).toBe('open')
    await expect(breaker.execute(async () => 'unreachable')).rejects.toMatchObject({ kind: 'circuit-open' })
    now = 100
    expect(breaker.state).toBe('half-open')
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok')
    expect(breaker.state).toBe('closed')
  })

  it('limits provider concurrency and queues excess work', async () => {
    const limiter = new RateLimiter({ concurrency: 1, minIntervalMs: 0 })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []
    const first = limiter.run(async () => { order.push('first:start'); await gate; order.push('first:end') })
    const second = limiter.run(async () => { order.push('second:start') })
    await Promise.resolve()
    expect(limiter.activeCount).toBe(1)
    expect(limiter.pendingCount).toBe(1)
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })
})

describe('security boundaries and redaction', () => {
  it('rejects arbitrary URLs, secret-bearing keys, invalid market, and cross-market instruments', () => {
    expect(() => assertCapabilityRequestBoundary({
      ...request,
      params: { endpoint: 'https://evil.test' },
    })).toThrowError(expect.objectContaining({ kind: 'invalid-request' }))
    expect(() => assertCapabilityRequestBoundary({
      ...request,
      params: { note: 'visit https://evil.test/callback' },
    })).toThrow(/arbitrary URLs/)
    expect(() => assertCapabilityRequestBoundary({
      ...request,
      params: { nested: { callback: 'file:///etc/passwd' } },
    })).toThrow(/arbitrary URLs/)
    expect(() => assertCapabilityRequestBoundary({
      ...request,
      params: { outputPath: '../secret' },
    })).toThrow(/unsafe path-like/)
    expect(() => assertCapabilityRequestBoundary({ ...request, market: '../../CN' })).toThrow(/market/)
    expect(() => assertCapabilityRequestBoundary({ ...request, market: 'US' })).toThrowError(
      expect.objectContaining({ kind: 'conflicting-instrument' }),
    )
    expect(() => assertCapabilityRequestBoundary({
      ...request,
      instrument: { ...request.instrument!, exchange: 'SZSE' },
    })).toThrowError(expect.objectContaining({ kind: 'conflicting-instrument' }))
  })

  it('rejects unknown quote params before adapter execution and accepts curated fields', async () => {
    const execute = vi.fn(async () => result('boundary'))
    const service = new FinanceDataService().register(registration('boundary', execute))
    const invalidOutcome = await service.execute({
      ...request,
      params: { frobnicate: 1 },
    }, { cache: false }).then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    )

    expect.soft(invalidOutcome).toMatchObject({
      status: 'rejected',
      reason: { kind: 'invalid-request' },
    })
    expect.soft(execute).not.toHaveBeenCalled()

    execute.mockClear()
    await expect(service.execute({
      ...request,
      params: { fields: ['last', 'volume'] },
    }, { cache: false })).resolves.toMatchObject({ status: 'available' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('redacts query/path tokens and free-form authorization text', () => {
    const secret = '0123456789abcdefghijklmnopqrstuvwxyz'
    const value = redactUrl(`https://user:pass@example.test/mcp/token/${secret}?token=${secret}&symbol=600519#${secret}`)
    expect(value).toContain('https://example.test/')
    expect(value).toContain('symbol=600519')
    expect(value).not.toContain(secret)
    expect(value).not.toContain('user:pass')
    expect(redactSensitiveText(`Authorization: Bearer ${secret}; password=${secret}`)).not.toContain(secret)
    expect(redactUrl('not a URL')).toBe('[REDACTED]')
  })

  it.each(['authToken', 'bearerToken', 'clientSecret'])(
    'redacts camelCase credential key %s across URLs and free-form text',
    key => {
      const marker = ['short', 'fixture', 'value'].join('-')
      expect(redactUrl(`https://example.test/mcp?${key}=${marker}`)).not.toContain(marker)
      expect(redactUrl(`https://example.test/mcp/${key}=${marker}`)).not.toContain(marker)
      expect(redactSensitiveText(`${key}=${marker}`)).not.toContain(marker)
    },
  )

  it.each(['accessToken', 'credential', 'sig'])(
    'redacts sensitive free-form key %s consistently with URL redaction',
    key => {
      const marker = ['short', 'fixture', 'value'].join('-')
      expect(redactSensitiveText(`${key}=${marker}`)).not.toContain(marker)
    },
  )
})
