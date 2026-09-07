import { FinanceDataError } from '@finance2dsh/core'
import type { RateLimitOptions } from './types.js'

interface QueueItem<T> {
  task: () => Promise<T> | T
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  aborted: boolean
  abortListener?: () => void
}

export interface RateLimiterOptions extends RateLimitOptions {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export class RateLimiter {
  private readonly concurrency: number
  private readonly minIntervalMs: number
  private readonly now: () => number
  private readonly setTimer: NonNullable<RateLimiterOptions['setTimer']>
  private readonly clearTimer: NonNullable<RateLimiterOptions['clearTimer']>
  private readonly queue: QueueItem<unknown>[] = []
  private active = 0
  private nextStartAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError('rate limiter concurrency must be a positive integer')
    }
    if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
      throw new RangeError('rate limiter minIntervalMs must be a non-negative finite number')
    }
    this.concurrency = options.concurrency
    this.minIntervalMs = options.minIntervalMs
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  get pendingCount(): number {
    return this.queue.filter(item => !item.aborted).length
  }

  get activeCount(): number {
    return this.active
  }

  run<T>(task: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) return Promise.reject(abortedError())
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = { task, resolve, reject, aborted: false }
      if (signal !== undefined) {
        item.signal = signal
        item.abortListener = () => {
          item.aborted = true
          reject(abortedError())
          this.schedule()
        }
        signal.addEventListener('abort', item.abortListener, { once: true })
      }
      this.queue.push(item as QueueItem<unknown>)
      this.schedule()
    })
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    while (this.active < this.concurrency) {
      const next = this.shiftPending()
      if (next === undefined) return
      const currentTime = this.now()
      if (!Number.isFinite(currentTime)) {
        next.reject(new FinanceDataError('rate limiter clock returned a non-finite value', 'provider-error'))
        continue
      }
      const delay = Math.max(0, this.nextStartAt - currentTime)
      if (delay > 0) {
        this.queue.unshift(next)
        this.timer = this.setTimer(() => {
          this.timer = undefined
          this.schedule()
        }, delay)
        return
      }
      this.start(next)
      if (this.minIntervalMs > 0) return this.schedule()
    }
  }

  private shiftPending(): QueueItem<unknown> | undefined {
    while (this.queue.length > 0) {
      const item = this.queue.shift()
      if (item === undefined) return undefined
      if (!item.aborted) return item
      this.detachAbort(item)
    }
    return undefined
  }

  private start(item: QueueItem<unknown>): void {
    this.detachAbort(item)
    if (item.signal?.aborted === true || item.aborted) {
      item.reject(abortedError())
      this.schedule()
      return
    }
    const currentTime = this.now()
    if (!Number.isFinite(currentTime)) {
      item.reject(new FinanceDataError('rate limiter clock returned a non-finite value', 'provider-error'))
      this.schedule()
      return
    }
    this.active += 1
    this.nextStartAt = currentTime + this.minIntervalMs
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active -= 1
        this.schedule()
      })
  }

  private detachAbort(item: QueueItem<unknown>): void {
    if (item.signal !== undefined && item.abortListener !== undefined) {
      item.signal.removeEventListener('abort', item.abortListener)
    }
  }
}

function abortedError(): FinanceDataError {
  return new FinanceDataError('request was aborted before provider execution', 'aborted', { retryable: false })
}
