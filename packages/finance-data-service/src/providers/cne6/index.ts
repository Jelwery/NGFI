import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AdjustmentMode,
  CanonicalDataResult,
  CapabilityRequest,
  DataCapability,
  DataField,
  DataProvenance,
  DataStatus,
  InstrumentId,
  ProviderHealth,
} from '@finance2dsh/core'

export type Cne6Dataset =
  | 'prices'
  | 'market-cap'
  | 'fundamentals'
  | 'industry'
  | 'benchmark'
  | 'dividends'

export type Cne6PitGrade = 'safe' | 'market-history' | 'partial' | 'unsafe'

export type Cne6JsonValue =
  | null
  | boolean
  | number
  | string
  | Cne6JsonValue[]
  | { [key: string]: Cne6JsonValue }

export interface Cne6AssetInspection {
  manifestKey: string
  file: string
  bytes: number
  sha256: string
  rows: number
  columns: string[]
}

export interface Cne6Provenance {
  build: Record<string, Cne6JsonValue> | null
  source: Record<string, Cne6JsonValue>
  coverage: Record<string, Cne6JsonValue>
  quality: { quality_flag: 'proxy'; coverage: Record<string, Cne6JsonValue>; reasons: string[] }
  partial: boolean | null
  failed: string[]
  requested: string[]
  units: {
    price: 'CNY'
    volume: 'share'
    turnover: 'CNY'
  }
  /** Per-asset hashes copied from the manifest and verified against disk. */
  hash: Record<Cne6Dataset, string>
  /** Deterministic digest over the verified per-asset manifest entries. */
  aggregateHash: string
  reportHash: string
  pitGrade: Cne6PitGrade
  pitReason: string
}

export interface Cne6Inspection extends Cne6Provenance {
  providerId: 'cne6-local'
  status: 'ready' | 'degraded'
  generatedAt: string | null
  assets: Record<Cne6Dataset, Cne6AssetInspection>
}

export interface Cne6QueryRequest {
  dataset: Cne6Dataset | 'marketCap' | 'caps'
  columns?: string[]
  limit?: number
  codes?: string[]
  /**
   * Fundamentals use available_date exclusively. Prices/benchmark use their
   * observation date and are graded market-history, not fully PIT-safe.
   */
  asOf?: string
  /** Snake-case alias used by the underlying CNE6 data contract. */
  as_of?: string
  /** Inclusive observation-date lower bound for prices and benchmark. */
  startDate?: string
  start_date?: string
  /** Inclusive observation-date upper bound for prices and benchmark. */
  endDate?: string
  end_date?: string
  signal?: AbortSignal
}

export interface Cne6QueryResult extends Cne6Provenance {
  providerId: 'cne6-local'
  dataset: Cne6Dataset
  columns: string[]
  rows: Array<Record<string, Cne6JsonValue>>
  /** Bare symbols matching the complete filtered query before projection/limit. */
  matchedCodes: string[]
  returned: number
  truncated: boolean
  asOf: string | null
  startDate: string | null
  endDate: string | null
}

export interface Cne6MarketBar {
  date: string
  observedAt: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  preClose: number | null
  volume: number | null
  turnover: number | null
}

export interface Cne6MarketBars {
  instrument: InstrumentId
  interval: '1d'
  adjustment: Extract<AdjustmentMode, 'none' | 'qfq'>
  bars: Cne6MarketBar[]
  returned: number
  truncated: boolean
  startDate: string
  endDate: string
}

export interface Cne6FundamentalPeriod {
  fiscalPeriod: string
  /** CNE6 stores the visibility date but cannot distinguish actual from estimated publication dates. */
  publishedAt: null
  availableAt: string | null
  currency: 'CNY'
  /** The artifact mixes monetary, per-share, and share-count values. */
  unit: null
  /** The published artifact does not identify consolidated versus parent-company scope. */
  scope: null
  fields: Record<string, DataField<number>>
}

export interface Cne6Fundamentals {
  instrument: InstrumentId
  periods: Cne6FundamentalPeriod[]
  returned: number
  truncated: boolean
  pitSafe: boolean
  quality: Cne6Provenance['quality']
}

export const CNE6_LOCAL_CAPABILITIES = [
  'risk-data',
  'fundamentals',
  'market-bars',
] as const satisfies readonly DataCapability[]

export type Cne6LocalCapability = typeof CNE6_LOCAL_CAPABILITIES[number]

export interface Cne6CapabilityParams {
  dataset?: Cne6Dataset | 'marketCap' | 'caps'
  columns?: string[]
  limit?: number
  codes?: string[]
  startDate?: string
  endDate?: string
  interval?: '1d'
  adjustment?: 'none' | 'qfq'
}

export interface Cne6LocalProviderOptions {
  /** Published data root containing quality-report.json and reference/. */
  dataRoot?: string
  /** Existing uv project that supplies Polars. */
  projectRoot?: string
  pythonRunner?: string
  uvExecutable?: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  killGraceMs?: number
  maxOutputBytes?: number
  defaultLimit?: number
  maxRows?: number
}

interface RunnerSuccess<T> {
  version: '1'
  id: string
  ok: true
  data: T
}

interface RunnerFailure {
  version: '1'
  id: string | null
  ok: false
  error: { kind: string; message: string; retryable: boolean }
}

const DATASET_ALIASES: Readonly<Record<string, Cne6Dataset>> = {
  prices: 'prices',
  'market-cap': 'market-cap',
  marketCap: 'market-cap',
  caps: 'market-cap',
  fundamentals: 'fundamentals',
  industry: 'industry',
  benchmark: 'benchmark',
  dividends: 'dividends',
}

