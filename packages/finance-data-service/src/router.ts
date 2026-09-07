import {
  ADJUSTMENT_MODES,
  DATA_STATUSES,
  SOURCE_KINDS,
  FinanceDataError,
  assertJsonSafe,
  dataErrorKind,
  isRetryableDataError,
} from '@finance2dsh/core'
import type {
  CanonicalDataResult,
  CapabilityRequest,
  DataProvenance,
  DataStatus,
  FallbackAttempt,
  ProviderHealth,
  ProviderHealthStatus,
} from '@finance2dsh/core'
import { DEFAULT_CACHE_POLICIES, MemoryCache, markResultStale } from './cache.js'
import type { CachePolicy } from './cache.js'
import { ProviderRegistry } from './registry.js'
import type { RegisteredProvider } from './registry.js'
import { redactSensitiveText, redactUrl } from './redaction.js'
import { withRetry } from './retry.js'
import type { RetryDependencies } from './retry.js'
import { assertCapabilityRequestBoundary, assertProviderId } from './safety.js'
import type { RetryOptions, RouteOptions, ServiceCapabilityRequest } from './types.js'

const USABLE_STATUSES: ReadonlySet<DataStatus> = new Set(['available', 'partial', 'stale'])
const ROUTABLE_HEALTH_STATUSES: ReadonlySet<ProviderHealthStatus> = new Set(['healthy', 'degraded'])
const DEFAULT_HEALTH_CACHE_TTL_MS = 5_000

export interface ProviderRouterOptions extends RetryDependencies {
  cache?: MemoryCache<CanonicalDataResult<unknown>>
  cachePolicies?: Partial<Record<CapabilityRequest['capability'], CachePolicy>>
  defaultRetry?: Partial<RetryOptions>
  now?: () => number
  maxResultBytes?: number
  /** Cache successful and failed health probes briefly; zero checks every automatic request. */
  healthCacheTtlMs?: number
}

interface StaleCandidate<T> {
  result: CanonicalDataResult<T>
  providerId: string
  ageMs: number
  qualityTier: string
}

interface CanonicalFallbackCandidate<T> {
  result: CanonicalDataResult<T>
  providerId: string
  qualityTier: string
  attemptIndex: number
}

interface CachedHealth {
  health: ProviderHealth
  expiresAt: number
}

class CanonicalNonSuccessError<T> extends FinanceDataError {
  constructor(
    readonly result: CanonicalDataResult<T>,
    providerId: string,
  ) {
    super(
      `provider returned canonical status ${result.status}`,
      statusToErrorKind(result.status),
      { provider: providerId },
    )
  }
}

export class ProviderRouter {
  readonly registry: ProviderRegistry
  private readonly cache: MemoryCache<CanonicalDataResult<unknown>>
  private readonly cachePolicies: Readonly<Record<CapabilityRequest['capability'], CachePolicy>>
  private readonly defaultRetry: Partial<RetryOptions>
  private readonly now: () => number
  private readonly retryDependencies: RetryDependencies
  private readonly maxResultBytes: number
  private readonly healthCacheTtlMs: number
  private readonly healthCache = new WeakMap<RegisteredProvider, CachedHealth>()
  private readonly inFlight = new Map<string, Promise<CanonicalDataResult<unknown>>>()
  private readonly abortIds = new WeakMap<AbortSignal, number>()
  private nextAbortId = 1

