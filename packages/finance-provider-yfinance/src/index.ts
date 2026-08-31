import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type {
  ComparableCompany,
  EstimateSnapshot,
  FinanceDataProvider,
  Fundamentals,
  MarketData,
  SecurityReference,
} from '@finance2dsh/core'
import { assertJsonSafe, requireTicker } from '@finance2dsh/core'

type Operation = 'security-reference' | 'fundamentals' | 'market-data' | 'estimates' | 'comparables'

interface RunnerSuccess<T> { version: '1'; ok: true; data: T }
interface RunnerFailure {
  version: '1'
  ok: false
  error: { kind: string; message: string; retryable: boolean }
}

export class YFinanceProviderError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'YFinanceProviderError'
  }
}

export interface YFinanceProviderOptions {
  projectRoot?: string
  pythonRunner?: string
  timeoutMs?: number
  cacheTtlMs?: number
  maxOutputBytes?: number
}

interface CacheEntry { expiresAt: number; value: unknown }

export class YFinanceProvider implements FinanceDataProvider {
  readonly name = 'yfinance'
  private readonly projectRoot: string
  private readonly pythonRunner: string
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly maxOutputBytes: number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: YFinanceProviderOptions = {}) {
    this.projectRoot = options.projectRoot ?? fileURLToPath(new URL('../../../', import.meta.url))
    this.pythonRunner = options.pythonRunner
      ?? fileURLToPath(new URL('../python/runner.py', import.meta.url))
    this.timeoutMs = options.timeoutMs ?? 45_000
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000
    this.maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
  }

  securityReference(ticker: string, signal?: AbortSignal): Promise<SecurityReference> {
    return this.call('security-reference', { ticker: requireTicker(ticker) }, signal)
  }

  fundamentals(ticker: string, signal?: AbortSignal): Promise<Fundamentals> {
    return this.call('fundamentals', { ticker: requireTicker(ticker) }, signal)
  }

  marketData(
    ticker: string,
    options: { period?: string; interval?: string; signal?: AbortSignal } = {},
  ): Promise<MarketData> {
    return this.call('market-data', {
      ticker: requireTicker(ticker),
      period: options.period ?? '6mo',
      interval: options.interval ?? '1d',
    }, options.signal)
  }

  estimates(ticker: string, signal?: AbortSignal): Promise<EstimateSnapshot> {
    return this.call('estimates', { ticker: requireTicker(ticker) }, signal)
  }

  comparables(tickers: string[], signal?: AbortSignal): Promise<ComparableCompany[]> {
    const normalized = [...new Set(tickers.map(requireTicker))]
    if (normalized.length < 1 || normalized.length > 11) {
      throw new RangeError('comparables requires 1-11 unique tickers')
    }
    return this.call('comparables', { tickers: normalized }, signal)
  }

  private async call<T>(operation: Operation, params: object, signal?: AbortSignal): Promise<T> {
    const request = { version: '1', operation, params }
    const key = JSON.stringify(request)
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return structuredClone(cached.value) as T
    }
    const response = await this.execute<T>(request, signal)
    assertJsonSafe(response.data)
    this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, value: response.data })
    return structuredClone(response.data)
  }

  private execute<T>(request: object, signal?: AbortSignal): Promise<RunnerSuccess<T>> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new YFinanceProviderError('yfinance request was aborted', 'aborted', false))
        return
      }

      const child = spawn('uv', ['run', '--project', this.projectRoot, 'python', this.pythonRunner], {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error?: Error, response?: RunnerSuccess<T>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve(response as RunnerSuccess<T>)
      }
      const abort = () => {
        child.kill('SIGTERM')
        finish(new YFinanceProviderError('yfinance request was aborted', 'aborted', false))
      }
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new YFinanceProviderError(
          `yfinance runner timed out after ${this.timeoutMs}ms`,
          'timeout',
          true,
        ))
      }, this.timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
        if (Buffer.byteLength(stdout) > this.maxOutputBytes) {
          child.kill('SIGTERM')
          finish(new YFinanceProviderError('yfinance runner output exceeded limit', 'output-limit', false))
        }
      })
      child.stderr.on('data', chunk => {
        if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk
      })
      child.on('error', error => finish(new YFinanceProviderError(
        `failed to start yfinance runner: ${error.message}`,
        'spawn-error',
        false,
        { cause: error },
      )))
      child.on('close', code => {
        if (settled) return
        let parsed: RunnerSuccess<T> | RunnerFailure
        try {
          parsed = JSON.parse(stdout) as RunnerSuccess<T> | RunnerFailure
        } catch (error) {
          finish(new YFinanceProviderError(
            `yfinance runner returned malformed JSON (exit ${code}; stderr: ${stderr.trim().slice(0, 500)})`,
            'protocol-error',
            false,
            { cause: error },
          ))
          return
        }
        if (parsed.version !== '1') {
          finish(new YFinanceProviderError('unsupported yfinance runner protocol version', 'protocol-error', false))
        } else if (!parsed.ok) {
          finish(new YFinanceProviderError(parsed.error.message, parsed.error.kind, parsed.error.retryable))
        } else if (code !== 0) {
          finish(new YFinanceProviderError(
            `yfinance runner exited with code ${code}`,
            'process-error',
            true,
          ))
        } else {
          finish(undefined, parsed)
        }
      })
      child.stdin.end(JSON.stringify(request))
    })
  }
}

export function createYFinanceProvider(options?: YFinanceProviderOptions): FinanceDataProvider {
  return new YFinanceProvider(options)
}
