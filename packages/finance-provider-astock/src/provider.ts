import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FinanceDataError,
  assertJsonSafe,
  canonicalInstrumentId,
  normalizeAshareInstrument,
} from '@finance2dsh/core'
import type {
  CanonicalDataResult,
  CapabilityRequest,
  DataErrorKind,
  InstrumentId,
  InstrumentReferenceV2,
  ProviderHealth,
} from '@finance2dsh/core'
import {
  ASTOCK_CAPABILITIES,
  ASTOCK_ERROR_CODES,
  ASTOCK_PROTOCOL_VERSION,
  ASTOCK_PROVIDER_ID,
} from './types.js'
import { getAshareFeature } from './features.js'
import type {
  AStockBars,
  AStockBarsParams,
  AStockCalendarParams,
  AStockCapability,
  AStockDisclosures,
  AStockDisclosuresParams,
  AStockErrorCode,
  AStockFundamentals,
  AStockFundamentalsParams,
  AStockIndexData,
  AStockIndexParams,
  AStockInstrumentParams,
  AStockProviderOptions,
  AStockQuote,
  AStockSource,
  AStockTradingCalendar,
} from './types.js'

type JsonObject = Record<string, unknown>

interface RunnerLimits {
  maxRecords: number
  maxDateSpanDays: number
  maxOutputBytes: number
  networkTimeoutMs: number
}

interface RunnerRequest {
  version: typeof ASTOCK_PROTOCOL_VERSION
  id: string
  operation: AStockCapability
  source: AStockSource
  params: JsonObject
  limits: RunnerLimits
  fixtureRoot?: string
}

interface RunnerSuccess<T> {
  version: '1'
  id: string
  ok: true
  data: CanonicalDataResult<T>
}

interface RunnerFailure {
  version: '1'
  id: string | null
  ok: false
  error: {
    kind: DataErrorKind
    code: AStockErrorCode
    message: string
    retryable: boolean
  }
}

const HARD_MAX_INPUT_BYTES = 256 * 1024
const HARD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const HARD_MAX_RECORDS = 10_000
const HARD_MAX_DATE_SPAN_DAYS = 3_660
const HARD_MAX_NETWORK_TIMEOUT_MS = 30_000
const RUNNER_ENVIRONMENT_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
] as const
const OPTIONAL_AUTH_ENVIRONMENT_KEYS = ['IWENCAI_API_KEY'] as const
const RESPONSE_STATUSES = new Set([
  'available', 'missing', 'not-applicable', 'no-data', 'unsupported', 'unauthorized',
  'insufficient-permission', 'rate-limited', 'provider-error',
  'schema-drift', 'stale', 'partial',
])
const DATA_ERROR_KINDS = new Set<DataErrorKind>([
  'invalid-request', 'ambiguous-instrument', 'conflicting-instrument',
  'unsupported', 'no-data', 'unauthorized', 'insufficient-permission',
  'rate-limited', 'provider-error', 'schema-drift', 'timeout', 'transport',
  'aborted', 'circuit-open', 'stale',
])
const CAPABILITY_PARAMS: Readonly<Record<AStockCapability, ReadonlySet<string>>> = {
  'instrument-reference': new Set(['symbol', 'exchange', 'assetType']),
  quote: new Set(),
  'market-bars': new Set(['startDate', 'endDate', 'adjustment', 'interval', 'limit']),
  fundamentals: new Set(['limit', 'statement']),
  disclosures: new Set(['startDate', 'endDate', 'limit']),
  index: new Set(['limit', 'officialProvider']),
  'trading-calendar': new Set(['exchange', 'startDate', 'endDate', 'limit']),
  'order-book': new Set(),
  'corporate-actions': new Set(),
  'research-consensus': new Set(),
  'capital-flow': new Set(),
  'market-signal': new Set(),
  'industry-classification': new Set(),
  macro: new Set(),
  'risk-data': new Set(),
}

export class AStockProviderError extends FinanceDataError {
  constructor(
    message: string,
    readonly code: AStockErrorCode,
    kind: DataErrorKind,
    retryable: boolean,
    options: ErrorOptions = {},
  ) {
    super(message, kind, { ...options, provider: ASTOCK_PROVIDER_ID, retryable })
    this.name = 'AStockProviderError'
  }
}

export class AStockProvider {
  readonly providerId = ASTOCK_PROVIDER_ID
  readonly name = ASTOCK_PROVIDER_ID
  readonly capabilities = ASTOCK_CAPABILITIES

  private readonly source: AStockSource
  private readonly fixtureRoot: string | undefined
  private readonly projectRoot: string
  private readonly pythonRunner: string
  private readonly pythonExecutable: string
  private readonly pythonArgs: readonly string[]
  private readonly runnerEnv: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly killGraceMs: number
  private readonly maxInputBytes: number
  private readonly maxOutputBytes: number
  private readonly limits: RunnerLimits
  private readonly minRequestIntervalMs: number
  private nextStartAt = 0
  private executionTail: Promise<void> = Promise.resolve()

