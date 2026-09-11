import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FinanceDataError,
  assertJsonSafe,
  type CanonicalDataResult,
  type CapabilityRequest,
  type DataCapability,
  type DataErrorKind,
  type InstrumentId,
  type ProviderHealth,
  type ProviderHealthStatus,
} from '@finance2dsh/core'

export const TDX_OFFICIAL_PROVIDER_ID = 'tdx-official' as const
export const TDX_COMMUNITY_PROVIDER_ID = 'tdx-community' as const

export const TDX_OFFICIAL_CAPABILITIES = ['quote', 'market-bars'] as const satisfies readonly DataCapability[]
export const TDX_COMMUNITY_CAPABILITIES = ['quote', 'market-bars'] as const satisfies readonly DataCapability[]

type TdxCapability = typeof TDX_COMMUNITY_CAPABILITIES[number]
type RunnerOperation = 'health' | TdxCapability
type HealthReason =
  | 'ready'
  | 'missing-credential'
  | 'missing-server-config'
  | 'unsupported-platform'
  | 'not-live-verified'
  | 'closed'
  | 'probe-failed'

export interface TdxProviderHealth extends ProviderHealth {
  reason: HealthReason
  authMode: 'none' | 'api-key'
  details: Readonly<Record<string, unknown>>
}

export interface TdxOfficialProviderOptions {
  dataKey?: string
  environment?: NodeJS.ProcessEnv
  transport?: 'remote-service' | 'local-client'
  platform?: NodeJS.Platform
  now?: () => number
}

/**
 * Configuration boundary for the licensed TDX data service. No endpoint is
 * guessed here: the official transport remains dormant until it is verified.
 */
export class TdxOfficialProvider {
  readonly providerId = TDX_OFFICIAL_PROVIDER_ID
  readonly name = TDX_OFFICIAL_PROVIDER_ID
  readonly capabilities = TDX_OFFICIAL_CAPABILITIES
  readonly markets = ['CN'] as const
  readonly authMode = 'api-key' as const
  private readonly hasDataKey: boolean
  private readonly transport: 'remote-service' | 'local-client'
  private readonly platform: NodeJS.Platform
  private readonly now: () => number

  constructor(options: TdxOfficialProviderOptions = {}) {
    const environment = options.environment ?? process.env
    const dataKey = options.dataKey ?? environment.TDX_DATA_KEY
    this.hasDataKey = typeof dataKey === 'string' && dataKey.trim() !== ''
    this.transport = options.transport ?? 'remote-service'
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? Date.now
  }

  async health(signal?: AbortSignal): Promise<TdxProviderHealth> {
    throwIfAborted(signal, this.providerId)
    if (this.transport === 'local-client' && this.platform !== 'win32') {
      return this.healthResult(
        'unsupported-platform',
        'blocked: the configured TDX official local client is only supported on Windows',
        'unsupported-platform',
        {
          requiredEnvironment: [],
          officialTransportEnabled: false,
          liveVerified: false,
          transport: this.transport,
          platform: this.platform,
        },
      )
    }
    if (!this.hasDataKey) {
      return this.healthResult(
        'dormant',
        'blocked: missing TDX_DATA_KEY',
        'missing-credential',
        {
          requiredEnvironment: ['TDX_DATA_KEY'],
          officialTransportEnabled: false,
          liveVerified: false,
          transport: this.transport,
          platform: this.platform,
        },
      )
    }
    return this.healthResult(
      'dormant',
      'blocked: TDX_DATA_KEY is configured but the official transport has not been live-verified',
      'not-live-verified',
      {
        requiredEnvironment: [],
        officialTransportEnabled: false,
        liveVerified: false,
        transport: this.transport,
        platform: this.platform,
      },
    )
  }

  async execute<T = unknown, P = Readonly<Record<string, unknown>>>(
    request: CapabilityRequest<P>,
  ): Promise<CanonicalDataResult<T>> {
    throwIfAborted(request.signal, this.providerId)
    const health = await this.health(request.signal)
    const kind: DataErrorKind = health.reason === 'missing-credential'
      ? 'unauthorized'
      : 'unsupported'
    throw new FinanceDataError(health.message ?? 'TDX official provider is dormant', kind, {
      provider: this.providerId,
      retryable: false,
      details: { reason: health.reason },
    })
  }

  private healthResult(
    status: ProviderHealthStatus,
    message: string,
    reason: HealthReason,
    details: Readonly<Record<string, unknown>>,
  ): TdxProviderHealth {
    return {
      providerId: this.providerId,
      status,
      checkedAt: new Date(this.now()).toISOString(),
      message,
      capabilities: capabilityHealth(TDX_OFFICIAL_CAPABILITIES, status),
      reason,
      authMode: this.authMode,
      details,
    }
  }
}

export interface TdxServer {
  host: string
  port: number
}

export interface TdxCommunityProviderOptions {
  servers?: readonly (TdxServer | string)[]
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  runnerCommand?: readonly string[]
  timeoutMs?: number
  terminationGraceMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxErrorBytes?: number
  maxServerAttempts?: number
  connectTimeoutMs?: number
  now?: () => number
}

export interface TdxQuote {
  instrument: InstrumentId
  providerSymbol: string
  observedAt: string | null
  lastPrice: number | null
  previousClose: number | null
  open: number | null
  high: number | null
  low: number | null
  volume: number | null
  amount: number | null
  bid1: number | null
  ask1: number | null
}

export interface TdxMarketBar {
  observedAt: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  amount: number | null
}

export interface TdxMarketBars {
  instrument: InstrumentId
  providerSymbol: string
  interval: TdxMarketBarInterval
  adjustment: 'none'
  bars: TdxMarketBar[]
}

export type TdxMarketBarInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1w' | '1mo'

