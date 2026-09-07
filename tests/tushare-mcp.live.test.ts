import { afterEach, describe, expect, it } from 'vitest'
import { TushareMcpProvider, redactTushareText, resolveTushareEndpoint } from '../packages/finance-provider-tushare-mcp/src/index.js'
import type {
  ResolvedTushareEndpoint,
  TushareMarketBars,
  TushareTradingCalendar,
} from '../packages/finance-provider-tushare-mcp/src/index.js'
import { normalizeAshareInstrument } from '@finance2dsh/core'
import { loadDataProviderSecrets } from '../src/runtime.js'

const live = process.env.NGFI_LIVE_TUSHARE === '1' ? describe : describe.skip
const ORIGINAL_STDOUT_WRITE = process.stdout.write
const ORIGINAL_STDERR_WRITE = process.stderr.write
const MAX_CAPTURE_CHARACTERS = 32 * 1024
const SECRET_LOAD_TIMEOUT_MS = 4_000
const PROVIDER_OPERATION_TIMEOUT_MS = 32_000
const CLEANUP_TIMEOUT_MS = 4_000
const DEADLINE_REACHED = Symbol('deadline reached')
const LIVE_ASSERTION_FAILED = Symbol('live assertion failed')
const SHANGHAI_DATE_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

type LiveStage =
  | 'output-capture'
  | 'environment'
  | 'secret-loading'
  | 'endpoint'
  | 'provider-construction'
  | 'inventory-request'
  | 'inventory-validation'
  | 'calendar-request'
  | 'calendar-validation'
  | 'bars-request'
  | 'bars-validation'

type FailureKind = LiveStage
  | 'cleanup'
  | 'capture-failed'
  | 'capture-overflow'
  | 'sensitive-output'
  | 'output-audit'
  | 'output-restoration'

const FAILURE_MESSAGES: Readonly<Record<FailureKind, string>> = {
  'output-capture': 'TuShare live smoke failed during protected output setup.',
  environment: 'TuShare live smoke failed during environment setup.',
  'secret-loading': 'TuShare live smoke failed while loading its protected configuration.',
  endpoint: 'TuShare live smoke has invalid or missing protected configuration.',
  'provider-construction': 'TuShare live smoke failed while constructing the provider.',
  'inventory-request': 'TuShare live smoke inventory request failed.',
  'inventory-validation': 'TuShare live smoke inventory response was invalid.',
  'calendar-request': 'TuShare live smoke trading-calendar request failed.',
  'calendar-validation': 'TuShare live smoke trading-calendar response was invalid.',
  'bars-request': 'TuShare live smoke daily-bars request failed.',
  'bars-validation': 'TuShare live smoke daily-bars response was invalid.',
  cleanup: 'TuShare live smoke provider cleanup failed.',
  'capture-failed': 'TuShare live smoke output capture failed.',
  'capture-overflow': 'TuShare live smoke output exceeded the safe capture limit.',
  'sensitive-output': 'TuShare live smoke emitted sensitive output.',
  'output-audit': 'TuShare live smoke output could not be audited safely.',
  'output-restoration': 'TuShare live smoke failed to restore protected process output.',
}

interface BoundedOutputCapture {
  readonly write: typeof process.stdout.write
  snapshot(): string
  failed(): boolean
  overflowed(): boolean
}

function createBoundedOutputCapture(maxCharacters: number): BoundedOutputCapture {
  let captured = ''
  let captureFailed = false
  let captureOverflowed = false

  const write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    try {
      const remaining = Math.max(0, maxCharacters - captured.length)
      const length = typeof chunk === 'string' ? chunk.length : chunk.byteLength
      if (length > remaining) captureOverflowed = true
      if (remaining > 0) {
        const fragment = typeof chunk === 'string'
          ? chunk.slice(0, remaining)
          : Buffer.from(chunk.subarray(0, remaining)).toString('utf8').slice(0, remaining)
        captured += fragment
      }
    } catch {
      captureFailed = true
    }

    try {
      const callback = args.at(-1)
      if (typeof callback === 'function') callback()
    } catch {
      captureFailed = true
    }
    return true
  }) as typeof process.stdout.write

  return {
    write,
    snapshot: () => captured,
    failed: () => captureFailed,
    overflowed: () => captureOverflowed,
  }
}

async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort()
      } catch {
        // The fixed sentinel below remains the only observable failure.
      }
      reject(DEADLINE_REACHED)
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function requireLive(condition: boolean): asserts condition {
  if (!condition) throw LIVE_ASSERTION_FAILED
}