  constructor(options: AStockProviderOptions = {}) {
    this.source = options.source ?? 'public-web'
    if (this.source !== 'fixture' && this.source !== 'public-web') {
      throw providerError('source is not allowed', 'unsupported-source', 'invalid-request', false)
    }
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.pythonRunner = resolve(options.pythonRunner
      ?? fileURLToPath(new URL('../python/runner.py', import.meta.url)))
    const environment = options.environment ?? process.env
    this.pythonExecutable = resolveRunnerExecutable(
      options.pythonExecutable ?? 'uv',
      this.projectRoot,
      environment,
    )
    this.pythonArgs = options.pythonArgs ?? (options.pythonExecutable === undefined
      ? [
          'run', '--frozen', '--no-sync', '--no-python-downloads', '--no-env-file', '--no-config',
          '--project', this.projectRoot, 'python',
        ]
      : [])
    this.runnerEnv = runnerEnvironment(this.projectRoot, environment, this.source)
    this.fixtureRoot = options.fixtureRoot === undefined ? undefined : resolve(options.fixtureRoot)
    if (this.source === 'fixture' && this.fixtureRoot === undefined) {
      throw providerError('fixtureRoot is required for fixture source', 'invalid-request', 'invalid-request', false)
    }
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 15_000, 'timeoutMs', 1, 120_000)
    this.killGraceMs = boundedInteger(options.killGraceMs ?? 500, 'killGraceMs', 1, 10_000)
    this.maxInputBytes = boundedInteger(
      options.maxInputBytes ?? HARD_MAX_INPUT_BYTES,
      'maxInputBytes',
      64,
      HARD_MAX_INPUT_BYTES,
    )
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? 4 * 1024 * 1024,
      'maxOutputBytes',
      256,
      HARD_MAX_OUTPUT_BYTES,
    )
    const maxRecords = boundedInteger(
      options.maxRecords ?? 1_000,
      'maxRecords',
      1,
      HARD_MAX_RECORDS,
    )
    const maxDateSpanDays = boundedInteger(
      options.maxDateSpanDays ?? 3_660,
      'maxDateSpanDays',
      1,
      HARD_MAX_DATE_SPAN_DAYS,
    )
    const networkTimeoutMs = boundedInteger(
      options.networkTimeoutMs ?? Math.min(10_000, this.timeoutMs),
      'networkTimeoutMs',
      1,
      HARD_MAX_NETWORK_TIMEOUT_MS,
    )
    this.limits = { maxRecords, maxDateSpanDays, maxOutputBytes: this.maxOutputBytes, networkTimeoutMs }
    this.minRequestIntervalMs = boundedInteger(
      options.minRequestIntervalMs ?? (this.source === 'public-web' ? 1_000 : 0),
      'minRequestIntervalMs',
      0,
      60_000,
    )
  }

  async execute<T = unknown, P = Readonly<Record<string, unknown>>>(
    request: CapabilityRequest<P>,
  ): Promise<CanonicalDataResult<T>> {
    const normalized = this.normalizeRequest(request as CapabilityRequest<JsonObject>)
    return this.enqueue(() => this.executeRunner<T>(normalized, request.signal), request.signal)
  }

  instrumentReference(
    request: CapabilityRequest<AStockInstrumentParams>,
  ): Promise<CanonicalDataResult<InstrumentReferenceV2>> {
    return this.execute(request)
  }

  quote(
    request: CapabilityRequest<Readonly<Record<string, never>>>,
  ): Promise<CanonicalDataResult<AStockQuote>> {
    return this.execute(request)
  }

  marketBars(
    request: CapabilityRequest<AStockBarsParams>,
  ): Promise<CanonicalDataResult<AStockBars>> {
    return this.execute(request)
  }

  fundamentalsV2(
    request: CapabilityRequest<AStockFundamentalsParams>,
  ): Promise<CanonicalDataResult<AStockFundamentals>> {
    return this.execute(request)
  }

  disclosures(
    request: CapabilityRequest<AStockDisclosuresParams>,
  ): Promise<CanonicalDataResult<AStockDisclosures>> {
    return this.execute(request)
  }

  indexData(
    request: CapabilityRequest<AStockIndexParams>,
  ): Promise<CanonicalDataResult<AStockIndexData>> {
    return this.execute(request)
  }

  tradingCalendar(
    request: CapabilityRequest<AStockCalendarParams>,
  ): Promise<CanonicalDataResult<AStockTradingCalendar>> {
    return this.execute(request)
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.providerId,
      status: this.source === 'fixture' ? 'healthy' : 'degraded',
      checkedAt: new Date().toISOString(),
      message: this.source === 'fixture'
        ? 'Recorded fixture source is configured.'
        : 'Fixed public-web and official endpoints are configured; availability is checked lazily and live tests are opt-in.',
      capabilities: Object.fromEntries(this.capabilities.map(capability => [
        capability,
        this.source === 'fixture' ? 'healthy' : 'degraded',
      ])),
    }
  }

  private normalizeRequest(request: CapabilityRequest<JsonObject>): RunnerRequest {
    if (!isPlainObject(request)) throw invalid('capability request must be a plain object')
    const allowedRoot = new Set(['capability', 'market', 'instrument', 'asOf', 'params', 'signal'])
    rejectUnknownKeys(request, allowedRoot, 'capability request')
    if (!ASTOCK_CAPABILITIES.includes(request.capability as AStockCapability)) {
      throw providerError(
        `unsupported A-stock capability: ${String(request.capability)}`,
        'unsupported-operation',
        'unsupported',
        false,
      )
    }
    const operation = request.capability as AStockCapability
    if (request.market.toUpperCase() !== 'CN') throw invalid('A-stock provider only accepts market CN')
    const rawParams = request.params ?? {}
    if (!isPlainObject(rawParams)) throw invalid('capability params must be a plain JSON object')
    assertJsonSafe(rawParams)
    if (typeof rawParams.featureId === 'string') {
      return this.normalizeFeatureRequest(request, operation, rawParams)
    }
    rejectUnknownKeys(rawParams, CAPABILITY_PARAMS[operation], `${operation} params`)
    if (!['instrument-reference', 'quote', 'market-bars', 'fundamentals', 'disclosures', 'index', 'trading-calendar'].includes(operation)) {
      throw providerError('featureId is required for this capability', 'invalid-request', 'invalid-request', false)
    }

    const params: JsonObject = {}
    if (operation === 'trading-calendar') {
      if (request.instrument !== undefined) throw invalid('trading-calendar does not accept an instrument')
      params.exchange = enumValue(rawParams.exchange, ['SSE', 'SZSE', 'BSE'], 'exchange')
    } else {
      const instrument = operation === 'instrument-reference'
        ? normalizeReferenceInstrument(request.instrument, rawParams)
        : requireInstrument(request.instrument)
      params.instrument = instrument
      if (operation === 'index' && instrument.assetType !== 'index') {
        throw invalid('index capability requires an index instrument')
      }
    }

    if (request.asOf !== undefined) params.asOf = strictDateOrTimestamp(request.asOf, 'asOf')
    if (operation === 'market-bars' || operation === 'disclosures' || operation === 'trading-calendar') {
      const startDate = strictDate(rawParams.startDate, 'startDate')
      const endDate = strictDate(rawParams.endDate, 'endDate')
      assertDateSpan(startDate, endDate, this.limits.maxDateSpanDays)
      params.startDate = startDate
      params.endDate = endDate
    }
    if (operation === 'market-bars') {
      params.adjustment = rawParams.adjustment === undefined
        ? 'none'
        : enumValue(rawParams.adjustment, ['none', 'qfq', 'hfq'], 'adjustment')
      params.interval = rawParams.interval === undefined
        ? '1d'
        : enumValue(rawParams.interval, ['1d'], 'interval')
    }
    if (operation === 'fundamentals') {
      params.statement = rawParams.statement === undefined
        ? 'income'
        : enumValue(rawParams.statement, ['income'], 'statement')
    }
    if (operation === 'index') {
      params.officialProvider = rawParams.officialProvider === undefined
        ? 'csi'
        : enumValue(rawParams.officialProvider, ['csi', 'cni'], 'officialProvider')
    }
    if (['market-bars', 'fundamentals', 'disclosures', 'index', 'trading-calendar'].includes(operation)) {
      params.limit = boundedInteger(rawParams.limit ?? defaultLimit(operation), 'limit', 1, this.limits.maxRecords)
    }

    const normalized: RunnerRequest = {
      version: ASTOCK_PROTOCOL_VERSION,
      id: randomUUID(),
      operation,
      source: this.source,
      params,
      limits: this.limits,
      ...(this.fixtureRoot === undefined ? {} : { fixtureRoot: this.fixtureRoot }),
    }
    const serialized = JSON.stringify(normalized)
    if (Buffer.byteLength(serialized) > this.maxInputBytes) {
      throw providerError('A-stock runner input exceeded limit', 'input-limit', 'invalid-request', false)
    }
    return normalized
  }

  private normalizeFeatureRequest(
    request: CapabilityRequest<JsonObject>,
    operation: AStockCapability,
    rawParams: JsonObject,
  ): RunnerRequest {
    const definition = getAshareFeature(rawParams.featureId as string)
    const variantId = rawParams.variant === undefined ? definition.variants[0]?.id : rawParams.variant
    if (typeof variantId !== 'string') throw invalid('feature variant is required')
    const variant = definition.variants.find(item => item.id === variantId)
    if (variant === undefined || variant.dataCapability !== operation) {
      throw invalid('feature does not belong to the requested capability')
    }
    rejectUnknownKeys(rawParams, new Set(['featureId', ...definition.allowedParams]), `${operation} feature params`)
    const params: JsonObject = { featureId: definition.featureId, variant: variant.id }
    if (definition.scope === 'instrument' || definition.scope === 'index') {
      params.instrument = requireInstrument(request.instrument)
    } else if (request.instrument !== undefined) {
      params.instrument = requireInstrument(request.instrument)
    }
    const asOf = rawParams.asOf ?? request.asOf
    if (asOf !== undefined) params.asOf = strictDateOrTimestamp(asOf, 'asOf')
    for (const key of ['startDate', 'endDate', 'tradeDate'] as const) {
      if (rawParams[key] !== undefined) params[key] = strictDate(rawParams[key], key)
    }
    if ((rawParams.startDate === undefined) !== (rawParams.endDate === undefined)) {
      throw invalid('startDate and endDate must be provided together')
    }
    if (typeof params.startDate === 'string' && typeof params.endDate === 'string') {
      assertDateSpan(params.startDate, params.endDate, this.limits.maxDateSpanDays)
    }
    params.limit = boundedInteger(
      rawParams.limit ?? definition.defaultLimit, 'limit', 1,
      Math.min(definition.maxLimit, this.limits.maxRecords),
    )
    const enumFields: Record<string, readonly string[]> = {
      interval: ['1m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo'],
      adjustment: ['none', 'qfq', 'hfq'], officialProvider: ['csi', 'cni'],
      boardType: ['industry', 'concept', 'region'], statement: ['lrb', 'fzb', 'llb'],
      channel: ['report', 'announcement', 'news'], optionType: ['call', 'put'],
    }
    for (const [key, allowed] of Object.entries(enumFields)) {
      if (rawParams[key] !== undefined) params[key] = enumValue(rawParams[key], allowed, key)
    }
    for (const key of ['year', 'page', 'lookbackDays', 'forwardDays'] as const) {
      if (rawParams[key] !== undefined) params[key] = boundedInteger(rawParams[key], key, 1, key === 'year' ? 9999 : 3660)
    }
    for (const key of ['industryCode', 'period', 'category', 'searchText', 'underlying', 'optionCode'] as const) {
      if (rawParams[key] !== undefined) params[key] = boundedString(rawParams[key], key, key === 'searchText' ? 500 : 100)
    }
    const normalized: RunnerRequest = {
      version: ASTOCK_PROTOCOL_VERSION, id: randomUUID(), operation, source: this.source,
      params, limits: this.limits,
      ...(this.fixtureRoot === undefined ? {} : { fixtureRoot: this.fixtureRoot }),
    }
    if (Buffer.byteLength(JSON.stringify(normalized)) > this.maxInputBytes) {
      throw providerError('A-stock runner input exceeded limit', 'input-limit', 'invalid-request', false)
    }
    return normalized
  }

  private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.executionTail
    let release = (): void => {}
    this.executionTail = new Promise<void>(resolvePromise => { release = resolvePromise })
    return (async () => {
      try {
        await previous
        if (signal?.aborted === true) throw providerError('A-stock request was aborted', 'aborted', 'aborted', false)
        const delay = Math.max(0, this.nextStartAt - Date.now())
        if (delay > 0) await delayWithAbort(delay, signal)
        this.nextStartAt = Date.now() + this.minRequestIntervalMs
        return await operation()
      } finally {
        release()
      }
    })()
  }

  private executeRunner<T>(request: RunnerRequest, signal?: AbortSignal): Promise<CanonicalDataResult<T>> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal?.aborted === true) {
        rejectPromise(providerError('A-stock request was aborted', 'aborted', 'aborted', false))
        return
      }

      const child = spawn(this.pythonExecutable, [...this.pythonArgs, this.pythonRunner], {
        cwd: this.projectRoot,
        env: this.runnerEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      const stdout: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let timeout: NodeJS.Timeout | undefined
      let killTimer: NodeJS.Timeout | undefined

      const kill = (target: ChildProcess, signalName: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && target.pid !== undefined) process.kill(-target.pid, signalName)
          else target.kill(signalName)
        } catch {
          target.kill(signalName)
        }
      }
      const terminate = (): void => {
        kill(child, 'SIGTERM')
        killTimer = setTimeout(() => kill(child, 'SIGKILL'), this.killGraceMs)
        killTimer.unref()
      }
      const finish = (error?: Error, result?: CanonicalDataResult<T>): void => {
        if (settled) return
        settled = true
        if (timeout !== undefined) clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        if (error !== undefined) rejectPromise(error)
        else resolvePromise(result as CanonicalDataResult<T>)
      }
      const abort = (): void => {
        terminate()
        finish(providerError('A-stock request was aborted', 'aborted', 'aborted', false))
      }
      signal?.addEventListener('abort', abort, { once: true })
      timeout = setTimeout(() => {
        terminate()
        finish(providerError(
          `A-stock runner timed out after ${this.timeoutMs}ms`,
          'timeout',
          'timeout',
          true,
        ))
      }, this.timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > this.maxOutputBytes) {
          terminate()
          finish(providerError('A-stock runner output exceeded limit', 'output-limit', 'schema-drift', false))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.byteLength)
      })
      child.on('error', () => finish(providerError(
        'failed to start A-stock runner',
        'spawn-error',
        'transport',
        true,
      )))
      child.stdin.on('error', () => {
        terminate()
        finish(providerError(
          'failed to write A-stock request',
          'process-error',
          'transport',
          true,
        ))
      })
      child.on('close', code => {
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (settled) return
        const output = Buffer.concat(stdout).toString('utf8').trim()
        const diagnostic = stderrBytes === 0 ? '' : '; runner emitted diagnostics'
        const lines = output === '' ? [] : output.split(/\r?\n/u)
        if (lines.length !== 1) {
          finish(providerError(
            `A-stock runner returned ${lines.length} NDJSON records (exit ${code}${diagnostic})`,
            'protocol-error',
            'schema-drift',
            false,
          ))
          return
        }
        let envelope: unknown
        try {
          envelope = JSON.parse(lines[0] as string)
        } catch {
          finish(providerError(
            `A-stock runner returned malformed NDJSON (exit ${code}${diagnostic})`,
            'protocol-error',
            'schema-drift',
            false,
          ))
          return
        }
        if (!isRunnerEnvelope(envelope)
          || envelope.version !== ASTOCK_PROTOCOL_VERSION
          || envelope.id !== request.id) {
          finish(providerError('invalid A-stock runner envelope', 'protocol-error', 'schema-drift', false))
          return
        }
        if (!envelope.ok) {
          finish(providerError(
            `A-stock runner reported ${envelope.error.code}${diagnostic}`,
            envelope.error.code,
            envelope.error.kind,
            envelope.error.retryable,
          ))
          return
        }
        if (code !== 0) {
          finish(providerError(
            `A-stock runner exited with code ${code}`,
            'process-error',
            'provider-error',
            true,
          ))
          return
        }
        try {
          validateCanonicalResult(envelope.data, request, this.limits.maxRecords)
        } catch {
          finish(providerError(
            'A-stock runner returned an invalid canonical response',
            'protocol-error',
            'schema-drift',
            false,
          ))
          return
        }
        finish(undefined, envelope.data as CanonicalDataResult<T>)
      })
      child.stdin.end(`${JSON.stringify(request)}\n`)
    })
  }
}