export interface TdxMarketBarsOptions {
  interval?: TdxMarketBarInterval
  offset?: number
  count?: number
  startDate?: string
  endDate?: string
  adjustment?: 'none'
  limit?: number
  asOf?: string
  signal?: AbortSignal
}

interface RunnerSuccess<T> {
  version: '1'
  ok: true
  data: T
  meta?: { attempts?: number; serverIndex?: number }
}

interface RunnerFailure {
  version: '1'
  ok: false
  error: { kind: string; message: string; retryable: boolean }
}

interface RunnerHealth {
  connected: true
}

interface RunnerExitStatus {
  version: '1'
  type: 'runner-exit'
  code: number | null
  signal: NodeJS.Signals | null
}

type JsonObject = Readonly<Record<string, unknown>>

interface CanonicalBarBoundary {
  startDate: string
  endDate: string
  asOfCutoff?: number
  limit: number
}

interface NormalizedMarketBarParams {
  interval: TdxMarketBarInterval
  offset: number
  count: number
  canonical?: CanonicalBarBoundary
}

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux', 'win32'])
const MARKET_BAR_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1mo'] as const
const MARKET_BAR_PARAM_KEYS = new Set([
  'interval', 'offset', 'count', 'startDate', 'endDate', 'adjustment', 'limit',
])
const MARKET_BAR_OPTION_KEYS = new Set([...MARKET_BAR_PARAM_KEYS, 'asOf', 'signal'])
const MAX_BAR_COUNT = 800
const MAX_CANONICAL_LIMIT = 5_000
const MAX_CANONICAL_DATE_SPAN_DAYS = 3_660
const MAX_RUNNER_STATUS_BYTES = 4 * 1024
const DAY_MS = 86_400_000
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1_000
const SAFE_ENVIRONMENT_KEYS = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
] as const

// POSIX process-group escalation must retain a live, owned group leader until
// the group is known empty or SIGKILL is sent. The requested runner cannot be
// that leader: it may exit on SIGTERM while one of its descendants ignores the
// signal, after which a delayed signal to its numeric PGID could target a
// recycled, unrelated group. This small supervisor remains the detached group
// leader, gives the runner direct access to its stdout/stderr descriptors, and
// reports the runner's real exit status over a supervisor-only descriptor
// before cleaning up the rest of the group.
const POSIX_RUNNER_SUPERVISOR = String.raw`
'use strict'
const { spawn } = require('node:child_process')
const { closeSync, writeSync } = require('node:fs')

const graceMs = Number(process.argv[1])
const command = process.argv[2]
const args = process.argv.slice(3)
if (!Number.isSafeInteger(graceMs) || graceMs < 0 || command === undefined) process.exit(125)

let terminating = false
let escalationTimer
let statusReported = false
// A signal listener alone does not keep Node alive. This handle preserves
// ownership of the process group between reporting a natural runner exit and
// the provider requesting descendant cleanup.
const ownershipHandle = setInterval(() => {}, 60 * 60 * 1000)

function reportRunnerExit(code, signal) {
  if (statusReported) return
  statusReported = true
  const frame = Buffer.from(JSON.stringify({
    version: '1',
    type: 'runner-exit',
    code,
    signal,
  }) + '\n', 'utf8')
  try {
    const written = writeSync(3, frame, 0, frame.length)
    if (written !== frame.length) throw new Error('short supervisor status write')
  } catch (error) {
    process.stderr.write('failed to report supervised runner exit: ' + error.message + '\n')
  } finally {
    try { closeSync(3) } catch {}
  }
}

function beginTermination(signalGroup = false) {
  if (terminating) return
  terminating = true
  escalationTimer = setTimeout(() => {
    // This process is still the group leader at this exact synchronous send,
    // so its negative PID cannot have been recycled for an unrelated group.
    try {
      process.kill(-process.pid, 'SIGKILL')
    } catch {
      process.exit(1)
    }
  }, graceMs)
  if (signalGroup) {
    try {
      process.kill(-process.pid, 'SIGTERM')
    } catch {
      process.exit(1)
    }
  }
}

process.on('SIGTERM', () => beginTermination(false))

const runner = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  // fd 3 is deliberately not inherited. stdout/stderr go straight to the
  // provider-owned pipes, so killing this supervisor cannot strand buffered
  // output in a JavaScript forwarding layer.
  stdio: ['pipe', 1, 2, 'ignore'],
})
process.stdin.pipe(runner.stdin)
runner.stdin.on('error', () => undefined)
runner.once('error', error => {
  process.stderr.write('failed to start supervised runner: ' + error.message + '\n')
  reportRunnerExit(1, null)
})
runner.once('exit', (code, signal) => {
  reportRunnerExit(code, signal)
})
`

export class TdxCommunityProvider {
  readonly providerId = TDX_COMMUNITY_PROVIDER_ID
  readonly name = TDX_COMMUNITY_PROVIDER_ID
  readonly capabilities = TDX_COMMUNITY_CAPABILITIES
  readonly markets = ['CN'] as const
  readonly authMode = 'none' as const
  private readonly servers: readonly TdxServer[]
  private readonly platform: NodeJS.Platform
  private readonly runnerCommand: readonly string[]
  private readonly runnerEnvironment: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly terminationGraceMs: number
  private readonly maxInputBytes: number
  private readonly maxOutputBytes: number
  private readonly maxErrorBytes: number
  private readonly maxServerAttempts: number
  private readonly connectTimeoutMs: number
  private readonly now: () => number
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>()
  private readonly activeTerminations = new Set<Promise<void>>()
  private closePromise: Promise<void> | undefined
  private serverCursor = 0
  private closed = false

