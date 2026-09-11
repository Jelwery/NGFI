import { canonicalInstrumentId, toAshareProviderSymbol } from '@finance2dsh/core'
import type {
  AdjustmentMode,
  CanonicalDataResult,
  CapabilityRequest,
  DataField,
  DataProvenance,
  InstrumentId,
  InstrumentReferenceV2,
} from '@finance2dsh/core'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { TushareMcpCapability } from './discovery.js'
import { MAPPED_OUTPUT_FIELDS, outputFields, toolAcceptsInput } from './discovery.js'
import { TushareMcpError } from './security.js'

export interface TushareMarketBar {
  observedAt: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  preClose: number | null
  volume: number | null
  amount: number | null
}

export interface TushareMarketBars {
  instrument: InstrumentId
  adjustment: AdjustmentMode
  bars: TushareMarketBar[]
}

export interface TushareTradingDay {
  exchange: string
  calendarDate: string
  isOpen: boolean
  previousOpenDate: string | null
}

export interface TushareTradingCalendar {
  exchange: string
  days: TushareTradingDay[]
}

export interface TushareFundamentals {
  instrument: InstrumentId
  periods: Array<{
    fiscalPeriod: string | null
    announcedAt: string | null
    availableAt: string | null
    fields: Record<string, DataField<number | string | boolean>>
  }>
  pointInTimeSafe: boolean
}

export interface MappedCall {
  arguments: Readonly<Record<string, unknown>>
  map(value: unknown): CanonicalDataResult<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function tabularRows(value: unknown): Record<string, unknown>[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.fields) || !Array.isArray(value.items)) return undefined
  if (value.fields.some(fieldName => typeof fieldName !== 'string' || fieldName === '')
    || new Set(value.fields).size !== value.fields.length) {
    throw new TushareMcpError('TuShare tabular response has invalid or duplicate fields', 'schema-drift', 'schema-drift')
  }
  const fields = value.fields as string[]
  return value.items.map((item, index) => {
    if (!Array.isArray(item) || item.length !== fields.length) {
      throw new TushareMcpError(`TuShare tabular row ${index} does not match fields`, 'schema-drift', 'schema-drift')
    }
    return Object.fromEntries(fields.map((fieldName, fieldIndex) => [fieldName, item[fieldIndex]]))
  })
}

function rowsFrom(value: unknown): Record<string, unknown>[] {
  const directTabular = tabularRows(value)
  if (directTabular !== undefined) return directTabular
  const nestedTabular = isRecord(value) ? tabularRows(value.data) : undefined
  if (nestedTabular !== undefined) return nestedTabular
  const candidate = isRecord(value) && Array.isArray(value.data) ? value.data
    : isRecord(value) && Array.isArray(value.items) ? value.items
      : isRecord(value) && Array.isArray(value.rows) ? value.rows
        : value
  if (!Array.isArray(candidate) || candidate.some(row => !isRecord(row))) {
    throw new TushareMcpError('TuShare MCP result must contain an array of row objects', 'schema-drift', 'schema-drift')
  }
  return candidate as Record<string, unknown>[]
}