function runnerEnvironment(
  projectRoot: string,
  parent: NodeJS.ProcessEnv,
  source: AStockSource,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    UV_CACHE_DIR: resolve(projectRoot, '.uv-cache'),
    UV_NO_CONFIG: '1',
    UV_NO_ENV_FILE: '1',
  }
  for (const key of RUNNER_ENVIRONMENT_KEYS) {
    const value = parent[key] ?? process.env[key]
    if (value !== undefined) environment[key] = value
  }
  if (source === 'public-web') {
    for (const key of OPTIONAL_AUTH_ENVIRONMENT_KEYS) {
      const value = parent[key]
      if (value !== undefined) environment[key] = value
    }
  }
  return environment
}

function resolveRunnerExecutable(
  command: string,
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (command.trim() === '' || command.includes('\0')) {
    throw invalid('pythonExecutable must be a non-empty executable path')
  }
  if (isAbsolute(command)) return command
  if (command.includes('/') || command.includes('\\')) return resolve(projectRoot, command)

  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const directory of (environment.PATH ?? process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`)
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Continue searching the construction-time PATH.
      }
    }
  }
  // Keep execution deterministic if the command was not present at construction.
  return resolve(projectRoot, command)
}

export function createAStockProvider(options?: AStockProviderOptions): AStockProvider {
  return new AStockProvider(options)
}

function normalizeReferenceInstrument(
  instrument: InstrumentId | undefined,
  params: JsonObject,
): InstrumentId {
  if (instrument !== undefined) {
    if (Object.keys(params).length > 0) {
      throw invalid('instrument-reference accepts either instrument or symbol params, not both')
    }
    return requireInstrument(instrument)
  }
  if (typeof params.symbol !== 'string') throw invalid('instrument-reference requires params.symbol')
  const exchange = params.exchange === undefined
    ? undefined
    : enumValue(params.exchange, ['SSE', 'SZSE', 'BSE'], 'exchange')
  const assetType = params.assetType === undefined
    ? undefined
    : enumValue(params.assetType, ['equity', 'index', 'etf', 'fund', 'bond'], 'assetType')
  try {
    return normalizeAshareInstrument(params.symbol, {
      ...(exchange === undefined ? {} : { exchange }),
      ...(assetType === undefined ? {} : { assetType }),
    })
  } catch (error) {
    if (error instanceof FinanceDataError) throw error
    throw invalid(error instanceof Error ? error.message : 'invalid A-stock instrument')
  }
}

function requireInstrument(instrument: InstrumentId | undefined): InstrumentId {
  if (!isPlainObject(instrument)) throw invalid('capability requires a canonical instrument')
  rejectUnknownKeys(instrument, new Set(['market', 'exchange', 'symbol', 'assetType']), 'instrument')
  try {
    canonicalInstrumentId(instrument as InstrumentId)
  } catch (error) {
    if (error instanceof FinanceDataError) throw error
    throw invalid('invalid canonical instrument')
  }
  if (instrument.market !== 'CN' || !['SSE', 'SZSE', 'BSE'].includes(instrument.exchange)) {
    throw invalid('instrument is not a supported mainland China listing')
  }
  if (!/^\d{6}$/u.test(instrument.symbol)) throw invalid('A-stock symbol must be six digits')
  if (!['equity', 'index', 'etf', 'fund', 'bond'].includes(instrument.assetType)) {
    throw invalid('A-stock asset type is not supported')
  }
  return structuredClone(instrument as InstrumentId)
}

function validateCanonicalResult(
  value: unknown,
  request: RunnerRequest,
  maxRecords: number,
): asserts value is CanonicalDataResult<unknown> {
  assertJsonSafe(value)
  const result = canonicalObject(
    value,
    ['status', 'data', 'provenance', 'warnings'],
    [],
    'result',
  )
  if (typeof result.status !== 'string' || !RESPONSE_STATUSES.has(result.status)) {
    throw new TypeError('result status is invalid')
  }
  if (result.status !== 'available'
    && !(request.operation === 'fundamentals' && result.status === 'partial')) {
    throw new TypeError('runner success status is inconsistent with canonical data')
  }
  if (!Array.isArray(result.warnings) || !result.warnings.every(item => typeof item === 'string')) {
    throw new TypeError('result warnings must be strings')
  }
  validateCanonicalProvenance(result.provenance)
  if (result.data === null) throw new TypeError('successful data must be an object')

  if (typeof request.params.featureId === 'string') {
    validateFeatureResult(result.data, request, maxRecords)
    return
  }
  switch (request.operation) {
    case 'instrument-reference':
      validateInstrumentReference(result.data, expectedRequestInstrument(request))
      break
    case 'quote':
      validateQuote(result.data, expectedRequestInstrument(request))
      break
    case 'market-bars':
      validateBars(result.data, request, maxRecords)
      break
    case 'fundamentals':
      validateFundamentals(result.data, request, maxRecords, result.status)
      break
    case 'disclosures':
      validateDisclosures(result.data, request, maxRecords)
      break
    case 'index':
      validateIndex(result.data, request, maxRecords)
      break
    case 'trading-calendar':
      validateTradingCalendar(result.data, request, maxRecords)
      break
  }
}

function validateFeatureResult(value: unknown, request: RunnerRequest, maxRecords: number): void {
  const definition = getAshareFeature(request.params.featureId as string)
  const data = canonicalObject(
    value,
    ['featureId', 'schemaVersion', 'scope', 'records', 'returned', 'truncated', 'fieldUnits', 'limitations'],
    ['instrument', 'asOf', 'startDate', 'endDate', 'nextCursor'],
    'A-share feature data',
  )
  if (data.featureId !== definition.featureId || data.schemaVersion !== 1 || data.scope !== definition.scope) {
    throw new TypeError('A-share feature identity or schema is inconsistent')
  }
  if (data.instrument !== undefined) validateCanonicalInstrument(data.instrument, 'A-share feature data.instrument')
  for (const key of ['asOf', 'startDate', 'endDate'] as const) {
    if (data[key] !== undefined) canonicalDateOrTimestamp(data[key], `A-share feature data.${key}`)
  }
  const records = validateCollection(data, 'records', request, maxRecords)
  for (const [index, item] of records.entries()) {
    if (!isPlainObject(item)) throw new TypeError(`A-share feature data.records[${index}] must be an object`)
    for (const child of Object.values(item)) {
      if (child !== null && !['string', 'number', 'boolean'].includes(typeof child)) {
        throw new TypeError(`A-share feature data.records[${index}] contains a non-scalar value`)
      }
      if (typeof child === 'number' && !Number.isFinite(child)) throw new TypeError('A-share feature data contains a non-finite number')
    }
  }
  if (!isPlainObject(data.fieldUnits)
      || Object.values(data.fieldUnits).some(unit => typeof unit !== 'string' || unit.length === 0)) {
    throw new TypeError('A-share feature fieldUnits are invalid')
  }
  if (!Array.isArray(data.limitations) || data.limitations.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError('A-share feature limitations are invalid')
  }
}

const CANONICAL_SOURCE_KINDS = new Set([
  'official', 'licensed', 'community', 'public-web', 'derived', 'user',
])
const CANONICAL_ADJUSTMENTS = new Set(['none', 'qfq', 'hfq'])

function canonicalObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): JsonObject {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`)
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`)
  }
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${label} contains unsupported fields: ${unknown.sort().join(', ')}`)
  }
  return value
}

