import type { ObservedField } from './contracts.js'
import type {
  BehaviorTradeAudit,
  BehaviorTradeAuditInput,
  CompletedTradeRecord,
  DispositionOpportunityMetrics,
  SaleOpportunitySet,
  TradeGroupStatistics,
} from './behavior-contracts.js'

const DAY_MS = 86_400_000
const CAVEAT = 'This audit reports descriptive patterns in the supplied sample. It does not identify a psychological cause or establish that the pattern will persist.'

interface AnalyzedTrade {
  record: CompletedTradeRecord
  returnValue: number
  holdingDays: number
  grossPnl: number | null
  netPnl: number | null
}

function available<T>(value: T, note?: string): ObservedField<T> {
  return note === undefined ? { status: 'available', value } : { status: 'available', value, note }
}

function missing<T>(note: string): ObservedField<T> {
  return { status: 'missing', value: null, note }
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(label + ' must be finite')
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new TypeError(label + ' must be a valid date or timestamp')
  return parsed
}

function analyze(record: CompletedTradeRecord): AnalyzedTrade {
  if (record.id.trim() === '') throw new TypeError('trade id must not be empty')
  if (record.ticker.trim() === '') throw new TypeError('trade ticker must not be empty')
  finite(record.entryPrice, 'entryPrice')
  finite(record.exitPrice, 'exitPrice')
  if (record.entryPrice <= 0 || record.exitPrice <= 0) throw new RangeError('trade prices must be positive')
  const openedAt = timestamp(record.openedAt, 'openedAt')
  const closedAt = timestamp(record.closedAt, 'closedAt')
  if (closedAt < openedAt) throw new RangeError('closedAt must not precede openedAt')
  if (record.quantity !== undefined) {
    finite(record.quantity, 'quantity')
    if (record.quantity <= 0) throw new RangeError('quantity must be positive')
  }
  if (record.fees !== undefined) {
    finite(record.fees, 'fees')
    if (record.fees < 0) throw new RangeError('fees must be non-negative')
  }
  if (record.plannedHorizonDays !== undefined) {
    finite(record.plannedHorizonDays, 'plannedHorizonDays')
    if (record.plannedHorizonDays < 0) throw new RangeError('plannedHorizonDays must be non-negative')
  }
  if (record.confidence !== undefined) {
    finite(record.confidence, 'confidence')
    if (record.confidence < 0 || record.confidence > 1) throw new RangeError('confidence must be between 0 and 1')
  }
  const side = record.side ?? 'long'
  const returnValue = side === 'long'
    ? record.exitPrice / record.entryPrice - 1
    : record.entryPrice / record.exitPrice - 1
  const grossPnl = record.quantity === undefined
    ? null
    : (side === 'long' ? record.exitPrice - record.entryPrice : record.entryPrice - record.exitPrice)
      * record.quantity
  const netPnl = grossPnl === null || record.fees === undefined ? null : grossPnl - record.fees
  return { record, returnValue, holdingDays: (closedAt - openedAt) / DAY_MS, grossPnl, netPnl }
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : sorted[middle] as number
}

function group(trades: readonly AnalyzedTrade[]): TradeGroupStatistics {
  return {
    count: trades.length,
    meanReturn: mean(trades.map(trade => trade.returnValue)),
    medianReturn: median(trades.map(trade => trade.returnValue)),
    meanHoldingDays: mean(trades.map(trade => trade.holdingDays)),
    medianHoldingDays: median(trades.map(trade => trade.holdingDays)),
  }
}

function confidenceInterval(values: readonly number[]): ObservedField<[number, number]> {
  if (values.length < 2) return missing('requires at least two completed trades')
  const average = mean(values) as number
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  const margin = 1.96 * Math.sqrt(variance / values.length)
  return available([average - margin, average + margin], 'normal-approximation 95% interval; descriptive, not a causal estimate')
}

function validateOpportunitySet(item: SaleOpportunitySet): void {
  if (item.id.trim() === '') throw new TypeError('opportunity-set id must not be empty')
  timestamp(item.observedAt, 'opportunity-set observedAt')
  for (const key of ['realizedGains', 'realizedLosses', 'paperGains', 'paperLosses'] as const) {
    const value = item[key]
    finite(value, key)
    if (!Number.isInteger(value) || value < 0) throw new RangeError(key + ' must be a non-negative integer')
  }
}

