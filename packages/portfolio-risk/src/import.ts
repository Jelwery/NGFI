import { canonicalInstrumentId, type AssetType, type Exchange, type InstrumentId, type Market } from '@finance2dsh/core'

import type {
  HoldingPosition,
  HoldingPositionInput,
  HoldingsImportFormat,
  HoldingsImportIssue,
  HoldingsImportResult,
} from './contracts.js'
import { holdingId, holdingKey, portfolioHash } from './identity.js'

export interface HoldingsImportContext {
  readonly portfolioId: string
  readonly asOf: string
  readonly baseCurrency: string
}

const CURRENCY_RE = /^[A-Z]{3}$/u
const JSON_POSITION_KEYS = new Set(['instrument', 'quantity', 'marketValue', 'currency', 'account', 'name'])
const INSTRUMENT_KEYS = new Set(['market', 'exchange', 'symbol', 'assetType'])
const CSV_COLUMNS = ['market', 'exchange', 'symbol', 'assetType', 'quantity', 'marketValue', 'currency', 'account', 'name'] as const
const CSV_REQUIRED = new Set(['market', 'exchange', 'symbol', 'assetType', 'quantity', 'marketValue', 'currency'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function issue(
  code: HoldingsImportIssue['code'],
  message: string,
  row?: number,
  field?: string,
): HoldingsImportIssue {
  return { code, message, ...(row === undefined ? {} : { row }), ...(field === undefined ? {} : { field }) }
}

function normalizeContext(context: HoldingsImportContext): HoldingsImportContext {
  const portfolioId = context.portfolioId.trim()
  const baseCurrency = context.baseCurrency.trim().toUpperCase()
  if (portfolioId === '') throw new TypeError('portfolioId must be non-empty')
  const parsedAsOf = Date.parse(context.asOf.length === 10 ? `${context.asOf}T00:00:00Z` : context.asOf)
  const validDateOnly = context.asOf.length !== 10
    || new Date(parsedAsOf).toISOString().slice(0, 10) === context.asOf
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(context.asOf) || !Number.isFinite(parsedAsOf) || !validDateOnly) {
    throw new TypeError('asOf must be an ISO date or timestamp')
  }
  if (!CURRENCY_RE.test(baseCurrency)) throw new TypeError('baseCurrency must be a three-letter ISO currency')
  return { portfolioId, asOf: context.asOf, baseCurrency }
}

function textField(value: unknown, row: number, field: string, errors: HoldingsImportIssue[]): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(issue('missing-field', `${field} must be a non-empty string`, row, field))
    return null
  }
  return value.trim()
}

function positiveNumber(value: unknown, row: number, field: string, errors: HoldingsImportIssue[]): number | null {
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(issue('invalid-number', `${field} must be a finite number greater than zero`, row, field))
    return null
  }
  return parsed
}

function normalizePosition(
  value: unknown,
  row: number,
  portfolioId: string,
  errors: HoldingsImportIssue[],
): HoldingPosition | null {
  if (!isPlainObject(value)) {
    errors.push(issue('invalid-shape', 'holding must be an object', row))
    return null
  }
  for (const key of Object.keys(value)) {
    if (!JSON_POSITION_KEYS.has(key)) errors.push(issue('unknown-field', `unsupported holding field: ${key}`, row, key))
  }
  const instrumentValue = value.instrument
  if (!isPlainObject(instrumentValue)) {
    errors.push(issue('missing-field', 'instrument must be an object', row, 'instrument'))
    return null
  }
  for (const key of Object.keys(instrumentValue)) {
    if (!INSTRUMENT_KEYS.has(key)) errors.push(issue('unknown-field', `unsupported instrument field: ${key}`, row, `instrument.${key}`))
  }
  const market = textField(instrumentValue.market, row, 'instrument.market', errors)
  const exchange = textField(instrumentValue.exchange, row, 'instrument.exchange', errors)
  const symbol = textField(instrumentValue.symbol, row, 'instrument.symbol', errors)
  const assetType = textField(instrumentValue.assetType, row, 'instrument.assetType', errors)
  const quantity = positiveNumber(value.quantity, row, 'quantity', errors)
  const marketValue = positiveNumber(value.marketValue, row, 'marketValue', errors)
  const currencyText = textField(value.currency, row, 'currency', errors)
  const currency = currencyText?.toUpperCase() ?? null
  if (currency !== null && !CURRENCY_RE.test(currency)) {
    errors.push(issue('invalid-currency', 'currency must be a three-letter ISO currency', row, 'currency'))
  }
  const account = value.account === undefined ? 'default' : textField(value.account, row, 'account', errors)
  const name = value.name === undefined ? undefined : textField(value.name, row, 'name', errors) ?? undefined
  if ([market, exchange, symbol, assetType, quantity, marketValue, currency, account].some(item => item === null)) return null
  const instrument: InstrumentId = {
    market: market!.toUpperCase() as Market,
    exchange: exchange!.toUpperCase() as Exchange,
    symbol: symbol!.toUpperCase(),
    assetType: assetType!.toLowerCase() as AssetType,
  }
  try {
    canonicalInstrumentId(instrument)
  } catch (error) {
    errors.push(issue('invalid-instrument', error instanceof Error ? error.message : 'invalid instrument', row, 'instrument'))
    return null
  }
  const input: HoldingPositionInput = {
    instrument, quantity: quantity!, marketValue: marketValue!, currency: currency!, account: account!,
    ...(name === undefined ? {} : { name }),
  }
  return { ...input, account: account!, id: holdingId(portfolioId, input) }
}