const DATASET_COLUMNS: Readonly<Record<Cne6Dataset, readonly string[]>> = {
  prices: [
    'code', 'date', 'open', 'high', 'low', 'close', 'preclose',
    'volume', 'amount', 'turn', 'daily_return',
  ],
  'market-cap': ['code', 'close', 'total_market_cap'],
  fundamentals: [
    'code', 'report_date', 'available_date', 'revenue', 'net_income', 'eps',
    'equity', 'operating_cashflow', 'total_assets', 'total_liabilities',
    'long_term_debt', 'preferred_equity', 'cogs', 'capex',
    'depreciation_amortization', 'ebit', 'dividend_per_share', 'total_shares',
    'cash', 'short_term_debt', 'investment_cashflow', 'non_current_liabilities',
    'parent_equity',
  ],
  industry: ['code', 'industry'],
  benchmark: ['date', 'close', 'daily_return'],
  dividends: ['code', 'report_date', 'dividend_per_share', 'pay_date'],
}

const FUNDAMENTAL_FIELD_NAMES = {
  revenue: 'revenue',
  net_income: 'netIncome',
  eps: 'eps',
  equity: 'equity',
  operating_cashflow: 'operatingCashFlow',
  total_assets: 'totalAssets',
  total_liabilities: 'totalLiabilities',
  long_term_debt: 'longTermDebt',
  preferred_equity: 'preferredEquity',
  cogs: 'cogs',
  capex: 'capex',
  depreciation_amortization: 'depreciationAmortization',
  ebit: 'ebit',
  dividend_per_share: 'dividendPerShare',
  total_shares: 'totalShares',
  cash: 'cash',
  short_term_debt: 'shortTermDebt',
  investment_cashflow: 'investmentCashFlow',
  non_current_liabilities: 'nonCurrentLiabilities',
  parent_equity: 'parentEquity',
} as const satisfies Readonly<Record<string, string>>

const QUERY_KEYS = new Set([
  'dataset', 'columns', 'limit', 'codes', 'asOf', 'as_of',
  'startDate', 'start_date', 'endDate', 'end_date', 'signal',
])
const DISALLOWED_DATA_PATH_PARTS = new Set(['staging', 'checkpoint', 'checkpoints'])
const MAX_CONFIGURED_ROWS = 100_000
const MAX_CONFIGURED_OUTPUT_BYTES = 16 * 1024 * 1024
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1_000
const DAY_MS = 24 * 60 * 60 * 1_000
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
const RUNNER_ERROR_KINDS = new Set([
  'artifact-missing',
  'integrity-error',
  'internal-error',
  'invalid-report',
  'invalid-request',
  'parquet-error',
  'pit-unsafe',
  'protocol-error',
  'provider-error',
  'unsafe-path',
  'unsupported-operation',
])

export class Cne6LocalProviderError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'Cne6LocalProviderError'
  }
}

export class Cne6LocalProvider {
  readonly providerId = 'cne6-local' as const
  readonly name = this.providerId
  readonly capabilities = CNE6_LOCAL_CAPABILITIES

  private readonly dataRoot: string
  private readonly projectRoot: string
  private readonly pythonRunner: string
  private readonly uvExecutable: string
  private readonly uvArgs: readonly string[]
  private readonly runnerEnv: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly killGraceMs: number
  private readonly maxOutputBytes: number
  private readonly defaultLimit: number
  private readonly maxRows: number

