import type { CanonicalDataResult, DataCapability } from '@finance2dsh/core'

export interface CachePolicy {
  ttlMs: number
  staleTtlMs: number
}

export interface CacheLookup<T> {
  state: 'fresh' | 'stale' | 'miss'
  value?: T
  ageMs?: number
}

interface CacheEntry<T> {
  value: T
  createdAt: number
  expiresAt: number
  staleUntil: number
}

export interface MemoryCacheOptions {
  maxEntries?: number
  now?: () => number
}

export const DEFAULT_CACHE_POLICIES: Readonly<Record<DataCapability, CachePolicy>> = {
  'instrument-reference': { ttlMs: 24 * 60 * 60_000, staleTtlMs: 7 * 24 * 60 * 60_000 },
  quote: { ttlMs: 5_000, staleTtlMs: 5 * 60_000 },
  'market-bars': { ttlMs: 60_000, staleTtlMs: 24 * 60 * 60_000 },
  'order-book': { ttlMs: 1_000, staleTtlMs: 30_000 },
  fundamentals: { ttlMs: 6 * 60 * 60_000, staleTtlMs: 7 * 24 * 60 * 60_000 },
  'corporate-actions': { ttlMs: 60 * 60_000, staleTtlMs: 7 * 24 * 60 * 60_000 },
  disclosures: { ttlMs: 5 * 60_000, staleTtlMs: 24 * 60 * 60_000 },
  'research-consensus': { ttlMs: 60 * 60_000, staleTtlMs: 24 * 60 * 60_000 },
  'capital-flow': { ttlMs: 30_000, staleTtlMs: 30 * 60_000 },
  'market-signal': { ttlMs: 30_000, staleTtlMs: 30 * 60_000 },
  'industry-classification': { ttlMs: 24 * 60 * 60_000, staleTtlMs: 7 * 24 * 60 * 60_000 },
  index: { ttlMs: 60 * 60_000, staleTtlMs: 24 * 60 * 60_000 },
  macro: { ttlMs: 6 * 60 * 60_000, staleTtlMs: 7 * 24 * 60 * 60_000 },
  'trading-calendar': { ttlMs: 24 * 60 * 60_000, staleTtlMs: 30 * 24 * 60 * 60_000 },
  'risk-data': { ttlMs: 60 * 60_000, staleTtlMs: 24 * 60 * 60_000 },
}

export class MemoryCache<T = unknown> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1_000
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError('cache maxEntries must be a positive integer')
    }
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  set(key: string, value: T, policy: CachePolicy): void {
    validatePolicy(policy)
    const now = this.now()
    if (!Number.isFinite(now)) throw new TypeError('cache clock must return a finite timestamp')
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, {
      value: cloneOrThrow(value),
      createdAt: now,
      expiresAt: now + policy.ttlMs,
      staleUntil: now + policy.ttlMs + policy.staleTtlMs,
    })
    this.evict()
  }

  get(key: string, allowStale = false): CacheLookup<T> {
    const entry = this.entries.get(key)
    if (entry === undefined) return { state: 'miss' }
    const now = this.now()
    if (!Number.isFinite(now)) throw new TypeError('cache clock must return a finite timestamp')
    if (now < entry.expiresAt) {
      this.touch(key, entry)
      return { state: 'fresh', value: cloneOrThrow(entry.value), ageMs: now - entry.createdAt }
    }
    if (now < entry.staleUntil) {
      if (allowStale) {
        this.touch(key, entry)
        return { state: 'stale', value: cloneOrThrow(entry.value), ageMs: now - entry.createdAt }
      }
      return { state: 'stale', ageMs: now - entry.createdAt }
    }
    this.entries.delete(key)
    return { state: 'miss' }
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.entries.delete(oldest)
    }
  }
}

export function markResultStale<T>(
  result: CanonicalDataResult<T>,
  reason: string,
): CanonicalDataResult<T> {
  return {
    ...structuredClone(result),
    status: 'stale',
    warnings: [...result.warnings, reason],
  }
}

function validatePolicy(policy: CachePolicy): void {
  if (!Number.isFinite(policy.ttlMs) || policy.ttlMs < 0
    || !Number.isFinite(policy.staleTtlMs) || policy.staleTtlMs < 0) {
    throw new RangeError('cache TTL values must be non-negative finite numbers')
  }
}

function cloneOrThrow<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError('cache values must be structured-clone safe', { cause: error })
  }
}