function addSecretVariants(target: Set<string>, value: string | undefined): void {
  if (value === undefined) return
  const trimmed = value.trim()
  for (const candidate of value === trimmed ? [value] : [value, trimmed]) {
    if (candidate === '') continue
    target.add(candidate)
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded !== '') {
        target.add(decoded)
        target.add(encodeURIComponent(decoded))
      }
    } catch {
      // Keep checking the original when it is not valid percent-encoding.
    }
  }
}

function configuredSecrets(
  environment: NodeJS.ProcessEnv | undefined,
  endpoint: ResolvedTushareEndpoint | undefined,
): string[] {
  const secrets = new Set<string>()
  addSecretVariants(secrets, environment?.TUSHARE_TOKEN)
  if (environment?.TUSHARE_MCP_URL) secrets.add(environment.TUSHARE_MCP_URL)
  for (const secret of endpoint?.secrets ?? []) addSecretVariants(secrets, secret)
  return [...secrets]
}

function auditOutput(
  capture: BoundedOutputCapture | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  endpoint: ResolvedTushareEndpoint | undefined,
): FailureKind | undefined {
  try {
    if (capture === undefined || capture.failed()) return 'capture-failed'
    if (capture.overflowed()) return 'capture-overflow'
    const observed = capture.snapshot()
    const secrets = configuredSecrets(environment, endpoint)
    if (secrets.some(secret => secret !== '' && observed.includes(secret))) return 'sensitive-output'
    if (redactTushareText(observed, secrets) !== observed) return 'sensitive-output'
    return undefined
  } catch {
    return 'output-audit'
  }
}

function restoreProcessOutput(): boolean {
  let restored = true
  try {
    process.stdout.write = ORIGINAL_STDOUT_WRITE
  } catch {
    restored = false
  }
  try {
    process.stderr.write = ORIGINAL_STDERR_WRITE
  } catch {
    restored = false
  }
  return restored
}

function safeFailure(kind: FailureKind): Error {
  return new Error(FAILURE_MESSAGES[kind])
}

function requiredPart(parts: Intl.DateTimeFormatPart[], type: 'year' | 'month' | 'day' | 'hour' | 'minute'): string {
  const value = parts.find(part => part.type === type)?.value
  if (value === undefined) throw LIVE_ASSERTION_FAILED
  return value
}