  constructor(options: Cne6LocalProviderOptions = {}) {
    this.projectRoot = resolve(options.projectRoot
      ?? fileURLToPath(new URL('../../../../combinatorial-optimization/', import.meta.url)))
    this.dataRoot = resolve(options.dataRoot ?? resolve(this.projectRoot, 'data'))
    this.pythonRunner = resolve(options.pythonRunner
      ?? fileURLToPath(new URL('../../../providers/cne6/python/runner.py', import.meta.url)))
    const environment = options.environment ?? process.env
    this.uvExecutable = resolveRunnerExecutable(
      options.uvExecutable ?? 'uv',
      this.projectRoot,
      environment,
    )
    this.uvArgs = [
      'run', '--frozen', '--no-sync', '--no-python-downloads', '--no-env-file', '--no-config',
      '--project', this.projectRoot, 'python', '-B', '-I',
    ]
    this.runnerEnv = runnerEnvironment(this.projectRoot, environment)
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 'timeoutMs', 1, 120_000)
    this.killGraceMs = boundedInteger(options.killGraceMs ?? 1_000, 'killGraceMs', 1, 10_000)
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? 8 * 1024 * 1024,
      'maxOutputBytes',
      256,
      MAX_CONFIGURED_OUTPUT_BYTES,
    )
    this.maxRows = boundedInteger(options.maxRows ?? 10_000, 'maxRows', 1, MAX_CONFIGURED_ROWS)
    this.defaultLimit = boundedInteger(options.defaultLimit ?? 1_000, 'defaultLimit', 1, this.maxRows)
    assertPublishedDataRoot(this.dataRoot)
  }

  inspect(signal?: AbortSignal): Promise<Cne6Inspection> {
    return this.runOperation<Cne6Inspection>('inspect', {}, signal)
  }

  query(request: Cne6QueryRequest, signal?: AbortSignal): Promise<Cne6QueryResult> {
    const normalized = this.normalizeQuery(request)
    return this.runOperation<Cne6QueryResult>('query', normalized, signal ?? request.signal)
  }

  async execute<T = unknown, P = Readonly<Record<string, unknown>>>(
    request: CapabilityRequest<P>,
  ): Promise<CanonicalDataResult<T>> {
    const capabilityRequest = request as CapabilityRequest<Cne6CapabilityParams>
    const normalized = this.normalizeCapabilityRequest(capabilityRequest)
    const result = await this.query(normalized, request.signal)
    const canonical = this.toCanonicalResult(result, capabilityRequest)
    const requestedAdjustment = capabilityRequest.params?.adjustment
    if (request.capability === 'market-bars' && requestedAdjustment !== undefined
      && canonical.provenance.adjustment !== requestedAdjustment) {
      throw new Cne6LocalProviderError(
        `CNE6 published bars are ${canonical.provenance.adjustment ?? 'unknown'}, not requested ${requestedAdjustment}`,
        'unsupported',
        false,
      )
    }
    return canonical as CanonicalDataResult<T>
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    try {
      const inspection = await this.inspect(signal)
      const status = inspection.status === 'ready' ? 'healthy' : 'degraded'
      return {
        providerId: this.providerId,
        status,
        message: inspection.partial === true
          ? `published artifact is partial (${inspection.failed.length} failed symbols)`
          : inspection.pitReason,
        capabilities: Object.fromEntries(this.capabilities.map(capability => [capability, status])),
        checkedAt,
      }
    } catch (error) {
      if (error instanceof Cne6LocalProviderError && error.kind === 'aborted') throw error
      return {
        providerId: this.providerId,
        status: 'unavailable',
        message: error instanceof Cne6LocalProviderError
          ? error.message
          : 'CNE6 local health probe failed',
        capabilities: Object.fromEntries(this.capabilities.map(capability => [capability, 'unavailable'])),
        checkedAt,
      }
    }
  }

  private normalizeCapabilityRequest(
    request: CapabilityRequest<Cne6CapabilityParams>,
  ): Cne6QueryRequest {
    if (!isPlainObject(request)) {
      throw new Cne6LocalProviderError('capability request must be an object', 'invalid-request', false)
    }
    const unknownRoot = Object.keys(request).filter(
      key => !new Set(['capability', 'market', 'instrument', 'asOf', 'params', 'signal']).has(key),
    )
    if (unknownRoot.length > 0) {
      throw new Cne6LocalProviderError(
        `capability request contains unsupported fields: ${unknownRoot.sort().join(', ')}`,
        'invalid-request',
        false,
      )
    }
    if (typeof request.market !== 'string' || request.market.toUpperCase() !== 'CN') {
      throw new Cne6LocalProviderError('CNE6 local provider only accepts market CN', 'unsupported', false)
    }
    if (!this.capabilities.includes(request.capability as Cne6LocalCapability)) {
      throw new Cne6LocalProviderError(
        `unsupported CNE6 local capability: ${String(request.capability)}`,
        'unsupported',
        false,
      )
    }
    const params = request.params ?? {}
    if (!isPlainObject(params)) {
      throw new Cne6LocalProviderError('capability params must be an object', 'invalid-request', false)
    }
    const allowedParams = new Set([
      'dataset', 'columns', 'limit', 'codes', 'startDate', 'endDate', 'interval', 'adjustment',
    ])
    const unknownParams = Object.keys(params).filter(key => !allowedParams.has(key))
    if (unknownParams.length > 0) {
      throw new Cne6LocalProviderError(
        `capability params contain unsupported fields: ${unknownParams.sort().join(', ')}`,
        'invalid-request',
        false,
      )
    }

    const capability = request.capability as Cne6LocalCapability
    if (params.columns !== undefined && capability !== 'risk-data') {
      throw new Cne6LocalProviderError(
        'column projection is only supported for raw CNE6 risk-data queries',
        'invalid-request',
        false,
      )
    }
    const defaultDataset: Record<Cne6LocalCapability, Cne6Dataset> = {
      'risk-data': 'market-cap',
      fundamentals: 'fundamentals',
      'market-bars': 'prices',
    }
    const dataset = params.dataset ?? defaultDataset[capability]
    const allowedDatasets: Record<Cne6LocalCapability, readonly Cne6Dataset[]> = {
      'risk-data': ['market-cap', 'industry', 'dividends'],
      fundamentals: ['fundamentals'],
      'market-bars': ['prices'],
    }
    const canonicalDataset = typeof dataset === 'string' ? DATASET_ALIASES[dataset] : undefined
    if (canonicalDataset === undefined || !allowedDatasets[capability].includes(canonicalDataset)) {
      throw new Cne6LocalProviderError(
        `dataset ${String(dataset)} is not valid for ${capability}`,
        'invalid-request',
        false,
      )
    }
    const interval = params.interval
    if (interval !== undefined && (capability !== 'market-bars' || interval !== '1d')) {
      throw new Cne6LocalProviderError('CNE6 market bars support interval 1d only', 'unsupported', false)
    }
    const adjustment = params.adjustment
    if (adjustment !== undefined
      && (capability !== 'market-bars' || (adjustment !== 'none' && adjustment !== 'qfq'))) {
      throw new Cne6LocalProviderError('CNE6 adjustment must be none or qfq for market-bars', 'unsupported', false)
    }

    const instrumentCode = request.instrument === undefined
      ? undefined
      : codeForInstrument(request.instrument)
    if ((capability === 'market-bars' || capability === 'fundamentals')
      && request.instrument === undefined) {
      throw new Cne6LocalProviderError(
        `${capability} requires a canonical instrument`,
        'invalid-request',
        false,
      )
    }
    const explicitCodes = params.codes
    if (instrumentCode !== undefined && explicitCodes !== undefined) {
      throw new Cne6LocalProviderError(
        'use either request.instrument or params.codes, not both',
        'invalid-request',
        false,
      )
    }
    const asOf = normalizeAsOfDate(
      request.asOf,
      capability === 'market-bars'
        ? 'market-close'
        : capability === 'fundamentals' ? 'date-end' : undefined,
    )
    const normalized: Cne6QueryRequest = { dataset: canonicalDataset }
    if (params.columns !== undefined) normalized.columns = params.columns as string[]
    if (params.limit !== undefined) normalized.limit = params.limit as number
    if (explicitCodes !== undefined) normalized.codes = explicitCodes as string[]
    else if (instrumentCode !== undefined) normalized.codes = [instrumentCode]
    if (asOf !== undefined) normalized.asOf = asOf
    if (params.startDate !== undefined) normalized.startDate = params.startDate as string
    if (params.endDate !== undefined) normalized.endDate = params.endDate as string
    return normalized
  }

  private toCanonicalResult(
    result: Cne6QueryResult,
    request: CapabilityRequest<Cne6CapabilityParams>,
  ): CanonicalDataResult<unknown> {
    const fetchedAt = new Date().toISOString()
    const sourceValue = result.source[result.dataset === 'market-cap' ? 'marketCap' : result.dataset]
    let provenance: DataProvenance = {
      actualProvider: this.providerId,
      provider: this.providerId,
      upstreamSource: sourceLabel(sourceValue),
      sourceKind: 'derived',
      fetchedAt,
      ...(result.dataset === 'prices' ? { adjustment: priceAdjustment(result.source.prices) } : {}),
      upstreamVersion: result.hash[result.dataset],
      fallbackChain: [],
      qualityTier: result.pitGrade,
      qualityDowngrade: result.pitGrade !== 'safe',
      derived: {
        inputRefs: [
          `quality-report:${result.reportHash}`,
          `asset:${result.hash[result.dataset]}`,
        ],
        algorithm: 'cne6-local-read-only',
        algorithmVersion: '1',
        methodology: result.pitReason,
      },
    }
    const warnings = [
      ...(result.partial === true ? [`Published artifact is partial; failed symbols: ${result.failed.join(', ')}`] : []),
      ...(result.pitGrade === 'safe' || result.pitGrade === 'market-history' ? [] : [result.pitReason]),
    ]
    const batchStatus = classifyBatchCoverage(result, request)
    const status: DataStatus = batchStatus !== undefined
      ? batchStatus
      : result.rows.length === 0
        ? emptyResultStatus(result, request)
        : result.partial === true || result.pitGrade === 'unsafe' ? 'partial' : 'available'
    if (result.rows.length === 0 || status === 'provider-error' || status === 'unsupported') {
      provenance = { ...provenance, ...emptyVisibilityProvenance(result, request.asOf) }
      return { status, data: null, provenance, warnings }
    }
    if (request.capability === 'market-bars') {
      const data = mapMarketBars(result, requireCapabilityInstrument(request), provenance.adjustment)
      const latest = data.bars.at(-1)
      provenance = {
        ...provenance,
        ...(latest === undefined ? {} : { observedAt: latest.observedAt }),
        timezone: 'Asia/Shanghai',
        currency: 'CNY',
        unit: `price:${result.units.price};volume:${result.units.volume};turnover:${result.units.turnover}`,
      }
      return { status, data, provenance, warnings }
    }
    if (request.capability === 'fundamentals') {
      const data = mapFundamentals(result, requireCapabilityInstrument(request))
      const newest = data.periods[0]
      provenance = {
        ...provenance,
        currency: 'CNY',
        ...(newest === undefined ? {} : {
          fiscalPeriod: newest.fiscalPeriod,
          ...(newest.availableAt === null ? {} : { availableAt: newest.availableAt }),
        }),
      }
      return {
        status,
        data,
        provenance,
        warnings: [
          ...warnings,
          'CNE6 fundamentals do not distinguish publication time from the conservative availability date and do not encode one common unit or consolidation scope; those metadata fields are null.',
        ],
      }
    }
    return { status, data: result, provenance, warnings }
  }

  private normalizeQuery(request: Cne6QueryRequest): Record<string, unknown> {
    if (!isPlainObject(request)) {
      throw new Cne6LocalProviderError('query request must be an object', 'invalid-request', false)
    }
    const unknown = Object.keys(request).filter(key => !QUERY_KEYS.has(key))
    if (unknown.length > 0) {
      throw new Cne6LocalProviderError(
        `query contains unsupported fields: ${unknown.sort().join(', ')}`,
        'invalid-request',
        false,
      )
    }
    const dataset = typeof request.dataset === 'string' ? DATASET_ALIASES[request.dataset] : undefined
    if (dataset === undefined) {
      throw new Cne6LocalProviderError('query dataset is not supported', 'invalid-request', false)
    }

    let columns: string[] | undefined
    if (request.columns !== undefined) {
      if (!Array.isArray(request.columns) || request.columns.length < 1 || request.columns.length > 32) {
        throw new Cne6LocalProviderError('columns requires 1-32 entries', 'invalid-request', false)
      }
      if (!request.columns.every(value => typeof value === 'string' && value.length > 0)) {
        throw new Cne6LocalProviderError('columns must contain non-empty strings', 'invalid-request', false)
      }
      columns = [...new Set(request.columns)]
      if (columns.length !== request.columns.length) {
        throw new Cne6LocalProviderError('columns must not contain duplicates', 'invalid-request', false)
      }
      const allowed = new Set(DATASET_COLUMNS[dataset])
      const invalid = columns.filter(column => !allowed.has(column))
      if (invalid.length > 0) {
        throw new Cne6LocalProviderError(
          `columns are not allowed for ${dataset}: ${invalid.sort().join(', ')}`,
          'invalid-request',
          false,
        )
      }
    }

    let codes: string[] | undefined
    if (request.codes !== undefined) {
      if (!Array.isArray(request.codes) || request.codes.length < 1 || request.codes.length > 1_000) {
        throw new Cne6LocalProviderError('codes requires 1-1000 entries', 'invalid-request', false)
      }
      if (!request.codes.every(code => typeof code === 'string' && /^(?:sh|sz|bj)\.\d{6}$/i.test(code))) {
        throw new Cne6LocalProviderError(
          'codes must use sh.600000, sz.000001, or bj.430047 form',
          'invalid-request',
          false,
        )
      }
      codes = [...new Set(request.codes.map(code => code.toLowerCase()))]
      if (dataset === 'benchmark') {
        throw new Cne6LocalProviderError('benchmark does not support code filtering', 'invalid-request', false)
      }
    }

    const camelAsOf = request.asOf
    const snakeAsOf = request.as_of
    if (camelAsOf !== undefined && snakeAsOf !== undefined && camelAsOf !== snakeAsOf) {
      throw new Cne6LocalProviderError('asOf and as_of disagree', 'invalid-request', false)
    }
    const asOf = camelAsOf ?? snakeAsOf
    if (asOf !== undefined && (typeof asOf !== 'string' || !isIsoDate(asOf))) {
      throw new Cne6LocalProviderError('as_of must be a valid YYYY-MM-DD date', 'invalid-request', false)
    }
    if (asOf !== undefined && !['fundamentals', 'prices', 'benchmark'].includes(dataset)) {
      throw new Cne6LocalProviderError(
        `${dataset} does not support historical as_of queries`,
        'pit-unsafe',
        false,
      )
    }

    const startDate = aliasedDate(request.startDate, request.start_date, 'startDate', 'start_date')
    const endDate = aliasedDate(request.endDate, request.end_date, 'endDate', 'end_date')
    if ((startDate !== undefined || endDate !== undefined)
      && dataset !== 'prices' && dataset !== 'benchmark') {
      throw new Cne6LocalProviderError(
        'start/end date filters are only supported for prices and benchmark',
        'invalid-request',
        false,
      )
    }
    if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
      throw new Cne6LocalProviderError('start date must not be after end date', 'invalid-request', false)
    }

    const params: Record<string, unknown> = {
      dataset,
      limit: boundedInteger(request.limit ?? this.defaultLimit, 'limit', 1, this.maxRows),
    }
    if (columns !== undefined) params.columns = columns
    if (codes !== undefined) params.codes = codes
    if (asOf !== undefined) params.as_of = asOf
    if (startDate !== undefined) params.start_date = startDate
    if (endDate !== undefined) params.end_date = endDate
    return params
  }

  private runOperation<T>(operation: 'inspect' | 'query', params: object, signal?: AbortSignal): Promise<T> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal?.aborted === true) {
        rejectPromise(new Cne6LocalProviderError('CNE6 local request was aborted', 'aborted', false))
        return
      }

      const id = randomUUID()
      const request = {
        version: '1',
        id,
        operation,
        dataRoot: this.dataRoot,
        params,
        limits: { maxRows: this.maxRows },
      }
      const child = spawn(
        this.uvExecutable,
        [...this.uvArgs, this.pythonRunner],
        {
          cwd: this.projectRoot,
          env: this.runnerEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        },
      )
      const stdout: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let terminating = false
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
        if (terminating) return
        terminating = true
        kill(child, 'SIGTERM')
        killTimer = setTimeout(() => kill(child, 'SIGKILL'), this.killGraceMs)
        killTimer.unref()
      }
      const finish = (error?: Error, data?: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        if (error !== undefined) rejectPromise(error)
        else resolvePromise(data as T)
      }
      const abort = (): void => {
        terminate()
        finish(new Cne6LocalProviderError('CNE6 local request was aborted', 'aborted', false))
      }
      const requestWriteError = (): Cne6LocalProviderError => new Cne6LocalProviderError(
        'failed to write CNE6 local request',
        'process-error',
        true,
      )
      signal?.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(() => {
        const error = child.stdin.writableFinished
          ? new Cne6LocalProviderError(
              `CNE6 local runner timed out after ${this.timeoutMs}ms`,
              'timeout',
              true,
            )
          : requestWriteError()
        terminate()
        finish(error)
      }, this.timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || terminating) return
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > this.maxOutputBytes) {
          terminate()
          finish(new Cne6LocalProviderError('CNE6 local runner output exceeded limit', 'output-limit', false))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.byteLength)
      })
      child.on('error', () => finish(new Cne6LocalProviderError(
        'failed to start CNE6 local runner',
        'spawn-error',
        false,
      )))
      child.on('close', code => {
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (settled) return
        const output = Buffer.concat(stdout).toString('utf8').trim()
        const diagnostic = stderrBytes === 0 ? '' : '; runner emitted diagnostics'
        const lines = output.length === 0 ? [] : output.split(/\r?\n/)
        if (lines.length !== 1) {
          finish(new Cne6LocalProviderError(
            `CNE6 local runner returned ${lines.length} NDJSON records (exit ${code}${diagnostic})`,
            'protocol-error',
            false,
          ))
          return
        }
        let parsed: RunnerSuccess<unknown> | RunnerFailure
        try {
          parsed = JSON.parse(lines[0] as string) as RunnerSuccess<unknown> | RunnerFailure
        } catch {
          finish(new Cne6LocalProviderError(
            `CNE6 local runner returned malformed NDJSON (exit ${code}${diagnostic})`,
            'protocol-error',
            false,
          ))
          return
        }
        if (!isRunnerEnvelope(parsed) || parsed.version !== '1' || parsed.id !== id) {
          finish(new Cne6LocalProviderError('invalid CNE6 local runner envelope', 'protocol-error', false))
        } else if (!parsed.ok) {
          const kind = RUNNER_ERROR_KINDS.has(parsed.error.kind) ? parsed.error.kind : 'protocol-error'
          finish(new Cne6LocalProviderError(
            `CNE6 local runner reported ${kind}${diagnostic}`,
            kind,
            kind === parsed.error.kind ? parsed.error.retryable : false,
          ))
        } else if (code !== 0) {
          finish(new Cne6LocalProviderError(
            `CNE6 local runner exited with code ${code}`,
            'process-error',
            true,
          ))
        } else {
          try {
            validateRunnerData(operation, parsed.data, params, this.maxRows)
          } catch {
            finish(new Cne6LocalProviderError(
              'CNE6 local runner returned an invalid data payload',
              'protocol-error',
              false,
            ))
            return
          }
          finish(undefined, parsed.data as T)
        }
      })
      child.stdin.on('error', () => {
        if (settled) return
        terminate()
        finish(requestWriteError())
      })
      child.stdin.end(`${JSON.stringify(request)}\n`)
    })
  }
}

