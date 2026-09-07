import {
  FinanceDataError,
  normalizeAshareInstrument,
  parseCanonicalInstrument,
} from '@finance2dsh/core'
import type {
  AssetType,
  CanonicalDataResult,
  CapabilityRequest,
  DataField,
  DataCapability,
  DataProvenance,
  Exchange,
  InstrumentId,
} from '@finance2dsh/core'
import type { FinanceDataService, RouteOptions } from '@finance2dsh/data-service'
import {
  ASHARE_FEATURES,
  getAshareFeature,
  type AshareFeatureDefinition,
  type AshareFeatureVariant,
} from '@finance2dsh/provider-astock'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AshareDataComposition, AshareProviderId } from './ashare-composition.js'

export const ASHARE_TOOL_NAMES = [
  'finance_data_catalog',
  'finance_cn_instrument',
  'finance_cn_quote',
  'finance_cn_bars',
  'finance_cn_fundamentals',
  'finance_cn_disclosures',
  'finance_cn_market_activity',
  'finance_cn_macro_index',
] as const

const SOURCES = [
  'auto',
  'a-stock-public',
  'tushare-mcp',
  'tdx-official',
  'tdx-community',
  'ifind-official',
  'cne6-local',
] as const
const EXCHANGES = ['SSE', 'SZSE', 'BSE'] as const
const ASSET_TYPES = ['equity', 'index', 'etf', 'fund', 'bond'] as const
const featureIdsFor = (toolName: string): string[] => ASHARE_FEATURES
  .filter(item => item.tools.includes(toolName)).map(item => item.featureId)
const datasetsFor = (toolName: string): string[] => [...new Set(ASHARE_FEATURES.flatMap(item => (
  item.variants.filter(variant => variant.toolName === toolName).map(variant => variant.dataset)
)))]
const variantsFor = (toolName: string): string[] => [...new Set(ASHARE_FEATURES.flatMap(item => (
  item.variants.filter(variant => variant.toolName === toolName).map(variant => variant.id)
)))]
const INSTRUMENT_FEATURES = featureIdsFor('finance_cn_instrument')
const QUOTE_FEATURES = featureIdsFor('finance_cn_quote')
const BARS_FEATURES = featureIdsFor('finance_cn_bars')
const FUNDAMENTAL_FEATURES = featureIdsFor('finance_cn_fundamentals')
const DISCLOSURE_FEATURES = featureIdsFor('finance_cn_disclosures')
const ACTIVITY_FEATURES = featureIdsFor('finance_cn_market_activity')
const MACRO_INDEX_FEATURES = featureIdsFor('finance_cn_macro_index')

type ToolSource = typeof SOURCES[number]
type JsonRecord = Record<string, unknown>

interface QuoteSnapshot {
  instrument: InstrumentId
  tradingDate: string | null
  observedAt: string | null
  currency: string | null
  fields: {
    name: DataField<string>
    open: DataField<number>
    high: DataField<number>
    low: DataField<number>
    last: DataField<number>
    previousClose: DataField<number>
    volume: DataField<number>
    turnover: DataField<number>
  }
}

interface FundamentalPeriodLike extends JsonRecord {
  fiscalPeriod?: string
  publishedAt?: string | null
  announcedAt?: string | null
  availableAt?: string | null
}

export interface AshareToolBackend {
  readonly service: Pick<FinanceDataService, 'execute'>
  readonly approvedProviderIds: readonly AshareProviderId[]
  catalog(): ReturnType<AshareDataComposition['catalog']>
  readonly iwencaiConfigured?: boolean
}

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

const SOURCE_PARAMETER = {
  type: 'string' as const,
  enum: SOURCES,
  description: 'auto or an approved provider id returned by finance_data_catalog.',
}

const AS_OF_PARAMETER = {
  type: 'string' as const,
  description: 'ISO YYYY-MM-DD date or timestamp; returned data must have been visible by this time.',
}

function strictTool(tool: ToolDefinition): ToolDefinition {
  const allowed = new Set(Object.keys(tool.parameters.properties ?? {}))
  const originalExecute = tool.execute.bind(tool)
  return {
    ...tool,
    parameters: { ...tool.parameters, additionalProperties: false },
    async execute(args, exec) {
      if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
        const unknown = Object.keys(args).filter(key => !allowed.has(key))
        if (unknown.length > 0) {
          throw new TypeError('unsupported tool parameters: ' + unknown.sort().join(', '))
        }
      }
      return originalExecute(args, exec)
    },
  }
}