function validateCanonicalProvenance(value: unknown): void {
  const provenance = canonicalObject(
    value,
    ['actualProvider', 'provider', 'upstreamSource', 'sourceKind', 'fetchedAt', 'fallbackChain'],
    [
      'requestedProvider', 'sourceUrl', 'observedAt', 'publishedAt', 'availableAt',
      'fiscalPeriod', 'timezone', 'currency', 'unit', 'adjustment', 'upstreamVersion',
      'upstreamCommit', 'qualityTier', 'qualityDowngrade', 'derived',
    ],
    'provenance',
  )
  for (const key of ['actualProvider', 'provider', 'upstreamSource']) {
    nonEmptyCanonicalString(provenance[key], `provenance.${key}`)
  }
  if (provenance.actualProvider !== ASTOCK_PROVIDER_ID || provenance.provider !== ASTOCK_PROVIDER_ID) {
    throw new TypeError('provider provenance does not match the adapter')
  }
  if (typeof provenance.sourceKind !== 'string' || !CANONICAL_SOURCE_KINDS.has(provenance.sourceKind)) {
    throw new TypeError('provenance.sourceKind is invalid')
  }
  canonicalTimestampMillis(provenance.fetchedAt, 'provenance.fetchedAt')
  for (const key of [
    'requestedProvider', 'sourceUrl', 'timezone', 'currency', 'unit', 'upstreamVersion',
    'upstreamCommit', 'qualityTier',
  ]) {
    if (provenance[key] !== undefined) nonEmptyCanonicalString(provenance[key], `provenance.${key}`)
  }
  for (const key of ['observedAt', 'publishedAt', 'availableAt']) {
    if (provenance[key] !== undefined) canonicalDateOrTimestamp(provenance[key], `provenance.${key}`)
  }
  if (provenance.fiscalPeriod !== undefined) canonicalDate(provenance.fiscalPeriod, 'provenance.fiscalPeriod')
  if (provenance.adjustment !== undefined
    && (typeof provenance.adjustment !== 'string' || !CANONICAL_ADJUSTMENTS.has(provenance.adjustment))) {
    throw new TypeError('provenance.adjustment is invalid')
  }
  if (provenance.qualityDowngrade !== undefined && typeof provenance.qualityDowngrade !== 'boolean') {
    throw new TypeError('provenance.qualityDowngrade must be boolean')
  }
  if (!Array.isArray(provenance.fallbackChain)) throw new TypeError('provenance.fallbackChain must be an array')
  for (const [index, rawAttempt] of provenance.fallbackChain.entries()) {
    const attempt = canonicalObject(
      rawAttempt,
      ['provider', 'outcome'],
      ['reason', 'qualityTier', 'qualityDowngrade'],
      `provenance.fallbackChain[${index}]`,
    )
    nonEmptyCanonicalString(attempt.provider, `provenance.fallbackChain[${index}].provider`)
    nonEmptyCanonicalString(attempt.outcome, `provenance.fallbackChain[${index}].outcome`)
    for (const key of ['reason', 'qualityTier']) {
      if (attempt[key] !== undefined) nonEmptyCanonicalString(attempt[key], `provenance.fallbackChain[${index}].${key}`)
    }
    if (attempt.qualityDowngrade !== undefined && typeof attempt.qualityDowngrade !== 'boolean') {
      throw new TypeError(`provenance.fallbackChain[${index}].qualityDowngrade must be boolean`)
    }
  }
  if (provenance.derived !== undefined) {
    const derived = canonicalObject(
      provenance.derived,
      ['inputRefs', 'algorithm', 'algorithmVersion'],
      ['methodology'],
      'provenance.derived',
    )
    if (!Array.isArray(derived.inputRefs)
      || !derived.inputRefs.every(item => typeof item === 'string' && item.length > 0)) {
      throw new TypeError('provenance.derived.inputRefs must be non-empty strings')
    }
    for (const key of ['algorithm', 'algorithmVersion']) {
      nonEmptyCanonicalString(derived[key], `provenance.derived.${key}`)
    }
    if (derived.methodology !== undefined) {
      nonEmptyCanonicalString(derived.methodology, 'provenance.derived.methodology')
    }
  }
}