export function createCne6LocalProvider(options?: Cne6LocalProviderOptions): Cne6LocalProvider {
  return new Cne6LocalProvider(options)
}

function runnerEnvironment(projectRoot: string, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
    const value = parent[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function resolveRunnerExecutable(
  command: string,
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (command.trim() === '' || command.includes('\0')) {
    throw new Cne6LocalProviderError(
      'uvExecutable must be a non-empty executable path',
      'invalid-request',
      false,
    )
  }
  if (isAbsolute(command)) return command
  if (command.includes('/') || command.includes('\\')) return resolve(projectRoot, command)

  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
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
  return resolve(projectRoot, command)
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function isRunnerEnvelope(value: unknown): value is RunnerSuccess<unknown> | RunnerFailure {
  if (!isPlainObject(value) || typeof value.version !== 'string' || typeof value.ok !== 'boolean') return false
  if (!(typeof value.id === 'string' || value.id === null)) return false
  if (value.ok) return Object.hasOwn(value, 'data')
  if (!isPlainObject(value.error)) return false
  return typeof value.error.kind === 'string'
    && typeof value.error.message === 'string'
    && typeof value.error.retryable === 'boolean'
}

function validateRunnerData(
  operation: 'inspect' | 'query',
  value: unknown,
  params: object,
  maxRows: number,
): asserts value is Cne6Inspection | Cne6QueryResult {
  assertJsonValue(value, '$.data')
  if (!isPlainObject(value) || value.providerId !== 'cne6-local') {
    throw new TypeError('data must be a cne6-local object')
  }
  validateProvenance(value)
  if (operation === 'inspect') {
    if (!['ready', 'degraded'].includes(value.status as string)) throw new TypeError('inspection status is invalid')
    if (!(typeof value.generatedAt === 'string' || value.generatedAt === null)) {
      throw new TypeError('generatedAt is invalid')
    }
    if (!isPlainObject(value.assets)) throw new TypeError('assets must be an object')
    for (const dataset of Object.keys(DATASET_COLUMNS) as Cne6Dataset[]) {
      const asset = value.assets[dataset]
      if (!isPlainObject(asset)
        || typeof asset.manifestKey !== 'string'
        || typeof asset.file !== 'string'
        || !isSafeNonNegativeInteger(asset.bytes)
        || typeof asset.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(asset.sha256)
        || !isSafeNonNegativeInteger(asset.rows)
        || !isStringArray(asset.columns)) {
        throw new TypeError(`asset ${dataset} is invalid`)
      }
    }
    return
  }

  const request = params as Record<string, unknown>
  if (!(typeof value.dataset === 'string' && value.dataset === request.dataset)) {
    throw new TypeError('query dataset does not match request')
  }
  if (!isStringArray(value.columns) || !Array.isArray(value.rows) || !isStringArray(value.matchedCodes)) {
    throw new TypeError('query rows or matched-code metadata are invalid')
  }
  const dataset = value.dataset as Cne6Dataset
  const responseColumns = value.columns as string[]
  if (responseColumns.some(column => !DATASET_COLUMNS[dataset].includes(column))) {
    throw new TypeError('query returned a non-whitelisted column')
  }
  const requestedColumns = request.columns
  if (Array.isArray(requestedColumns)
    && (requestedColumns.length !== responseColumns.length
      || requestedColumns.some((column, index) => column !== responseColumns[index]))) {
    throw new TypeError('query columns do not match request')
  }
  const requestedLimit = request.limit
  if (!isSafeNonNegativeInteger(requestedLimit)
    || value.rows.length > requestedLimit
    || value.rows.length > maxRows
    || value.returned !== value.rows.length
    || typeof value.truncated !== 'boolean') {
    throw new TypeError('query pagination metadata is invalid')
  }
  const matchedCodes = value.matchedCodes as string[]
  const requestedCodes = Array.isArray(request.codes)
    ? request.codes.map(code => String(code).replace(/^(?:sh|sz|bj)\./iu, ''))
    : []
  if (new Set(matchedCodes).size !== matchedCodes.length
    || matchedCodes.some(code => !/^\d{6}$/u.test(code))
    || matchedCodes.some(code => !requestedCodes.includes(code))
    || (requestedCodes.length === 0 && matchedCodes.length !== 0)) {
    throw new TypeError('query matched-code metadata is invalid')
  }
  const columnSet = new Set(responseColumns)
  for (const row of value.rows) {
    if (!isPlainObject(row)
      || Object.keys(row).length !== responseColumns.length
      || Object.keys(row).some(column => !columnSet.has(column))) {
      throw new TypeError('query row columns are invalid')
    }
  }
  for (const field of ['asOf', 'startDate', 'endDate']) {
    if (!(typeof value[field] === 'string' || value[field] === null)) {
      throw new TypeError(`${field} is invalid`)
    }
  }
  if (value.asOf !== (request.as_of ?? null)
    || value.startDate !== (request.start_date ?? null)
    || value.endDate !== (request.end_date ?? null)) {
    throw new TypeError('query date metadata does not match request')
  }
}

function validateProvenance(value: Record<string, unknown>): void {
  if (!(isPlainObject(value.build) || value.build === null)
    || !isPlainObject(value.source)
    || !isPlainObject(value.coverage)
    || !isPlainObject(value.quality) || value.quality.quality_flag !== 'proxy'
    || !isPlainObject(value.quality.coverage) || !isStringArray(value.quality.reasons)
    || !(typeof value.partial === 'boolean' || value.partial === null)
    || !isStringArray(value.failed)
    || !isStringArray(value.requested)
    || !isPublishedUnits(value.units)
    || !isPlainObject(value.hash)
    || typeof value.aggregateHash !== 'string'
    || typeof value.reportHash !== 'string'
    || !['safe', 'market-history', 'partial', 'unsafe'].includes(value.pitGrade as string)
    || typeof value.pitReason !== 'string') {
    throw new TypeError('provenance is invalid')
  }
  const requested = value.requested as string[]
  const failed = value.failed as string[]
  if (requested.length === 0
    || new Set(requested).size !== requested.length
    || new Set(failed).size !== failed.length
    || requested.some(symbol => !/^\d{6}$/u.test(symbol))
    || failed.some(symbol => !/^\d{6}$/u.test(symbol))
    || failed.some(symbol => !requested.includes(symbol))) {
    throw new TypeError('provenance symbol coverage is invalid')
  }
  for (const dataset of Object.keys(DATASET_COLUMNS) as Cne6Dataset[]) {
    if (typeof value.hash[dataset] !== 'string' || !/^[0-9a-f]{64}$/.test(value.hash[dataset])) {
      throw new TypeError(`hash ${dataset} is invalid`)
    }
  }
  if (!/^[0-9a-f]{64}$/.test(value.aggregateHash) || !/^[0-9a-f]{64}$/.test(value.reportHash)) {
    throw new TypeError('aggregate or report hash is invalid')
  }
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`)
    return
  }
  throw new TypeError(`${path} is not JSON-safe`)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function aliasedDate(
  camelValue: unknown,
  snakeValue: unknown,
  camelName: string,
  snakeName: string,
): string | undefined {
  if (camelValue !== undefined && snakeValue !== undefined && camelValue !== snakeValue) {
    throw new Cne6LocalProviderError(`${camelName} and ${snakeName} disagree`, 'invalid-request', false)
  }
  const value = camelValue ?? snakeValue
  if (value !== undefined && (typeof value !== 'string' || !isIsoDate(value))) {
    throw new Cne6LocalProviderError(
      `${snakeName} must be a valid YYYY-MM-DD date`,
      'invalid-request',
      false,
    )
  }
  return value as string | undefined
}

function normalizeAsOfDate(
  value: string | undefined,
  visibility?: 'market-close' | 'date-end',
): string | undefined {
  if (value === undefined) return undefined
  if (isIsoDate(value)) return value
  const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  const parsed = Date.parse(value)
  if (timestamp !== null
    && isIsoDate(timestamp[1] as string)
    && Number(timestamp[2]) <= 23
    && Number(timestamp[3]) <= 59
    && Number(timestamp[4]) <= 59
    && Number.isFinite(parsed)) {
    const shanghaiDate = new Date(parsed + CHINA_OFFSET_MS).toISOString().slice(0, 10)
    if (visibility === 'date-end'
      || (visibility === 'market-close'
        && parsed < Date.parse(`${shanghaiDate}T15:00:00+08:00`))) {
      return new Date(Date.parse(`${shanghaiDate}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
    }
    return shanghaiDate
  }
  throw new Cne6LocalProviderError('asOf must be an ISO-compatible date or timestamp', 'invalid-request', false)
}

function codeForInstrument(instrument: InstrumentId): string {
  if (!isPlainObject(instrument)) {
    throw new Cne6LocalProviderError('instrument must be a canonical object', 'invalid-request', false)
  }
  const unknown = Object.keys(instrument).filter(
    key => !new Set(['market', 'exchange', 'symbol', 'assetType']).has(key),
  )
  if (unknown.length > 0) {
    throw new Cne6LocalProviderError(
      `instrument contains unsupported fields: ${unknown.sort().join(', ')}`,
      'invalid-request',
      false,
    )
  }
  if (instrument.market !== 'CN' || !/^\d{6}$/.test(instrument.symbol)) {
    throw new Cne6LocalProviderError('instrument must be a six-digit CN instrument', 'invalid-request', false)
  }
  if (!['SSE', 'SZSE', 'BSE'].includes(instrument.exchange)) {
    throw new Cne6LocalProviderError('instrument exchange is unsupported', 'unsupported', false)
  }
  if (instrument.assetType !== 'equity') {
    throw new Cne6LocalProviderError('capability requires an equity instrument', 'invalid-request', false)
  }
  const prefix = ({ SSE: 'sh', SZSE: 'sz', BSE: 'bj' } as const)[instrument.exchange as 'SSE' | 'SZSE' | 'BSE']
  return `${prefix}.${instrument.symbol}`
}

function sourceLabel(value: Cne6JsonValue | undefined): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value !== undefined) return JSON.stringify(value)
  return 'verified CNE6 local published artifact'
}

