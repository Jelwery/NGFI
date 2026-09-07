import { FinanceDataError, isRetryableDataError } from '@finance2dsh/core'
import type { RetryOptions } from './types.js'

export const DEFAULT_RETRY_OPTIONS: Readonly<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
}

export interface RetryDependencies {
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  if (error !== null && typeof error === 'object') {
    const candidate = error as {
      retryAfterMs?: unknown
      retryAfter?: unknown
      headers?: { get?(name: string): string | null } | Record<string, unknown>
    }
    if (typeof candidate.retryAfterMs === 'number' && Number.isFinite(candidate.retryAfterMs)) {
      return Math.max(0, candidate.retryAfterMs)
    }
    const raw = candidate.retryAfter
      ?? (typeof candidate.headers?.get === 'function'
        ? candidate.headers.get('retry-after')
        : (candidate.headers as Record<string, unknown> | undefined)?.['retry-after'])
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw * 1_000)
    if (typeof raw === 'string') {
      const seconds = Number(raw)
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
      const timestamp = Date.parse(raw)
      if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now)
    }
  }
  return undefined
}

export async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortedError()
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    function finish(): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortedError())
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> = {},
  dependencies: RetryDependencies & { signal?: AbortSignal } = {},
): Promise<T> {
  const merged = { ...DEFAULT_RETRY_OPTIONS, ...options }
  validateOptions(merged)
  const sleep = dependencies.sleep ?? sleepWithAbort
  const random = dependencies.random ?? Math.random
  let lastError: unknown

  for (let attempt = 1; attempt <= merged.maxAttempts; attempt += 1) {
    if (dependencies.signal?.aborted === true) throw abortedError()
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt === merged.maxAttempts || !isRetryableDataError(error)) throw error
      const exponential = Math.min(merged.maxDelayMs, merged.baseDelayMs * (2 ** (attempt - 1)))
      const jitter = exponential * merged.jitterRatio * ((random() * 2) - 1)
      const retryAfter = retryAfterMs(error)
      const delay = Math.max(retryAfter ?? 0, Math.max(0, exponential + jitter))
      await sleep(delay, dependencies.signal)
    }
  }
  throw lastError
}

function validateOptions(options: RetryOptions): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError('retry maxAttempts must be a positive integer')
  }
  if (![options.baseDelayMs, options.maxDelayMs, options.jitterRatio].every(Number.isFinite)
    || options.baseDelayMs < 0
    || options.maxDelayMs < 0
    || options.jitterRatio < 0
    || options.jitterRatio > 1) {
    throw new RangeError('retry delays must be non-negative and jitterRatio must be between zero and one')
  }
}

function abortedError(): FinanceDataError {
  return new FinanceDataError('request was aborted', 'aborted', { retryable: false })
}