function expectedRequestInstrument(request: RunnerRequest): InstrumentId {
  return validateCanonicalInstrument(request.params.instrument, 'request.params.instrument')
}

function validateCanonicalInstrument(
  value: unknown,
  label: string,
  expected?: InstrumentId,
): InstrumentId {
  const object = canonicalObject(value, ['market', 'exchange', 'symbol', 'assetType'], [], label)
  if (object.market !== 'CN'
    || typeof object.exchange !== 'string'
    || !['SSE', 'SZSE', 'BSE'].includes(object.exchange)
    || typeof object.symbol !== 'string'
    || !/^\d{6}$/u.test(object.symbol)
    || typeof object.assetType !== 'string'
    || !['equity', 'index', 'etf', 'fund', 'bond'].includes(object.assetType)) {
    throw new TypeError(`${label} is not a canonical A-stock instrument`)
  }
  const instrument = object as unknown as InstrumentId
  const identity = canonicalInstrumentId(instrument)
  if (expected !== undefined && identity !== canonicalInstrumentId(expected)) {
    throw new TypeError(`${label} does not match the requested instrument`)
  }
  return instrument
}

function validateInstrumentReference(value: unknown, expected: InstrumentId): void {
  const data = canonicalObject(
    value,
    ['id', 'canonical', 'name', 'quoteCurrency', 'providerSymbols'],
    ['cik', 'figi', 'isin'],
    'instrument-reference data',
  )
  const instrument = validateCanonicalInstrument(data.id, 'instrument-reference data.id', expected)
  if (data.canonical !== canonicalInstrumentId(instrument)) {
    throw new TypeError('instrument-reference data.canonical is inconsistent')
  }
  validateDataField(data.name, 'instrument-reference data.name', value => {
    nonEmptyCanonicalString(value, 'instrument-reference data.name.value')
  })
  validateDataField(data.quoteCurrency, 'instrument-reference data.quoteCurrency', value => {
    if (value !== 'CNY') throw new TypeError('instrument-reference quote currency must be CNY')
  })
  const symbols = data.providerSymbols
  if (!isPlainObject(symbols) || Object.keys(symbols).length === 0) {
    throw new TypeError('instrument-reference providerSymbols must be a non-empty object')
  }
  for (const [key, symbol] of Object.entries(symbols)) {
    if (key.length === 0 || typeof symbol !== 'string' || symbol.length === 0) {
      throw new TypeError('instrument-reference providerSymbols must contain non-empty strings')
    }
  }
  for (const key of ['cik', 'figi', 'isin']) {
    if (data[key] !== undefined) nonEmptyCanonicalString(data[key], `instrument-reference data.${key}`)
  }
}