  constructor(options: TdxCommunityProviderOptions = {}) {
    const environment = options.environment ?? process.env
    this.servers = Object.freeze(parseServers(options.servers ?? parseServerEnvironment(environment.TDX_COMMUNITY_SERVERS)))
    this.platform = options.platform ?? process.platform
    const packageRoot = resolve(fileURLToPath(new URL('../../../providers/tdx/', import.meta.url)))
    const runner = fileURLToPath(new URL('../../../providers/tdx/python/runner.py', import.meta.url))
    const configuredRunner = options.runnerCommand ?? [
      'uv',
      'run',
      '--frozen',
      '--no-sync',
      '--no-python-downloads',
      '--no-env-file',
      '--no-config',
      '--project',
      packageRoot,
      'python',
      '-B',
      runner,
    ]
    if (configuredRunner.length === 0 || configuredRunner.some(part => part.trim() === '')) {
      throw new TypeError('runnerCommand must contain a non-empty executable and arguments')
    }
    const [executable, ...runnerArgs] = configuredRunner as [string, ...string[]]
    this.runnerCommand = Object.freeze([
      resolveRunnerExecutable(executable, packageRoot, environment),
      ...runnerArgs,
    ])
    this.runnerEnvironment = childEnvironment(packageRoot, environment)
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, 'timeoutMs')
    this.terminationGraceMs = nonNegativeInteger(options.terminationGraceMs ?? 500, 'terminationGraceMs')
    this.maxInputBytes = positiveInteger(options.maxInputBytes ?? 64 * 1024, 'maxInputBytes')
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 4 * 1024 * 1024, 'maxOutputBytes')
    this.maxErrorBytes = positiveInteger(options.maxErrorBytes ?? 64 * 1024, 'maxErrorBytes')
    this.maxServerAttempts = boundedInteger(options.maxServerAttempts ?? 3, 'maxServerAttempts', 1, 3)
    this.connectTimeoutMs = boundedInteger(options.connectTimeoutMs ?? 1_500, 'connectTimeoutMs', 100, 30_000)
    this.now = options.now ?? Date.now
  }

  async health(signal?: AbortSignal): Promise<TdxProviderHealth> {
    throwIfAborted(signal, this.providerId)
    if (this.closed) {
      return this.healthResult('unavailable', 'tdx-community provider is closed', 'closed')
    }
    const unsupportedReason = communityPlatformReason(this.platform)
    if (unsupportedReason !== null) {
      return this.healthResult(
        'unsupported-platform',
        unsupportedReason,
        'unsupported-platform',
        { platform: this.platform },
      )
    }
    if (this.servers.length === 0) {
      return this.healthResult(
        'dormant',
        'blocked: missing TDX_COMMUNITY_SERVERS',
        'missing-server-config',
      )
    }
    try {
      const response = await this.executeRunner<RunnerHealth>('health', {}, signal)
      if (!isObject(response.data) || response.data.connected !== true) {
        throw protocolError(this.providerId, 'health response did not confirm a connection')
      }
      return this.healthResult(
        'healthy',
        'tdx-community runner and a configured server are reachable',
        'ready',
        response.meta?.attempts === undefined ? {} : { attempts: response.meta.attempts },
      )
    } catch (error) {
      if (isAbortedError(error)) throw error
      return this.healthResult(
        'unavailable',
        safeHealthMessage(error),
        'probe-failed',
      )
    }
  }

  async execute<T = unknown, P = Readonly<Record<string, unknown>>>(
    request: CapabilityRequest<P>,
  ): Promise<CanonicalDataResult<T>> {
    throwIfAborted(request.signal, this.providerId)
    this.assertRunnable()
    assertCommunityRequest(request)
    if (request.capability === 'quote') {
      const response = await this.executeRunner<JsonObject>('quote', {
        instrument: runnerInstrument(request.instrument as InstrumentId),
      }, request.signal)
      this.advanceServerCursor(response.meta?.serverIndex)
      return this.mapQuote(request.instrument as InstrumentId, response.data) as CanonicalDataResult<T>
    }
    const params = marketBarParams(request.params, request.asOf, this.now())
    const response = await this.executeRunner<readonly JsonObject[]>('market-bars', {
      instrument: runnerInstrument(request.instrument as InstrumentId),
      interval: params.interval,
      offset: params.offset,
      count: params.count,
    }, request.signal)
    this.advanceServerCursor(response.meta?.serverIndex)
    return this.mapMarketBars(
      request.instrument as InstrumentId,
      params,
      response.data,
    ) as CanonicalDataResult<T>
  }

  quote(
    instrument: InstrumentId,
    signal?: AbortSignal,
  ): Promise<CanonicalDataResult<TdxQuote>> {
    return this.execute({
      capability: 'quote',
      market: instrument.market,
      instrument,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  async marketBars(
    instrument: InstrumentId,
    options: TdxMarketBarsOptions = {},
  ): Promise<CanonicalDataResult<TdxMarketBars>> {
    const rawOptions: unknown = options
    if (!isPlainObject(rawOptions)
      || Object.keys(options).some(key => !MARKET_BAR_OPTION_KEYS.has(key))) {
      throw new FinanceDataError('tdx-community market-bars options contain non-whitelisted parameters', 'invalid-request', {
        provider: this.providerId,
        retryable: false,
      })
    }
    return this.execute({
      capability: 'market-bars',
      market: instrument.market,
      instrument,
      params: {
        ...(options.interval === undefined ? {} : { interval: options.interval }),
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        ...(options.count === undefined ? {} : { count: options.count }),
        ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
        ...(options.endDate === undefined ? {} : { endDate: options.endDate }),
        ...(options.adjustment === undefined ? {} : { adjustment: options.adjustment }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      },
      ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closed = true
    const children = [...this.activeChildren]
    this.closePromise = (async () => {
      await Promise.all(children.map(child => this.terminate(child)))
      await Promise.all([...this.activeTerminations])
    })()
    return this.closePromise
  }

  private terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    const termination = terminateAndWait(child, this.terminationGraceMs)
    this.activeTerminations.add(termination)
    void termination.then(() => this.activeTerminations.delete(termination))
    return termination
  }

  private assertRunnable(): void {
    if (this.closed) {
      throw new FinanceDataError('tdx-community provider is closed', 'provider-error', {
        provider: this.providerId,
        retryable: false,
      })
    }
    const unsupportedReason = communityPlatformReason(this.platform)
    if (unsupportedReason !== null) {
      throw new FinanceDataError(unsupportedReason, 'unsupported', {
        provider: this.providerId,
        retryable: false,
      })
    }
    if (this.servers.length === 0) {
      throw new FinanceDataError('blocked: missing TDX_COMMUNITY_SERVERS', 'provider-error', {
        provider: this.providerId,
        retryable: false,
      })
    }
  }

  private healthResult(
    status: ProviderHealthStatus,
    message: string,
    reason: HealthReason,
    details: Readonly<Record<string, unknown>> = {},
  ): TdxProviderHealth {
    return {
      providerId: this.providerId,
      status,
      checkedAt: new Date(this.now()).toISOString(),
      message,
      capabilities: capabilityHealth(TDX_COMMUNITY_CAPABILITIES, status),
      reason,
      authMode: this.authMode,
      details: {
        configuredServerCount: this.servers.length,
        maximumAttemptsPerRequest: Math.min(this.maxServerAttempts, this.servers.length),
        protocolVersion: '1',
        sourceKind: 'community',
        liveVerified: status === 'healthy',
        ...details,
      },
    }
  }

  private serverCandidates(): readonly TdxServer[] {
    const count = Math.min(this.maxServerAttempts, this.servers.length)
    const candidates = Array.from({ length: count }, (_unused, index) =>
      this.servers[(this.serverCursor + index) % this.servers.length] as TdxServer)
    if (this.servers.length > 0) this.serverCursor = (this.serverCursor + 1) % this.servers.length
    return candidates
  }

  private advanceServerCursor(selectedIndex: number | undefined): void {
    // serverCandidates already rotates the starting node once per process call.
    // A successful fallback is deliberately not pinned forever.
    if (selectedIndex === undefined || this.servers.length === 0) return
    if (!Number.isInteger(selectedIndex)
      || selectedIndex < 0
      || selectedIndex >= Math.min(this.maxServerAttempts, this.servers.length)) {
      throw protocolError(this.providerId, 'runner returned an invalid server index')
    }
  }

  private async executeRunner<T>(
    operation: RunnerOperation,
    params: JsonObject,
    signal?: AbortSignal,
  ): Promise<RunnerSuccess<T>> {
    const request = {
      version: '1',
      operation,
      params,
      servers: this.serverCandidates(),
      maxServerAttempts: Math.min(this.maxServerAttempts, this.servers.length),
      connectTimeoutMs: this.connectTimeoutMs,
    }
    const serialized = JSON.stringify(request)
    if (Buffer.byteLength(serialized) > this.maxInputBytes) {
      throw new FinanceDataError('tdx-community runner input exceeded limit', 'invalid-request', {
        provider: this.providerId,
        retryable: false,
      })
    }

    return new Promise((resolve, reject) => {
      throwIfAborted(signal, this.providerId)
      const [command, ...args] = this.runnerCommand as [string, ...string[]]
      const supervised = process.platform !== 'win32'
      const child = spawn(supervised ? process.execPath : command, supervised
        ? ['--input-type=commonjs', '--eval', POSIX_RUNNER_SUPERVISOR, '--',
            String(this.terminationGraceMs), command, ...args]
        : args, {
        cwd: fileURLToPath(new URL('../../../providers/tdx/', import.meta.url)),
        env: this.runnerEnvironment,
        stdio: supervised ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        detached: supervised,
      }) as ChildProcessWithoutNullStreams
      this.activeChildren.add(child)
      let stdoutBytes = 0
      let stderrBytes = 0
      let statusBytes = 0
      let statusOverflow = false
      let runnerExit: RunnerExitStatus | undefined
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const status: Buffer[] = []
      let settled = false

      const finish = (error?: Error, response?: RunnerSuccess<T>) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        signal?.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve(response as RunnerSuccess<T>)
      }
      const terminate = () => {
        void this.terminate(child)
      }
      const abort = () => {
        terminate()
        finish(new FinanceDataError('tdx-community request was aborted', 'aborted', {
          provider: this.providerId,
          retryable: false,
        }))
      }
      signal?.addEventListener('abort', abort, { once: true })
      const timeoutTimer = setTimeout(() => {
        terminate()
        finish(new FinanceDataError(`tdx-community runner timed out after ${this.timeoutMs}ms`, 'timeout', {
          provider: this.providerId,
          retryable: true,
        }))
      }, this.timeoutMs)
      timeoutTimer.unref?.()

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > this.maxOutputBytes) {
          terminate()
          finish(protocolError(this.providerId, 'runner output exceeded limit'))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= this.maxErrorBytes) return
        const remaining = this.maxErrorBytes - stderrBytes
        const retained = chunk.subarray(0, remaining)
        stderr.push(retained)
        stderrBytes += retained.byteLength
      })
      const statusStream = supervised ? child.stdio[3] : undefined
      if (statusStream !== undefined && statusStream !== null) {
        statusStream.on('data', (chunk: Buffer) => {
          statusBytes += chunk.byteLength
          if (statusBytes > MAX_RUNNER_STATUS_BYTES) {
            statusOverflow = true
            return
          }
          status.push(chunk)
        })
        statusStream.once('end', () => {
          if (settled) return
          try {
            runnerExit = parseRunnerExitStatus(Buffer.concat(status), statusOverflow)
          } catch (error) {
            terminate()
            finish(protocolError(
              this.providerId,
              'runner supervisor returned an invalid exit status',
              error,
            ))
            return
          }
          terminate()
        })
      }
      child.stdin.on('error', () => undefined)
      child.once('error', error => {
        finish(new FinanceDataError(`failed to start tdx-community runner: ${error.message}`, 'transport', {
          provider: this.providerId,
          retryable: true,
          cause: error,
        }))
      })
      child.once('close', (code, supervisorSignal) => {
        this.activeChildren.delete(child)
        if (settled) return
        if (supervised) {
          if (runnerExit === undefined) {
            finish(protocolError(this.providerId, 'runner supervisor omitted its exit status'))
            return
          }
        } else {
          runnerExit = { version: '1', type: 'runner-exit', code, signal: supervisorSignal }
        }
        const output = Buffer.concat(stdout).toString('utf8')
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim().slice(0, 500)
        const exitDescription = runnerExit.code === null
          ? `signal ${String(runnerExit.signal)}`
          : `exit ${String(runnerExit.code)}`
        let parsed: unknown
        try {
          parsed = JSON.parse(output)
        } catch (error) {
          finish(protocolError(
            this.providerId,
            `runner returned malformed JSON (${exitDescription}${diagnostic === '' ? '' : `; stderr: ${diagnostic}`})`,
            error,
          ))
          return
        }
        if (!isRunnerEnvelope(parsed)) {
          finish(protocolError(this.providerId, 'runner returned an invalid protocol envelope'))
          return
        }
        if (parsed.version !== '1') {
          finish(protocolError(this.providerId, 'unsupported tdx-community runner protocol version'))
          return
        }
        if (!parsed.ok) {
          finish(runnerFailure(this.providerId, parsed))
          return
        }
        if (runnerExit.code !== 0) {
          const message = runnerExit.code === null
            ? `tdx-community runner exited due to signal ${String(runnerExit.signal)}`
            : `tdx-community runner exited with code ${String(runnerExit.code)}`
          finish(new FinanceDataError(message, 'provider-error', {
            provider: this.providerId,
            retryable: true,
          }))
          return
        }
        try {
          assertJsonSafe(parsed.data)
        } catch (error) {
          finish(protocolError(this.providerId, 'runner returned non-JSON-safe data', error))
          return
        }
        finish(undefined, parsed as RunnerSuccess<T>)
      })
      child.stdin.end(serialized)
    })
  }

  private mapQuote(
    instrument: InstrumentId,
    raw: JsonObject,
  ): CanonicalDataResult<TdxQuote> {
    if (!isObject(raw)) throw protocolError(this.providerId, 'quote payload must be an object')
    const fetchedAt = new Date(this.now()).toISOString()
    const quote: TdxQuote = {
      instrument: structuredClone(instrument),
      providerSymbol: providerSymbol(instrument),
      observedAt: optionalTimestamp(raw.datetime),
      lastPrice: optionalFiniteNumber(raw.price),
      previousClose: optionalFiniteNumber(raw.last_close),
      open: optionalFiniteNumber(raw.open),
      high: optionalFiniteNumber(raw.high),
      low: optionalFiniteNumber(raw.low),
      volume: optionalFiniteNumber(raw.vol),
      amount: optionalFiniteNumber(raw.amount),
      bid1: optionalFiniteNumber(raw.bid1),
      ask1: optionalFiniteNumber(raw.ask1),
    }
    return {
      status: quote.lastPrice === null ? 'partial' : 'available',
      data: quote,
      provenance: {
        actualProvider: this.providerId,
        provider: this.providerId,
        upstreamSource: this.providerId,
        sourceKind: 'community',
        fetchedAt,
        ...(quote.observedAt === null ? {} : { observedAt: quote.observedAt }),
        timezone: 'Asia/Shanghai',
        currency: 'CNY',
        unit: 'raw',
        adjustment: 'none',
        fallbackChain: [],
      },
      warnings: ['Community TDX-compatible market data has no official service guarantee.'],
    }
  }

  private mapMarketBars(
    instrument: InstrumentId,
    params: NormalizedMarketBarParams,
    raw: readonly JsonObject[],
  ): CanonicalDataResult<TdxMarketBars> {
    if (!Array.isArray(raw)) throw protocolError(this.providerId, 'market-bars payload must be an array')
    if (raw.length > params.count) {
      throw protocolError(this.providerId, 'market-bars payload exceeded the requested count')
    }
    let bars = raw.map((item, index): TdxMarketBar => {
      if (!isObject(item)) throw protocolError(this.providerId, `market bar ${index} must be an object`)
      const observedAt = requiredTimestamp(item.datetime, `market bar ${index}.datetime`, this.providerId)
      return {
        observedAt,
        open: optionalFiniteNumber(item.open),
        high: optionalFiniteNumber(item.high),
        low: optionalFiniteNumber(item.low),
        close: optionalFiniteNumber(item.close),
        volume: optionalFiniteNumber(item.vol),
        amount: optionalFiniteNumber(item.amount),
      }
    }).sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    const seenObservations = new Set<string>()
    const seenTradingDates = new Set<string>()
    for (const [index, bar] of bars.entries()) {
      if (seenObservations.has(bar.observedAt)) {
        throw protocolError(this.providerId, `market bar ${index} duplicated an observation timestamp`)
      }
      seenObservations.add(bar.observedAt)
      if (params.canonical !== undefined) {
        const tradingDate = chinaDate(Date.parse(bar.observedAt))
        if (seenTradingDates.has(tradingDate)) {
          throw protocolError(this.providerId, `market bar ${index} duplicated a daily trading date`)
        }
        seenTradingDates.add(tradingDate)
      }
    }
    if (params.canonical !== undefined) {
      const boundary = params.canonical
      bars = bars.filter(bar => {
        const observed = Date.parse(bar.observedAt)
        const tradingDate = chinaDate(observed)
        return tradingDate >= boundary.startDate
          && tradingDate <= boundary.endDate
          && (boundary.asOfCutoff === undefined || observed <= boundary.asOfCutoff)
      })
      if (bars.length > boundary.limit) bars = bars.slice(-boundary.limit)
    }
    if (bars.length === 0) {
      throw new FinanceDataError('tdx-community returned no market bars in the requested date boundary', 'no-data', {
        provider: this.providerId,
        retryable: false,
      })
    }
    const complete = bars.every(bar => bar.open !== null && bar.high !== null
      && bar.low !== null && bar.close !== null)
    const latest = bars[bars.length - 1] as TdxMarketBar
    return {
      status: complete ? 'available' : 'partial',
      data: {
        instrument: structuredClone(instrument),
        providerSymbol: providerSymbol(instrument),
        interval: params.interval,
        adjustment: 'none',
        bars,
      },
      provenance: {
        actualProvider: this.providerId,
        provider: this.providerId,
        upstreamSource: this.providerId,
        sourceKind: 'community',
        fetchedAt: new Date(this.now()).toISOString(),
        observedAt: latest.observedAt,
        timezone: 'Asia/Shanghai',
        currency: 'CNY',
        unit: 'raw',
        adjustment: 'none',
        fallbackChain: [],
      },
      warnings: ['Community TDX-compatible bars are unadjusted and have no official service guarantee.'],
    }
  }
}