  constructor(registry: ProviderRegistry, options: ProviderRouterOptions = {}) {
    this.registry = registry
    this.now = options.now ?? Date.now
    this.cache = options.cache ?? new MemoryCache({ now: this.now })
    this.cachePolicies = { ...DEFAULT_CACHE_POLICIES, ...options.cachePolicies }
    Object.values(this.cachePolicies).forEach(policy => {
      if (!Number.isFinite(policy.ttlMs) || policy.ttlMs < 0
        || !Number.isFinite(policy.staleTtlMs) || policy.staleTtlMs < 0) {
        throw new RangeError('router cache policies require non-negative finite TTL values')
      }
    })
    this.defaultRetry = options.defaultRetry ?? {}
    if (options.defaultRetry !== undefined) validateRetryOptions(options.defaultRetry)
    this.retryDependencies = {
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.random === undefined ? {} : { random: options.random }),
    }
    this.maxResultBytes = options.maxResultBytes ?? 4 * 1024 * 1024
    if (!Number.isInteger(this.maxResultBytes) || this.maxResultBytes < 1) {
      throw new RangeError('maxResultBytes must be a positive integer')
    }
    this.healthCacheTtlMs = options.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS
    if (!Number.isFinite(this.healthCacheTtlMs) || this.healthCacheTtlMs < 0) {
      throw new RangeError('healthCacheTtlMs must be a non-negative finite number')
    }
  }

  execute<T>(
    request: ServiceCapabilityRequest,
    options: RouteOptions = {},
  ): Promise<CanonicalDataResult<T>> {
    return this.route(request, options)
  }

  async route<T>(
    request: ServiceCapabilityRequest,
    options: RouteOptions = {},
  ): Promise<CanonicalDataResult<T>> {
    request = assertCapabilityRequestBoundary(request)
    const requestedProvider = options.provider === undefined || options.provider === 'auto'
      ? undefined
      : assertProviderId(options.provider)
    const fallbackEnabled = options.fallback ?? requestedProvider === undefined
    const candidates = this.candidates(request, requestedProvider, fallbackEnabled)
    if (candidates.length === 0) {
      throw new FinanceDataError(
        `no provider supports ${request.capability} for market ${request.market}`,
        'unsupported',
        { retryable: false },
      )
    }

    const attempts: FallbackAttempt[] = []
    let lastError: unknown
    let staleCandidate: StaleCandidate<T> | undefined
    let canonicalFallback: CanonicalFallbackCandidate<T> | undefined
    let terminalError = false
    const bestQualityRank = Math.max(...candidates.map(candidate => (
      qualityRank(candidate.registration.qualityTier)
    )))

    for (const candidate of candidates) {
      const providerId = candidate.registration.providerId
      const cacheKey = makeCacheKey(providerId, candidate.registrationOrder, request)
      let freshCandidate: CanonicalDataResult<T> | undefined
      if (options.cache !== false) {
        const cached = this.cache.get(cacheKey, true)
        if (cached.state === 'fresh' && cached.value !== undefined) {
          this.validateResult(cached.value, providerId, request)
          freshCandidate = cached.value as CanonicalDataResult<T>
        }
        if (cached.state === 'stale' && cached.value !== undefined && staleCandidate === undefined) {
          this.validateResult(cached.value, providerId, request)
          staleCandidate = {
            result: cached.value as CanonicalDataResult<T>,
            providerId,
            ageMs: cached.ageMs ?? 0,
            qualityTier: candidate.registration.qualityTier,
          }
        }
      }
      if (requestedProvider === undefined) {
        const health = await this.providerHealth(candidate, request.signal)
        const capabilityStatus = health.capabilities?.[request.capability]
        const blockingStatus = !ROUTABLE_HEALTH_STATUSES.has(health.status)
          ? health.status
          : capabilityStatus !== undefined && !ROUTABLE_HEALTH_STATUSES.has(capabilityStatus)
            ? capabilityStatus
            : undefined
        if (blockingStatus !== undefined) {
          lastError = healthStatusError(providerId, blockingStatus)
          attempts.push({
            provider: providerId,
            outcome: 'skipped',
            reason: safeHealthReason(blockingStatus, health.message),
            qualityTier: candidate.registration.qualityTier,
          })
          continue
        }
      }
      if (freshCandidate !== undefined) {
        attempts.push({
          provider: providerId,
          outcome: 'success',
          reason: 'fresh memory cache',
          qualityTier: candidate.registration.qualityTier,
        })
        return this.withRoutingProvenance(
          freshCandidate,
          providerId,
          requestedProvider,
          attempts,
          candidate.registration.qualityTier,
          bestQualityRank,
        )
      }
      try {
        const result = await this.executeProvider<T>(candidate, request)
        if (!USABLE_STATUSES.has(result.status)) {
          const attemptIndex = attempts.length
          attempts.push({
            provider: providerId,
            outcome: fallbackEnabled ? 'rejected' : 'selected',
            reason: `canonical status ${result.status}`,
            qualityTier: candidate.registration.qualityTier,
          })
          canonicalFallback = {
            result,
            providerId,
            qualityTier: candidate.registration.qualityTier,
            attemptIndex,
          }
          if (!fallbackEnabled) {
            return this.withRoutingProvenance(
              result, providerId, requestedProvider, attempts,
              candidate.registration.qualityTier, bestQualityRank,
            )
          }
          continue
        }
        attempts.push({ provider: providerId, outcome: 'success', qualityTier: candidate.registration.qualityTier })
        const routed = this.withRoutingProvenance(
          result, providerId, requestedProvider, attempts, candidate.registration.qualityTier, bestQualityRank,
        )
        if (options.cache !== false && result.status !== 'stale') {
          const sanitized = this.withRoutingProvenance(
            result, providerId, undefined, [], candidate.registration.qualityTier,
            qualityRank(candidate.registration.qualityTier),
          )
          this.cache.set(cacheKey, sanitized as CanonicalDataResult<unknown>, this.cachePolicies[request.capability])
        }
        return routed
      } catch (error) {
        lastError = error
        if (request.signal?.aborted === true) {
          lastError = new FinanceDataError('request was aborted during provider execution', 'aborted', {
            retryable: false,
          })
        }
        const kind = dataErrorKind(lastError)
        attempts.push({
          provider: providerId,
          outcome: 'failed',
          reason: safeErrorReason(lastError),
          qualityTier: candidate.registration.qualityTier,
        })
        if (kind === 'aborted' || kind === 'invalid-request' || kind === 'conflicting-instrument'
          || kind === 'ambiguous-instrument' || !fallbackEnabled) {
          terminalError = kind === 'aborted' || kind === 'invalid-request'
            || kind === 'conflicting-instrument' || kind === 'ambiguous-instrument'
          break
        }
      }
    }

    throwIfAborted(request.signal)
    if (!terminalError && staleCandidate !== undefined && options.allowStale === true) {
      attempts.push({
        provider: staleCandidate.providerId,
        outcome: 'selected',
        reason: `stale memory cache (${staleCandidate.ageMs}ms old) after live providers failed`,
        qualityTier: staleCandidate.qualityTier,
      })
      const stale = markResultStale(
        staleCandidate.result,
        'Live providers failed; explicitly returning stale memory-cache data.',
      )
      return this.withRoutingProvenance(
        stale,
        staleCandidate.providerId,
        requestedProvider,
        attempts,
        staleCandidate.qualityTier,
        bestQualityRank,
      )
    }

    if (canonicalFallback !== undefined && !terminalError) {
      const selectedAttempts = attempts.map((attempt, index): FallbackAttempt => (
        index === canonicalFallback.attemptIndex
          ? { ...attempt, outcome: 'selected' }
          : attempt
      ))
      return this.withRoutingProvenance(
        canonicalFallback.result,
        canonicalFallback.providerId,
        requestedProvider,
        selectedAttempts,
        canonicalFallback.qualityTier,
        bestQualityRank,
      )
    }

    const message = attempts.length === 0
      ? `no provider supports ${request.capability} for market ${request.market}`
      : `all eligible providers failed for ${request.capability}: ${attempts.map(attempt => `${attempt.provider} (${attempt.reason ?? attempt.outcome})`).join('; ')}`
    throw new FinanceDataError(redactSensitiveText(message).slice(0, 2_048), dataErrorKind(lastError), {
      retryable: isRetryableDataError(lastError),
      details: { fallbackChain: attempts },
    })
  }

  private candidates(
    request: ServiceCapabilityRequest,
    requestedProvider: string | undefined,
    fallbackEnabled: boolean,
  ): RegisteredProvider[] {
    const eligible = this.registry.select(request.capability, request.market)
    if (requestedProvider === undefined) return eligible
    const requested = this.registry.require(requestedProvider)
    const isEligible = eligible.some(candidate => candidate.registration.providerId === requestedProvider)
    if (!isEligible) {
      throw new FinanceDataError(
        `provider ${requestedProvider} does not support ${request.capability} for market ${request.market}`,
        'unsupported',
        { retryable: false },
      )
    }
    if (!fallbackEnabled) return [requested]
    return [requested, ...eligible.filter(candidate => candidate.registration.providerId !== requestedProvider)]
  }

  private executeProvider<T>(
    provider: RegisteredProvider,
    request: ServiceCapabilityRequest,
  ): Promise<CanonicalDataResult<T>> {
    const baseKey = makeCacheKey(
      provider.registration.providerId, provider.registrationOrder, request,
    )
    const inFlightKey = request.signal === undefined
      ? baseKey
      : `${baseKey}:signal:${this.abortSignalId(request.signal)}`
    const existing = this.inFlight.get(inFlightKey)
    if (existing !== undefined) return existing as Promise<CanonicalDataResult<T>>
    const retry = { ...this.defaultRetry, ...provider.registration.retry }
    const pending = (async (): Promise<CanonicalDataResult<T>> => {
      try {
        return await provider.circuit.execute(() => withRetry(
          async () => {
            const result = await provider.limiter.run(
              () => provider.registration.adapter.execute<T>(request),
              request.signal,
            )
            this.validateResult(result, provider.registration.providerId, request)
            if (!USABLE_STATUSES.has(result.status)) {
              throw new CanonicalNonSuccessError(result, provider.registration.providerId)
            }
            return result
          },
          retry,
          { ...this.retryDependencies, ...(request.signal === undefined ? {} : { signal: request.signal }) },
        ))
      } catch (error) {
        if (error instanceof CanonicalNonSuccessError) return error.result as CanonicalDataResult<T>
        throw error
      }
    })()
    this.inFlight.set(inFlightKey, pending as Promise<CanonicalDataResult<unknown>>)
    pending.finally(() => {
      if (this.inFlight.get(inFlightKey) === pending) this.inFlight.delete(inFlightKey)
    }).catch(() => undefined)
    return pending
  }

  private async providerHealth(
    provider: RegisteredProvider,
    signal: AbortSignal | undefined,
  ): Promise<ProviderHealth> {
    throwIfAborted(signal)
    const providerId = provider.registration.providerId
    if (provider.circuit.snapshot().state === 'open') {
      return this.registry.health(providerId, signal, this.now)
    }
    const cached = this.healthCache.get(provider)
    if (cached !== undefined && this.currentTime() < cached.expiresAt) {
      return cached.health
    }
    const health = await this.registry.health(providerId, signal, this.now)
    throwIfAborted(signal)
    if (this.healthCacheTtlMs > 0) {
      this.healthCache.set(provider, {
        health,
        expiresAt: this.currentTime() + this.healthCacheTtlMs,
      })
    }
    return health
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isFinite(value)) throw new RangeError('provider router clock must return a finite timestamp')
    return value
  }

  private abortSignalId(signal: AbortSignal): number {
    const existing = this.abortIds.get(signal)
    if (existing !== undefined) return existing
    const id = this.nextAbortId
    this.nextAbortId += 1
    this.abortIds.set(signal, id)
    return id
  }

  private validateResult<T>(
    result: CanonicalDataResult<T>,
    providerId: string,
    request: ServiceCapabilityRequest,
  ): void {
    try {
      assertJsonSafe(result)
      const serialized = JSON.stringify(result)
      if (serialized === undefined || Buffer.byteLength(serialized) > this.maxResultBytes) {
        throw new TypeError('provider response exceeds the configured byte limit')
      }
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('provider response must be an object')
      }
      if (!DATA_STATUSES.includes(result.status)) throw new TypeError('unknown canonical result status')
      if (!Object.hasOwn(result, 'data') || result.data === undefined) {
        throw new TypeError('canonical result must include data as a value or null')
      }
      if (!Array.isArray(result.warnings) || result.warnings.some(warning => typeof warning !== 'string')) {
        throw new TypeError('canonical result warnings must be strings')
      }
      if (result.provenance === null || typeof result.provenance !== 'object' || Array.isArray(result.provenance)) {
        throw new TypeError('canonical result provenance must be an object')
      }
    } catch (error) {
      throw new FinanceDataError(`provider ${providerId} returned an invalid canonical response`, 'schema-drift', {
        provider: providerId,
        retryable: false,
        cause: error,
      })
    }
    if (containsUnsupportedValue(result)) {
      throw new FinanceDataError(
        `provider ${providerId} returned undefined, bigint, symbol, or function data`,
        'schema-drift',
        { provider: providerId, retryable: false },
      )
    }
    const provenance = result.provenance
    if (provenance === null || typeof provenance !== 'object'
      || typeof provenance.provider !== 'string'
      || typeof provenance.actualProvider !== 'string'
      || typeof provenance.upstreamSource !== 'string'
      || provenance.provider.trim() === ''
      || provenance.actualProvider.trim() === ''
      || provenance.upstreamSource.trim() === ''
      || !SOURCE_KINDS.includes(provenance.sourceKind)
      || typeof provenance.fetchedAt !== 'string'
      || !Number.isFinite(Date.parse(provenance.fetchedAt))
      || !Array.isArray(provenance.fallbackChain)
      || provenance.fallbackChain.some(attempt => attempt === null
        || typeof attempt !== 'object'
        || typeof attempt.provider !== 'string'
        || attempt.provider.trim() === ''
        || typeof attempt.outcome !== 'string'
        || (attempt.reason !== undefined && typeof attempt.reason !== 'string'))) {
      throw new FinanceDataError(`provider ${providerId} returned incomplete provenance`, 'schema-drift', { retryable: false })
    }
    if (provenance.provider !== providerId || provenance.actualProvider !== providerId) {
      throw new FinanceDataError(
        `provider ${providerId} returned mismatched provider provenance`,
        'schema-drift',
        { retryable: false },
      )
    }
    if (result.status === 'available' && result.data === null) {
      throw new FinanceDataError(`provider ${providerId} returned null data as available`, 'schema-drift', { retryable: false })
    }
    if (result.status === 'stale' && result.warnings.length === 0) {
      throw new FinanceDataError(
        `provider ${providerId} returned stale data without an explanation`,
        'schema-drift',
        { retryable: false },
      )
    }
    if (provenance.adjustment !== undefined && !ADJUSTMENT_MODES.includes(provenance.adjustment)) {
      throw new FinanceDataError(
        `provider ${providerId} returned an invalid price adjustment mode`,
        'schema-drift',
        { retryable: false },
      )
    }
    if (request.market.toUpperCase() === 'CN'
      && (request.capability === 'quote' || request.capability === 'market-bars')
      && provenance.adjustment === undefined) {
      throw new FinanceDataError(
        `provider ${providerId} omitted the A-share price adjustment mode`,
        'schema-drift',
        { retryable: false },
      )
    }
    for (const [name, timestamp] of [
      ['observedAt', provenance.observedAt],
      ['publishedAt', provenance.publishedAt],
      ['availableAt', provenance.availableAt],
    ] as const) {
      if (timestamp !== undefined && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))) {
        throw new FinanceDataError(
          `provider ${providerId} returned invalid ${name}`,
          'schema-drift',
          { retryable: false },
        )
      }
    }
    if (request.asOf !== undefined) {
      const visibleAt = provenance.availableAt ?? provenance.publishedAt ?? provenance.observedAt
      if (visibleAt === undefined) {
        throw new FinanceDataError(
          `provider ${providerId} omitted visibility time for an as-of request`,
          'schema-drift',
          { retryable: false },
        )
      }
      if (!Number.isFinite(Date.parse(visibleAt)) || Date.parse(visibleAt) > asOfCutoff(request.asOf, request.market)) {
        throw new FinanceDataError(
          `provider ${providerId} returned data unavailable at the requested as-of time`,
          'schema-drift',
          { retryable: false },
        )
      }
    }
  }

  private withRoutingProvenance<T>(
    result: CanonicalDataResult<T>,
    providerId: string,
    requestedProvider: string | undefined,
    attempts: readonly FallbackAttempt[],
    qualityTier: string,
    bestQualityRank: number,
  ): CanonicalDataResult<T> {
    const qualityDowngrade = qualityRank(qualityTier) < bestQualityRank
    const providerProvenance = structuredClone(result.provenance)
    delete providerProvenance.requestedProvider
    const provenance: DataProvenance = {
      ...providerProvenance,
      provider: providerId,
      actualProvider: providerId,
      upstreamSource: redactSensitiveText(result.provenance.upstreamSource),
      ...(requestedProvider === undefined ? {} : { requestedProvider }),
      ...(result.provenance.sourceUrl === undefined ? {} : { sourceUrl: redactUrl(result.provenance.sourceUrl) }),
      fallbackChain: [
        ...attempts.map(attempt => ({
          ...attempt,
          ...(attempt.reason === undefined ? {} : { reason: redactSensitiveText(attempt.reason) }),
        })),
        ...result.provenance.fallbackChain.map(attempt => ({
          ...attempt,
          ...(attempt.reason === undefined ? {} : { reason: redactSensitiveText(attempt.reason) }),
        })),
      ],
      qualityTier,
      qualityDowngrade,
    }
    return {
      ...structuredClone(result),
      provenance,
      warnings: result.warnings.map(warning => redactSensitiveText(warning)),
    }
  }
}

