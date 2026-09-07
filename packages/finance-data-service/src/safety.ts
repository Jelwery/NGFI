import {
  DATA_CAPABILITIES,
  FinanceDataError,
  canonicalInstrumentId,
  normalizeAshareInstrument,
  parseCanonicalInstrument,
  type DataCapability,
} from '@finance2dsh/core'
import type { ServiceCapabilityRequest } from './types.js'

const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const MARKET_ID = /^[A-Za-z0-9_-]{1,16}$/
const FORBIDDEN_PARAMETER_KEYS = new Set([
  'url',
  'uri',
  'endpoint',
  'baseurl',
  'base_url',
  'host',
  'hostname',
  'authorization',
  'cookie',
  'token',
  'apikey',
  'api_key',
  'sql',
  'query',
  'rawsql',
  'raw_sql',
  'command',
  'cmd',
  'shell',
  'script',
  'executable',
  'argv',
  'args',
  'arguments',
  '__proto__',
  'constructor',
  'prototype',
])
const URL_VALUE = /(?:^|[\s"'(<])(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const PATH_TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/
const REQUEST_KEYS = new Set(['capability', 'market', 'instrument', 'asOf', 'params', 'signal'])
const INSTRUMENT_KEYS = new Set(['market', 'exchange', 'symbol', 'assetType'])

/**
 * Public capability parameters are deliberately enumerated here rather than
 * delegated to providers. This keeps provider configuration, raw queries, and
 * executable inputs out of the service boundary.
 */
const CAPABILITY_PARAMETER_KEYS = {
  'instrument-reference': new Set(['symbol', 'exchange', 'assetType', 'featureId', 'variant', 'limit', 'asOf']),
  quote: new Set(['fields', 'featureId', 'variant', 'limit', 'asOf', 'tradeDate']),
  // offset/count are the bounded legacy TDX pagination shape.
  'market-bars': new Set([
    'startDate', 'endDate', 'adjustment', 'interval', 'limit', 'offset', 'count', 'dataset', 'featureId', 'variant', 'asOf',
  ]),
  'order-book': new Set(['startDate', 'endDate', 'tradeDate', 'limit', 'featureId', 'variant', 'asOf']),
  fundamentals: new Set([
    'period', 'startDate', 'endDate', 'limit', 'fields', 'statement', 'dataset', 'featureId', 'variant', 'asOf', 'category',
  ]),
  'corporate-actions': new Set(['startDate', 'endDate', 'tradeDate', 'limit', 'featureId', 'variant', 'asOf', 'forwardDays']),
  disclosures: new Set(['startDate', 'endDate', 'tradeDate', 'limit', 'featureId', 'variant', 'asOf', 'category']),
  'research-consensus': new Set(['startDate', 'endDate', 'limit', 'featureId', 'variant', 'asOf', 'searchText', 'channel', 'page']),
  'capital-flow': new Set(['date', 'metric', 'startDate', 'endDate', 'tradeDate', 'limit', 'featureId', 'variant', 'asOf', 'boardType', 'period']),
  'market-signal': new Set(['startDate', 'endDate', 'tradeDate', 'limit', 'featureId', 'variant', 'asOf', 'lookbackDays', 'industryCode', 'period', 'page', 'underlying', 'optionType']),
  'industry-classification': new Set(['featureId', 'variant', 'asOf', 'limit', 'industryCode']),
  index: new Set(['exchange', 'startDate', 'endDate', 'limit', 'officialProvider', 'featureId', 'variant', 'asOf']),
  macro: new Set(['exchange', 'startDate', 'endDate', 'limit', 'featureId', 'variant', 'asOf', 'year']),
  'trading-calendar': new Set(['exchange', 'startDate', 'endDate', 'isOpen', 'limit', 'featureId', 'variant', 'asOf']),
  // CNE6 exposes these as a bounded, read-only projection over published data.
  'risk-data': new Set(['dataset', 'columns', 'codes', 'limit', 'featureId', 'variant', 'asOf', 'tradeDate', 'optionCode']),
} satisfies Readonly<Record<DataCapability, ReadonlySet<string>>>

export interface RequestBoundaryLimits {
  maxDepth?: number
  maxArrayLength?: number
  maxKeys?: number
  maxStringLength?: number
}

export function assertProviderId(providerId: string): string {
  if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId)) {
    throw new FinanceDataError(
      'providerId must be 1-64 lowercase letters, digits, dots, underscores, or hyphens',
      'invalid-request',
      { retryable: false },
    )
  }
  return providerId
}