export function createTdxOfficialProvider(options?: TdxOfficialProviderOptions): TdxOfficialProvider {
  return new TdxOfficialProvider(options)
}

export function createTdxCommunityProvider(options?: TdxCommunityProviderOptions): TdxCommunityProvider {
  return new TdxCommunityProvider(options)
}

function capabilityHealth(
  capabilities: readonly DataCapability[],
  status: ProviderHealthStatus,
): Partial<Record<DataCapability, ProviderHealthStatus>> {
  return Object.fromEntries(capabilities.map(capability => [capability, status]))
}

function communityPlatformReason(platform: NodeJS.Platform): string | null {
  // The injectable value exists only to exercise stricter platform states in
  // tests; it must never make a real Windows process claim POSIX cleanup.
  if (process.platform === 'win32') {
    return 'tdx-community subprocess cancellation has not been verified on Windows'
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) return `tdx-community runner is not supported on ${platform}`
  if (platform === 'win32') {
    return 'tdx-community subprocess cancellation has not been verified on Windows'
  }
  return null
}

function parseServerEnvironment(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') return []
  return value.split(',').map(server => server.trim()).filter(server => server !== '')
}

function parseServers(values: readonly (TdxServer | string)[]): TdxServer[] {
  if (values.length > 16) throw new RangeError('at most 16 TDX community servers may be configured')
  return values.map(value => {
    const candidate = typeof value === 'string' ? parseServer(value) : value
    const host = candidate.host.trim().toLowerCase()
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
      throw new TypeError('TDX server host must be a DNS name or IPv4 address without a URL scheme')
    }
    if (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535) {
      throw new RangeError('TDX server port must be an integer between 1 and 65535')
    }
    return Object.freeze({ host, port: candidate.port })
  })
}

