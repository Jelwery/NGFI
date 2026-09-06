import type { AssetType, Exchange, InstrumentId, Market } from './contracts.js'
import { FinanceDataError } from './errors.js'

export interface NormalizeAshareOptions {
  exchange?: 'SSE' | 'SZSE' | 'BSE'
  assetType?: 'equity' | 'index' | 'etf' | 'fund' | 'bond'
}

interface ParsedSymbol {
  symbol: string
  prefixExchange?: 'SSE' | 'SZSE' | 'BSE'
  suffixExchange?: 'SSE' | 'SZSE' | 'BSE'
}

const PREFIX_EXCHANGES: Readonly<Record<string, 'SSE' | 'SZSE' | 'BSE'>> = {
  sh: 'SSE',
  ss: 'SSE',
  sz: 'SZSE',
  bj: 'BSE',
}

const SUFFIX_EXCHANGES: Readonly<Record<string, 'SSE' | 'SZSE' | 'BSE'>> = {
  SH: 'SSE',
  SS: 'SSE',
  XSHG: 'SSE',
  SZ: 'SZSE',
  XSHE: 'SZSE',
  BJ: 'BSE',
  BSE: 'BSE',
}

const INDEX_BY_SYMBOL: Readonly<Record<string, 'SSE' | 'SZSE' | 'BSE'>> = {
  '000001': 'SSE',
  '000016': 'SSE',
  '000300': 'SSE',
  '000688': 'SSE',
  '000852': 'SSE',
  '000905': 'SSE',
  '399001': 'SZSE',
  '399005': 'SZSE',
  '399006': 'SZSE',
  '399300': 'SZSE',
  '399905': 'SZSE',
  '899050': 'BSE',
}
const AMBIGUOUS_INDEX_SYMBOLS = new Set([
  '000001',
  '000016',
  '000300',
  '000688',
  '000852',
  '000905',
])

function invalid(message: string, kind: 'invalid-request' | 'conflicting-instrument' | 'ambiguous-instrument' = 'invalid-request'): never {
  throw new FinanceDataError(message, kind, { retryable: false })
}

function parseSymbol(input: string): ParsedSymbol {
  const value = input.trim()
  if (value === '') invalid('instrument symbol cannot be empty')

  const match = /^(?:(sh|ss|sz|bj))?(\d{6})(?:\.([a-z]+))?$/i.exec(value)
  if (match === null) {
    invalid('A-share symbol must be six digits with an optional sh/sz/bj prefix or SH/SZ/BJ suffix')
  }
  const prefix = match[1]?.toLowerCase()
  const suffix = match[3]?.toUpperCase()
  const prefixExchange = prefix === undefined ? undefined : PREFIX_EXCHANGES[prefix]
  const suffixExchange = suffix === undefined ? undefined : SUFFIX_EXCHANGES[suffix]
  if (suffix !== undefined && suffixExchange === undefined) {
    invalid(`unsupported A-share exchange suffix: ${suffix}`)
  }
  if (prefixExchange !== undefined && suffixExchange !== undefined && prefixExchange !== suffixExchange) {
    invalid(`conflicting A-share exchange prefix and suffix: ${prefixExchange} versus ${suffixExchange}`, 'conflicting-instrument')
  }
  return {
    symbol: match[2] as string,
    ...(prefixExchange === undefined ? {} : { prefixExchange }),
    ...(suffixExchange === undefined ? {} : { suffixExchange }),
  }
}

function inferEquityExchange(symbol: string): 'SSE' | 'SZSE' | 'BSE' {
  if (/^(4|8|92)/.test(symbol)) return 'BSE'
  if (/^(5|6|9)/.test(symbol)) return 'SSE'
  if (/^(0|1|2|3)/.test(symbol)) return 'SZSE'
  invalid(`cannot infer exchange for A-share equity ${symbol}`, 'ambiguous-instrument')
}

function inferFundExchange(symbol: string): 'SSE' | 'SZSE' | 'BSE' {
  if (/^(5|6)/.test(symbol)) return 'SSE'
  if (/^(1|2)/.test(symbol)) return 'SZSE'
  if (/^(4|8|92)/.test(symbol)) return 'BSE'
  invalid(`cannot infer exchange for A-share fund ${symbol}`, 'ambiguous-instrument')
}

function inferBondExchange(symbol: string): 'SSE' | 'SZSE' | undefined {
  if (/^(110|113|118)/.test(symbol)) return 'SSE'
  if (/^(123|127|128)/.test(symbol)) return 'SZSE'
  return undefined
}