function validateValue(
  value: unknown,
  path: string,
  depth: number,
  state: { keys: number; seen: WeakSet<object> },
  limits: Required<RequestBoundaryLimits>,
): void {
  if (depth > limits.maxDepth) {
    throw new FinanceDataError(`request parameters exceed maximum depth at ${path}`, 'invalid-request')
  }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FinanceDataError(`request contains a non-finite number at ${path}`, 'invalid-request')
    }
    return
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) {
      throw new FinanceDataError(`request string exceeds limit at ${path}`, 'invalid-request')
    }
    if (URL_VALUE.test(value.trim())) {
      throw new FinanceDataError(
        `arbitrary URLs are not accepted in capability requests (${path})`,
        'invalid-request',
        { retryable: false },
      )
    }
    if (value.includes('\0') || PATH_TRAVERSAL.test(value)) {
      throw new FinanceDataError(`unsafe path-like value at ${path}`, 'invalid-request', { retryable: false })
    }
    return
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      throw new FinanceDataError(`request contains a cycle at ${path}`, 'invalid-request')
    }
    state.seen.add(value)
    if (value.length > limits.maxArrayLength) {
      throw new FinanceDataError(`request array exceeds limit at ${path}`, 'invalid-request')
    }
    value.forEach((child, index) => validateValue(child, `${path}[${index}]`, depth + 1, state, limits))
    return
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new FinanceDataError(`request contains a non-JSON value at ${path}`, 'invalid-request')
  }
  if (state.seen.has(value)) {
    throw new FinanceDataError(`request contains a cycle at ${path}`, 'invalid-request')
  }
  state.seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    state.keys += 1
    if (state.keys > limits.maxKeys) {
      throw new FinanceDataError('request contains too many parameter keys', 'invalid-request')
    }
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '')
    if (FORBIDDEN_PARAMETER_KEYS.has(key.toLowerCase())
      || /(?:url|uri|endpoint|hostname)$/.test(normalizedKey)
      || /(?:token|apikey|authorization|cookie|credential|password|secret|signature)$/.test(normalizedKey)
      || /(?:sql|query|command|cmd|shell|script|executable|argv)$/.test(normalizedKey)) {
      throw new FinanceDataError(
        `request parameter ${path}.${key} is not part of the curated capability boundary`,
        'invalid-request',
        { retryable: false },
      )
    }
    validateValue(child, `${path}.${key}`, depth + 1, state, limits)
  }
}