function parseServer(value: string): TdxServer {
  const match = /^([^:/\s]+):(\d{1,5})$/.exec(value)
  if (match === null) throw new TypeError('TDX server must use host:port syntax')
  return { host: match[1] as string, port: Number(match[2]) }
}

function childEnvironment(packageRoot: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    UV_CACHE_DIR: resolve(packageRoot, '.uv-cache'),
    UV_NO_CONFIG: '1',
    UV_NO_ENV_FILE: '1',
  }
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environment[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function resolveRunnerExecutable(
  executable: string,
  packageRoot: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (isAbsolute(executable)) return executable
  if (executable.includes('/') || executable.includes('\\')) return resolve(packageRoot, executable)

  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  const searchPath = environment.PATH ?? process.env.PATH ?? ''
  for (const directory of searchPath.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = resolve(directory, `${executable}${extension}`)
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Continue searching the construction-time PATH.
      }
    }
  }
  return resolve(packageRoot, executable)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`)
  return value
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function throwIfAborted(signal: AbortSignal | undefined, provider: string): void {
  if (signal?.aborted === true) {
    throw new FinanceDataError(`${provider} request was aborted`, 'aborted', { provider, retryable: false })
  }
}

function assertCommunityRequest<P>(request: CapabilityRequest<P>): void {
  if (!TDX_COMMUNITY_CAPABILITIES.includes(request.capability as TdxCapability)) {
    throw new FinanceDataError(
      `tdx-community only supports quote and market-bars, not ${request.capability}`,
      'unsupported',
      { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
    )
  }
  if (request.market.toUpperCase() !== 'CN' || request.instrument === undefined
    || request.instrument.market.toUpperCase() !== 'CN') {
    throw new FinanceDataError('tdx-community only supports canonical CN instruments', 'unsupported', {
      provider: TDX_COMMUNITY_PROVIDER_ID,
      retryable: false,
    })
  }
  if (!['SSE', 'SZSE'].includes(request.instrument.exchange)) {
    throw new FinanceDataError(
      `tdx-community has not verified exchange ${request.instrument.exchange}`,
      'unsupported',
      { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
    )
  }
  if (!['equity', 'index', 'etf', 'fund'].includes(request.instrument.assetType)) {
    throw new FinanceDataError(
      `tdx-community has not verified asset type ${request.instrument.assetType}`,
      'unsupported',
      { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
    )
  }
  if (request.capability === 'quote' && request.instrument.assetType === 'index') {
    throw new FinanceDataError(
      'tdx-community index quotes have not been verified; use market-bars',
      'unsupported',
      { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
    )
  }
  if (!/^\d{6}$/.test(request.instrument.symbol)) {
    throw new FinanceDataError('tdx-community requires a six-digit canonical symbol', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID,
      retryable: false,
    })
  }
  const params = request.params
  const paramsObject = params === undefined ? undefined : isPlainObject(params) ? params : null
  const allowedParams = request.capability === 'quote' ? new Set<string>() : MARKET_BAR_PARAM_KEYS
  if (paramsObject === null
    || (paramsObject !== undefined
      && Object.keys(paramsObject).some(key => !allowedParams.has(key)))) {
    throw new FinanceDataError('tdx-community request contains non-whitelisted parameters', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID,
      retryable: false,
    })
  }
  if (request.capability === 'quote'
    && paramsObject !== undefined
    && paramsObject !== null
    && Object.keys(paramsObject).length > 0) {
    throw new FinanceDataError('tdx-community quote does not accept parameters', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID,
      retryable: false,
    })
  }
}

function runnerInstrument(instrument: InstrumentId): JsonObject {
  return {
    market: instrument.exchange === 'SSE' ? 1 : 0,
    exchange: instrument.exchange,
    symbol: instrument.symbol,
    assetType: instrument.assetType,
  }
}

function marketBarParams(
  value: unknown,
  asOf: string | undefined,
  now: number,
): NormalizedMarketBarParams {
  const params = isPlainObject(value) ? value : {}
  const interval = params.interval ?? '1d'
  if (typeof interval !== 'string' || !MARKET_BAR_INTERVALS.includes(interval as TdxMarketBarInterval)) {
    throw new FinanceDataError('tdx-community market-bars interval is unsupported', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  const adjustment = params.adjustment ?? 'none'
  if (typeof adjustment !== 'string' || !['none', 'qfq', 'hfq'].includes(adjustment)) {
    throw new FinanceDataError('tdx-community market-bars adjustment must be none, qfq, or hfq', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  if (adjustment !== 'none') {
    throw new FinanceDataError('tdx-community market-bars only supports unadjusted data', 'unsupported', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }

  const canonical = params.startDate !== undefined
    || params.endDate !== undefined
    || params.limit !== undefined
    || params.adjustment !== undefined
    || asOf !== undefined
  if (canonical) {
    if (params.offset !== undefined || params.count !== undefined) {
      throw new FinanceDataError(
        'tdx-community canonical date ranges cannot be combined with offset or count',
        'invalid-request',
        { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
      )
    }
    if (interval !== '1d') {
      throw new FinanceDataError('tdx-community canonical date ranges support interval 1d only', 'unsupported', {
        provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
      })
    }
    const startDate = strictDate(params.startDate, 'startDate')
    const requestedEndDate = strictDate(params.endDate, 'endDate')
    const requestedSpan = inclusiveDays(startDate, requestedEndDate)
    if (requestedSpan < 1) {
      throw new FinanceDataError('tdx-community market-bars startDate must not be after endDate', 'invalid-request', {
        provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
      })
    }
    if (requestedSpan > MAX_CANONICAL_DATE_SPAN_DAYS) {
      throw new FinanceDataError(
        `tdx-community market-bars date span must not exceed ${MAX_CANONICAL_DATE_SPAN_DAYS} days`,
        'invalid-request',
        { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
      )
    }
    const limit = optionalBoundedInteger(params.limit, 'limit', 1, MAX_CANONICAL_LIMIT, 500)
    const asOfCutoff = asOf === undefined ? undefined : strictAsOfCutoff(asOf)
    const endDate = asOfCutoff === undefined
      ? requestedEndDate
      : [requestedEndDate, chinaDate(asOfCutoff)].sort()[0] as string
    if (endDate < startDate) {
      throw new FinanceDataError('tdx-community returned no market bars in the requested as-of boundary', 'no-data', {
        provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
      })
    }
    if (!Number.isFinite(now)) {
      throw new FinanceDataError('tdx-community clock returned a non-finite value', 'provider-error', {
        provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
      })
    }
    const today = chinaDate(now)
    const lookbackDays = startDate > today ? 1 : inclusiveDays(startDate, today)
    if (lookbackDays > MAX_BAR_COUNT) {
      throw new FinanceDataError(
        `tdx-community cannot reliably resolve a canonical date range more than ${MAX_BAR_COUNT} calendar days old`,
        'unsupported',
        { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
      )
    }
    return {
      interval: '1d',
      offset: 0,
      count: lookbackDays,
      canonical: {
        startDate,
        endDate,
        ...(asOfCutoff === undefined ? {} : { asOfCutoff }),
        limit,
      },
    }
  }

  const offset = params.offset ?? 0
  const count = params.count ?? 100
  if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 100_000) {
    throw new FinanceDataError('tdx-community market-bars offset must be an integer from 0 to 100000', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > MAX_BAR_COUNT) {
    throw new FinanceDataError(`tdx-community market-bars count must be an integer from 1 to ${MAX_BAR_COUNT}`, 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  return { interval: interval as TdxMarketBarInterval, offset: Number(offset), count: Number(count) }
}

function strictDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new FinanceDataError(`tdx-community market-bars ${name} must be YYYY-MM-DD`, 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new FinanceDataError(`tdx-community market-bars ${name} must be a real calendar date`, 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  return value
}

function inclusiveDays(startDate: string, endDate: string): number {
  return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS) + 1
}

function strictAsOfCutoff(value: unknown): number {
  if (typeof value !== 'string') {
    throw new FinanceDataError('tdx-community market-bars asOf must be an ISO date or timestamp', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = strictDate(value, 'asOf')
    return Date.parse(`${date}T23:59:59.999+08:00`)
  }
  const parsed = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(parsed)) {
    throw new FinanceDataError('tdx-community market-bars asOf must be an ISO date or timestamp', 'invalid-request', {
      provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false,
    })
  }
  return parsed
}

function chinaDate(timestamp: number): string {
  return new Date(timestamp + CHINA_OFFSET_MS).toISOString().slice(0, 10)
}

function optionalBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || (selected as number) < minimum || (selected as number) > maximum) {
    throw new FinanceDataError(
      `tdx-community market-bars ${name} must be an integer from ${minimum} to ${maximum}`,
      'invalid-request',
      { provider: TDX_COMMUNITY_PROVIDER_ID, retryable: false },
    )
  }
  return selected as number
}

function providerSymbol(instrument: InstrumentId): string {
  return `${instrument.symbol}.${instrument.exchange === 'SSE' ? 'SH' : 'SZ'}`
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw protocolError(TDX_COMMUNITY_PROVIDER_ID, 'runner returned a non-finite numeric field')
  }
  return value
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw protocolError(TDX_COMMUNITY_PROVIDER_ID, 'runner returned an invalid timestamp')
  }
  return new Date(value).toISOString()
}

function requiredTimestamp(value: unknown, field: string, provider: string): string {
  const timestamp = optionalTimestamp(value)
  if (timestamp === null) throw protocolError(provider, `runner omitted ${field}`)
  return timestamp
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype
}

function isRunnerEnvelope(value: unknown): value is RunnerSuccess<unknown> | RunnerFailure {
  if (!isObject(value) || typeof value.version !== 'string' || typeof value.ok !== 'boolean') return false
  if (value.ok) return Object.hasOwn(value, 'data')
  return isObject(value.error)
    && typeof value.error.kind === 'string'
    && typeof value.error.message === 'string'
    && typeof value.error.retryable === 'boolean'
}

function parseRunnerExitStatus(buffer: Buffer, overflow: boolean): RunnerExitStatus {
  if (overflow || buffer.byteLength === 0 || buffer.byteLength > MAX_RUNNER_STATUS_BYTES) {
    throw new Error('runner supervisor status frame was empty or exceeded its limit')
  }
  const serialized = buffer.toString('utf8')
  if (!serialized.endsWith('\n') || serialized.slice(0, -1).includes('\n')) {
    throw new Error('runner supervisor status must contain exactly one newline-terminated frame')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized.slice(0, -1))
  } catch (error) {
    throw new Error('runner supervisor status was malformed JSON', { cause: error })
  }
  if (!isPlainObject(parsed)
    || Object.keys(parsed).length !== 4
    || parsed.version !== '1'
    || parsed.type !== 'runner-exit'
    || !(parsed.code === null
      || (typeof parsed.code === 'number'
        && Number.isSafeInteger(parsed.code)
        && parsed.code >= 0
        && parsed.code <= 255))
    || !(parsed.signal === null || isNodeSignal(parsed.signal))
    || ((parsed.code === null) === (parsed.signal === null))) {
    throw new Error('runner supervisor status frame was invalid')
  }
  return parsed as unknown as RunnerExitStatus
}

function isNodeSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === 'string'
    && /^SIG[A-Z0-9]+$/u.test(value)
    && Object.hasOwn(osConstants.signals, value)
}

function protocolError(provider: string, message: string, cause?: unknown): FinanceDataError {
  return new FinanceDataError(message, 'schema-drift', {
    provider,
    retryable: false,
    details: { stage: 'protocol-error' },
    ...(cause === undefined ? {} : { cause }),
  })
}

function runnerFailure(provider: string, response: RunnerFailure): FinanceDataError {
  const kind = runnerErrorKind(response.error.kind)
  return new FinanceDataError(response.error.message, kind, {
    provider,
    retryable: response.error.retryable,
    details: { runnerKind: response.error.kind },
  })
}

function runnerErrorKind(kind: string): DataErrorKind {
  if ([
    'invalid-request',
    'unsupported',
    'no-data',
    'unauthorized',
    'insufficient-permission',
    'rate-limited',
    'schema-drift',
    'timeout',
    'transport',
    'aborted',
  ].includes(kind)) return kind as DataErrorKind
  return 'provider-error'
}

function isAbortedError(error: unknown): boolean {
  return error instanceof FinanceDataError && error.kind === 'aborted'
}

function safeHealthMessage(error: unknown): string {
  const kind = error instanceof FinanceDataError ? error.kind : 'provider-error'
  return `tdx-community health probe failed (${kind})`
}

const CHILD_TERMINATIONS = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>()

function signalChildTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The group may already be gone or unavailable; fall back to the leader.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Termination is best-effort when the process has already exited.
  }
}

function terminateAndWait(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  const existing = CHILD_TERMINATIONS.get(child)
  if (existing !== undefined) return existing
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  const termination = new Promise<void>(resolvePromise => {
    let settled = false
    let escalationTimer: ReturnType<typeof setTimeout> | undefined
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (settled) return
      settled = true
      if (escalationTimer !== undefined) clearTimeout(escalationTimer)
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
      resolvePromise()
    }
    const childFinished = () => finish()
    child.once('exit', childFinished)
    child.once('error', childFinished)

    signalChildTree(child, 'SIGTERM')
    if (process.platform !== 'win32') return

    // Windows has no detached POSIX process group or negative-PID reuse risk.
    // Its direct-child escalation remains here; POSIX escalation is owned by
    // POSIX_RUNNER_SUPERVISOR while that supervisor is still the group leader.
    escalationTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish()
        return
      }
      signalChildTree(child, 'SIGKILL')
      fallbackTimer = setTimeout(finish, 1_000)
    }, graceMs)
  })
  CHILD_TERMINATIONS.set(child, termination)
  return termination
}