function makeCacheKey(
  providerId: string, registrationOrder: number, request: ServiceCapabilityRequest,
): string {
  return stableSerialize({
    providerId,
    registrationOrder,
    capability: request.capability,
    market: request.market.toUpperCase(),
    instrument: request.instrument,
    asOf: request.asOf,
    params: request.params,
  })
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(',')}}`
}

function safeErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${dataErrorKind(error)}: ${redactSensitiveText(message)}`.slice(0, 1_024)
}

function safeHealthReason(status: ProviderHealthStatus, message: string | undefined): string {
  const detail = message === undefined ? '' : `: ${redactSensitiveText(message)}`
  return `health ${status}${detail}`.slice(0, 1_024)
}

function healthStatusError(providerId: string, status: ProviderHealthStatus): FinanceDataError {
  const kind = status === 'unauthorized'
    ? 'unauthorized'
    : status === 'circuit-open'
      ? 'circuit-open'
      : status === 'dormant' || status === 'unsupported-platform'
        ? 'unsupported'
        : 'provider-error'
  return new FinanceDataError(`provider ${providerId} health is ${status}`, kind, { provider: providerId })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new FinanceDataError('request was aborted before provider execution', 'aborted', { retryable: false })
}

function statusToErrorKind(status: DataStatus): ConstructorParameters<typeof FinanceDataError>[1] {
  switch (status) {
    case 'no-data':
    case 'unsupported':
    case 'unauthorized':
    case 'insufficient-permission':
    case 'rate-limited':
    case 'provider-error':
    case 'schema-drift':
    case 'stale':
      return status
    case 'missing':
    case 'not-applicable':
      return 'no-data'
    default:
      return 'provider-error'
  }
}

function qualityRank(tier: string): number {
  return { authoritative: 4, standard: 3, fallback: 2, experimental: 1 }[tier] ?? 0
}

function asOfCutoff(asOf: string, market: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? Date.parse(`${asOf}T23:59:59.999${market.toUpperCase() === 'CN' ? '+08:00' : 'Z'}`)
    : Date.parse(asOf)
}

function containsUnsupportedValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return true
  }
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.some(item => containsUnsupportedValue(item, seen))
  if (Object.getPrototypeOf(value) !== Object.prototype) return true
  return Object.entries(value).some(([key, child]) => (
    ['__proto__', 'prototype', 'constructor'].includes(key) || containsUnsupportedValue(child, seen)
  ))
}

function validateRetryOptions(options: Partial<RetryOptions>): void {
  if ((options.maxAttempts !== undefined
    && (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1))
    || (options.baseDelayMs !== undefined
      && (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0))
    || (options.maxDelayMs !== undefined
      && (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0))
    || (options.jitterRatio !== undefined
      && (!Number.isFinite(options.jitterRatio)
        || options.jitterRatio < 0
        || options.jitterRatio > 1))) {
    throw new RangeError('router defaultRetry options are invalid')
  }
}