function emptyVisibilityProvenance(
  result: Cne6QueryResult,
  requestedAsOf: string | undefined,
): Pick<DataProvenance, 'availableAt' | 'observedAt'> {
  if (result.asOf === null) return {}
  const timestamp = requestedAsOf ?? result.asOf
  return result.dataset === 'fundamentals'
    ? { availableAt: timestamp }
    : { availableAt: timestamp, observedAt: dailyCloseTimestamp(result.asOf) }
}

function emptyResultStatus(
  result: Cne6QueryResult,
  request: CapabilityRequest<Cne6CapabilityParams>,
): Extract<DataStatus, 'provider-error' | 'unsupported' | 'no-data'> {
  const requestedCodes = requestedSymbols(request)
  if (requestedCodes.some(symbol => result.failed.includes(symbol))) return 'provider-error'
  if (requestedCodes.length > 0
    && requestedCodes.every(symbol => !result.requested.includes(symbol))) return 'unsupported'
  return 'no-data'
}

function classifyBatchCoverage(
  result: Cne6QueryResult,
  request: CapabilityRequest<Cne6CapabilityParams>,
): Extract<DataStatus, 'provider-error' | 'unsupported' | 'partial'> | undefined {
  const symbols = requestedSymbols(request)
  if (symbols.length === 0) return undefined
  if (symbols.every(symbol => result.failed.includes(symbol))) return 'provider-error'
  if (symbols.every(symbol => !result.requested.includes(symbol))) return 'unsupported'
  if (symbols.length > 1
    && symbols.some(symbol => result.failed.includes(symbol) || !result.requested.includes(symbol))) {
    return 'partial'
  }
  if (symbols.length > 1 && result.rows.length > 0) {
    const returnedSymbols = new Set(result.matchedCodes)
    const expectedSymbols = symbols.filter(
      symbol => result.requested.includes(symbol) && !result.failed.includes(symbol),
    )
    if (expectedSymbols.some(symbol => !returnedSymbols.has(symbol))) return 'partial'
  }
  return undefined
}

