import { FinanceDataError, dataErrorKind } from '@finance2dsh/core'
import type { CircuitBreakerOptions } from './types.js'

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitSnapshot {
  state: CircuitState
  consecutiveFailures: number
  openedAt?: number
  retryAt?: number
  halfOpenInFlight: number
}

export interface CircuitBreakerDependencies {
  now?: () => number
  isFailure?: (error: unknown) => boolean
}

const DEFAULT_OPTIONS: Readonly<CircuitBreakerOptions> = {
  failureThreshold: 3,
  openDurationMs: 30_000,
  halfOpenMaxRequests: 1,
}

export class CircuitBreaker {
  private readonly options: CircuitBreakerOptions
  private readonly now: () => number
  private readonly isFailure: (error: unknown) => boolean
  private stateValue: CircuitState = 'closed'
  private failures = 0
  private openedAtValue: number | undefined
  private halfOpenInFlight = 0

  constructor(
    options: Partial<CircuitBreakerOptions> = {},
    dependencies: CircuitBreakerDependencies = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    if (!Number.isInteger(this.options.failureThreshold) || this.options.failureThreshold < 1
      || !Number.isFinite(this.options.openDurationMs) || this.options.openDurationMs < 0
      || !Number.isInteger(this.options.halfOpenMaxRequests) || this.options.halfOpenMaxRequests < 1) {
      throw new RangeError('invalid circuit breaker options')
    }
    this.now = dependencies.now ?? Date.now
    this.isFailure = dependencies.isFailure ?? defaultCircuitFailure
  }

  get state(): CircuitState {
    this.refreshState()
    return this.stateValue
  }

  snapshot(): CircuitSnapshot {
    this.refreshState()
    return {
      state: this.stateValue,
      consecutiveFailures: this.failures,
      ...(this.openedAtValue === undefined ? {} : {
        openedAt: this.openedAtValue,
        retryAt: this.openedAtValue + this.options.openDurationMs,
      }),
      halfOpenInFlight: this.halfOpenInFlight,
    }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.refreshState()
    if (this.stateValue === 'open') throw this.openError()
    if (this.stateValue === 'half-open' && this.halfOpenInFlight >= this.options.halfOpenMaxRequests) {
      throw this.openError('circuit breaker half-open probe is already running')
    }
    const isProbe = this.stateValue === 'half-open'
    if (isProbe) this.halfOpenInFlight += 1
    try {
      const result = await operation()
      this.failures = 0
      this.openedAtValue = undefined
      this.stateValue = 'closed'
      return result
    } catch (error) {
      if (this.isFailure(error)) {
        this.failures += 1
        if (isProbe || this.failures >= this.options.failureThreshold) this.open()
      }
      throw error
    } finally {
      if (isProbe) this.halfOpenInFlight -= 1
    }
  }

  reset(): void {
    this.stateValue = 'closed'
    this.failures = 0
    this.openedAtValue = undefined
    this.halfOpenInFlight = 0
  }

  private refreshState(): void {
    const currentTime = this.currentTime()
    if (this.stateValue === 'open'
      && this.openedAtValue !== undefined
      && currentTime >= this.openedAtValue + this.options.openDurationMs) {
      this.stateValue = 'half-open'
      this.halfOpenInFlight = 0
    }
  }

  private open(): void {
    this.stateValue = 'open'
    this.openedAtValue = this.currentTime()
  }

  private openError(message = 'provider circuit is open'): FinanceDataError {
    const retryAt = this.openedAtValue === undefined
      ? this.options.openDurationMs
      : Math.max(0, this.openedAtValue + this.options.openDurationMs - this.currentTime())
    return new FinanceDataError(message, 'circuit-open', { retryAfterMs: retryAt, retryable: true })
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isFinite(value)) {
      throw new FinanceDataError('circuit breaker clock returned a non-finite value', 'provider-error')
    }
    return value
  }
}

function defaultCircuitFailure(error: unknown): boolean {
  return ![
    'invalid-request',
    'ambiguous-instrument',
    'conflicting-instrument',
    'unsupported',
    'no-data',
    'unauthorized',
    'insufficient-permission',
    'aborted',
  ].includes(dataErrorKind(error))
}