function shiftIsoDate(value: string, days: number): string {
  const shifted = new Date(`${value}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

function completedTradingCalendarWindow(now = new Date()): { startDate: string; endDate: string } {
  const parts = SHANGHAI_DATE_TIME.formatToParts(now)
  const localDate = [
    requiredPart(parts, 'year'),
    requiredPart(parts, 'month'),
    requiredPart(parts, 'day'),
  ].join('-')
  const localMinutes = Number(requiredPart(parts, 'hour')) * 60 + Number(requiredPart(parts, 'minute'))
  const endDate = localMinutes >= 15 * 60 + 30 ? localDate : shiftIsoDate(localDate, -1)
  return { startDate: shiftIsoDate(endDate, -45), endDate }
}

describe('TuShare live smoke safety helpers', () => {
  it('keeps captured output bounded and acknowledges writes', () => {
    const capture = createBoundedOutputCapture(4)
    let callbackCalled = false
    capture.write('overflow', () => {
      callbackCalled = true
    })

    expect({ callbackCalled, captureFailed: capture.failed(), overflowed: capture.overflowed() }).toEqual({
      callbackCalled: true,
      captureFailed: false,
      overflowed: true,
    })
    expect(capture.snapshot().length).toBe(4)
  })

  it('detects a configured credential split across captured writes', () => {
    const credential = ['offline', 'only', 'credential'].join('-')
    const capture = createBoundedOutputCapture(64)
    capture.write(`prefix ${credential.slice(0, 9)}`)
    capture.write(`${credential.slice(9)} suffix`)

    const sensitiveOutputDetected = auditOutput(capture, { TUSHARE_TOKEN: credential }, undefined)
      === 'sensitive-output'
    expect(sensitiveOutputDetected).toBe(true)
  })

  it('creates only fixed cause-free failures', () => {
    const failure = safeFailure('sensitive-output')
    expect({ cause: failure.cause, message: failure.message }).toEqual({
      cause: undefined,
      message: 'TuShare live smoke emitted sensitive output.',
    })
  })
})

live('live TuShare MCP provider', () => {
  afterEach(() => {
    restoreProcessOutput()
  })

  it('uses trade_cal and daily to verify the latest completed trading day without leaking credentials', async () => {
    let environment: NodeJS.ProcessEnv | undefined
    let endpoint: ResolvedTushareEndpoint | undefined
    let provider: TushareMcpProvider | undefined
    let capture: BoundedOutputCapture | undefined
    let stage: LiveStage = 'output-capture'
    let operationFailure: LiveStage | undefined
    let cleanupFailed = false
    let outputFailure: FailureKind | undefined
    let outputRestored = false

    try {
      try {
        capture = createBoundedOutputCapture(MAX_CAPTURE_CHARACTERS)
        process.stdout.write = capture.write
        process.stderr.write = capture.write

        stage = 'environment'
        environment = { ...process.env }
        const activeEnvironment = environment

        stage = 'secret-loading'
        await withinDeadline(async () => {
          await loadDataProviderSecrets(activeEnvironment)
        }, SECRET_LOAD_TIMEOUT_MS)

        stage = 'endpoint'
        endpoint = resolveTushareEndpoint({ env: activeEnvironment })
        requireLive(endpoint !== undefined)

        stage = 'provider-construction'
        const activeProvider = new TushareMcpProvider({ env: activeEnvironment, timeoutMs: 30_000 })
        provider = activeProvider

        stage = 'inventory-request'
        const inventory = await withinDeadline(
          signal => activeProvider.inventory(signal, { refresh: true }),
          PROVIDER_OPERATION_TIMEOUT_MS,
        )
        stage = 'inventory-validation'
        requireLive(typeof inventory.server?.name === 'string' && inventory.server.name !== '')
        requireLive(inventory.toolNames.includes('trade_cal') && inventory.toolNames.includes('daily'))
        requireLive(inventory.capabilities.includes('trading-calendar'))
        requireLive(inventory.capabilities.includes('market-bars'))

        const { startDate, endDate } = completedTradingCalendarWindow()
        stage = 'calendar-request'
        const calendar = await withinDeadline(signal => activeProvider.execute<TushareTradingCalendar>({
          capability: 'trading-calendar',
          market: 'CN',
          params: { exchange: 'SSE', startDate, endDate, limit: 64 },
          signal,
        }), PROVIDER_OPERATION_TIMEOUT_MS)
        stage = 'calendar-validation'
        requireLive(calendar.status === 'available' && calendar.data !== null)
        requireLive(calendar.data.days.length > 0)
        requireLive(calendar.provenance.actualProvider === 'tushare-mcp')
        requireLive(calendar.provenance.upstreamSource === 'tushare')
        requireLive(calendar.provenance.sourceKind === 'licensed')
        requireLive(calendar.provenance.timezone === 'Asia/Shanghai')

        const latestCompletedTradingDate = calendar.data.days
          .filter(day => day.isOpen)
          .map(day => day.calendarDate)
          .sort((left, right) => left.localeCompare(right))
          .at(-1)
        requireLive(latestCompletedTradingDate !== undefined)

        stage = 'bars-request'
        const bars = await withinDeadline(signal => activeProvider.execute<TushareMarketBars>({
          capability: 'market-bars',
          market: 'CN',
          instrument: normalizeAshareInstrument('600519.SH'),
          params: {
            startDate: latestCompletedTradingDate,
            endDate: latestCompletedTradingDate,
            adjustment: 'none',
            interval: '1d',
            limit: 1,
          },
          signal,
        }), PROVIDER_OPERATION_TIMEOUT_MS)
        stage = 'bars-validation'
        requireLive(bars.status === 'available' && bars.data !== null)
        requireLive(bars.data.instrument.exchange === 'SSE')
        requireLive(bars.data.instrument.symbol === '600519')
        requireLive(bars.data.instrument.assetType === 'equity')
        requireLive(bars.data.bars.length === 1)
        requireLive(bars.data.bars[0]?.observedAt === latestCompletedTradingDate)
        requireLive(bars.provenance.actualProvider === 'tushare-mcp')
        requireLive(bars.provenance.upstreamSource === 'tushare')
        requireLive(bars.provenance.sourceKind === 'licensed')
        requireLive(bars.provenance.observedAt === latestCompletedTradingDate)
        requireLive(bars.provenance.adjustment === 'none')
        requireLive(bars.provenance.timezone === 'Asia/Shanghai')
      } catch {
        operationFailure = stage
      }

      try {
        const activeProvider = provider
        if (activeProvider !== undefined) {
          await withinDeadline(async () => {
            await activeProvider.close()
          }, CLEANUP_TIMEOUT_MS)
        }
      } catch {
        cleanupFailed = true
      }

      outputFailure = auditOutput(capture, environment, endpoint)
    } catch {
      outputFailure = 'output-audit'
    } finally {
      outputRestored = restoreProcessOutput()
    }

    const failure = !outputRestored
      ? 'output-restoration'
      : outputFailure ?? (cleanupFailed ? 'cleanup' : operationFailure)
    if (failure !== undefined) throw safeFailure(failure)
  }, 120_000)
})