function inferAssetType(
  symbol: string,
  explicitExchange?: 'SSE' | 'SZSE' | 'BSE',
): 'equity' | 'etf' | 'fund' | 'bond' {
  if (inferBondExchange(symbol) !== undefined) return 'bond'
  const inferredExchange = explicitExchange ?? inferEquityExchange(symbol)
  if (inferredExchange === 'SSE' && /^(51[0-8]|56|58[089])/.test(symbol)) return 'etf'
  if (inferredExchange === 'SZSE' && /^159/.test(symbol)) return 'etf'
  if (inferredExchange === 'SSE' && /^(50|51[9])/.test(symbol)) return 'fund'
  if (inferredExchange === 'SZSE' && /^16/.test(symbol)) return 'fund'
  return 'equity'
}

export function canonicalInstrumentId(id: InstrumentId): string {
  if (id === null || typeof id !== 'object'
    || !['market', 'exchange', 'symbol', 'assetType'].every(key => (
      typeof (id as unknown as Record<string, unknown>)[key] === 'string'
    ))) {
    invalid('canonical instrument requires string market, exchange, symbol, and assetType')
  }
  const market = id.market.trim().toUpperCase()
  const exchange = id.exchange.trim().toUpperCase()
  const symbol = id.symbol.trim().toUpperCase()
  const assetType = id.assetType.trim().toUpperCase()
  if (!/^[A-Z0-9_-]{1,16}$/.test(market)
    || !/^[A-Z0-9_-]{1,16}$/.test(exchange)
    || !/^[A-Z0-9.^=_-]{1,32}$/.test(symbol)
    || !/^[A-Z0-9_-]{1,32}$/.test(assetType)) {
    invalid('canonical instrument components contain unsupported characters or lengths')
  }
  return `${market}:${exchange}:${symbol}:${assetType}`
}

export function parseCanonicalInstrument(value: string): InstrumentId {
  const parts = value.trim().split(':')
  if (parts.length !== 4) invalid('canonical instrument must use MARKET:EXCHANGE:SYMBOL:ASSET_TYPE')
  const [market, exchange, symbol, assetType] = parts as [string, string, string, string]
  const id: InstrumentId = {
    market: market.toUpperCase() as Market,
    exchange: exchange.toUpperCase() as Exchange,
    symbol: symbol.toUpperCase(),
    assetType: assetType.toLowerCase() as AssetType,
  }
  canonicalInstrumentId(id)
  if (id.market === 'CN') {
    if (!['SSE', 'SZSE', 'BSE'].includes(id.exchange) || !/^\d{6}$/.test(id.symbol)) {
      invalid('canonical mainland China instruments require a supported exchange and six-digit symbol')
    }
    if (!['equity', 'index', 'etf', 'fund', 'bond'].includes(id.assetType)) {
      invalid(`unsupported mainland China asset type: ${id.assetType}`)
    }
  }
  return id
}