function requestedSymbols(request: CapabilityRequest<Cne6CapabilityParams>): string[] {
  return request.instrument === undefined
    ? (request.params?.codes ?? []).map(code => code.replace(/^(?:sh|sz|bj)\./iu, ''))
    : [request.instrument.symbol]
}

function requireCapabilityInstrument(
  request: CapabilityRequest<Cne6CapabilityParams>,
): InstrumentId {
  if (request.instrument === undefined) {
    throw new Cne6LocalProviderError(
      `${request.capability} requires a canonical instrument`,
      'invalid-request',
      false,
    )
  }
  return structuredClone(request.instrument)
}

function mapMarketBars(
  result: Cne6QueryResult,
  instrument: InstrumentId,
  adjustment: AdjustmentMode | undefined,
): Cne6MarketBars {
  if (result.dataset !== 'prices' || (adjustment !== 'none' && adjustment !== 'qfq')) {
    throw canonicalMappingError('market-bars query metadata is incompatible')
  }
  const expectedCode = codeForInstrument(instrument)
  const bars = result.rows.map((row, index): Cne6MarketBar => {
    if (row.code !== expectedCode) {
      throw canonicalMappingError(`market-bars row ${index} has a conflicting instrument`)
    }
    return {
      date: requiredDate(row.date, `market-bars row ${index}.date`),
      observedAt: dailyCloseTimestamp(requiredDate(row.date, `market-bars row ${index}.date`)),
      open: nullableNumber(row.open, `market-bars row ${index}.open`),
      high: nullableNumber(row.high, `market-bars row ${index}.high`),
      low: nullableNumber(row.low, `market-bars row ${index}.low`),
      close: nullableNumber(row.close, `market-bars row ${index}.close`),
      preClose: nullableNumber(row.preclose, `market-bars row ${index}.preclose`),
      volume: nullableNumber(row.volume, `market-bars row ${index}.volume`),
      turnover: nullableNumber(row.amount, `market-bars row ${index}.amount`),
    }
  }).sort((left, right) => left.date.localeCompare(right.date))
  if (new Set(bars.map(bar => bar.date)).size !== bars.length) {
    throw canonicalMappingError('market-bars rows contain duplicate dates')
  }
  const startDate = bars[0]?.date
  const endDate = bars.at(-1)?.date
  if (startDate === undefined || endDate === undefined) {
    throw canonicalMappingError('market-bars rows are empty')
  }
  return {
    instrument,
    interval: '1d',
    adjustment,
    bars,
    returned: bars.length,
    truncated: result.truncated,
    startDate,
    endDate,
  }
}