export function assertCapabilityRequestBoundary(
  request: ServiceCapabilityRequest,
  limits: RequestBoundaryLimits = {},
): ServiceCapabilityRequest {
  if (request === null || typeof request !== 'object' || Array.isArray(request)
    || Object.getPrototypeOf(request) !== Object.prototype) {
    throw new FinanceDataError('capability request must be a plain object', 'invalid-request')
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) {
      throw new FinanceDataError(`unknown capability request property: ${key}`, 'invalid-request')
    }
  }
  if (!DATA_CAPABILITIES.includes(request.capability)) {
    throw new FinanceDataError(`unsupported capability: ${String(request.capability)}`, 'invalid-request')
  }
  if (typeof request.market !== 'string' || !MARKET_ID.test(request.market)) {
    throw new FinanceDataError('market must be a short canonical identifier', 'invalid-request')
  }
  let normalizedInstrument = request.instrument
  if (request.instrument !== undefined) {
    if (request.instrument === null || typeof request.instrument !== 'object'
      || Array.isArray(request.instrument)
      || Object.getPrototypeOf(request.instrument) !== Object.prototype
      || !['market', 'exchange', 'symbol', 'assetType'].every(key => (
        typeof (request.instrument as unknown as Record<string, unknown>)[key] === 'string'
      ))) {
      throw new FinanceDataError('instrument must be a canonical plain object', 'invalid-request')
    }
    for (const key of Object.keys(request.instrument)) {
      if (!INSTRUMENT_KEYS.has(key)) {
        throw new FinanceDataError(`unknown instrument property: ${key}`, 'invalid-request')
      }
    }
    const canonical = canonicalInstrumentId(request.instrument)
    normalizedInstrument = parseCanonicalInstrument(canonical)
    if (normalizedInstrument.market === 'CN') normalizedInstrument = normalizeAshareInstrument(canonical)
    if (request.instrument.market.toUpperCase() !== request.market.toUpperCase()) {
      throw new FinanceDataError(
        `instrument market ${request.instrument.market} conflicts with request market ${request.market}`,
        'conflicting-instrument',
        { retryable: false },
      )
    }
  }
  if (request.asOf !== undefined && !isStrictDateOrTimestamp(request.asOf)) {
    throw new FinanceDataError('asOf must be an ISO-compatible date or timestamp', 'invalid-request')
  }
  if (request.signal !== undefined
    && (request.signal === null
      || typeof request.signal !== 'object'
      || typeof request.signal.aborted !== 'boolean'
      || typeof request.signal.addEventListener !== 'function'
      || typeof request.signal.removeEventListener !== 'function')) {
    throw new FinanceDataError('signal must implement the AbortSignal contract', 'invalid-request')
  }
  if (request.params !== undefined) {
    if (request.params === null
      || typeof request.params !== 'object'
      || Array.isArray(request.params)
      || Object.getPrototypeOf(request.params) !== Object.prototype) {
      throw new FinanceDataError('capability params must be a plain object', 'invalid-request')
    }
    validateValue(request.params, '$.params', 0, { keys: 0, seen: new WeakSet() }, {
      maxDepth: limits.maxDepth ?? 8,
      maxArrayLength: limits.maxArrayLength ?? 1_000,
      maxKeys: limits.maxKeys ?? 1_000,
      maxStringLength: limits.maxStringLength ?? 16_384,
    })
    const allowedKeys = CAPABILITY_PARAMETER_KEYS[request.capability]
    const unknownKeys = Object.keys(request.params).filter(key => !allowedKeys.has(key)).sort()
    if (unknownKeys.length > 0) {
      throw new FinanceDataError(
        `${request.capability} params contain unsupported fields: ${unknownKeys.join(', ')}`,
        'invalid-request',
        { retryable: false },
      )
    }
  }
  return {
    ...request,
    market: request.market.toUpperCase(),
    ...(normalizedInstrument === undefined ? {} : { instrument: normalizedInstrument }),
  }
}

function isStrictDateOrTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (date !== null) return isRealCalendarDate(date[1]!, date[2]!, date[3]!)
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (timestamp === null
    || !isRealCalendarDate(timestamp[1]!, timestamp[2]!, timestamp[3]!)
    || Number(timestamp[4]) > 23
    || Number(timestamp[5]) > 59
    || Number(timestamp[6]) > 59) return false
  const zone = timestamp[7]!
  if (zone !== 'Z') {
    const [hours, minutes] = zone.slice(1).split(':').map(Number)
    if ((hours ?? 24) > 23 || (minutes ?? 60) > 59) return false
  }
  return Number.isFinite(Date.parse(value))
}

function isRealCalendarDate(year: string, month: string, day: string): boolean {
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`)
  return Number.isFinite(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === `${year}-${month}-${day}`
}