function validateQuote(value: unknown, expected: InstrumentId): void {
  const data = canonicalObject(
    value,
    ['instrument', 'tradingDate', 'observedAt', 'currency', 'fields'],
    [],
    'quote data',
  )
  validateCanonicalInstrument(data.instrument, 'quote data.instrument', expected)
  const tradingDate = canonicalDate(data.tradingDate, 'quote data.tradingDate')
  const observedAt = canonicalTimestampMillis(data.observedAt, 'quote data.observedAt')
  if (tradingDate !== shanghaiDate(observedAt)) {
    throw new TypeError('quote tradingDate does not match observedAt in Asia/Shanghai')
  }
  if (data.currency !== 'CNY') throw new TypeError('quote data.currency must be CNY')
  const fields = canonicalObject(
    data.fields,
    ['name', 'open', 'high', 'low', 'last', 'previousClose', 'volume', 'turnover'],
    [],
    'quote data.fields',
  )
  validateDataField(fields.name, 'quote data.fields.name', fieldValue => {
    nonEmptyCanonicalString(fieldValue, 'quote data.fields.name.value')
  })
  for (const key of ['open', 'high', 'low', 'last', 'previousClose', 'volume', 'turnover']) {
    validateDataField(fields[key], `quote data.fields.${key}`, fieldValue => {
      canonicalFiniteNumber(fieldValue, `quote data.fields.${key}.value`)
    })
  }
}

function validateBars(value: unknown, request: RunnerRequest, maxRecords: number): void {
  const data = canonicalObject(
    value,
    ['instrument', 'interval', 'adjustment', 'startDate', 'endDate', 'bars', 'returned', 'truncated'],
    [],
    'market-bars data',
  )
  validateCanonicalInstrument(data.instrument, 'market-bars data.instrument', expectedRequestInstrument(request))
  if (data.interval !== request.params.interval) throw new TypeError('market-bars interval does not match request')
  if (data.adjustment !== request.params.adjustment) throw new TypeError('market-bars adjustment does not match request')
  const startDate = canonicalDate(data.startDate, 'market-bars data.startDate')
  const endDate = canonicalDate(data.endDate, 'market-bars data.endDate')
  const asOfDate = requestAsOfShanghaiDate(request, true)
  const effectiveEndDate = asOfDate === undefined
    ? request.params.endDate as string
    : [request.params.endDate as string, asOfDate].sort()[0] as string
  const bars = validateCollection(data, 'bars', request, maxRecords)
  let previous = ''
  for (const [index, rawBar] of bars.entries()) {
    const bar = canonicalObject(
      rawBar,
      ['date', 'open', 'high', 'low', 'close', 'volume', 'turnover'],
      [],
      `market-bars data.bars[${index}]`,
    )
    const barDate = canonicalDate(bar.date, `market-bars data.bars[${index}].date`)
    if (barDate < (request.params.startDate as string) || barDate > effectiveEndDate) {
      throw new TypeError(`market-bars data.bars[${index}].date falls outside the requested or as-of range`)
    }
    if (barDate <= previous) throw new TypeError('market-bars dates must be unique and ascending')
    previous = barDate
    for (const key of ['open', 'high', 'low', 'close', 'volume', 'turnover']) {
      if (bar[key] !== null) canonicalFiniteNumber(bar[key], `market-bars data.bars[${index}].${key}`)
    }
  }
  if (bars.length === 0
    || (bars[0] as JsonObject).date !== startDate
    || (bars[bars.length - 1] as JsonObject).date !== endDate
    || startDate < (request.params.startDate as string)
    || endDate > effectiveEndDate) {
    throw new TypeError('market-bars date range is inconsistent')
  }
}

