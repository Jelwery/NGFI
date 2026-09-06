import {
  DATA_CAPABILITIES,
  PROVIDER_HEALTH_STATUSES,
  FinanceDataError,
  dataErrorKind,
} from '@finance2dsh/core'
import type { DataCapability, ProviderHealth } from '@finance2dsh/core'
import { CircuitBreaker } from './circuit-breaker.js'
import { RateLimiter } from './rate-limiter.js'
import { redactSensitiveText } from './redaction.js'
import { assertProviderId } from './safety.js'
import type { ProviderCatalogEntry, ProviderRegistration } from './types.js'

export interface RegisteredProvider {
  readonly registration: Readonly<ProviderRegistration>
  readonly limiter: RateLimiter
  readonly circuit: CircuitBreaker
  readonly registrationOrder: number
}

const DEFAULT_RATE_LIMIT = { concurrency: 4, minIntervalMs: 0 } as const

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>()
  private order = 0

  constructor(initial: readonly ProviderRegistration[] = []) {
    initial.forEach(registration => this.register(registration))
  }

  register(registration: ProviderRegistration): this {
    if (registration === null || typeof registration !== 'object') {
      throw new FinanceDataError('provider registration must be an object', 'invalid-request')
    }
    assertProviderId(registration.providerId)
    if (this.providers.has(registration.providerId)) {
      throw new FinanceDataError(`provider already registered: ${registration.providerId}`, 'invalid-request')
    }
    if (!Array.isArray(registration.capabilities) || registration.capabilities.length === 0) {
      throw new FinanceDataError('provider registration requires at least one capability', 'invalid-request')
    }
    if (registration.capabilities.some(capability => !DATA_CAPABILITIES.includes(capability))) {
      throw new FinanceDataError('provider registration contains an unknown capability', 'invalid-request')
    }
    if (!Array.isArray(registration.markets)
      || registration.markets.length === 0
      || registration.markets.some(market => typeof market !== 'string' || !/^(?:\*|[A-Za-z0-9_-]{1,16})$/.test(market))) {
      throw new FinanceDataError('provider registration requires at least one canonical market', 'invalid-request')
    }
    if (registration.adapter === null || typeof registration.adapter !== 'object'
      || typeof registration.adapter.execute !== 'function'
      || (registration.adapter.health !== undefined && typeof registration.adapter.health !== 'function')) {
      throw new FinanceDataError('provider registration requires a valid capability adapter', 'invalid-request')
    }
    if (typeof registration.qualityTier !== 'string' || registration.qualityTier.trim() === ''
      || typeof registration.authMode !== 'string' || registration.authMode.trim() === '') {
      throw new FinanceDataError('provider registration requires qualityTier and authMode', 'invalid-request')
    }
    if (registration.priority !== undefined && !Number.isFinite(registration.priority)) {
      throw new FinanceDataError('provider priority must be finite', 'invalid-request')
    }
    validateResilienceOptions(registration)
    const capabilities = Object.freeze([...new Set(registration.capabilities)])
    const markets = Object.freeze([...new Set(registration.markets.map(market => market.toUpperCase()))])
    const resilience = {
      ...(registration.rateLimit === undefined ? {} : { rateLimit: Object.freeze({ ...registration.rateLimit }) }),
      ...(registration.retry === undefined ? {} : { retry: Object.freeze({ ...registration.retry }) }),
      ...(registration.circuitBreaker === undefined
        ? {}
        : { circuitBreaker: Object.freeze({ ...registration.circuitBreaker }) }),
    }
    const normalized: ProviderRegistration = Object.freeze({
      ...registration,
      capabilities,
      markets,
      ...resilience,
    })
    const rateLimit = { ...DEFAULT_RATE_LIMIT, ...registration.rateLimit }
    this.providers.set(registration.providerId, {
      registration: normalized,
      limiter: new RateLimiter(rateLimit),
      circuit: new CircuitBreaker(registration.circuitBreaker),
      registrationOrder: this.order,
    })
    this.order += 1
    return this
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId)
  }

  get(providerId: string): RegisteredProvider | undefined {
    return this.providers.get(providerId)
  }

  require(providerId: string): RegisteredProvider {
    const provider = this.get(providerId)
    if (provider === undefined) {
      throw new FinanceDataError(`unknown provider: ${providerId}`, 'unsupported', { retryable: false })
    }
    return provider
  }

  select(capability: DataCapability, market: string): RegisteredProvider[] {
    const normalizedMarket = market.toUpperCase()
    return [...this.providers.values()]
      .filter(({ registration }) => registration.capabilities.includes(capability)
        && registration.markets.some(value => value === '*' || value.toUpperCase() === normalizedMarket))
      .sort((left, right) => {
        const priority = (right.registration.priority ?? 0) - (left.registration.priority ?? 0)
        return priority === 0 ? left.registrationOrder - right.registrationOrder : priority
      })
  }

  list(): Readonly<ProviderRegistration>[] {
    return [...this.providers.values()].map(provider => cloneRegistration(provider.registration))
  }

  /** Resolve one provider's canonical health, including its local circuit state. */
  async health(
    providerId: string,
    signal?: AbortSignal,
    now: () => number = Date.now,
  ): Promise<ProviderHealth> {
    const registered = this.require(providerId)
    const registration = registered.registration
    throwIfHealthAborted(signal, providerId)

    const circuit = registered.circuit.snapshot()
    if (circuit.state === 'open') {
      const checkedAt = safeNow(now)
      return {
        providerId,
        status: 'circuit-open',
        checkedAt: new Date(checkedAt).toISOString(),
        ...(circuit.retryAt === undefined ? {} : { retryAfterMs: Math.max(0, circuit.retryAt - checkedAt) }),
      }
    }
    if (registration.adapter.health === undefined) {
      return {
        providerId,
        status: 'healthy',
        checkedAt: new Date(safeNow(now)).toISOString(),
      }
    }

    try {
      const reported = signal === undefined
        ? await registration.adapter.health()
        : await registration.adapter.health(signal)
      throwIfHealthAborted(signal, providerId)
      assertProviderHealth(reported, providerId)
      return {
        ...reported,
        providerId,
        ...(reported.message === undefined ? {} : { message: redactSensitiveText(reported.message) }),
        ...(reported.capabilities === undefined ? {} : { capabilities: { ...reported.capabilities } }),
      }
    } catch (error) {
      if (signal?.aborted === true || dataErrorKind(error) === 'aborted') {
        throw new FinanceDataError('provider health check was aborted', 'aborted', {
          provider: providerId,
          retryable: false,
        })
      }
      return {
        providerId,
        status: 'unavailable',
        checkedAt: new Date(safeNow(now)).toISOString(),
        message: safeHealthErrorMessage(error),
      }
    }
  }

  async catalog(now: () => number = Date.now): Promise<ProviderCatalogEntry[]> {
    const result: ProviderCatalogEntry[] = []
    for (const registered of this.providers.values()) {
      const registration = registered.registration
      const health = await this.health(registration.providerId, undefined, now)
      result.push({
        providerId: registration.providerId,
        capabilities: Object.freeze([...registration.capabilities]),
        markets: Object.freeze([...registration.markets]),
        qualityTier: registration.qualityTier,
        authMode: registration.authMode,
        priority: registration.priority ?? 0,
        health,
      })
    }
    return result
  }
}