function strictDate(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TushareMcpError(`${name} must be a date string`, 'schema-drift', 'schema-drift')
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  const iso = compact === null ? value : `${compact[1]}-${compact[2]}-${compact[3]}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== iso) {
    throw new TushareMcpError(`${name} is not a valid calendar date`, 'schema-drift', 'schema-drift')
  }
  return iso
}

function compactDate(value: string, name: string): string {
  const iso = strictDate(value.slice(0, 10), name)
  return iso.replaceAll('-', '')
}

function optionalDate(value: unknown, name: string): string | null {
  return value === null || value === undefined || value === '' ? null : strictDate(value, name)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function optionalNumber(value: unknown, name: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  throw new TushareMcpError(`${name} must be a finite number or null`, 'schema-drift', 'schema-drift')
}

function field<T>(value: T | null, note?: string): DataField<T> {
  return value === null
    ? { status: 'missing', value: null, ...(note === undefined ? {} : { note }) }
    : { status: 'available', value }
}

function ensureInstrument(request: CapabilityRequest): InstrumentId {
  if (request.instrument === undefined) {
    throw new TushareMcpError(`${request.capability} requires a canonical instrument`, 'invalid-request', 'schema-drift')
  }
  if (request.instrument.market.toUpperCase() !== 'CN' || request.market.toUpperCase() !== 'CN') {
    throw new TushareMcpError('TuShare MCP provider supports market CN only', 'unsupported', 'schema-drift')
  }
  if (!/^[0-9]{6}$/.test(request.instrument.symbol)) {
    throw new TushareMcpError('TuShare A-share instruments require a six-digit symbol', 'invalid-request', 'schema-drift')
  }
  if (!['SSE', 'SZSE', 'BSE'].includes(request.instrument.exchange)) {
    throw new TushareMcpError('TuShare A-share instruments require SSE, SZSE, or BSE', 'invalid-request', 'schema-drift')
  }
  return request.instrument
}

function plainParams(request: CapabilityRequest): Record<string, unknown> {
  const params = request.params ?? {}
  if (!isRecord(params) || Object.getPrototypeOf(params) !== Object.prototype) {
    throw new TushareMcpError('capability params must be a plain object', 'invalid-request', 'schema-drift')
  }
  return params
}

function rejectUnknown(params: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(params).filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new TushareMcpError(
      `capability params contain unsupported fields: ${unknown.sort().join(', ')}`,
      'invalid-request',
      'schema-drift',
    )
  }
}

function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TushareMcpError(`${name} must be a non-empty string`, 'invalid-request', 'schema-drift')
  }
  return value.trim()
}

function provenance(
  endpoint: string,
  fetchedAt: string,
  extras: Partial<DataProvenance> = {},
): DataProvenance {
  return {
    actualProvider: 'tushare-mcp',
    provider: 'tushare-mcp',
    upstreamSource: 'tushare',
    sourceKind: 'licensed',
    sourceUrl: endpoint,
    fetchedAt,
    timezone: 'Asia/Shanghai',
    fallbackChain: [],
    ...extras,
  }
}

function result<T>(data: T | null, meta: DataProvenance, warnings: string[] = []): CanonicalDataResult<T> {
  return { status: data === null ? 'no-data' : 'available', data, provenance: meta, warnings }
}

function mapInstrument(
  request: CapabilityRequest,
  tool: Tool,
  endpoint: string,
  now: () => Date,
): MappedCall {
  const instrument = ensureInstrument(request)
  const params = plainParams(request)
  rejectUnknown(params, [])
  const tsCode = toAshareProviderSymbol(instrument, 'suffix')
  const args = {
    ts_code: tsCode,
    ...outputFields(tool, MAPPED_OUTPUT_FIELDS['instrument-reference']),
  }
  return {
    arguments: args,
    map(value) {
      const rows = rowsFrom(value)
      if (rows.length === 0) return result(null, provenance(endpoint, now().toISOString()))
      if (rows.length > 1) throw new TushareMcpError('instrument lookup returned multiple rows', 'schema-drift', 'schema-drift')
      const row = rows[0] as Record<string, unknown>
      const returnedCode = optionalString(row.ts_code)
      if (returnedCode === null || returnedCode.toUpperCase() !== tsCode) {
        throw new TushareMcpError('instrument result must return the requested non-empty ts_code', 'schema-drift', 'schema-drift')
      }
      const currency = optionalString(row.curr_type) ?? optionalString(row.currency)
      const data: InstrumentReferenceV2 = {
        id: structuredClone(instrument),
        canonical: canonicalInstrumentId(instrument),
        name: field(optionalString(row.name) ?? optionalString(row.fullname)),
        quoteCurrency: field(currency, 'TuShare did not return a quote currency'),
        providerSymbols: { tushare: tsCode },
      }
      return result(data, provenance(endpoint, now().toISOString(), currency === null ? {} : { currency }))
    },
  }
}

function marketBarArguments(
  request: CapabilityRequest,
  tool: Tool,
  instrument: InstrumentId,
): Record<string, unknown> {
  const params = plainParams(request)
  rejectUnknown(params, ['startDate', 'endDate', 'adjustment', 'interval', 'limit'])
  const interval = stringParam(params, 'interval') ?? '1d'
  if (interval !== '1d') {
    throw new TushareMcpError('TuShare MCP bars mapping currently supports interval 1d only', 'unsupported', 'schema-drift')
  }
  const adjustment = stringParam(params, 'adjustment') ?? 'none'
  if (!['none', 'qfq', 'hfq'].includes(adjustment)) {
    throw new TushareMcpError('adjustment must be none, qfq, or hfq', 'invalid-request', 'schema-drift')
  }
  // TuShare daily/index_daily/fund_daily are unadjusted. Never relabel them as qfq/hfq.
  if (adjustment !== 'none') {
    throw new TushareMcpError('TuShare MCP bars mapping currently supports unadjusted data only', 'unsupported', 'schema-drift')
  }
  const startDate = stringParam(params, 'startDate')
  const endDate = stringParam(params, 'endDate') ?? request.asOf?.slice(0, 10)
  if (startDate === undefined || endDate === undefined) {
    throw new TushareMcpError('market-bars requires startDate and endDate (or asOf)', 'invalid-request', 'schema-drift')
  }
  if (startDate !== undefined && endDate !== undefined
    && strictDate(startDate, 'startDate') > strictDate(endDate, 'endDate')) {
    throw new TushareMcpError('startDate must not be after endDate', 'invalid-request', 'schema-drift')
  }
  const limit = params.limit
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 5_000)) {
    throw new TushareMcpError('limit must be an integer from 1 through 5000', 'invalid-request', 'schema-drift')
  }
  return {
    ts_code: toAshareProviderSymbol(instrument, 'suffix'),
    ...(startDate === undefined ? {} : { start_date: compactDate(startDate, 'startDate') }),
    ...(endDate === undefined ? {} : { end_date: compactDate(endDate, 'endDate') }),
    ...(limit === undefined || !toolAcceptsInput(tool, 'limit') ? {} : { limit }),
    ...outputFields(tool, MAPPED_OUTPUT_FIELDS['market-bars']),
  }
}

function mapBars(
  request: CapabilityRequest,
  tool: Tool,
  endpoint: string,
  now: () => Date,
): MappedCall {
  const instrument = ensureInstrument(request)
  const args = marketBarArguments(request, tool, instrument)
  const params = plainParams(request)
  const limitValue = params.limit
  const limit = typeof limitValue === 'number' ? limitValue : undefined
  const requestedStart = stringParam(params, 'startDate') as string
  const requestedEnd = stringParam(params, 'endDate') ?? request.asOf?.slice(0, 10) as string
  const minObservedAt = strictDate(requestedStart, 'startDate')
  const maxObservedAt = strictDate(requestedEnd, 'endDate')
  return {
    arguments: args,
    map(value) {
      const rows = rowsFrom(value)
      const expectedCode = toAshareProviderSymbol(instrument, 'suffix')
      let bars = rows.map((row, index): TushareMarketBar => {
        const code = optionalString(row.ts_code)
        if (code === null || code.toUpperCase() !== expectedCode) {
          throw new TushareMcpError(`bar ${index} must return the requested non-empty ts_code`, 'schema-drift', 'schema-drift')
        }
        const observedAt = strictDate(row.trade_date, `bar ${index}.trade_date`)
        if (observedAt < minObservedAt || observedAt > maxObservedAt) {
          throw new TushareMcpError(`bar ${index} is outside the requested date boundary`, 'schema-drift', 'schema-drift')
        }
        return {
          observedAt,
          open: optionalNumber(row.open, `bar ${index}.open`),
          high: optionalNumber(row.high, `bar ${index}.high`),
          low: optionalNumber(row.low, `bar ${index}.low`),
          close: optionalNumber(row.close, `bar ${index}.close`),
          preClose: optionalNumber(row.pre_close, `bar ${index}.pre_close`),
          volume: optionalNumber(row.vol ?? row.volume, `bar ${index}.vol`),
          amount: optionalNumber(row.amount, `bar ${index}.amount`),
        }
      }).sort((left, right) => left.observedAt.localeCompare(right.observedAt))
      if (limit !== undefined) bars = bars.slice(-limit)
      if (bars.length === 0) return result(null, provenance(endpoint, now().toISOString(), { adjustment: 'none' }))
      const data: TushareMarketBars = { instrument: structuredClone(instrument), adjustment: 'none', bars }
      const observedAt = bars.at(-1)?.observedAt
      const unit = tool.name === 'index_daily'
        ? 'TuShare index_daily native units'
        : 'price CNY; volume lots; amount CNY thousands'
      return result(data, provenance(endpoint, now().toISOString(), {
        adjustment: 'none',
        ...(observedAt === undefined ? {} : { observedAt }),
        currency: 'CNY',
        unit,
      }))
    },
  }
}

function mapCalendar(
  request: CapabilityRequest,
  tool: Tool,
  endpoint: string,
  now: () => Date,
): MappedCall {
  if (request.market.toUpperCase() !== 'CN') throw new TushareMcpError('TuShare calendar supports market CN only', 'unsupported', 'schema-drift')
  const params = plainParams(request)
  rejectUnknown(params, ['exchange', 'startDate', 'endDate', 'isOpen', 'limit'])
  const exchange = stringParam(params, 'exchange') ?? ''
  const startDate = stringParam(params, 'startDate')
  const endDate = stringParam(params, 'endDate') ?? request.asOf?.slice(0, 10)
  if (startDate === undefined || endDate === undefined) {
    throw new TushareMcpError('trading-calendar requires startDate and endDate (or asOf)', 'invalid-request', 'schema-drift')
  }
  if (strictDate(startDate, 'startDate') > strictDate(endDate, 'endDate')) {
    throw new TushareMcpError('startDate must not be after endDate', 'invalid-request', 'schema-drift')
  }
  const isOpen = params.isOpen
  if (isOpen !== undefined && typeof isOpen !== 'boolean') {
    throw new TushareMcpError('isOpen must be boolean', 'invalid-request', 'schema-drift')
  }
  const limit = params.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000)) {
    throw new TushareMcpError('limit must be an integer from 1 through 5000', 'invalid-request', 'schema-drift')
  }
  const args: Record<string, unknown> = {
    exchange,
    start_date: compactDate(startDate, 'startDate'),
    end_date: compactDate(endDate, 'endDate'),
    ...(isOpen === undefined || !toolAcceptsInput(tool, 'is_open') ? {} : { is_open: isOpen ? '1' : '0' }),
    ...(limit === undefined || !toolAcceptsInput(tool, 'limit') ? {} : { limit }),
    ...outputFields(tool, MAPPED_OUTPUT_FIELDS['trading-calendar']),
  }
  return {
    arguments: args,
    map(value) {
      const rows = rowsFrom(value)
      let days = rows.map((row, index): TushareTradingDay => {
        const rawOpen = row.is_open
        const open = rawOpen === true || rawOpen === 1 || rawOpen === '1'
        if (!(open || rawOpen === false || rawOpen === 0 || rawOpen === '0')) {
          throw new TushareMcpError(`calendar row ${index}.is_open must be 0 or 1`, 'schema-drift', 'schema-drift')
        }
        const calendarDate = strictDate(row.cal_date, `calendar row ${index}.cal_date`)
        if (calendarDate > strictDate(endDate, 'endDate')) {
          throw new TushareMcpError(`calendar row ${index} is after the requested as-of boundary`, 'schema-drift', 'schema-drift')
        }
        if (calendarDate < strictDate(startDate, 'startDate')) {
          throw new TushareMcpError(`calendar row ${index} is before the requested date boundary`, 'schema-drift', 'schema-drift')
        }
        const rowExchange = optionalString(row.exchange) ?? exchange
        if (exchange !== '' && rowExchange !== exchange) {
          throw new TushareMcpError(`calendar row ${index} returned a conflicting exchange`, 'schema-drift', 'schema-drift')
        }
        return {
          exchange: rowExchange,
          calendarDate,
          isOpen: open,
          previousOpenDate: optionalDate(row.pretrade_date, `calendar row ${index}.pretrade_date`),
        }
      }).sort((left, right) => left.calendarDate.localeCompare(right.calendarDate))
      if (typeof isOpen === 'boolean') days = days.filter(day => day.isOpen === isOpen)
      if (limit !== undefined) days = days.slice(0, limit)
      if (days.length === 0) return result(null, provenance(endpoint, now().toISOString()))
      const data: TushareTradingCalendar = { exchange, days }
      const observedAt = days.at(-1)?.calendarDate
      return result(data, provenance(endpoint, now().toISOString(), observedAt === undefined ? {} : { observedAt }))
    },
  }
}

function fundamentalFields(row: Record<string, unknown>): Record<string, DataField<number | string | boolean>> {
  const omitted = new Set(['ts_code', 'end_date', 'ann_date', 'f_ann_date', 'update_flag'])
  const result: Record<string, DataField<number | string | boolean>> = {}
  for (const [key, value] of Object.entries(row)) {
    if (omitted.has(key)) continue
    if (value === null || value === undefined || value === '') result[key] = field<number | string | boolean>(null)
    else if (typeof value === 'boolean' || typeof value === 'string') result[key] = field(value)
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = field(value)
    else throw new TushareMcpError(`fundamentals field ${key} has an unsupported value`, 'schema-drift', 'schema-drift')
  }
  return result
}

function mapFundamentals(
  request: CapabilityRequest,
  tool: Tool,
  endpoint: string,
  now: () => Date,
): MappedCall {
  const instrument = ensureInstrument(request)
  if (instrument.assetType !== 'equity') throw new TushareMcpError('fundamentals mapping supports equities only', 'unsupported', 'schema-drift')
  const params = plainParams(request)
  rejectUnknown(params, ['period', 'startDate', 'endDate', 'limit', 'fields'])
  const period = stringParam(params, 'period')
  const startDate = stringParam(params, 'startDate')
  const endDate = stringParam(params, 'endDate')
  const asOf = request.asOf?.slice(0, 10)
  if (startDate !== undefined && endDate !== undefined
    && strictDate(startDate, 'startDate') > strictDate(endDate, 'endDate')) {
    throw new TushareMcpError('startDate must not be after endDate', 'invalid-request', 'schema-drift')
  }
  const limit = params.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)) {
    throw new TushareMcpError('limit must be an integer from 1 through 1000', 'invalid-request', 'schema-drift')
  }
  const requestedFields = params.fields
  if (requestedFields !== undefined && (!Array.isArray(requestedFields) || requestedFields.length < 1
    || requestedFields.length > 100 || requestedFields.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value)))) {
    throw new TushareMcpError('fields must contain 1-100 safe field names', 'invalid-request', 'schema-drift')
  }
  const fields = requestedFields === undefined
    ? undefined
    : [...new Set(['ts_code', 'end_date', 'ann_date', 'f_ann_date', ...requestedFields as string[]])]
  const args: Record<string, unknown> = {
    ts_code: toAshareProviderSymbol(instrument, 'suffix'),
    ...(period === undefined ? {} : { period: compactDate(period, 'period') }),
    ...(startDate === undefined ? {} : { start_date: compactDate(startDate, 'startDate') }),
    ...(endDate === undefined && asOf === undefined ? {} : { end_date: compactDate(endDate ?? asOf as string, 'endDate') }),
    ...(limit === undefined || asOf !== undefined || !toolAcceptsInput(tool, 'limit') ? {} : { limit }),
    ...(fields === undefined ? {} : outputFields(tool, fields)),
  }
  return {
    arguments: args,
    map(value) {
      const rows = rowsFrom(value)
      const expectedCode = toAshareProviderSymbol(instrument, 'suffix')
      let periods = rows.map((row, index) => {
        const code = optionalString(row.ts_code)
        if (code === null || code.toUpperCase() !== expectedCode) {
          throw new TushareMcpError(`fundamentals row ${index} must return the requested non-empty ts_code`, 'schema-drift', 'schema-drift')
        }
        const fiscalPeriod = optionalDate(row.end_date, `fundamentals row ${index}.end_date`)
        const announcedAt = optionalDate(row.ann_date, `fundamentals row ${index}.ann_date`)
        const finalAnnouncedAt = optionalDate(row.f_ann_date, `fundamentals row ${index}.f_ann_date`)
        const availableAt = finalAnnouncedAt ?? announcedAt
        return { fiscalPeriod, announcedAt, availableAt, fields: fundamentalFields(row) }
      }).sort((left, right) => (right.fiscalPeriod ?? '').localeCompare(left.fiscalPeriod ?? ''))
      if (asOf !== undefined) {
        const cutoff = strictDate(asOf, 'asOf')
        periods = periods.filter(item => item.availableAt !== null && item.availableAt <= cutoff)
      }
      if (limit !== undefined) periods = periods.slice(0, limit)
      if (periods.length === 0) {
        return result(null, provenance(endpoint, now().toISOString()), asOf === undefined
          ? []
          : ['No rows with a known availability date were available at the requested as-of date.'])
      }
      const pointInTimeSafe = periods.every(item => item.availableAt !== null)
      const data: TushareFundamentals = { instrument: structuredClone(instrument), periods, pointInTimeSafe }
      const warnings = pointInTimeSafe ? [] : ['Some rows have no announcement/availability date; PIT safety is not claimed.']
      const fiscalPeriod = periods[0]?.fiscalPeriod ?? undefined
      const availableAt = periods[0]?.availableAt ?? undefined
      return result(data, provenance(endpoint, now().toISOString(), {
        currency: 'CNY',
        unit: 'provider-defined; see returned field names',
        ...(fiscalPeriod === undefined ? {} : { fiscalPeriod }),
        ...(availableAt === undefined ? {} : { availableAt }),
      }), warnings)
    },
  }
}

export function createMappedCall(
  capability: TushareMcpCapability,
  request: CapabilityRequest,
  tool: Tool,
  endpoint: string,
  now: () => Date,
): MappedCall {
  switch (capability) {
    case 'instrument-reference': return mapInstrument(request, tool, endpoint, now)
    case 'market-bars': return mapBars(request, tool, endpoint, now)
    case 'trading-calendar': return mapCalendar(request, tool, endpoint, now)
    case 'fundamentals': return mapFundamentals(request, tool, endpoint, now)
  }
}