function dispositionMetrics(input: BehaviorTradeAuditInput): DispositionOpportunityMetrics {
  const sets = input.opportunitySets
  if (sets === undefined || sets.length === 0) {
    return {
      status: 'missing', pgr: null, plr: null, spread: null, opportunityDates: 0,
      note: 'PGR/PLR require realized and paper gain/loss opportunities for every included sale date; completed trades alone are insufficient.',
    }
  }
  const ids = new Set<string>()
  sets.forEach(item => {
    if (ids.has(item.id)) throw new RangeError('opportunity-set ids must be unique')
    ids.add(item.id)
    validateOpportunitySet(item)
  })
  if (input.lotMatchingAssumption === undefined || input.lotMatchingAssumption.trim() === '') {
    return {
      status: 'missing', pgr: null, plr: null, spread: null, opportunityDates: sets.length,
      note: 'PGR/PLR were not calculated because the lot-matching assumption was not supplied.',
    }
  }
  const total = sets.reduce((sum, item) => ({
    realizedGains: sum.realizedGains + item.realizedGains,
    realizedLosses: sum.realizedLosses + item.realizedLosses,
    paperGains: sum.paperGains + item.paperGains,
    paperLosses: sum.paperLosses + item.paperLosses,
  }), { realizedGains: 0, realizedLosses: 0, paperGains: 0, paperLosses: 0 })
  const gainDenominator = total.realizedGains + total.paperGains
  const lossDenominator = total.realizedLosses + total.paperLosses
  if (gainDenominator === 0 || lossDenominator === 0) {
    return {
      status: 'missing', pgr: null, plr: null, spread: null, opportunityDates: sets.length,
      note: 'PGR/PLR require at least one gain opportunity and one loss opportunity.',
    }
  }
  const pgr = total.realizedGains / gainDenominator
  const plr = total.realizedLosses / lossDenominator
  return {
    status: 'available', pgr, plr, spread: pgr - plr, opportunityDates: sets.length,
    note: 'Calculated from supplied sale-date opportunity counts using lot matching: ' + input.lotMatchingAssumption + '. Descriptive evidence does not establish motive.',
  }
}

function completeness(records: readonly CompletedTradeRecord[], key: keyof CompletedTradeRecord): number {
  return records.length === 0 ? 0 : records.filter(record => record[key] !== undefined).length / records.length
}

function activity(trades: readonly AnalyzedTrade[]): BehaviorTradeAudit['activity'] {
  const opened = trades
    .map(trade => Date.parse(trade.record.openedAt))
    .sort((a, b) => a - b)
  const entryGaps = opened.slice(1).map((value, index) => (value - (opened[index] as number)) / DAY_MS)
  const sampleDates = trades.flatMap(trade => [
    Date.parse(trade.record.openedAt),
    Date.parse(trade.record.closedAt),
  ])
  const spanDays = sampleDates.length === 0
    ? null
    : (Math.max(...sampleDates) - Math.min(...sampleDates)) / DAY_MS

  const byTicker = new Map<string, AnalyzedTrade[]>()
  for (const trade of trades) {
    const ticker = trade.record.ticker.trim().toUpperCase()
    const group = byTicker.get(ticker) ?? []
    group.push(trade)
    byTicker.set(ticker, group)
  }
  const reentryGaps: number[] = []
  for (const tickerTrades of byTicker.values()) {
    tickerTrades.sort((a, b) => Date.parse(a.record.openedAt) - Date.parse(b.record.openedAt))
    for (let index = 1; index < tickerTrades.length; index += 1) {
      const previous = tickerTrades[index - 1] as AnalyzedTrade
      const current = tickerTrades[index] as AnalyzedTrade
      const gap = (Date.parse(current.record.openedAt) - Date.parse(previous.record.closedAt)) / DAY_MS
      if (gap >= 0) reentryGaps.push(gap)
    }
  }

  return {
    completedTradesPer30Days: spanDays === null || spanDays <= 0
      ? missing('requires a positive observation span')
      : available(trades.length * 30 / spanDays, 'completed records per 30 calendar days across the supplied observation span; not account turnover'),
    medianDaysBetweenEntries: entryGaps.length === 0
      ? missing('requires at least two completed trades')
      : available(median(entryGaps) as number),
    medianSameTickerReentryDays: reentryGaps.length === 0
      ? missing('no non-overlapping same-ticker reentry pair was supplied')
      : available(median(reentryGaps) as number, 'calendar days from a prior close to the next opening in the same ticker'),
  }
}