function jsonSafe(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never
}

function routeOptions(source: ToolSource): RouteOptions {
  return source === 'auto' ? { provider: 'auto' } : { provider: source, fallback: false }
}

function selectedFeature(
  toolName: string,
  featureId: string | undefined,
  dataset: string | undefined,
  variantId?: string,
): { definition: AshareFeatureDefinition; variant: AshareFeatureVariant } | undefined {
  if (featureId === undefined && dataset === undefined) return undefined
  let candidates = ASHARE_FEATURES.flatMap(definition => definition.variants
    .filter(variant => variant.toolName === toolName
      && (featureId === undefined || definition.featureId === featureId)
      && (dataset === undefined || variant.dataset === dataset)
      && (variantId === undefined || variant.id === variantId))
    .map(variant => ({ definition, variant })))
  if (candidates.length > 1 && featureId !== undefined && dataset === undefined && variantId === undefined) {
    const definition = getAshareFeature(featureId)
    const preferred = candidates.find(item => item.variant.id === definition.variants[0]?.id)
    if (preferred !== undefined) candidates = [preferred]
  }
  if (candidates.length !== 1) throw new TypeError('feature and dataset must select exactly one curated A-share variant')
  return candidates[0]
}

function optionalCanonical(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError('instrument must be a canonical or six-digit string')
  const normalized = normalizeAshareInstrument(value)
  return 'CN:' + normalized.exchange + ':' + normalized.symbol + ':' + normalized.assetType
}