function mapFundamentals(
  result: Cne6QueryResult,
  instrument: InstrumentId,
): Cne6Fundamentals {
  if (result.dataset !== 'fundamentals') {
    throw canonicalMappingError('fundamentals query metadata is incompatible')
  }
  const expectedCode = codeForInstrument(instrument)
  const periods = result.rows.map((row, index): Cne6FundamentalPeriod => {
    if (row.code !== expectedCode) {
      throw canonicalMappingError(`fundamentals row ${index} has a conflicting instrument`)
    }
    const fiscalPeriod = requiredDate(row.report_date, `fundamentals row ${index}.report_date`)
    const availableAt = optionalDate(row.available_date, `fundamentals row ${index}.available_date`)
    if (availableAt !== null && availableAt < fiscalPeriod) {
      throw canonicalMappingError(`fundamentals row ${index} predates its fiscal period`)
    }
    const fields: Record<string, DataField<number>> = {}
    for (const [sourceName, canonicalName] of Object.entries(FUNDAMENTAL_FIELD_NAMES)) {
      fields[canonicalName] = numericField(row[sourceName], `fundamentals row ${index}.${sourceName}`)
    }
    return {
      fiscalPeriod,
      publishedAt: null,
      availableAt,
      currency: 'CNY',
      unit: null,
      scope: null,
      fields,
    }
  }).sort((left, right) => right.fiscalPeriod.localeCompare(left.fiscalPeriod))
  if (new Set(periods.map(period => period.fiscalPeriod)).size !== periods.length) {
    throw canonicalMappingError('fundamentals rows contain duplicate fiscal periods')
  }
  return {
    instrument,
    periods,
    returned: periods.length,
    truncated: result.truncated,
    pitSafe: result.pitGrade === 'safe' && periods.every(period => period.availableAt !== null),
    quality: result.quality,
  }
}