function assertProviderHealth(health: ProviderHealth, providerId: string): void {
  if (health === null || typeof health !== 'object'
    || Array.isArray(health)
    || !PROVIDER_HEALTH_STATUSES.includes(health.status)
    || typeof health.checkedAt !== 'string'
    || !Number.isFinite(Date.parse(health.checkedAt))
    || (health.message !== undefined && typeof health.message !== 'string')
    || (health.retryAfterMs !== undefined
      && (!Number.isFinite(health.retryAfterMs) || health.retryAfterMs < 0))) {
    throw new FinanceDataError('provider health response has an invalid canonical shape', 'schema-drift', {
      provider: providerId,
      retryable: false,
    })
  }
  if (health.capabilities !== undefined
    && (health.capabilities === null || typeof health.capabilities !== 'object'
      || Array.isArray(health.capabilities)
      || Object.entries(health.capabilities).some(([capability, status]) => (
        !DATA_CAPABILITIES.includes(capability as DataCapability)
        || !PROVIDER_HEALTH_STATUSES.includes(status)
      )))) {
    throw new FinanceDataError(
      'provider capability health response has an invalid canonical shape',
      'schema-drift',
      { provider: providerId, retryable: false },
    )
  }
}

function throwIfHealthAborted(signal: AbortSignal | undefined, providerId: string): void {
  if (signal?.aborted !== true) return
  throw new FinanceDataError('provider health check was aborted', 'aborted', {
    provider: providerId,
    retryable: false,
  })
}

function safeHealthErrorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return redactSensitiveText(message).slice(0, 1_024)
  } catch {
    return 'provider health check failed'
  }
}

function safeNow(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value)) throw new RangeError('provider catalog clock must return a finite timestamp')
  return value
}

function cloneRegistration(registration: Readonly<ProviderRegistration>): Readonly<ProviderRegistration> {
  return Object.freeze({
    ...registration,
    capabilities: Object.freeze([...registration.capabilities]),
    markets: Object.freeze([...registration.markets]),
    ...(registration.rateLimit === undefined ? {} : { rateLimit: Object.freeze({ ...registration.rateLimit }) }),
    ...(registration.retry === undefined ? {} : { retry: Object.freeze({ ...registration.retry }) }),
    ...(registration.circuitBreaker === undefined
      ? {}
      : { circuitBreaker: Object.freeze({ ...registration.circuitBreaker }) }),
  })
}

function validateResilienceOptions(registration: ProviderRegistration): void {
  if (registration.rateLimit !== undefined) {
    if ((registration.rateLimit.concurrency !== undefined
      && (!Number.isInteger(registration.rateLimit.concurrency) || registration.rateLimit.concurrency < 1))
      || (registration.rateLimit.minIntervalMs !== undefined
        && (!Number.isFinite(registration.rateLimit.minIntervalMs) || registration.rateLimit.minIntervalMs < 0))) {
      throw new FinanceDataError('provider rateLimit options are invalid', 'invalid-request')
    }
  }
  if (registration.retry !== undefined) {
    if ((registration.retry.maxAttempts !== undefined
      && (!Number.isInteger(registration.retry.maxAttempts) || registration.retry.maxAttempts < 1))
      || (registration.retry.baseDelayMs !== undefined
        && (!Number.isFinite(registration.retry.baseDelayMs) || registration.retry.baseDelayMs < 0))
      || (registration.retry.maxDelayMs !== undefined
        && (!Number.isFinite(registration.retry.maxDelayMs) || registration.retry.maxDelayMs < 0))
      || (registration.retry.jitterRatio !== undefined
        && (!Number.isFinite(registration.retry.jitterRatio)
          || registration.retry.jitterRatio < 0
          || registration.retry.jitterRatio > 1))) {
      throw new FinanceDataError('provider retry options are invalid', 'invalid-request')
    }
  }
  if (registration.circuitBreaker !== undefined) {
    if ((registration.circuitBreaker.failureThreshold !== undefined
      && (!Number.isInteger(registration.circuitBreaker.failureThreshold)
        || registration.circuitBreaker.failureThreshold < 1))
      || (registration.circuitBreaker.openDurationMs !== undefined
        && (!Number.isFinite(registration.circuitBreaker.openDurationMs)
          || registration.circuitBreaker.openDurationMs < 0))
      || (registration.circuitBreaker.halfOpenMaxRequests !== undefined
        && (!Number.isInteger(registration.circuitBreaker.halfOpenMaxRequests)
          || registration.circuitBreaker.halfOpenMaxRequests < 1))) {
      throw new FinanceDataError('provider circuitBreaker options are invalid', 'invalid-request')
    }
  }
}