async function executeFeature(
  backend: AshareToolBackend,
  selected: { definition: AshareFeatureDefinition; variant: AshareFeatureVariant },
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<never> {
  if (args.source !== undefined && args.source !== 'auto' && args.source !== 'a-stock-public') {
    throw new FinanceDataError('curated A-share features are implemented by a-stock-public', 'invalid-request', { retryable: false })
  }
  const definition = getAshareFeature(selected.definition.featureId)
  const instrument = optionalCanonical(args.instrument ?? args.query)
  if ((definition.scope === 'instrument' || definition.scope === 'index') && instrument === undefined) {
    throw new TypeError('selected feature requires instrument')
  }
  const params: Record<string, unknown> = {
    featureId: definition.featureId,
    variant: selected.variant.id,
    limit: boundedInteger((args.limit as number | undefined) ?? definition.defaultLimit, 'limit', 1, definition.maxLimit),
  }
  const mappings: Array<[string, string]> = [
    ['start_date', 'startDate'], ['end_date', 'endDate'], ['trade_date', 'tradeDate'],
    ['as_of', 'asOf'], ['official_provider', 'officialProvider'], ['industry_code', 'industryCode'],
    ['board_type', 'boardType'], ['period', 'period'], ['year', 'year'], ['page', 'page'],
    ['lookback_days', 'lookbackDays'], ['forward_days', 'forwardDays'], ['category', 'category'],
    ['statement', 'statement'], ['search_text', 'searchText'], ['channel', 'channel'],
    ['underlying', 'underlying'], ['option_code', 'optionCode'], ['option_type', 'optionType'],
    ['interval', 'interval'], ['adjustment', 'adjustment'],
  ]
  for (const [external, internal] of mappings) if (args[external] !== undefined) params[internal] = args[external]
  return executeAshare(
    backend, selected.variant.dataCapability, instrument, args.as_of as string | undefined, params,
    'a-stock-public', signal,
  )
}

function buildRequest(
  capability: DataCapability,
  canonical: string | undefined,
  asOf: string | undefined,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): CapabilityRequest {
  return {
    capability,
    market: 'CN',
    ...(canonical === undefined ? {} : { instrument: parseCanonicalInstrument(canonical) }),
    ...(asOf === undefined ? {} : { asOf: strictDateOrTimestamp(asOf, 'as_of') }),
    ...(Object.keys(params).length === 0 ? {} : { params }),
    signal,
  }
}

async function executeAshare(
  backend: AshareToolBackend,
  capability: DataCapability,
  canonical: string | undefined,
  asOf: string | undefined,
  params: Readonly<Record<string, unknown>>,
  source: ToolSource,
  signal: AbortSignal,
): Promise<never> {
  if (source !== 'auto' && !(backend.approvedProviderIds as readonly string[]).includes(source)) {
    throw new FinanceDataError('source is not an approved A-share provider', 'invalid-request', { retryable: false })
  }
  return jsonSafe(await backend.service.execute(
    buildRequest(capability, canonical, asOf, params, signal),
    routeOptions(source),
  ))
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function field<T>(value: unknown, note: string): DataField<T> {
  const existing = record(value)
  if (existing !== undefined && typeof existing.status === 'string' && 'value' in existing) {
    return JSON.parse(JSON.stringify(existing)) as DataField<T>
  }
  return value === undefined || value === null
    ? { status: 'missing', value: null, note }
    : { status: 'available', value: value as T }
}

function quoteField(
  data: JsonRecord,
  name: string,
  aliases: readonly string[],
  note: string,
): DataField<never> {
  const fields = record(data.fields)
  if (fields !== undefined && name in fields) return field(fields[name], note)
  for (const alias of aliases) {
    if (alias in data) return field(data[alias], note)
  }
  return field(undefined, note)
}

function quoteSnapshot(
  data: JsonRecord,
  fallbackInstrument: InstrumentId,
  provenance: DataProvenance,
): QuoteSnapshot {
  const observedAt = typeof data.observedAt === 'string'
    ? data.observedAt
    : typeof provenance.observedAt === 'string' ? provenance.observedAt : null
  const tradingDate = typeof data.tradingDate === 'string'
    ? data.tradingDate
    : observedAt === null ? null : observedAt.slice(0, 10)
  return {
    instrument: record(data.instrument) === undefined
      ? structuredClone(fallbackInstrument)
      : JSON.parse(JSON.stringify(data.instrument)) as InstrumentId,
    tradingDate,
    observedAt,
    currency: typeof data.currency === 'string'
      ? data.currency
      : typeof provenance.currency === 'string' ? provenance.currency : 'CNY',
    fields: {
      name: quoteField(data, 'name', ['name'], 'The selected quote provider did not return a security name'),
      open: quoteField(data, 'open', ['open'], 'The selected quote provider did not return an open price'),
      high: quoteField(data, 'high', ['high'], 'The selected quote provider did not return a high price'),
      low: quoteField(data, 'low', ['low'], 'The selected quote provider did not return a low price'),
      last: quoteField(data, 'last', ['last', 'lastPrice', 'close'], 'The selected quote provider did not return a last price'),
      previousClose: quoteField(data, 'previousClose', ['previousClose', 'preClose'], 'The selected quote provider did not return a previous close'),
      volume: quoteField(data, 'volume', ['volume'], 'The selected quote provider did not return volume'),
      turnover: quoteField(data, 'turnover', ['turnover', 'amount'], 'The selected quote provider did not return turnover'),
    },
  }
}

function appendWarning(warnings: readonly string[], warning: string): string[] {
  return warnings.includes(warning) ? [...warnings] : [...warnings, warning]
}

function historicalQuote(
  response: CanonicalDataResult<unknown>,
  canonical: string,
  requestedDate: string,
): never {
  const warning = 'Historical quote snapshot was derived from one unadjusted daily bar; it is not a historical real-time quote or order-book snapshot.'
  const provenance: DataProvenance = {
    ...response.provenance,
    adjustment: 'none',
    derived: {
      inputRefs: [`${response.provenance.actualProvider}:market-bars:${requestedDate}`],
      algorithm: 'daily-bar-to-quote-snapshot',
      algorithmVersion: '1',
      methodology: 'Maps the exact requested trading date from one unadjusted daily OHLCV bar.',
    },
  }
  const payload = record(response.data)
  const bars = payload?.bars
  if (!Array.isArray(bars)) {
    if (response.data !== null || ['available', 'partial', 'stale'].includes(response.status)) {
      throw new FinanceDataError(
        'market-bars provider returned a payload that cannot be mapped to a historical quote',
        'schema-drift',
        { provider: response.provenance.actualProvider, retryable: false },
      )
    }
    return jsonSafe({ ...response, provenance, warnings: appendWarning(response.warnings, warning) })
  }
  const selected = bars.map(record).find(item => {
    const observedAt = typeof item?.observedAt === 'string' ? item.observedAt : item?.date
    return typeof observedAt === 'string' && observedAt.slice(0, 10) === requestedDate
  })
  if (selected === undefined) {
    return jsonSafe({
      ...response,
      status: 'no-data',
      data: null,
      provenance,
      warnings: appendWarning(
        appendWarning(response.warnings, warning),
        'No daily bar exists for the exact requested date; a nearby trading day was not substituted.',
      ),
    })
  }
  const observedAt = typeof selected.observedAt === 'string' ? selected.observedAt : requestedDate
  const snapshot = quoteSnapshot({
    instrument: payload?.instrument ?? parseCanonicalInstrument(canonical),
    tradingDate: requestedDate,
    observedAt,
    currency: response.provenance.currency ?? 'CNY',
    open: selected.open,
    high: selected.high,
    low: selected.low,
    close: selected.close,
    preClose: selected.preClose,
    volume: selected.volume,
    turnover: selected.turnover ?? selected.amount,
  }, parseCanonicalInstrument(canonical), provenance)
  return jsonSafe({
    ...response,
    data: snapshot,
    provenance: { ...provenance, observedAt },
    warnings: appendWarning(response.warnings, warning),
  })
}

function currentQuote(
  response: CanonicalDataResult<unknown>,
  canonical: string,
): never {
  const payload = record(response.data)
  if (payload === undefined) return jsonSafe(response)
  return jsonSafe({
    ...response,
    data: quoteSnapshot(payload, parseCanonicalInstrument(canonical), response.provenance),
  })
}

function providerHealthAllows(
  entry: Awaited<ReturnType<AshareDataComposition['catalog']>>[number],
  capability: DataCapability,
): boolean {
  const healthy = (status: string): boolean => status === 'healthy' || status === 'degraded'
  const capabilityStatus = entry.health.capabilities?.[capability]
  return entry.routable
    && healthy(entry.health.status)
    && (capabilityStatus === undefined || healthy(capabilityStatus))
}

async function ensureRoutableCapability(
  backend: AshareToolBackend,
  capability: DataCapability,
  source: ToolSource,
): Promise<void> {
  if (source !== 'auto' && !(backend.approvedProviderIds as readonly string[]).includes(source)) {
    throw new FinanceDataError('source is not an approved A-share provider', 'invalid-request', { retryable: false })
  }
  const candidates = (await backend.catalog()).filter(entry => (
    (source === 'auto' || entry.providerId === source)
    && entry.capabilities.includes(capability)
  ))
  if (candidates.some(entry => providerHealthAllows(entry, capability))) return
  throw new FinanceDataError(
    `${capability} is not supported by a currently healthy, routable A-share provider`,
    'unsupported',
    {
      ...(source === 'auto' ? {} : { provider: source }),
      retryable: false,
      details: { capability, source },
    },
  )
}

function alignedFundamentalsProvenance(
  provenance: DataProvenance,
  selected: FundamentalPeriodLike | undefined,
): DataProvenance {
  const { fiscalPeriod: _fiscalPeriod, publishedAt: _publishedAt, availableAt: _availableAt, ...base } = provenance
  if (selected === undefined) return base
  const publishedAt = typeof selected.publishedAt === 'string'
    ? selected.publishedAt
    : typeof selected.announcedAt === 'string' ? selected.announcedAt : undefined
  return {
    ...base,
    ...(typeof selected.fiscalPeriod === 'string' ? { fiscalPeriod: selected.fiscalPeriod } : {}),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(typeof selected.availableAt === 'string' ? { availableAt: selected.availableAt } : {}),
  }
}

function page(value: number | undefined): number {
  const selected = boundedInteger(value ?? 1, 'page', 1, 200)
  if (selected !== 1) {
    throw new RangeError('page values above 1 are not supported yet; use a narrower date range')
  }
  return selected
}

function dateRange(start: string | undefined, end: string | undefined): { startDate?: string; endDate?: string } {
  if ((start === undefined) !== (end === undefined)) {
    throw new TypeError('start_date and end_date must be provided together')
  }
  if (start === undefined || end === undefined) return {}
  const startDate = strictDate(start, 'start_date')
  const endDate = strictDate(end, 'end_date')
  if (startDate > endDate) throw new RangeError('start_date must not be after end_date')
  const days = Math.floor((Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86_400_000) + 1
  if (days > 3_660) throw new RangeError('date range must not exceed 3660 days')
  return { startDate, endDate }
}

export function createAshareFinanceTools(backend: AshareToolBackend): ToolDefinition[] {
  return [
    strictTool(defineTool({
      name: 'finance_data_catalog',
      description: 'List curated A-share providers, capabilities, routing eligibility and health. Advertised long-tail surfaces may still be unsupported when no healthy routable provider exists.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        capability: { type: 'string', enum: [
          'instrument-reference', 'quote', 'market-bars', 'order-book', 'fundamentals',
          'corporate-actions', 'disclosures', 'research-consensus', 'capital-flow',
          'market-signal', 'industry-classification', 'index', 'macro', 'trading-calendar', 'risk-data',
        ] },
        source: SOURCE_PARAMETER,
        feature: { type: 'string', enum: ASHARE_FEATURES.map(item => item.featureId) },
      },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const catalog = await backend.catalog()
        const features = ASHARE_FEATURES.filter(item => (
          args.feature === undefined || item.featureId === args.feature
        )).map(item => ({
          ...item,
          health: item.auth === 'api-key' && backend.iwencaiConfigured !== true
            ? 'blocked-auth'
            : catalog.find(entry => entry.providerId === 'a-stock-public')?.health.status ?? 'unavailable',
        }))
        return jsonSafe({
          market: 'CN',
          providers: catalog.filter(entry => (
            (args.source === undefined || args.source === 'auto' || entry.providerId === args.source)
            && (args.capability === undefined || entry.capabilities.includes(args.capability as DataCapability))
          )),
          features,
        })
      },
    })),
    strictTool(defineTool({
      name: 'finance_cn_instrument',
      description: 'Normalize one mainland-China security code to a canonical instrument and enrich it through a curated provider.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        query: { type: 'string', required: true, description: 'Six-digit, exchange-qualified, or canonical security identifier.' },
        exchange: { type: 'string', enum: EXCHANGES },
        asset_type: { type: 'string', enum: ASSET_TYPES },
        source: SOURCE_PARAMETER,
        dataset: { type: 'string', enum: datasetsFor('finance_cn_instrument') },
        feature: { type: 'string', enum: INSTRUMENT_FEATURES },
        variant: { type: 'string', enum: variantsFor('finance_cn_instrument') },
        as_of: AS_OF_PARAMETER,
        limit: { type: 'integer' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const normalized = normalizeAshareInstrument(args.query, {
          ...(args.exchange === undefined ? {} : { exchange: args.exchange as Extract<Exchange, 'SSE' | 'SZSE' | 'BSE'> }),
          ...(args.asset_type === undefined ? {} : { assetType: args.asset_type as Extract<AssetType, 'equity' | 'index' | 'etf' | 'fund' | 'bond'> }),
        })
        const selected = selectedFeature('finance_cn_instrument', args.feature, args.dataset, args.variant)
        if (selected !== undefined) {
          return executeFeature(backend, selected, { ...args, instrument: args.query }, exec.signal)
        }
        return executeAshare(backend, 'instrument-reference',
          'CN:' + normalized.exchange + ':' + normalized.symbol + ':' + normalized.assetType,
          undefined, {}, args.source ?? 'auto', exec.signal)
      },
    })),
    strictTool(defineTool({
      name: 'finance_cn_quote',
      description: 'Fetch a stable A-share quote snapshot. Historical as_of snapshots are derived from one exact-date unadjusted daily bar and retain the actual bars provenance and warning.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        instrument: { type: 'string', required: true, description: 'Canonical MARKET:EXCHANGE:SYMBOL:ASSET_TYPE id.' },
        as_of: AS_OF_PARAMETER,
        source: SOURCE_PARAMETER,
        dataset: { type: 'string', enum: ['snapshot', ...datasetsFor('finance_cn_quote')] },
        feature: { type: 'string', enum: QUOTE_FEATURES },
        variant: { type: 'string', enum: variantsFor('finance_cn_quote') },
        include_order_book: { type: 'boolean' },
        trade_date: { type: 'string' },
        limit: { type: 'integer' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const selected = selectedFeature(
          'finance_cn_quote', args.feature, args.dataset === 'snapshot' ? undefined : args.dataset, args.variant,
        )
        if (selected !== undefined) return executeFeature(backend, selected, args, exec.signal)
        if (args.as_of === undefined) {
          const response = await executeAshare(
            backend, 'quote', args.instrument, undefined, {}, args.source ?? 'auto', exec.signal,
          )
          return currentQuote(response, args.instrument)
        }
        const requestedDate = ashareDateAt(strictDateOrTimestamp(args.as_of, 'as_of'))
        const response = await executeAshare(backend, 'market-bars', args.instrument, args.as_of, {
          startDate: requestedDate,
          endDate: requestedDate,
          interval: '1d',
          adjustment: 'none',
          limit: 1,
        }, args.source ?? 'auto', exec.signal)
        return historicalQuote(response, args.instrument, requestedDate)
      },
    })),
    strictTool(defineTool({
      name: 'finance_cn_bars',
      description: 'Fetch bounded A-share OHLCV bars with explicit adjustment and point-in-time constraints.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        instrument: { type: 'string', required: true },
        start_date: { type: 'string', required: true },
        end_date: { type: 'string', required: true },
        interval: { type: 'string', enum: ['1m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo'] },
        adjustment: { type: 'string', enum: ['none', 'qfq', 'hfq'], required: true },
        limit: { type: 'integer' },
        page: { type: 'integer' },
        as_of: AS_OF_PARAMETER,
        source: SOURCE_PARAMETER,
        dataset: { type: 'string', enum: ['price-bars', ...datasetsFor('finance_cn_bars')] },
        feature: { type: 'string', enum: BARS_FEATURES },
        variant: { type: 'string', enum: variantsFor('finance_cn_bars') },
      },
      output: JSON_OUTPUT,
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      execute: (args, exec) => {
        const selected = selectedFeature(
          'finance_cn_bars', args.feature, args.dataset === 'price-bars' ? undefined : args.dataset, args.variant,
        )
        if (selected !== undefined) return executeFeature(backend, selected, args, exec.signal)
        if (args.interval !== undefined && args.interval !== '1d') {
          throw new TypeError('intraday intervals require a curated feature')
        }
        return executeAshare(backend, 'market-bars', args.instrument, args.as_of, {
          ...dateRange(args.start_date, args.end_date),
          interval: args.interval ?? '1d',
          adjustment: args.adjustment,
          limit: boundedInteger(args.limit ?? 500, 'limit', 1, 5_000),
          ...(page(args.page) === 1 ? {} : {}),
        }, args.source ?? 'auto', exec.signal)
      },
    })),
    strictTool(defineTool({
      name: 'finance_cn_fundamentals',
      description: 'Fetch bounded A-share fundamentals with period-aligned provenance. Corporate actions retain a stable surface but may be unsupported when no healthy routable provider is mapped.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        instrument: { type: 'string', required: true },
        dataset: { type: 'string', enum: ['fundamentals', 'corporate-actions', ...datasetsFor('finance_cn_fundamentals')] },
        feature: { type: 'string', enum: FUNDAMENTAL_FEATURES },
        variant: { type: 'string', enum: variantsFor('finance_cn_fundamentals') },
        report_period: { type: 'string', description: 'Optional fiscal period in YYYY-MM-DD form.' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'integer' },
        page: { type: 'integer' },
        as_of: AS_OF_PARAMETER,
        source: SOURCE_PARAMETER,
        trade_date: { type: 'string' },
        forward_days: { type: 'integer' },
        category: { type: 'string' },
        statement: { type: 'string', enum: ['lrb', 'fzb', 'llb'] },
      },
      output: JSON_OUTPUT,
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        page(args.page)
        const selected = selectedFeature(
          'finance_cn_fundamentals', args.feature,
          args.dataset === undefined || ['fundamentals', 'corporate-actions'].includes(args.dataset)
            ? undefined : args.dataset, args.variant,
        )
        if (selected !== undefined) return executeFeature(backend, selected, args, exec.signal)
        if (args.dataset === 'corporate-actions') {
          throw new FinanceDataError(
            'corporate-actions is not mapped by an installed provider yet',
            'unsupported',
            { retryable: false },
          )
        }
        const range = dateRange(args.start_date, args.end_date)
        const period = args.report_period === undefined
          ? undefined
          : strictDate(args.report_period, 'report_period')
        const requestedLimit = boundedInteger(args.limit ?? 20, 'limit', 1, 1_000)
        const hasPeriodFilter = period !== undefined || range.startDate !== undefined
        const providerParams = args.source === 'tushare-mcp'
          ? {
              ...(period === undefined ? {} : { period }),
              ...range,
              limit: requestedLimit,
            }
          : { limit: hasPeriodFilter ? 1_000 : requestedLimit }
        const response = await backend.service.execute<{ periods?: FundamentalPeriodLike[]; [key: string]: unknown }>(
          buildRequest('fundamentals', args.instrument, args.as_of, {
            ...providerParams,
          }, exec.signal),
          routeOptions(args.source ?? 'auto'),
        )
        if (response.data === null || !Array.isArray(response.data.periods)) return jsonSafe(response)
        const matchingPeriods = response.data.periods.filter(item => (
          typeof item.fiscalPeriod === 'string'
          && (period === undefined || item.fiscalPeriod === period)
          && (range.startDate === undefined || item.fiscalPeriod >= range.startDate)
          && (range.endDate === undefined || item.fiscalPeriod <= range.endDate)
        ))
        const periods = matchingPeriods.slice(0, requestedLimit)
        const selectedPeriod = periods[0]
        const filteringWarning = 'Fundamentals were filtered to the requested fiscal period or date range before applying the response limit.'
        return jsonSafe({
          ...response,
          status: periods.length === 0 ? 'no-data' : response.status,
          data: periods.length === 0 ? null : {
            ...response.data,
            periods,
            returned: periods.length,
            truncated: response.data.truncated === true || matchingPeriods.length > periods.length,
          },
          provenance: alignedFundamentalsProvenance(response.provenance, selectedPeriod),
          warnings: periods.length === 0
            ? [...response.warnings, 'No fiscal period matched the requested filter.']
            : hasPeriodFilter ? appendWarning(response.warnings, filteringWarning) : response.warnings,
        })
      },
    })),
    strictTool(defineTool({
      name: 'finance_cn_disclosures',
      description: 'Fetch bounded A-share announcements. Research consensus is a stable controlled surface but may be unsupported when no healthy routable provider is mapped.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        instrument: { type: 'string' },
        document_type: { type: 'string', enum: ['announcement', 'research-consensus', ...datasetsFor('finance_cn_disclosures')] },
        dataset: { type: 'string', enum: datasetsFor('finance_cn_disclosures') },
        feature: { type: 'string', enum: DISCLOSURE_FEATURES },
        variant: { type: 'string', enum: variantsFor('finance_cn_disclosures') },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'integer' },
        page: { type: 'integer' },
        as_of: AS_OF_PARAMETER,
        source: SOURCE_PARAMETER,
        trade_date: { type: 'string' },
        industry_code: { type: 'string' },
        category: { type: 'string' },
        search_text: { type: 'string' },
        channel: { type: 'string', enum: ['report', 'announcement', 'news'] },
      },
      output: JSON_OUTPUT,
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        page(args.page)
        const selected = selectedFeature(
          'finance_cn_disclosures', args.feature,
          args.dataset ?? (args.document_type === undefined || ['announcement', 'research-consensus'].includes(args.document_type)
            ? undefined : args.document_type), args.variant,
        )
        if (selected !== undefined) return executeFeature(backend, selected, args, exec.signal)
        if (args.instrument === undefined) throw new TypeError('canonical disclosure surface requires instrument')
        if (args.start_date === undefined || args.end_date === undefined) {
          throw new TypeError('start_date and end_date are required for the canonical announcement surface')
        }
        const capability = args.document_type === 'research-consensus' ? 'research-consensus' : 'disclosures'
        const source = args.source ?? 'auto'
        if (capability === 'research-consensus') {
          await ensureRoutableCapability(backend, capability, source)
        }
        return executeAshare(backend, capability, args.instrument, args.as_of, {
          ...dateRange(args.start_date, args.end_date),
          limit: boundedInteger(args.limit ?? 50, 'limit', 1, 1_000),
        }, source, exec.signal)
      },
    })),
    strictTool(defineTool({
      name: 'finance_cn_market_activity',
      description: 'Stable controlled surface for A-share market activity. It may return canonical unsupported when catalog has no healthy routable provider; arbitrary endpoints are never accepted.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        capability: { type: 'string', enum: ['capital-flow', 'market-signal', 'order-book', 'quote', 'risk-data'] },
        feature: { type: 'string', enum: ACTIVITY_FEATURES },
        dataset: { type: 'string', enum: datasetsFor('finance_cn_market_activity') },
        variant: { type: 'string', enum: variantsFor('finance_cn_market_activity') },
        instrument: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'integer' },
        page: { type: 'integer' },
        as_of: AS_OF_PARAMETER,
        source: SOURCE_PARAMETER,
        trade_date: { type: 'string' },
        industry_code: { type: 'string' },
        board_type: { type: 'string', enum: ['industry', 'concept', 'region'] },
        period: { type: 'string' },
        lookback_days: { type: 'integer' },
        forward_days: { type: 'integer' },
        underlying: { type: 'string' },
        option_code: { type: 'string' },
        option_type: { type: 'string', enum: ['call', 'put'] },
      },
      output: JSON_OUTPUT,
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        page(args.page)
        const selected = selectedFeature('finance_cn_market_activity', args.feature, args.dataset, args.variant)
        if (selected !== undefined) return executeFeature(backend, selected, args, exec.signal)
        if (args.capability === undefined) throw new TypeError('capability or curated feature is required')
        const source = args.source ?? 'auto'
        await ensureRoutableCapability(backend, args.capability, source)
        return executeAshare(backend, args.capability, args.instrument, args.as_of, {
          ...dateRange(args.start_date, args.end_date),
          limit: boundedInteger(args.limit ?? 100, 'limit', 1, 1_000),
        }, source, exec.signal)
      },
    })),
    strictTool(defineTool({
      name: 'finance_cn_macro_index',
      description: 'Fetch a controlled China index, trading-calendar, or macro dataset. Macro may be unsupported when catalog has no healthy routable provider.',
      parameters: {
        market: { type: 'string', enum: ['CN'] },
        capability: { type: 'string', enum: ['index', 'trading-calendar', 'macro'] },
        feature: { type: 'string', enum: MACRO_INDEX_FEATURES },
        dataset: { type: 'string', enum: datasetsFor('finance_cn_macro_index') },
        variant: { type: 'string', enum: variantsFor('finance_cn_macro_index') },
        instrument: { type: 'string' },
        exchange: { type: 'string', enum: EXCHANGES },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'integer' },
        page: { type: 'integer' },
        as_of: AS_OF_PARAMETER,
        source: SOURCE_PARAMETER,
        official_provider: { type: 'string', enum: ['csi', 'cni'] },
        year: { type: 'integer' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        page(args.page)
        const selected = selectedFeature('finance_cn_macro_index', args.feature, args.dataset, args.variant)
        if (selected !== undefined) return executeFeature(backend, selected, args, exec.signal)
        if (args.capability === undefined) throw new TypeError('capability or curated feature is required')
        if (args.capability === 'index' && args.instrument === undefined) {
          throw new TypeError('index capability requires instrument')
        }
        if (args.capability === 'trading-calendar' && args.exchange === undefined) {
          throw new TypeError('trading-calendar capability requires exchange')
        }
        if (args.capability === 'trading-calendar' && args.instrument !== undefined) {
          throw new TypeError('trading-calendar does not accept instrument')
        }
        const source = args.source ?? 'auto'
        if (args.capability === 'macro') {
          await ensureRoutableCapability(backend, args.capability, source)
        }
        return executeAshare(backend, args.capability, args.instrument, args.as_of, {
          ...dateRange(args.start_date, args.end_date),
          ...(args.exchange === undefined ? {} : { exchange: args.exchange }),
          limit: boundedInteger(args.limit ?? 500, 'limit', 1, 1_000),
        }, source, exec.signal)
      },
    })),
  ]
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(name + ' must be an integer from ' + minimum + ' through ' + maximum)
  }
  return value
}

function strictDate(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(name + ' must be YYYY-MM-DD')
  const parsed = new Date(value + 'T00:00:00Z')
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(name + ' must be a real calendar date')
  }
  return value
}

function strictDateOrTimestamp(value: string, name: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return strictDate(value, name)
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(name + ' must be an ISO date or timestamp')
  return value
}

function ashareDateAt(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value
  return new Date(Date.parse(value) + 8 * 60 * 60_000).toISOString().slice(0, 10)
}
