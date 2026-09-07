import type { ProviderHealth } from '@finance2dsh/core'
import type { AStockProviderOptions } from './types.js'
import { AStockProvider } from './provider.js'
import { ASTOCK_CAPABILITIES, ASTOCK_PROVIDER_ID } from './types.js'

/** Structural registration consumed by finance-data-service without a package cycle. */
export interface AStockProviderRegistration {
  providerId: typeof ASTOCK_PROVIDER_ID
  adapter: AStockProvider & { health(): Promise<ProviderHealth> }
  capabilities: typeof ASTOCK_CAPABILITIES
  markets: readonly ['CN']
  qualityTier: 'fallback'
  authMode: 'none'
  priority: number
  rateLimit: { concurrency: 1; minIntervalMs: number }
  retry: { maxAttempts: 2; baseDelayMs: 1_000; maxDelayMs: 5_000; jitterRatio: 0.2 }
  circuitBreaker: { failureThreshold: 3; openDurationMs: 60_000; halfOpenMaxRequests: 1 }
}

export function createAStockProviderRegistration(
  options: AStockProviderOptions = {},
): AStockProviderRegistration {
  return {
    providerId: ASTOCK_PROVIDER_ID,
    adapter: new AStockProvider(options),
    capabilities: ASTOCK_CAPABILITIES,
    markets: ['CN'],
    qualityTier: 'fallback',
    authMode: 'none',
    priority: 10,
    rateLimit: {
      concurrency: 1,
      minIntervalMs: options.minRequestIntervalMs ?? (options.source === 'fixture' ? 0 : 1_000),
    },
    retry: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 5_000, jitterRatio: 0.2 },
    circuitBreaker: { failureThreshold: 3, openDurationMs: 60_000, halfOpenMaxRequests: 1 },
  }
}