function validateFundamentals(
  value: unknown,
  request: RunnerRequest,
  maxRecords: number,
  resultStatus: unknown,
): void {
  const data = canonicalObject(
    value,
    ['instrument', 'periods', 'returned', 'truncated', 'pitSafe'],
    [],
    'fundamentals data',
  )
  validateCanonicalInstrument(data.instrument, 'fundamentals data.instrument', expectedRequestInstrument(request))
  if (typeof data.pitSafe !== 'boolean') throw new TypeError('fundamentals data.pitSafe must be boolean')
  if ((resultStatus === 'partial') !== (data.pitSafe === false)) {
    throw new TypeError('fundamentals status is inconsistent with PIT safety')
  }
  const periods = validateCollection(data, 'periods', request, maxRecords)
  const asOfDate = requestAsOfShanghaiDate(request)
  let previous = '9999-99-99'
  const seen = new Set<string>()
  for (const [index, rawPeriod] of periods.entries()) {
    const period = canonicalObject(
      rawPeriod,
      ['fiscalPeriod', 'publishedAt', 'availableAt', 'currency', 'unit', 'scope', 'fields'],
      [],
      `fundamentals data.periods[${index}]`,
    )
    const fiscalPeriod = canonicalDate(period.fiscalPeriod, `fundamentals data.periods[${index}].fiscalPeriod`)
    if (seen.has(fiscalPeriod) || fiscalPeriod > previous) {
      throw new TypeError('fundamental periods must be unique and descending')
    }
    seen.add(fiscalPeriod)
    previous = fiscalPeriod
    const publishedAt = nullableCanonicalDate(period.publishedAt, `fundamentals data.periods[${index}].publishedAt`)
    const availableAt = nullableCanonicalDate(period.availableAt, `fundamentals data.periods[${index}].availableAt`)
    if ((publishedAt !== null && publishedAt < fiscalPeriod)
      || (availableAt !== null && publishedAt !== null && availableAt < publishedAt)) {
      throw new TypeError('fundamental period dates are inconsistent')
    }
    if (data.pitSafe === true && availableAt === null) {
      throw new TypeError('PIT-safe fundamentals require availability dates')
    }
    if (asOfDate !== undefined && (availableAt === null || availableAt > asOfDate)) {
      throw new TypeError('fundamental period is unavailable at the requested as-of time')
    }
    if (period.currency !== 'CNY') throw new TypeError('fundamental currency must be CNY')
    nonEmptyCanonicalString(period.unit, `fundamentals data.periods[${index}].unit`)
    if (period.scope !== 'consolidated' && period.scope !== 'parent') {
      throw new TypeError('fundamental scope is invalid')
    }
    if (!isPlainObject(period.fields) || Object.keys(period.fields).length === 0) {
      throw new TypeError('fundamental fields must be a non-empty object')
    }
    for (const [field, fieldValue] of Object.entries(period.fields)) {
      if (field.length === 0) throw new TypeError('fundamental field names must be non-empty')
      validateDataField(fieldValue, `fundamentals data.periods[${index}].fields.${field}`, item => {
        canonicalFiniteNumber(item, `fundamentals data.periods[${index}].fields.${field}.value`)
      })
    }
  }
}

function validateDisclosures(value: unknown, request: RunnerRequest, maxRecords: number): void {
  const data = canonicalObject(
    value,
    ['instrument', 'items', 'returned', 'truncated'],
    [],
    'disclosures data',
  )
  validateCanonicalInstrument(data.instrument, 'disclosures data.instrument', expectedRequestInstrument(request))
  const items = validateCollection(data, 'items', request, maxRecords)
  const seen = new Set<string>()
  let previous = Number.POSITIVE_INFINITY
  const cutoff = request.params.asOf === undefined
    ? undefined
    : canonicalAsOfCutoffMillis(request.params.asOf, 'request.params.asOf')
  for (const [index, rawItem] of items.entries()) {
    const item = canonicalObject(
      rawItem,
      ['id', 'title', 'category', 'publishedAt', 'documentRef'],
      [],
      `disclosures data.items[${index}]`,
    )
    for (const key of ['id', 'title', 'category', 'documentRef']) {
      nonEmptyCanonicalString(item[key], `disclosures data.items[${index}].${key}`)
    }
    const id = item.id as string
    if (seen.has(id)) throw new TypeError('disclosures contain duplicate ids')
    seen.add(id)
    const publishedAt = canonicalTimestampMillis(
      item.publishedAt,
      `disclosures data.items[${index}].publishedAt`,
    )
    if (publishedAt > previous) throw new TypeError('disclosures must be sorted newest first')
    previous = publishedAt
    const publishedDate = shanghaiDate(publishedAt)
    if (publishedDate < (request.params.startDate as string)
      || publishedDate > (request.params.endDate as string)
      || (cutoff !== undefined && publishedAt > cutoff)) {
      throw new TypeError('disclosure falls outside the requested date or as-of range')
    }
  }
}

function validateIndex(value: unknown, request: RunnerRequest, maxRecords: number): void {
  const data = canonicalObject(
    value,
    ['instrument', 'asOf', 'constituents', 'returned', 'truncated'],
    [],
    'index data',
  )
  validateCanonicalInstrument(data.instrument, 'index data.instrument', expectedRequestInstrument(request))
  const asOf = canonicalDate(data.asOf, 'index data.asOf')
  const requestAsOfDate = requestAsOfShanghaiDate(request)
  if (requestAsOfDate !== undefined && asOf > requestAsOfDate) {
    throw new TypeError('index snapshot is newer than the requested as-of date')
  }
  const constituents = validateCollection(data, 'constituents', request, maxRecords)
  const seen = new Set<string>()
  for (const [index, rawConstituent] of constituents.entries()) {
    const constituent = canonicalObject(
      rawConstituent,
      ['instrument', 'name', 'weight'],
      [],
      `index data.constituents[${index}]`,
    )
    const instrument = validateCanonicalInstrument(
      constituent.instrument,
      `index data.constituents[${index}].instrument`,
    )
    const identity = canonicalInstrumentId(instrument)
    if (seen.has(identity)) throw new TypeError('index constituents contain duplicate instruments')
    seen.add(identity)
    nonEmptyCanonicalString(constituent.name, `index data.constituents[${index}].name`)
    validateDataField(constituent.weight, `index data.constituents[${index}].weight`, fieldValue => {
      canonicalFiniteNumber(fieldValue, `index data.constituents[${index}].weight.value`)
    })
  }
}

function validateTradingCalendar(value: unknown, request: RunnerRequest, maxRecords: number): void {
  const data = canonicalObject(
    value,
    ['exchange', 'startDate', 'endDate', 'days', 'returned', 'truncated'],
    [],
    'trading-calendar data',
  )
  if (data.exchange !== request.params.exchange) {
    throw new TypeError('trading-calendar exchange does not match request')
  }
  const startDate = canonicalDate(data.startDate, 'trading-calendar data.startDate')
  const endDate = canonicalDate(data.endDate, 'trading-calendar data.endDate')
  const asOfDate = requestAsOfShanghaiDate(request)
  const effectiveEndDate = asOfDate === undefined
    ? request.params.endDate as string
    : [request.params.endDate as string, asOfDate].sort()[0] as string
  const days = validateCollection(data, 'days', request, maxRecords)
  let previous = ''
  for (const [index, rawDay] of days.entries()) {
    const day = canonicalObject(
      rawDay,
      ['date', 'isTradingDay', 'session'],
      [],
      `trading-calendar data.days[${index}]`,
    )
    const dayDate = canonicalDate(day.date, `trading-calendar data.days[${index}].date`)
    if (dayDate <= previous) throw new TypeError('trading-calendar dates must be unique and ascending')
    previous = dayDate
    if (typeof day.isTradingDay !== 'boolean') {
      throw new TypeError(`trading-calendar data.days[${index}].isTradingDay must be boolean`)
    }
    if (day.session !== null && typeof day.session !== 'string') {
      throw new TypeError(`trading-calendar data.days[${index}].session must be string or null`)
    }
  }
  if (days.length === 0
    || (days[0] as JsonObject).date !== startDate
    || (days[days.length - 1] as JsonObject).date !== endDate
    || startDate < (request.params.startDate as string)
    || endDate > effectiveEndDate) {
    throw new TypeError('trading-calendar date range is inconsistent')
  }
}