export function normalizeAshareInstrument(
  input: string,
  options: NormalizeAshareOptions = {},
): InstrumentId {
  const canonicalCandidate = input.trim()
  if (canonicalCandidate.includes(':')) {
    const parsed = parseCanonicalInstrument(canonicalCandidate)
    if (parsed.market !== 'CN' || !['SSE', 'SZSE', 'BSE'].includes(parsed.exchange)) {
      invalid('canonical instrument is not a supported mainland China listing')
    }
    if (options.exchange !== undefined && parsed.exchange !== options.exchange) {
      invalid(`canonical exchange ${parsed.exchange} conflicts with requested ${options.exchange}`, 'conflicting-instrument')
    }
    if (options.assetType !== undefined && parsed.assetType !== options.assetType) {
      invalid(`canonical asset type ${parsed.assetType} conflicts with requested ${options.assetType}`, 'conflicting-instrument')
    }
    const suffix = { SSE: 'SH', SZSE: 'SZ', BSE: 'BJ' }[parsed.exchange as 'SSE' | 'SZSE' | 'BSE']
    normalizeAshareInstrument(`${parsed.symbol}.${suffix}`, {
      exchange: parsed.exchange as 'SSE' | 'SZSE' | 'BSE',
      assetType: parsed.assetType as NonNullable<NormalizeAshareOptions['assetType']>,
    })
    return parsed
  }

  const parsed = parseSymbol(input)
  const encodedExchange = parsed.prefixExchange ?? parsed.suffixExchange
  if (encodedExchange !== undefined && options.exchange !== undefined && encodedExchange !== options.exchange) {
    invalid(`symbol exchange ${encodedExchange} conflicts with requested ${options.exchange}`, 'conflicting-instrument')
  }

  const indexExchange = INDEX_BY_SYMBOL[parsed.symbol]
  let assetType = options.assetType
  const prefixAssetType = inferAssetType(parsed.symbol, encodedExchange ?? options.exchange)
  const bondExchange = inferBondExchange(parsed.symbol)
  if (assetType === 'bond' && bondExchange === undefined) {
    invalid(`${parsed.symbol} is not in a recognized convertible bond code range`, 'conflicting-instrument')
  }
  if (assetType !== undefined && prefixAssetType !== 'equity'
    && assetType !== prefixAssetType
    && !(prefixAssetType === 'fund' && assetType === 'etf')) {
    invalid(
      `${parsed.symbol} is classified as ${prefixAssetType}, not ${assetType}`,
      'conflicting-instrument',
    )
  }
  if (assetType === 'etf' && prefixAssetType === 'equity') {
    invalid(`${parsed.symbol} is not in a recognized ETF code range`, 'conflicting-instrument')
  }
  if (assetType !== undefined && assetType !== 'index' && indexExchange !== undefined) {
    const requestedExchange = encodedExchange ?? options.exchange ?? (
      assetType === 'etf' || assetType === 'fund'
        ? inferFundExchange(parsed.symbol)
        : inferEquityExchange(parsed.symbol)
    )
    if (requestedExchange === indexExchange) {
      invalid(
        `${parsed.symbol} is a known ${indexExchange} index, not ${assetType}`,
        'conflicting-instrument',
      )
    }
  }
  if (assetType === undefined && indexExchange !== undefined && encodedExchange === indexExchange) assetType = 'index'
  if (assetType === undefined && indexExchange !== undefined && encodedExchange === undefined
    && AMBIGUOUS_INDEX_SYMBOLS.has(parsed.symbol)) {
    invalid(
      `${parsed.symbol} is ambiguous between ${indexExchange} index and an exchange-listed security; provide assetType or an exchange marker`,
      'ambiguous-instrument',
    )
  }
  if (assetType === undefined && indexExchange !== undefined && encodedExchange === undefined) assetType = 'index'
  assetType ??= prefixAssetType

  let inferredExchange: 'SSE' | 'SZSE' | 'BSE'
  if (assetType === 'index') {
    if (indexExchange === undefined && encodedExchange === undefined && options.exchange === undefined) {
      invalid(`cannot infer exchange for index ${parsed.symbol}`, 'ambiguous-instrument')
    }
    inferredExchange = indexExchange ?? encodedExchange ?? options.exchange as 'SSE' | 'SZSE' | 'BSE'
    if (indexExchange !== undefined && encodedExchange !== undefined && indexExchange !== encodedExchange) {
      invalid(`index ${parsed.symbol} belongs to ${indexExchange}, not ${encodedExchange}`, 'conflicting-instrument')
    }
  } else if (assetType === 'etf' || assetType === 'fund') {
    inferredExchange = inferFundExchange(parsed.symbol)
  } else if (assetType === 'bond') {
    if (bondExchange === undefined) {
      invalid(`cannot infer exchange for A-share bond ${parsed.symbol}`, 'ambiguous-instrument')
    }
    inferredExchange = bondExchange
  } else {
    inferredExchange = inferEquityExchange(parsed.symbol)
  }

  const exchange = encodedExchange ?? options.exchange ?? inferredExchange
  if (exchange !== inferredExchange) {
    invalid(
      `${assetType} ${parsed.symbol} belongs to ${inferredExchange}, not ${exchange}`,
      'conflicting-instrument',
    )
  }
  return { market: 'CN', exchange, symbol: parsed.symbol, assetType }
}

export function normalizeAshareCanonical(
  input: string,
  options: NormalizeAshareOptions = {},
): string {
  return canonicalInstrumentId(normalizeAshareInstrument(input, options))
}

/** Provider-specific symbols are produced only at the adapter boundary. */
export function toAshareProviderSymbol(
  instrument: InstrumentId,
  dialect: 'suffix' | 'lower-prefix',
): string {
  if (instrument.market !== 'CN') invalid('A-share provider symbol requires market CN')
  normalizeAshareInstrument(canonicalInstrumentId(instrument))
  const suffixByExchange = { SSE: 'SH', SZSE: 'SZ', BSE: 'BJ' } as const
  const prefixByExchange = { SSE: 'sh', SZSE: 'sz', BSE: 'bj' } as const
  if (!(instrument.exchange in suffixByExchange)) invalid(`unsupported A-share exchange ${instrument.exchange}`)
  const exchange = instrument.exchange as keyof typeof suffixByExchange
  return dialect === 'suffix'
    ? `${instrument.symbol}.${suffixByExchange[exchange]}`
    : `${prefixByExchange[exchange]}${instrument.symbol}`
}
