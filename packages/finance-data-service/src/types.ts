import type {
  CanonicalDataResult,
  DataCapability,
  InstrumentId,
  Market,
  ProviderHealth,
} from '@finance2dsh/core'

export type ProviderQualityTier =
  | 'authoritative'
  | 'standard'
  | 'fallback'
  | 'experimental'
  | (string & {})
export type ProviderAuthMode =
  | 'none'
  | 'api-key'
  | 'oauth'
  | 'local'
  | 'custom'
  | (string & {})

export interface RateLimitOptions {
  concurrency: number
  minIntervalMs: number
}

export interface RetryOptions {
  /** Total calls, including the initial attempt. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

export interface CircuitBreakerOptions {
  failureThreshold: number
  openDurationMs: number
  halfOpenMaxRequests: number
}

/** Runtime-facing request shape; undefined optionals are accepted and rejected only when required by a capability. */
export interface ServiceCapabilityRequest {
  capability: DataCapability
  market: Market
  instrument?: InstrumentId | undefined
  asOf?: string | undefined
  params?: unknown
  signal?: AbortSignal | undefined
}

export interface CapabilityAdapter {
  execute<T = unknown>(request: ServiceCapabilityRequest): Promise<CanonicalDataResult<T>>
  health?(signal?: AbortSignal): Promise<ProviderHealth>
}

export interface ProviderRegistration {
  providerId: string
  adapter: CapabilityAdapter
  capabilities: readonly DataCapability[]
  markets: readonly string[]
  qualityTier: ProviderQualityTier
  authMode: ProviderAuthMode
  /** Higher values route first. Registration order breaks ties. */
  priority?: number
  rateLimit?: Partial<RateLimitOptions>
  retry?: Partial<RetryOptions>
  circuitBreaker?: Partial<CircuitBreakerOptions>
}

export interface RouteOptions {
  provider?: 'auto' | string
  fallback?: boolean
  allowStale?: boolean
  cache?: boolean
}

export interface ProviderCatalogEntry {
  providerId: string
  capabilities: readonly DataCapability[]
  markets: readonly string[]
  qualityTier: ProviderQualityTier
  authMode: ProviderAuthMode
  priority: number
  health: ProviderHealth
}