function validateCollection(
  data: JsonObject,
  key: string,
  request: RunnerRequest,
  maxRecords: number,
): unknown[] {
  const collection = data[key]
  const requestLimit = typeof request.params.limit === 'number' ? request.params.limit : maxRecords
  if (!Array.isArray(collection)
    || collection.length === 0
    || collection.length > maxRecords
    || collection.length > requestLimit) {
    throw new TypeError(`${key} violates record limit`)
  }
  if (data.returned !== collection.length || typeof data.truncated !== 'boolean') {
    throw new TypeError(`${key} pagination metadata is inconsistent`)
  }
  if (data.truncated === true && collection.length !== requestLimit) {
    throw new TypeError(`${key} cannot be truncated below the request limit`)
  }
  return collection
}

function validateDataField(
  value: unknown,
  label: string,
  validateValue: (fieldValue: unknown) => void,
): void {
  const field = canonicalObject(value, ['status', 'value'], ['note'], label)
  if (typeof field.status !== 'string' || !RESPONSE_STATUSES.has(field.status)) {
    throw new TypeError(`${label}.status is invalid`)
  }
  if (field.note !== undefined && typeof field.note !== 'string') {
    throw new TypeError(`${label}.note must be a string`)
  }
  if (field.value === null) {
    if (field.status === 'available') throw new TypeError(`${label} cannot be available with a null value`)
    return
  }
  if (field.status !== 'available') throw new TypeError(`${label} must be available when it has a value`)
  validateValue(field.value)
}

function nonEmptyCanonicalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function canonicalFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`)
  }
  return value
}

function canonicalDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError(`${label} must be YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} must be a real calendar date`)
  }
  return value
}

function nullableCanonicalDate(value: unknown, label: string): string | null {
  return value === null ? null : canonicalDate(value, label)
}

function canonicalDateOrTimestamp(value: unknown, label: string): void {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    canonicalDate(value, label)
    return
  }
  canonicalTimestampMillis(value, label)
}

function canonicalTimestampMillis(value: unknown, label: string): number {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)) {
    throw new TypeError(`${label} must be an ISO timestamp`)
  }
  canonicalDate(value.slice(0, 10), label)
  const normalized = value.includes(' ') ? `${value.slice(0, 10)}T${value.slice(11)}` : value
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized) ? normalized : `${normalized}+08:00`
  const parsed = Date.parse(zoned)
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO timestamp`)
  return parsed
}

function canonicalAsOfCutoffMillis(value: unknown, label: string): number {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const day = canonicalDate(value, label)
    return Date.parse(`${day}T23:59:59.999+08:00`)
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be an ISO date or timestamp`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO date or timestamp`)
  return parsed
}

function requestAsOfShanghaiDate(request: RunnerRequest, dailyClose = false): string | undefined {
  if (request.params.asOf === undefined) return undefined
  const raw = request.params.asOf
  const cutoff = canonicalAsOfCutoffMillis(raw, 'request.params.asOf')
  const localDate = shanghaiDate(cutoff)
  if (dailyClose && typeof raw === 'string' && !/^\d{4}-\d{2}-\d{2}$/u.test(raw)
    && cutoff < Date.parse(`${localDate}T15:00:00+08:00`)) {
    return new Date(Date.parse(`${localDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  }
  return localDate
}

function shanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp)
}

function isRunnerEnvelope(value: unknown): value is RunnerSuccess<unknown> | RunnerFailure {
  if (!isPlainObject(value)) return false
  if (value.version !== ASTOCK_PROTOCOL_VERSION
    || !(typeof value.id === 'string' || value.id === null)
    || typeof value.ok !== 'boolean') return false
  if (value.ok) return Object.hasOwn(value, 'data')
  if (!isPlainObject(value.error)) return false
  return typeof value.error.kind === 'string'
    && DATA_ERROR_KINDS.has(value.error.kind as DataErrorKind)
    && typeof value.error.code === 'string'
    && ASTOCK_ERROR_CODES.includes(value.error.code as AStockErrorCode)
    && typeof value.error.message === 'string'
    && typeof value.error.retryable === 'boolean'
}

function invalid(message: string): AStockProviderError {
  return providerError(message, 'invalid-request', 'invalid-request', false)
}

function providerError(
  message: string,
  code: AStockErrorCode,
  kind: DataErrorKind,
  retryable: boolean,
  options?: ErrorOptions,
): AStockProviderError {
  return new AStockProviderError(message, code, kind, retryable, options)
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejectUnknownKeys(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) throw invalid(`${label} contains unsupported fields: ${unknown.sort().join(', ')}`)
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalid(`${name} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
      || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw invalid(`${name} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function strictDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalid(`${name} must be YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalid(`${name} must be a real calendar date`)
  }
  return value
}

function strictDateOrTimestamp(value: unknown, name: string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return strictDate(value, name)
  }
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)) {
    throw invalid(`${name} must be an ISO date or timestamp`)
  }
  strictDate(value.slice(0, 10), name)
  if (!Number.isFinite(Date.parse(value))) throw invalid(`${name} must be an ISO date or timestamp`)
  return value
}

function assertDateSpan(startDate: string, endDate: string, maximum: number): void {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (start > end) throw invalid('startDate must not be after endDate')
  const span = Math.floor((end - start) / 86_400_000) + 1
  if (span > maximum) throw invalid(`date span exceeds ${maximum} days`)
}

function defaultLimit(operation: AStockCapability): number {
  switch (operation) {
    case 'fundamentals': return 20
    case 'disclosures': return 50
    case 'index': return 500
    default: return 1_000
  }
}

function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(providerError('A-stock request was aborted', 'aborted', 'aborted', false))
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, delayMs)
    function finish(): void {
      signal?.removeEventListener('abort', abort)
      resolvePromise()
    }
    function abort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      rejectPromise(providerError('A-stock request was aborted', 'aborted', 'aborted', false))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