function requiredDate(value: Cne6JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !isIsoDate(value)) {
    throw canonicalMappingError(`${label} must be a valid YYYY-MM-DD date`)
  }
  return value
}

function optionalDate(value: Cne6JsonValue | undefined, label: string): string | null {
  if (value === null || value === undefined) return null
  return requiredDate(value, label)
}

function nullableNumber(value: Cne6JsonValue | undefined, label: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw canonicalMappingError(`${label} must be a finite number or null`)
  }
  return value
}

function numericField(value: Cne6JsonValue | undefined, label: string): DataField<number> {
  const number = nullableNumber(value, label)
  return number === null ? { status: 'missing', value: null } : { status: 'available', value: number }
}

function dailyCloseTimestamp(value: string): string {
  return `${value}T15:00:00+08:00`
}

function isPublishedUnits(value: unknown): value is Cne6Provenance['units'] {
  return isPlainObject(value)
    && Object.keys(value).length === 3
    && value.price === 'CNY'
    && value.volume === 'share'
    && value.turnover === 'CNY'
}

function canonicalMappingError(message: string): Cne6LocalProviderError {
  return new Cne6LocalProviderError(`CNE6 canonical mapping failed: ${message}`, 'schema-drift', false)
}

function priceAdjustment(source: Cne6JsonValue | undefined): 'none' | 'qfq' {
  if (isPlainObject(source)) {
    const qfqCount = source['eastmoney-qfq']
    const rawCount = source['sina-unadjusted']
    const qfq = typeof qfqCount === 'number' && qfqCount > 0
    const raw = typeof rawCount === 'number' && rawCount > 0
    if (qfq && !raw) return 'qfq'
    if (raw && !qfq) return 'none'
  }
  throw new Cne6LocalProviderError(
    'CNE6 published prices do not declare one unambiguous adjustment mode',
    'unsupported',
    false,
  )
}

function assertPublishedDataRoot(dataRoot: string): void {
  const parts = dataRoot.split(sep).map(part => part.toLowerCase())
  const forbidden = parts.find(part => DISALLOWED_DATA_PATH_PARTS.has(part))
  if (forbidden !== undefined) {
    throw new Cne6LocalProviderError(
      `published data root cannot be inside ${forbidden}`,
      'unsafe-path',
      false,
    )
  }
}