export function calculateBehaviorTradeAudit(input: BehaviorTradeAuditInput): BehaviorTradeAudit {
  const ids = new Set<string>()
  const analyzed = input.records.map(record => {
    if (ids.has(record.id)) throw new RangeError('trade ids must be unique')
    ids.add(record.id)
    return analyze(record)
  })
  const winners = analyzed.filter(trade => trade.returnValue > 0)
  const losers = analyzed.filter(trade => trade.returnValue < 0)
  const flat = analyzed.length - winners.length - losers.length
  const allGrossPnl = analyzed.every(trade => trade.grossPnl !== null)
  const allNetPnl = analyzed.every(trade => trade.netPnl !== null)
  const allFees = analyzed.every(trade => trade.record.fees !== undefined)
  const grossPnl = allGrossPnl && analyzed.length > 0
    ? analyzed.reduce((sum, trade) => sum + (trade.grossPnl as number), 0)
    : null
  const netPnl = allNetPnl && analyzed.length > 0
    ? analyzed.reduce((sum, trade) => sum + (trade.netPnl as number), 0)
    : null
  const totalFees = allFees && analyzed.length > 0
    ? analyzed.reduce((sum, trade) => sum + (trade.record.fees as number), 0)
    : null
  const ruleRecords = analyzed.filter(trade => trade.record.ruleFollowed !== undefined)
  const dates = analyzed.flatMap(trade => [Date.parse(trade.record.openedAt), Date.parse(trade.record.closedAt)])
  const limitations: string[] = []
  if (analyzed.length < 10) limitations.push('small sample: fewer than 10 completed trades')
  if (!allGrossPnl) limitations.push('gross and net monetary P&L require quantity for every trade')
  if (!allFees) limitations.push('fee drag requires fees for every trade')
  if (input.opportunitySets === undefined || input.opportunitySets.length === 0) {
    limitations.push('completed trades omit unrealized sale-date opportunities and cannot identify Odean PGR/PLR')
  }
  const disposition = dispositionMetrics(input)
  if (disposition.status !== 'available'
    && input.opportunitySets !== undefined && input.opportunitySets.length > 0) {
    limitations.push(disposition.note)
  }
  return {
    status: analyzed.length === 0 ? 'insufficient-data' : limitations.length === 0 ? 'available' : 'partial',
    sample: {
      records: analyzed.length,
      winners: winners.length,
      losers: losers.length,
      flat,
      startAt: dates.length === 0 ? null : new Date(Math.min(...dates)).toISOString(),
      endAt: dates.length === 0 ? null : new Date(Math.max(...dates)).toISOString(),
    },
    completeness: {
      quantity: completeness(input.records, 'quantity'),
      fees: completeness(input.records, 'fees'),
      rationale: completeness(input.records, 'rationale'),
      plannedHorizon: completeness(input.records, 'plannedHorizonDays'),
      confidence: completeness(input.records, 'confidence'),
      ruleFollowed: completeness(input.records, 'ruleFollowed'),
    },
    allTrades: group(analyzed),
    winningTrades: group(winners),
    losingTrades: group(losers),
    activity: activity(analyzed),
    aggregate: {
      grossPnl: grossPnl === null ? missing('quantity is required for every trade') : available(grossPnl),
      netPnl: netPnl === null ? missing('quantity and fees are required for every trade') : available(netPnl),
      feeDrag: totalFees === null ? missing('fees are required for every trade') : available(totalFees, 'sum of supplied fees in the records currency'),
      ruleAdherenceRate: ruleRecords.length === 0
        ? missing('no ruleFollowed observations were supplied')
        : available(ruleRecords.filter(trade => trade.record.ruleFollowed === true).length / ruleRecords.length),
      meanReturn95Ci: confidenceInterval(analyzed.map(trade => trade.returnValue)),
    },
    dispositionOpportunityMetrics: disposition,
    diagnosticCaveat: CAVEAT,
    limitations,
  }
}