function finalize(
  format: HoldingsImportFormat,
  contextInput: HoldingsImportContext,
  rawInput: unknown,
  values: readonly unknown[],
  initialErrors: readonly HoldingsImportIssue[] = [],
): HoldingsImportResult {
  const context = normalizeContext(contextInput)
  const errors = [...initialErrors]
  const positions: HoldingPosition[] = []
  for (let index = 0; index < values.length; index += 1) {
    const position = normalizePosition(values[index], index + 1, context.portfolioId, errors)
    if (position !== null) positions.push(position)
  }
  const seen = new Map<string, number>()
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index] as HoldingPosition
    const key = holdingKey(position)
    const first = seen.get(key)
    if (first !== undefined) {
      errors.push(issue('duplicate-holding', `duplicate holding matches row ${first}`, index + 1))
    } else {
      seen.set(key, index + 1)
    }
  }
  const inputHash = portfolioHash({ format, input: rawInput })
  if (errors.length > 0 || positions.length === 0) {
    if (positions.length === 0 && errors.length === 0) errors.push(issue('invalid-shape', 'holdings import must contain at least one row'))
    return { ...context, format, inputHash, status: 'invalid', positions: [], errors }
  }
  return { ...context, format, inputHash, status: 'ready', positions, errors: [] }
}

export function importHoldingsJson(text: string, context: HoldingsImportContext): HoldingsImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return finalize('json', context, text, [], [issue(
      'invalid-syntax',
      error instanceof Error ? `invalid JSON: ${error.message}` : 'invalid JSON',
    )])
  }
  const objectErrors: HoldingsImportIssue[] = []
  if (isPlainObject(parsed)) {
    for (const key of Object.keys(parsed)) {
      if (key !== 'holdings') objectErrors.push(issue('unknown-field', `unsupported JSON envelope field: ${key}`, undefined, key))
    }
  }
  const values = Array.isArray(parsed)
    ? parsed
    : (isPlainObject(parsed) && Array.isArray(parsed.holdings) ? parsed.holdings : null)
  if (values === null) {
    return finalize('json', context, parsed, [], [issue('invalid-shape', 'JSON must be an array or an object with a holdings array')])
  }
  return finalize('json', context, parsed, values, objectErrors)
}

function parseCsvRows(text: string): { rows: string[][]; error?: HoldingsImportIssue } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (character === '"') quoted = false
      else field += character
    } else if (character === '"' && field === '') quoted = true
    else if (character === ',') { row.push(field); field = '' }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (character !== '\r') field += character
  }
  if (quoted) return { rows: [], error: issue('invalid-syntax', 'CSV contains an unterminated quoted field') }
  row.push(field)
  if (row.some(cell => cell !== '') || rows.length === 0) rows.push(row)
  return { rows }
}

export function importHoldingsCsv(text: string, context: HoldingsImportContext): HoldingsImportResult {
  const parsed = parseCsvRows(text)
  if (parsed.error !== undefined) return finalize('csv', context, text, [], [parsed.error])
  const [headerRow, ...dataRows] = parsed.rows
  if (headerRow === undefined) return finalize('csv', context, text, [], [issue('invalid-shape', 'CSV header is missing')])
  const headers = headerRow.map(header => header.trim())
  const errors: HoldingsImportIssue[] = []
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index)
  for (const header of new Set(duplicates)) errors.push(issue('invalid-shape', `duplicate CSV column: ${header}`, 1, header))
  for (const header of headers) {
    if (!(CSV_COLUMNS as readonly string[]).includes(header)) errors.push(issue('unknown-field', `unsupported CSV column: ${header}`, 1, header))
  }
  for (const required of CSV_REQUIRED) {
    if (!headers.includes(required)) errors.push(issue('missing-field', `required CSV column is missing: ${required}`, 1, required))
  }
  const values: unknown[] = []
  for (let index = 0; index < dataRows.length; index += 1) {
    const cells = dataRows[index] as string[]
    if (cells.every(cell => cell.trim() === '')) continue
    if (cells.length !== headers.length) {
      errors.push(issue('invalid-shape', `CSV row has ${cells.length} cells; expected ${headers.length}`, index + 2))
      continue
    }
    const flat = Object.fromEntries(headers.map((header, column) => [header, cells[column]?.trim()]))
    values.push({
      instrument: { market: flat.market, exchange: flat.exchange, symbol: flat.symbol, assetType: flat.assetType },
      quantity: flat.quantity, marketValue: flat.marketValue, currency: flat.currency,
      ...(flat.account === undefined || flat.account === '' ? {} : { account: flat.account }),
      ...(flat.name === undefined || flat.name === '' ? {} : { name: flat.name }),
    })
  }
  return finalize('csv', context, text, values, errors)
}
