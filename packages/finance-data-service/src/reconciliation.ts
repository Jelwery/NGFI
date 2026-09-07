import {
  DATA_CAPABILITIES,
  DATA_STATUSES,
  SOURCE_KINDS,
  FinanceDataError,
  assertJsonSafe,
  canonicalInstrumentId,
  dataErrorKind,
  isRetryableDataError,
} from '@finance2dsh/core'
import type {
  AdjustmentMode,
  CanonicalDataResult,
  DataCapability,
  DataProvenance,
  DataStatus,
  InstrumentId,
} from '@finance2dsh/core'
import { redactSensitiveText } from './redaction.js'
import { assertProviderId } from './safety.js'

export const RECONCILIATION_CAPABILITIES = [
  'quote',
  'market-bars',
  'fundamentals',
  'index',
] as const satisfies readonly DataCapability[]

export type ReconciliationCapability = typeof RECONCILIATION_CAPABILITIES[number]
export type ReconciliationStatus = 'consistent' | 'conflict' | 'inconclusive'

/**
 * A value is within tolerance when its absolute difference is no greater than
 * max(absolute, relative * max(abs(left), abs(right))). Relative is a fraction.
 */
export interface NumericTolerance {
  absolute: number
  relative: number
}

export interface QuoteReconciliationPolicy {
  capability: 'quote'
  price: NumericTolerance
  volume: NumericTolerance
  turnover: NumericTolerance
  /** Optional maximum wall-clock separation for two same-trading-day snapshots. */
  maxObservationSkewMs?: number
}

export interface MarketBarsReconciliationPolicy {
  capability: 'market-bars'
  price: NumericTolerance
  volume: NumericTolerance
  turnover: NumericTolerance
}

export interface FundamentalFieldPolicy extends NumericTolerance {
  /** Explicit provider field names. No fuzzy or case-insensitive matching is performed. */
  aliases?: readonly string[]
}

export interface FundamentalsReconciliationPolicy {
  capability: 'fundamentals'
  /** Canonical field name to its numeric comparison policy. */
  fields: Readonly<Record<string, FundamentalFieldPolicy>>
}

export interface IndexReconciliationPolicy {
  capability: 'index'
  weight: NumericTolerance
}

export type ReconciliationPolicy =
  | QuoteReconciliationPolicy
  | MarketBarsReconciliationPolicy
  | FundamentalsReconciliationPolicy
  | IndexReconciliationPolicy

export interface ReconciliationContext {
  /** Expected request identity. A source returning another identity is a business conflict. */
  instrument?: InstrumentId
  /** Explicit request interval used only when a provider omits it from its payload. */
  interval?: string
  /** Explicit request adjustment used only when a provider omits it from its payload. */
  adjustment?: AdjustmentMode
}

export interface FulfilledReconciliationSource {
  provider: string
  result: CanonicalDataResult<unknown>
}

export interface RejectedReconciliationSource {
  provider: string
  error: unknown
}

export type ReconciliationSourceInput =
  | FulfilledReconciliationSource
  | RejectedReconciliationSource

export interface CrossSourceReconciliationInput {
  capability: ReconciliationCapability
  sources: readonly ReconciliationSourceInput[]
  policy: ReconciliationPolicy
  context?: ReconciliationContext
}

export interface ReconciliationSourceError {
  kind: ReturnType<typeof dataErrorKind>
  message: string
  retryable: boolean
}

export interface FulfilledReconciliationSnapshot {
  provider: string
  outcome: 'fulfilled'
  status: DataStatus
  data: unknown | null
  provenance: DataProvenance
  warnings: string[]
  sourceDate: string | null
}

export interface RejectedReconciliationSnapshot {
  provider: string
  outcome: 'rejected'
  error: ReconciliationSourceError
}

export type ReconciliationSourceSnapshot =
  | FulfilledReconciliationSnapshot
  | RejectedReconciliationSnapshot

export type ReconciliationFindingCode =
  | 'source-not-independent'
  | 'source-status'
  | 'identity-mismatch'
  | 'trading-date-mismatch'
  | 'observation-time-mismatch'
  | 'currency-mismatch'
  | 'unit-mismatch'
  | 'adjustment-mismatch'
  | 'interval-mismatch'
  | 'source-date-mismatch'
  | 'period-context-mismatch'
  | 'missing-record'
  | 'missing-field'
  | 'value-match'
  | 'value-mismatch'
  | 'no-common-fields'

export interface ReconciliationFindingSide {
  provider: string
  value: unknown | null
  sourceDate: string | null
  provenance: DataProvenance
}

export interface ReconciliationDifference {
  absolute: number
  relative: number
  allowed: number
}

export interface ReconciliationFinding {
  status: ReconciliationStatus
  code: ReconciliationFindingCode
  path: string
  reason: string
  left: ReconciliationFindingSide
  right: ReconciliationFindingSide
  tolerance?: NumericTolerance
  difference?: ReconciliationDifference
  context?: Readonly<Record<string, string>>
}

export interface CrossSourceReconciliationResult {
  capability: ReconciliationCapability
  status: ReconciliationStatus
  sources: ReconciliationSourceSnapshot[]
  findings: ReconciliationFinding[]
}

interface NormalizedSource {
  provider: string
  result: CanonicalDataResult<unknown>
  normalized: NormalizedPayload | null
  sourceDate: string | null
}

interface NormalizedQuote {
  kind: 'quote'
  identity: string
  tradingDate: string | null
  observationTime: string | null
  currency: string | null
  fields: Readonly<Record<QuoteField, number | null>>
}

type QuoteField = 'open' | 'high' | 'low' | 'last' | 'previousClose' | 'volume' | 'turnover'

interface NormalizedBar {
  key: string
  values: Readonly<Record<BarField, number | null>>
  original: Record<string, unknown>
}

type BarField = 'open' | 'high' | 'low' | 'close' | 'volume' | 'turnover'

interface NormalizedBars {
  kind: 'market-bars'
  identity: string
  interval: string | null
  adjustment: AdjustmentMode | null
  currency: string | null
  unit: string | null
  truncated: boolean | null
  bars: ReadonlyMap<string, NormalizedBar>
}

interface NormalizedFundamentalPeriod {
  fiscalPeriod: string | null
  currency: string | null
  unit: string | null
  scope: string | null
  key: string | null
  fields: Readonly<Record<string, number | null>>
  original: Record<string, unknown>
}

interface NormalizedFundamentals {
  kind: 'fundamentals'
  identity: string
  periods: readonly NormalizedFundamentalPeriod[]
}

interface NormalizedIndexConstituent {
  identity: string
  weight: number | null
  original: Record<string, unknown>
}

interface NormalizedIndex {
  kind: 'index'
  identity: string
  asOf: string | null
  truncated: boolean | null
  constituents: ReadonlyMap<string, NormalizedIndexConstituent>
}

type NormalizedPayload = NormalizedQuote | NormalizedBars | NormalizedFundamentals | NormalizedIndex

const USABLE_STATUSES = new Set<DataStatus>(['available', 'partial', 'stale'])
const ADJUSTMENTS = new Set<AdjustmentMode>(['none', 'qfq', 'hfq'])
const PRICE_FIELDS = ['open', 'high', 'low', 'last', 'previousClose'] as const
const BAR_PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const
const QUOTE_ALIASES: Readonly<Record<QuoteField, readonly string[]>> = {
  open: ['open'],
  high: ['high'],
  low: ['low'],
  last: ['last', 'lastPrice', 'price'],
  previousClose: ['previousClose'],
  volume: ['volume', 'vol'],
  turnover: ['turnover', 'amount'],
}
const BAR_ALIASES: Readonly<Record<BarField, readonly string[]>> = {
  open: ['open'],
  high: ['high'],
  low: ['low'],
  close: ['close'],
  volume: ['volume', 'vol'],
  turnover: ['turnover', 'amount'],
}

/** Validate a reconciliation strategy before any providers are called. */
export function assertReconciliationPlan(
  capability: DataCapability,
  providers: readonly string[],
  policy: ReconciliationPolicy,
): asserts capability is ReconciliationCapability {
  if (!RECONCILIATION_CAPABILITIES.includes(capability as ReconciliationCapability)) {
    throw invalid(`cross-source reconciliation does not support capability ${String(capability)}`)
  }
  if (!Array.isArray(providers) || providers.length < 2) {
    throw invalid('cross-source reconciliation requires at least two explicit providers')
  }
  const seen = new Set<string>()
  for (const provider of providers) {
    const normalized = assertProviderId(provider)
    if (normalized === 'auto') {
      throw invalid('cross-source reconciliation requires explicit providers; auto is not allowed')
    }
    if (seen.has(normalized)) throw invalid(`duplicate reconciliation provider: ${normalized}`)
    seen.add(normalized)
  }
  assertPolicy(capability as ReconciliationCapability, policy)
}

/**
 * Pure, order-invariant reconciliation of two or more provider outcomes.
 * It never chooses or averages a conflicting value.
 */
export function reconcileCrossSourceResults(
  input: CrossSourceReconciliationInput,
): CrossSourceReconciliationResult {
  assertExactObject(input, ['capability', 'sources', 'policy', 'context'], 'reconciliation input', invalid)
  if (!Array.isArray(input.sources)) throw invalid('reconciliation sources must be an array')
  const providers = input.sources.map(source => {
    if (!isPlainObject(source)) throw invalid('each reconciliation source must be an object')
    if (typeof source.provider !== 'string') throw invalid('each reconciliation source requires a provider')
    return assertProviderId(source.provider)
  })
  assertReconciliationPlan(input.capability, providers, input.policy)
  const context = normalizeContext(input.context)

  const ordered = input.sources
    .map((source, index) => ({ source, provider: providers[index] as string }))
    .sort((left, right) => compareText(left.provider, right.provider))
  const snapshots: ReconciliationSourceSnapshot[] = []
  const normalized: NormalizedSource[] = []

  for (const { source, provider } of ordered) {
    const hasResult = Object.hasOwn(source, 'result')
    const hasError = Object.hasOwn(source, 'error')
    if (hasResult === hasError) {
      throw invalid(`reconciliation source ${provider} must contain exactly one of result or error`)
    }
    assertExactObject(source, hasResult ? ['provider', 'result'] : ['provider', 'error'], `source ${provider}`, invalid)
    if (!hasResult) {
      snapshots.push({
        provider,
        outcome: 'rejected',
        error: normalizeError(source.error),
      })
      continue
    }

    const result = validateCanonicalResult(
      source.result,
      provider,
    )
    const payload = USABLE_STATUSES.has(result.status) && result.data !== null
      ? normalizePayload(input.capability, result, input.policy, context, provider)
      : null
    const sourceDate = payloadSourceDate(payload)
    normalized.push({ provider, result, normalized: payload, sourceDate })
    snapshots.push({
      provider,
      outcome: 'fulfilled',
      status: result.status,
      data: clone(result.data),
      provenance: clone(result.provenance),
      warnings: [...result.warnings],
      sourceDate,
    })
  }

  const findings: ReconciliationFinding[] = []
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      const left = normalized[leftIndex] as NormalizedSource
      const right = normalized[rightIndex] as NormalizedSource
      findings.push(...reconcilePair(input.capability, left, right, input.policy, context))
    }
  }
  findings.sort(compareFindings)

  const hasRejected = snapshots.some(source => source.outcome === 'rejected')
  const hasConflict = findings.some(finding => finding.status === 'conflict')
  const hasInconclusive = hasRejected || findings.length === 0
    || findings.some(finding => finding.status === 'inconclusive')
  return {
    capability: input.capability,
    status: hasConflict ? 'conflict' : hasInconclusive ? 'inconclusive' : 'consistent',
    sources: snapshots,
    findings,
  }
}

/** Backwards-friendly short alias for callers that do not need the longer name. */
export const reconcileSources = reconcileCrossSourceResults

function reconcilePair(
  capability: ReconciliationCapability,
  left: NormalizedSource,
  right: NormalizedSource,
  policy: ReconciliationPolicy,
  context: ReconciliationContext,
): ReconciliationFinding[] {
  if (!USABLE_STATUSES.has(left.result.status) || !USABLE_STATUSES.has(right.result.status)
    || left.normalized === null || right.normalized === null) {
    return [finding(
      'inconclusive', 'source-status', '$.status',
      'Both sources must have a usable canonical status and non-null data before their values can be compared.',
      left, right, left.result.status, right.result.status,
    )]
  }
  const leftPayload = left.normalized as NormalizedPayload
  const rightPayload = right.normalized as NormalizedPayload
  const expectedIdentity = context.instrument === undefined ? null : safeCanonicalIdentity(context.instrument, 'context')
  if (leftPayload.identity !== rightPayload.identity
    || (expectedIdentity !== null
      && (leftPayload.identity !== expectedIdentity || rightPayload.identity !== expectedIdentity))) {
    return [finding(
      'conflict', 'identity-mismatch', '$.instrument',
      'Sources do not describe the same canonical instrument.',
      left, right, leftPayload.identity, rightPayload.identity,
    )]
  }
  if (!independentSources(left, right)) {
    return [finding(
      'inconclusive', 'source-not-independent', '$.provenance',
      'Providers share an upstream source or an explicitly referenced lineage input and are not independent.',
      left, right, left.result.provenance.upstreamSource, right.result.provenance.upstreamSource,
    )]
  }

  switch (capability) {
    case 'quote':
      return compareQuotes(
        left, right, leftPayload as NormalizedQuote, rightPayload as NormalizedQuote,
        policy as QuoteReconciliationPolicy,
      )
    case 'market-bars':
      return compareBars(
        left, right, leftPayload as NormalizedBars, rightPayload as NormalizedBars,
        policy as MarketBarsReconciliationPolicy,
      )
    case 'fundamentals':
      return compareFundamentals(
        left, right, leftPayload as NormalizedFundamentals, rightPayload as NormalizedFundamentals,
        policy as FundamentalsReconciliationPolicy,
      )
    case 'index':
      return compareIndexes(
        left, right, leftPayload as NormalizedIndex, rightPayload as NormalizedIndex,
        policy as IndexReconciliationPolicy,
      )
  }
}

function compareQuotes(
  left: NormalizedSource,
  right: NormalizedSource,
  leftQuote: NormalizedQuote,
  rightQuote: NormalizedQuote,
  policy: QuoteReconciliationPolicy,
): ReconciliationFinding[] {
  if (leftQuote.tradingDate === null || rightQuote.tradingDate === null
    || leftQuote.tradingDate !== rightQuote.tradingDate) {
    return [finding(
      'conflict', 'trading-date-mismatch', '$.tradingDate',
      'Quote trading dates must both be present and equal.',
      left, right, leftQuote.tradingDate, rightQuote.tradingDate,
    )]
  }
  if (leftQuote.currency === null || rightQuote.currency === null
    || leftQuote.currency !== rightQuote.currency) {
    return [finding(
      'inconclusive', 'currency-mismatch', '$.currency',
      'Quote currencies must both be declared and equal before price or turnover comparison.',
      left, right, leftQuote.currency, rightQuote.currency,
    )]
  }
  if (policy.maxObservationSkewMs !== undefined) {
    if (leftQuote.observationTime === null || rightQuote.observationTime === null) {
      return [finding(
        'inconclusive', 'observation-time-mismatch', '$.observedAt',
        'Quote observation timestamps are required by the configured skew policy.',
        left, right, leftQuote.observationTime, rightQuote.observationTime,
      )]
    }
    const skew = Math.abs(Date.parse(leftQuote.observationTime) - Date.parse(rightQuote.observationTime))
    if (skew > policy.maxObservationSkewMs) {
      return [finding(
        'inconclusive', 'observation-time-mismatch', '$.observedAt',
        `Quote observation timestamps differ by ${skew}ms, exceeding the configured ${policy.maxObservationSkewMs}ms.`,
        left, right, leftQuote.observationTime, rightQuote.observationTime,
      )]
    }
  }

  const findings: ReconciliationFinding[] = []
  let commonPriceValues = 0
  for (const field of [...PRICE_FIELDS, 'volume', 'turnover'] as const) {
    const leftValue = leftQuote.fields[field]
    const rightValue = rightQuote.fields[field]
    if (leftValue === null && rightValue === null) continue
    const tolerance = field === 'volume' ? policy.volume
      : field === 'turnover' ? policy.turnover
        : policy.price
    if (leftValue === null || rightValue === null) {
      findings.push(finding(
        'inconclusive', 'missing-field', `$.${field}`,
        `Quote field ${field} is not available from both sources.`,
        left, right, leftValue, rightValue,
      ))
      continue
    }
    if ((PRICE_FIELDS as readonly string[]).includes(field)) commonPriceValues += 1
    findings.push(numericFinding(`$.${field}`, left, right, leftValue, rightValue, tolerance))
  }
  if (commonPriceValues === 0) {
    findings.push(finding(
      'inconclusive', 'no-common-fields', '$.price',
      'The quote sources expose no common controlled price field.',
      left, right, null, null,
    ))
  }
  return findings
}

function compareBars(
  left: NormalizedSource,
  right: NormalizedSource,
  leftBars: NormalizedBars,
  rightBars: NormalizedBars,
  policy: MarketBarsReconciliationPolicy,
): ReconciliationFinding[] {
  if (leftBars.adjustment === null || rightBars.adjustment === null
    || leftBars.adjustment !== rightBars.adjustment) {
    return [finding(
      'inconclusive', 'adjustment-mismatch', '$.adjustment',
      'Market bars must declare the same adjustment before comparison.',
      left, right, leftBars.adjustment, rightBars.adjustment,
    )]
  }
  if (leftBars.interval === null || rightBars.interval === null
    || leftBars.interval !== rightBars.interval) {
    return [finding(
      'inconclusive', 'interval-mismatch', '$.interval',
      'Market bars must declare the same interval before comparison.',
      left, right, leftBars.interval, rightBars.interval,
    )]
  }
  if (missingOrDifferent(leftBars.currency, rightBars.currency)) {
    return [finding(
      'inconclusive', 'currency-mismatch', '$.currency',
      'Market-bar currencies must both be declared and equal before comparison.',
      left, right, leftBars.currency, rightBars.currency,
    )]
  }
  if (missingOrDifferent(leftBars.unit, rightBars.unit)) {
    return [finding(
      'inconclusive', 'unit-mismatch', '$.unit',
      'Market-bar units must both be declared and equal before comparison.',
      left, right, leftBars.unit, rightBars.unit,
    )]
  }

  const findings: ReconciliationFinding[] = []
  let commonValues = 0
  const dates = sortedUnion(leftBars.bars.keys(), rightBars.bars.keys())
  for (const date of dates) {
    const leftBar = leftBars.bars.get(date)
    const rightBar = rightBars.bars.get(date)
    if (leftBar === undefined || rightBar === undefined) {
      const missingSourceIsComplete = leftBar === undefined
        ? leftBars.truncated === false
        : rightBars.truncated === false
      findings.push(finding(
        missingSourceIsComplete ? 'conflict' : 'inconclusive', 'missing-record', `$.bars[${JSON.stringify(date)}]`,
        missingSourceIsComplete
          ? `Bar key ${date} is absent from a complete source response.`
          : `Bar key ${date} is missing while source completeness is unknown or truncated.`,
        left, right, leftBar?.original ?? null, rightBar?.original ?? null, date, date,
      ))
      continue
    }
    for (const field of [...BAR_PRICE_FIELDS, 'volume', 'turnover'] as const) {
      const leftValue = leftBar.values[field]
      const rightValue = rightBar.values[field]
      if (leftValue === null && rightValue === null) continue
      const path = `$.bars[${JSON.stringify(date)}].${field}`
      if (leftValue === null || rightValue === null) {
        findings.push(finding(
          'inconclusive', 'missing-field', path,
          `Bar field ${field} is not available from both sources for ${date}.`,
          left, right, leftValue, rightValue, date, date,
        ))
        continue
      }
      commonValues += 1
      const tolerance = field === 'volume' ? policy.volume
        : field === 'turnover' ? policy.turnover
          : policy.price
      findings.push(numericFinding(path, left, right, leftValue, rightValue, tolerance, date, date))
    }
  }
  if (commonValues === 0) {
    findings.push(finding(
      'inconclusive', 'no-common-fields', '$.bars',
      'The market-bar sources expose no common date-keyed numeric fields.',
      left, right, null, null,
    ))
  }
  return findings
}

function compareFundamentals(
  left: NormalizedSource,
  right: NormalizedSource,
  leftFundamentals: NormalizedFundamentals,
  rightFundamentals: NormalizedFundamentals,
  policy: FundamentalsReconciliationPolicy,
): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = []
  let commonValues = 0
  const leftByPeriod = groupPeriods(leftFundamentals.periods)
  const rightByPeriod = groupPeriods(rightFundamentals.periods)
  const fiscalPeriods = sortedUnion(leftByPeriod.keys(), rightByPeriod.keys())

  for (const fiscalPeriod of fiscalPeriods) {
    const leftPeriods = leftByPeriod.get(fiscalPeriod) ?? []
    const rightPeriods = rightByPeriod.get(fiscalPeriod) ?? []
    if (leftPeriods.length === 0 || rightPeriods.length === 0) {
      findings.push(finding(
        'inconclusive', 'missing-record', `$.periods[${JSON.stringify(fiscalPeriod)}]`,
        `Fiscal period ${fiscalPeriod} is not available from both sources.`,
        left, right, leftPeriods.map(period => period.original), rightPeriods.map(period => period.original),
        fiscalPeriod === '<missing>' ? null : fiscalPeriod,
        fiscalPeriod === '<missing>' ? null : fiscalPeriod,
      ))
      continue
    }
    const leftByContext = new Map(leftPeriods.filter(hasPeriodKey).map(period => [period.key, period]))
    const rightByContext = new Map(rightPeriods.filter(hasPeriodKey).map(period => [period.key, period]))
    const contexts = sortedUnion(leftByContext.keys(), rightByContext.keys())
    if (contexts.length === 0 || !contexts.some(key => leftByContext.has(key) && rightByContext.has(key))) {
      findings.push(finding(
        'inconclusive', 'period-context-mismatch', `$.periods[${JSON.stringify(fiscalPeriod)}]`,
        'Fundamentals require the same fiscal period, currency, unit, and consolidation scope.',
        left, right, periodContexts(leftPeriods), periodContexts(rightPeriods),
        fiscalPeriod === '<missing>' ? null : fiscalPeriod,
        fiscalPeriod === '<missing>' ? null : fiscalPeriod,
      ))
      continue
    }

    for (const key of contexts) {
      const leftPeriod = leftByContext.get(key)
      const rightPeriod = rightByContext.get(key)
      if (leftPeriod === undefined || rightPeriod === undefined) {
        findings.push(finding(
          'inconclusive', 'period-context-mismatch', `$.periods[${JSON.stringify(fiscalPeriod)}]`,
          'Fundamentals require the same fiscal period, currency, unit, and consolidation scope.',
          left, right, leftPeriod?.original ?? null, rightPeriod?.original ?? null,
          fiscalPeriod === '<missing>' ? null : fiscalPeriod,
          fiscalPeriod === '<missing>' ? null : fiscalPeriod,
        ))
        continue
      }
      for (const field of Object.keys(policy.fields).sort(compareText)) {
        const comparisonContext = fundamentalContext(leftPeriod)
        const leftValue = leftPeriod.fields[field] ?? null
        const rightValue = rightPeriod.fields[field] ?? null
        if (leftValue === null && rightValue === null) continue
        const path = `$.periods[${JSON.stringify([
          comparisonContext.fiscalPeriod, comparisonContext.currency,
          comparisonContext.unit, comparisonContext.scope,
        ])}].fields.${field}`
        if (leftValue === null || rightValue === null) {
          findings.push(finding(
            'inconclusive', 'missing-field', path,
            `Fundamental field ${field} is not available from both sources.`,
            left, right, leftValue, rightValue, fiscalPeriod, fiscalPeriod,
            { context: comparisonContext },
          ))
          continue
        }
        commonValues += 1
        findings.push(numericFinding(
          path, left, right, leftValue, rightValue, policy.fields[field] as FundamentalFieldPolicy,
          fiscalPeriod, fiscalPeriod,
          { context: comparisonContext },
        ))
      }
    }
  }
  if (commonValues === 0) {
    findings.push(finding(
      'inconclusive', 'no-common-fields', '$.periods',
      'The fundamentals sources expose no common explicitly configured numeric fields.',
      left, right, null, null,
    ))
  }
  return findings
}

function compareIndexes(
  left: NormalizedSource,
  right: NormalizedSource,
  leftIndex: NormalizedIndex,
  rightIndex: NormalizedIndex,
  policy: IndexReconciliationPolicy,
): ReconciliationFinding[] {
  if (leftIndex.asOf === null || rightIndex.asOf === null || leftIndex.asOf !== rightIndex.asOf) {
    return [finding(
      'inconclusive', 'source-date-mismatch', '$.asOf',
      'Index snapshots with different source dates are retained but not force-aligned.',
      left, right, leftIndex.asOf, rightIndex.asOf, leftIndex.asOf, rightIndex.asOf,
    )]
  }

  const findings: ReconciliationFinding[] = []
  let commonConstituents = 0
  const identities = sortedUnion(leftIndex.constituents.keys(), rightIndex.constituents.keys())
  for (const identity of identities) {
    const leftConstituent = leftIndex.constituents.get(identity)
    const rightConstituent = rightIndex.constituents.get(identity)
    const path = `$.constituents[${JSON.stringify(identity)}]`
    if (leftConstituent === undefined || rightConstituent === undefined) {
      const missingSourceIsComplete = leftConstituent === undefined
        ? leftIndex.truncated === false
        : rightIndex.truncated === false
      findings.push(finding(
        missingSourceIsComplete ? 'conflict' : 'inconclusive', 'missing-record', path,
        missingSourceIsComplete
          ? `Index constituent ${identity} is absent from a complete same-date snapshot.`
          : `Index constituent ${identity} is missing while source completeness is unknown or truncated.`,
        left, right, leftConstituent?.original ?? null, rightConstituent?.original ?? null,
        leftIndex.asOf, rightIndex.asOf,
      ))
      continue
    }
    commonConstituents += 1
    findings.push(finding(
      'consistent', 'value-match', path,
      `Index constituent ${identity} is present in both sources.`,
      left, right, identity, identity, leftIndex.asOf, rightIndex.asOf,
    ))
    if (leftConstituent.weight === null || rightConstituent.weight === null) {
      findings.push(finding(
        'inconclusive', 'missing-field', `${path}.weight`,
        `Index weight for ${identity} is not available from both sources.`,
        left, right, leftConstituent.weight, rightConstituent.weight,
        leftIndex.asOf, rightIndex.asOf,
      ))
      continue
    }
    findings.push(numericFinding(
      `${path}.weight`, left, right, leftConstituent.weight, rightConstituent.weight, policy.weight,
      leftIndex.asOf, rightIndex.asOf,
    ))
  }
  if (commonConstituents === 0 && findings.every(item => item.status !== 'conflict')) {
    findings.push(finding(
      'inconclusive', 'no-common-fields', '$.constituents',
      'The index sources expose no common constituents.',
      left, right, null, null, leftIndex.asOf, rightIndex.asOf,
    ))
  }
  return findings
}

function normalizePayload(
  capability: ReconciliationCapability,
  result: CanonicalDataResult<unknown>,
  policy: ReconciliationPolicy,
  context: ReconciliationContext,
  provider: string,
): NormalizedPayload {
  if (!isPlainObject(result.data)) throw drift(provider, `${capability} data must be an object`)
  switch (capability) {
    case 'quote':
      return normalizeQuote(result.data, result.provenance, provider)
    case 'market-bars':
      return normalizeBars(result.data, result.provenance, context, provider)
    case 'fundamentals':
      return normalizeFundamentals(
        result.data, result.provenance, policy as FundamentalsReconciliationPolicy, provider,
      )
    case 'index':
      return normalizeIndex(result.data, result.provenance, provider)
  }
}

function normalizeQuote(
  data: Record<string, unknown>,
  provenance: DataProvenance,
  provider: string,
): NormalizedQuote {
  const identity = payloadIdentity(data, provider)
  const tradingDate = compatibleDateCandidates([
    ['tradingDate', data.tradingDate],
    ['observedAt', data.observedAt],
    ['provenance.observedAt', provenance.observedAt],
  ], provider, 'quote trading date')
  const observationTime = compatibleObservationTimeCandidates([
    ['observedAt', data.observedAt],
    ['provenance.observedAt', provenance.observedAt],
  ], provider, 'quote observation time')
  const currency = compatibleStringCandidates([
    ['currency', data.currency],
    ['provenance.currency', provenance.currency],
  ], provider, 'quote currency')
  const nestedFields = data.fields === undefined ? undefined
    : requireRecord(data.fields, provider, 'quote fields')
  return {
    kind: 'quote',
    identity,
    tradingDate,
    observationTime,
    currency,
    fields: Object.fromEntries((Object.keys(QUOTE_ALIASES) as QuoteField[]).map(field => [
      field,
      numericAlias(data, nestedFields, QUOTE_ALIASES[field], provider, `quote.${field}`),
    ])) as unknown as Readonly<Record<QuoteField, number | null>>,
  }
}

function normalizeBars(
  data: Record<string, unknown>,
  provenance: DataProvenance,
  context: ReconciliationContext,
  provider: string,
): NormalizedBars {
  const identity = payloadIdentity(data, provider)
  const interval = compatibleStringCandidates([
    ['interval', data.interval],
    ['request.interval', context.interval],
  ], provider, 'market-bars interval')
  const adjustmentValue = compatibleStringCandidates([
    ['adjustment', data.adjustment],
    ['provenance.adjustment', provenance.adjustment],
    ['request.adjustment', context.adjustment],
  ], provider, 'market-bars adjustment')
  if (adjustmentValue !== null && !ADJUSTMENTS.has(adjustmentValue as AdjustmentMode)) {
    throw drift(provider, `market-bars adjustment is invalid: ${adjustmentValue}`)
  }
  const currency = compatibleStringCandidates([
    ['currency', data.currency],
    ['provenance.currency', provenance.currency],
  ], provider, 'market-bars currency')
  const unit = compatibleStringCandidates([
    ['unit', data.unit],
    ['provenance.unit', provenance.unit],
  ], provider, 'market-bars unit')
  const truncated = optionalBoolean(data.truncated, provider, 'market-bars truncated')
  if (!Array.isArray(data.bars)) throw drift(provider, 'market-bars data.bars must be an array')
  const bars = new Map<string, NormalizedBar>()
  for (const [index, value] of data.bars.entries()) {
    const row = requireRecord(value, provider, `market-bars row ${index}`)
    const rawKey = compatibleStringCandidates([
      ['date', row.date],
      ['observedAt', row.observedAt],
    ], provider, `market-bars row ${index} date key`)
    if (rawKey === null) throw drift(provider, `market-bars row ${index} omits date/observedAt`)
    const key = normalizeBarKey(rawKey, interval, provider, index)
    if (bars.has(key)) throw drift(provider, `market-bars contains duplicate date key ${key}`)
    const values = Object.fromEntries((Object.keys(BAR_ALIASES) as BarField[]).map(field => [
      field, numericAlias(row, undefined, BAR_ALIASES[field], provider, `bar ${key}.${field}`),
    ])) as unknown as Readonly<Record<BarField, number | null>>
    bars.set(key, { key, values, original: clone(row) })
  }
  return {
    kind: 'market-bars',
    identity,
    interval,
    adjustment: adjustmentValue as AdjustmentMode | null,
    currency,
    unit,
    truncated,
    bars,
  }
}

function normalizeFundamentals(
  data: Record<string, unknown>,
  provenance: DataProvenance,
  policy: FundamentalsReconciliationPolicy,
  provider: string,
): NormalizedFundamentals {
  const identity = payloadIdentity(data, provider)
  if (!Array.isArray(data.periods)) throw drift(provider, 'fundamentals data.periods must be an array')
  const periods: NormalizedFundamentalPeriod[] = []
  const keys = new Set<string>()
  for (const [index, value] of data.periods.entries()) {
    const period = requireRecord(value, provider, `fundamentals period ${index}`)
    const fiscalPeriod = compatibleDateCandidates([
      ['fiscalPeriod', period.fiscalPeriod],
    ], provider, `fundamentals period ${index} fiscalPeriod`)
    const currency = compatibleStringCandidates([
      ['currency', period.currency],
      ['provenance.currency', provenance.currency],
    ], provider, `fundamentals period ${index} currency`)
    const unit = compatibleStringCandidates([
      ['unit', period.unit],
      ['provenance.unit', provenance.unit],
    ], provider, `fundamentals period ${index} unit`)
    const scope = compatibleStringCandidates([
      ['scope', period.scope],
      ['consolidationScope', period.consolidationScope],
    ], provider, `fundamentals period ${index} scope`)
    const fieldData = requireRecord(period.fields, provider, `fundamentals period ${index} fields`)
    const fields: Record<string, number | null> = {}
    for (const canonicalField of Object.keys(policy.fields).sort(compareText)) {
      const fieldPolicy = policy.fields[canonicalField] as FundamentalFieldPolicy
      fields[canonicalField] = numericAlias(
        fieldData, undefined, [canonicalField, ...(fieldPolicy.aliases ?? [])],
        provider, `fundamentals.${canonicalField}`,
      )
    }
    const key = fiscalPeriod === null || currency === null || unit === null || scope === null
      ? null
      : JSON.stringify([fiscalPeriod, currency, unit, scope])
    if (key !== null && keys.has(key)) throw drift(provider, `fundamentals contains duplicate context ${key}`)
    if (key !== null) keys.add(key)
    periods.push({
      fiscalPeriod, currency, unit, scope, key, fields, original: clone(period),
    })
  }
  periods.sort((left, right) => compareText(periodSortKey(left), periodSortKey(right)))
  return { kind: 'fundamentals', identity, periods }
}

function normalizeIndex(
  data: Record<string, unknown>,
  provenance: DataProvenance,
  provider: string,
): NormalizedIndex {
  const identity = payloadIdentity(data, provider)
  const asOf = compatibleDateCandidates([
    ['asOf', data.asOf],
    ['sourceDate', data.sourceDate],
    ['provenance.observedAt', provenance.observedAt],
  ], provider, 'index source date')
  const truncated = optionalBoolean(data.truncated, provider, 'index truncated')
  if (!Array.isArray(data.constituents)) throw drift(provider, 'index data.constituents must be an array')
  const constituents = new Map<string, NormalizedIndexConstituent>()
  for (const [index, value] of data.constituents.entries()) {
    const constituent = requireRecord(value, provider, `index constituent ${index}`)
    const instrument = requireRecord(constituent.instrument, provider, `index constituent ${index}.instrument`)
    const constituentIdentity = safeCanonicalIdentity(instrument as unknown as InstrumentId, provider)
    if (constituents.has(constituentIdentity)) {
      throw drift(provider, `index contains duplicate constituent ${constituentIdentity}`)
    }
    constituents.set(constituentIdentity, {
      identity: constituentIdentity,
      weight: numericAlias(
        constituent, undefined, ['weight', 'weightPercent'], provider,
        `index constituent ${constituentIdentity}.weight`,
      ),
      original: clone(constituent),
    })
  }
  return { kind: 'index', identity, asOf, truncated, constituents }
}

function validateCanonicalResult(
  value: unknown,
  provider: string,
): CanonicalDataResult<unknown> {
  try {
    assertJsonSafe(value)
  } catch (error) {
    throw drift(provider, 'canonical result is not JSON-safe', error)
  }
  if (containsUnsupportedValue(value)) {
    throw drift(provider, 'canonical result contains an unsupported JSON value or object shape')
  }
  if (!isPlainObject(value)) throw drift(provider, 'canonical result must be an object')
  if (!DATA_STATUSES.includes(value.status as DataStatus)) throw drift(provider, 'canonical result status is invalid')
  if (!Object.hasOwn(value, 'data') || value.data === undefined) {
    throw drift(provider, 'canonical result must include data as a value or null')
  }
  if (!Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string')) {
    throw drift(provider, 'canonical result warnings must be strings')
  }
  if (!isPlainObject(value.provenance)) throw drift(provider, 'canonical result provenance must be an object')
  const provenance = value.provenance
  if (typeof provenance.provider !== 'string' || provenance.provider !== provider
    || typeof provenance.actualProvider !== 'string' || provenance.actualProvider !== provider
    || typeof provenance.upstreamSource !== 'string' || provenance.upstreamSource.trim() === ''
    || !SOURCE_KINDS.includes(provenance.sourceKind as DataProvenance['sourceKind'])
    || typeof provenance.fetchedAt !== 'string' || !Number.isFinite(Date.parse(provenance.fetchedAt))
    || !Array.isArray(provenance.fallbackChain)) {
    throw drift(provider, 'canonical result has incomplete or mismatched provenance')
  }
  if (provenance.fallbackChain.some(attempt => !isPlainObject(attempt)
    || typeof attempt.provider !== 'string' || attempt.provider.trim() === ''
    || typeof attempt.outcome !== 'string' || attempt.outcome.trim() === ''
    || (attempt.reason !== undefined && typeof attempt.reason !== 'string'))) {
    throw drift(provider, 'canonical result fallbackChain is invalid')
  }
  for (const [name, timestamp] of [
    ['observedAt', provenance.observedAt],
    ['publishedAt', provenance.publishedAt],
    ['availableAt', provenance.availableAt],
  ] as const) {
    if (timestamp !== undefined && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))) {
      throw drift(provider, `canonical result provenance.${name} is invalid`)
    }
  }
  if (provenance.adjustment !== undefined) {
    if (typeof provenance.adjustment !== 'string'
      || !ADJUSTMENTS.has(provenance.adjustment as AdjustmentMode)) {
      throw drift(provider, 'canonical result provenance.adjustment is invalid')
    }
  }
  if (provenance.derived !== undefined
    && (!isPlainObject(provenance.derived)
      || !Array.isArray(provenance.derived.inputRefs)
      || provenance.derived.inputRefs.some(reference => typeof reference !== 'string' || reference.trim() === '')
      || typeof provenance.derived.algorithm !== 'string' || provenance.derived.algorithm.trim() === ''
      || typeof provenance.derived.algorithmVersion !== 'string'
      || provenance.derived.algorithmVersion.trim() === ''
      || (provenance.derived.methodology !== undefined
        && typeof provenance.derived.methodology !== 'string'))) {
    throw drift(provider, 'canonical result derived provenance is invalid')
  }
  if (value.status === 'available' && value.data === null) {
    throw drift(provider, 'canonical result has null data with available status')
  }
  return value as unknown as CanonicalDataResult<unknown>
}

function assertPolicy(capability: ReconciliationCapability, policy: ReconciliationPolicy): void {
  if (!isPlainObject(policy)) throw invalid('reconciliation policy must be an object')
  if (policy.capability !== capability) {
    throw invalid(`reconciliation policy capability must be ${capability}`)
  }
  if (capability === 'quote' || capability === 'market-bars') {
    assertExactObject(
      policy,
      capability === 'quote'
        ? ['capability', 'price', 'volume', 'turnover', 'maxObservationSkewMs']
        : ['capability', 'price', 'volume', 'turnover'],
      `${capability} policy`,
      invalid,
    )
    validateTolerance(policy.price, `${capability}.price`)
    validateTolerance(policy.volume, `${capability}.volume`)
    validateTolerance(policy.turnover, `${capability}.turnover`)
    if (capability === 'quote' && policy.maxObservationSkewMs !== undefined) {
      const skew = policy.maxObservationSkewMs
      if (typeof skew !== 'number' || !Number.isSafeInteger(skew) || skew < 0) {
        throw invalid('quote.maxObservationSkewMs must be a non-negative safe integer')
      }
    }
    return
  }
  if (capability === 'index') {
    assertExactObject(policy, ['capability', 'weight'], 'index policy', invalid)
    validateTolerance(policy.weight, 'index.weight')
    return
  }
  assertExactObject(policy, ['capability', 'fields'], 'fundamentals policy', invalid)
  if (!isPlainObject(policy.fields) || Object.keys(policy.fields).length === 0) {
    throw invalid('fundamentals policy requires at least one explicit field policy')
  }
  const aliases = new Map<string, string>()
  for (const [field, fieldPolicy] of Object.entries(policy.fields)) {
    if (!validFieldName(field)) throw invalid(`invalid canonical fundamentals field: ${field}`)
    if (!isPlainObject(fieldPolicy)) throw invalid(`fundamentals field policy ${field} must be an object`)
    assertExactObject(fieldPolicy, ['absolute', 'relative', 'aliases'], `fundamentals field policy ${field}`, invalid)
    validateToleranceFields(fieldPolicy, `fundamentals.${field}`)
    const fieldAliases = fieldPolicy.aliases
    if (fieldAliases !== undefined && (!Array.isArray(fieldAliases)
      || fieldAliases.some(alias => typeof alias !== 'string' || !validFieldName(alias)))) {
      throw invalid(`fundamentals aliases for ${field} must be safe field names`)
    }
    for (const alias of [field, ...(fieldAliases ?? [])]) {
      const owner = aliases.get(alias)
      if (owner !== undefined && owner !== field) {
        throw invalid(`fundamentals alias ${alias} is assigned to both ${owner} and ${field}`)
      }
      aliases.set(alias, field)
    }
  }
}

function validateTolerance(value: unknown, label: string): asserts value is NumericTolerance {
  if (!isPlainObject(value)) throw invalid(`${label} tolerance must be an object`)
  assertExactObject(value, ['absolute', 'relative'], `${label} tolerance`, invalid)
  validateToleranceFields(value, label)
}

function validateToleranceFields(value: Record<string, unknown>, label: string): void {
  if (typeof value.absolute !== 'number' || !Number.isFinite(value.absolute) || value.absolute < 0
    || typeof value.relative !== 'number' || !Number.isFinite(value.relative) || value.relative < 0) {
    throw invalid(`${label} tolerance requires non-negative finite absolute and relative values`)
  }
}

function normalizeContext(value: ReconciliationContext | undefined): ReconciliationContext {
  if (value === undefined) return {}
  assertExactObject(value, ['instrument', 'interval', 'adjustment'], 'reconciliation context', invalid)
  if (value.instrument !== undefined) {
    if (!isPlainObject(value.instrument)) throw invalid('reconciliation context instrument must be an object')
    safeCanonicalIdentity(value.instrument as unknown as InstrumentId, 'context')
  }
  if (value.interval !== undefined && (typeof value.interval !== 'string' || value.interval.trim() === '')) {
    throw invalid('reconciliation context interval must be a non-empty string')
  }
  if (value.adjustment !== undefined) {
    if (typeof value.adjustment !== 'string' || !ADJUSTMENTS.has(value.adjustment as AdjustmentMode)) {
      throw invalid('reconciliation context adjustment must be none, qfq, or hfq')
    }
  }
  return clone(value)
}

function payloadIdentity(data: Record<string, unknown>, provider: string): string {
  const instrument = requireRecord(data.instrument, provider, 'data.instrument')
  return safeCanonicalIdentity(instrument as unknown as InstrumentId, provider)
}

function safeCanonicalIdentity(instrument: InstrumentId, source: string): string {
  try {
    return canonicalInstrumentId(instrument)
  } catch (error) {
    if (source === 'context') {
      throw new FinanceDataError('reconciliation context instrument is invalid', 'invalid-request', {
        retryable: false, cause: error,
      })
    }
    throw drift(source, 'payload instrument is invalid', error)
  }
}

function numericAlias(
  direct: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
  aliases: readonly string[],
  provider: string,
  label: string,
): number | null {
  const values: number[] = []
  for (const alias of aliases) {
    if (Object.hasOwn(direct, alias)) {
      const value = numericValue(direct[alias], provider, `${label} (${alias})`)
      if (value !== null) values.push(value)
    }
    if (nested !== undefined && Object.hasOwn(nested, alias)) {
      const value = numericValue(nested[alias], provider, `${label} (fields.${alias})`)
      if (value !== null) values.push(value)
    }
  }
  if (values.length === 0) return null
  const first = values[0] as number
  if (values.some(value => !Object.is(value, first))) {
    throw drift(provider, `${label} has conflicting explicit aliases`)
  }
  return first
}

function numericValue(value: unknown, provider: string, label: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw drift(provider, `${label} must be finite`)
    return value
  }
  if (isPlainObject(value) && typeof value.status === 'string' && Object.hasOwn(value, 'value')) {
    if (!DATA_STATUSES.includes(value.status as DataStatus)) {
      throw drift(provider, `${label} canonical data field has an invalid status`)
    }
    if (value.status !== 'available' && value.status !== 'partial' && value.status !== 'stale') return null
    if (value.value === null) return null
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
      throw drift(provider, `${label} available field value must be a finite number`)
    }
    return value.value
  }
  throw drift(provider, `${label} must be a finite number, null, or canonical data field`)
}

function compatibleDateCandidates(
  candidates: readonly (readonly [string, unknown])[],
  provider: string,
  label: string,
): string | null {
  const dates: string[] = []
  for (const [name, value] of candidates) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw drift(provider, `${label} alias ${name} must be a string`)
    dates.push(datePart(value, provider, `${label} alias ${name}`))
  }
  if (dates.length === 0) return null
  const first = dates[0] as string
  if (dates.some(date => date !== first)) throw drift(provider, `${label} aliases disagree`)
  return first
}

function compatibleStringCandidates(
  candidates: readonly (readonly [string, unknown])[],
  provider: string,
  label: string,
): string | null {
  const values: string[] = []
  for (const [name, value] of candidates) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || value.trim() === '') {
      throw drift(provider, `${label} alias ${name} must be a non-empty string`)
    }
    values.push(value.trim())
  }
  if (values.length === 0) return null
  const first = values[0] as string
  if (values.some(value => value !== first)) throw drift(provider, `${label} aliases disagree`)
  return first
}

function compatibleObservationTimeCandidates(
  candidates: readonly (readonly [string, unknown])[],
  provider: string,
  label: string,
): string | null {
  const values: string[] = []
  let hasDateOnlyValue = false
  for (const [name, value] of candidates) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      throw drift(provider, `${label} alias ${name} must be an ISO timestamp`)
    }
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      datePart(value, provider, `${label} alias ${name}`)
      hasDateOnlyValue = true
      continue
    }
    if (!isIsoTimestamp(value)) throw drift(provider, `${label} alias ${name} must be an ISO timestamp`)
    values.push(new Date(value).toISOString())
  }
  if (values.length === 0 || hasDateOnlyValue) return null
  const first = values[0] as string
  if (values.some(value => value !== first)) throw drift(provider, `${label} aliases disagree`)
  return first
}

function optionalBoolean(value: unknown, provider: string, label: string): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw drift(provider, `${label} must be boolean when present`)
  return value
}

function datePart(value: string, provider: string, label: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/u.exec(value)
  const date = match?.[1]
  if (date === undefined
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    || (value !== date && !isIsoTimestamp(value))) {
    throw drift(provider, `${label} must be an ISO date or timestamp`)
  }
  return date
}

function normalizeBarKey(
  value: string,
  interval: string | null,
  provider: string,
  index: number,
): string {
  if (interval === null) {
    return value.includes('T')
      ? normalizeTimestamp(value, provider, `market-bars row ${index} date key`)
      : datePart(value, provider, `market-bars row ${index} date key`)
  }
  if (interval === '1d' || interval === '1w' || interval === '1mo') {
    return datePart(value, provider, `market-bars row ${index} date key`)
  }
  return normalizeTimestamp(value, provider, `intraday market-bars row ${index} date key`)
}

function normalizeTimestamp(value: string, provider: string, label: string): string {
  if (!isIsoTimestamp(value)) throw drift(provider, `${label} must be an ISO timestamp`)
  return new Date(Date.parse(value)).toISOString()
}

function numericFinding(
  path: string,
  left: NormalizedSource,
  right: NormalizedSource,
  leftValue: number,
  rightValue: number,
  tolerance: NumericTolerance,
  leftDate: string | null = left.sourceDate,
  rightDate: string | null = right.sourceDate,
  extras: Pick<ReconciliationFinding, 'context'> = {},
): ReconciliationFinding {
  const absolute = Math.abs(leftValue - rightValue)
  const scale = Math.max(Math.abs(leftValue), Math.abs(rightValue))
  const relative = scale === 0 ? 0 : absolute / scale
  const allowed = Math.max(tolerance.absolute, tolerance.relative * scale)
  const consistent = absolute <= allowed
  return finding(
    consistent ? 'consistent' : 'conflict',
    consistent ? 'value-match' : 'value-mismatch',
    path,
    consistent
      ? `Values are within the configured tolerance for ${path}.`
      : `Values exceed the configured tolerance for ${path}.`,
    left, right, leftValue, rightValue, leftDate, rightDate,
    { ...extras, tolerance: clone(tolerance), difference: { absolute, relative, allowed } },
  )
}

function finding(
  status: ReconciliationStatus,
  code: ReconciliationFindingCode,
  path: string,
  reason: string,
  left: NormalizedSource,
  right: NormalizedSource,
  leftValue: unknown | null,
  rightValue: unknown | null,
  leftDate: string | null = left.sourceDate,
  rightDate: string | null = right.sourceDate,
  extras: Pick<ReconciliationFinding, 'tolerance' | 'difference' | 'context'> = {},
): ReconciliationFinding {
  return {
    status, code, path, reason,
    left: {
      provider: left.provider,
      value: clone(leftValue),
      sourceDate: leftDate,
      provenance: clone(left.result.provenance),
    },
    right: {
      provider: right.provider,
      value: clone(rightValue),
      sourceDate: rightDate,
      provenance: clone(right.result.provenance),
    },
    ...extras,
  }
}

function payloadSourceDate(payload: NormalizedPayload | null): string | null {
  if (payload === null) return null
  switch (payload.kind) {
    case 'quote': return payload.tradingDate
    case 'market-bars': return [...payload.bars.keys()].sort(compareText).at(-1) ?? null
    case 'fundamentals': return payload.periods
      .map(period => period.fiscalPeriod)
      .filter((value): value is string => value !== null)
      .sort(compareText)
      .at(-1) ?? null
    case 'index': return payload.asOf
  }
}

function groupPeriods(
  periods: readonly NormalizedFundamentalPeriod[],
): Map<string, NormalizedFundamentalPeriod[]> {
  const grouped = new Map<string, NormalizedFundamentalPeriod[]>()
  for (const period of periods) {
    const key = period.fiscalPeriod ?? '<missing>'
    const current = grouped.get(key) ?? []
    current.push(period)
    grouped.set(key, current)
  }
  return grouped
}

function hasPeriodKey(
  period: NormalizedFundamentalPeriod,
): period is NormalizedFundamentalPeriod & { key: string } {
  return period.key !== null
}

function periodContexts(periods: readonly NormalizedFundamentalPeriod[]): unknown[] {
  return periods.map(period => ({
    fiscalPeriod: period.fiscalPeriod,
    currency: period.currency,
    unit: period.unit,
    scope: period.scope,
  }))
}

function fundamentalContext(
  period: NormalizedFundamentalPeriod & { key: string },
): Readonly<Record<string, string>> {
  return {
    fiscalPeriod: period.fiscalPeriod as string,
    currency: period.currency as string,
    unit: period.unit as string,
    scope: period.scope as string,
  }
}

function periodSortKey(period: NormalizedFundamentalPeriod): string {
  return JSON.stringify([period.fiscalPeriod, period.currency, period.unit, period.scope])
}

function compareFindings(left: ReconciliationFinding, right: ReconciliationFinding): number {
  return compareText(left.left.provider, right.left.provider)
    || compareText(left.right.provider, right.right.provider)
    || compareText(left.path, right.path)
    || compareText(left.code, right.code)
    || compareText(left.status, right.status)
}

function sortedUnion(left: Iterable<string>, right: Iterable<string>): string[] {
  return [...new Set([...left, ...right])].sort(compareText)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function missingOrDifferent(left: string | null, right: string | null): boolean {
  return left === null || right === null || left !== right
}

function normalizedUpstream(value: string): string {
  return value.trim().toLowerCase()
}

function independentSources(left: NormalizedSource, right: NormalizedSource): boolean {
  const leftIdentities = sourceIdentityTokens(left)
  const rightIdentities = sourceIdentityTokens(right)
  if ([...leftIdentities].some(identity => rightIdentities.has(identity))) return false
  const leftInputs = lineageReferences(left.result.provenance)
  const rightInputs = lineageReferences(right.result.provenance)
  if ((left.result.provenance.sourceKind === 'derived' && leftInputs.size === 0)
    || (right.result.provenance.sourceKind === 'derived' && rightInputs.size === 0)) return false
  if ([...rightInputs].some(reference => [...leftIdentities].some(identity => (
    lineageRefMatchesIdentity(reference, identity)
  )))) return false
  if ([...leftInputs].some(reference => [...rightIdentities].some(identity => (
    lineageRefMatchesIdentity(reference, identity)
  )))) return false
  return ![...leftInputs].some(reference => rightInputs.has(reference))
}

function sourceIdentityTokens(source: NormalizedSource): ReadonlySet<string> {
  return new Set([source.provider, source.result.provenance.upstreamSource].map(normalizedUpstream))
}

function lineageReferences(provenance: DataProvenance): ReadonlySet<string> {
  return new Set((provenance.derived?.inputRefs ?? [])
    .map(normalizedLineageReference)
    .filter(reference => reference !== ''))
}

function normalizedLineageReference(reference: string): string {
  const normalized = reference.trim().toLowerCase()
  return normalized.startsWith('provider:')
    ? normalized.slice('provider:'.length)
    : normalized.startsWith('upstream-source:')
      ? normalized.slice('upstream-source:'.length)
      : normalized
}

function lineageRefMatchesIdentity(reference: string, identity: string): boolean {
  return reference === identity
    || reference === `provider:${identity}`
    || reference === `upstream-source:${identity}`
    || reference.startsWith(`${identity}:`)
}

function isIsoTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (match === null || !Number.isFinite(Date.parse(value))) return false
  const date = match[1] as string
  return Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}

function normalizeError(error: unknown): ReconciliationSourceError {
  return {
    kind: dataErrorKind(error),
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1_024),
    retryable: isRetryableDataError(error),
  }
}

function requireRecord(value: unknown, provider: string, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw drift(provider, `${label} must be an object`)
  return value
}

function validFieldName(value: string): boolean {
  return /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{0,127}$/u.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function containsUnsupportedValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return true
  }
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.some(item => containsUnsupportedValue(item, seen))
  if (!isPlainObject(value)) return true
  return Object.entries(value).some(([key, child]) => (
    key === '__proto__' || key === 'prototype' || key === 'constructor'
      || containsUnsupportedValue(child, seen)
  ))
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
  fail: (message: string) => never,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be an object`)
  const allowed = new Set(keys)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.has(key)) fail(`${label} contains unknown property ${key}`)
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function invalid(message: string): never {
  throw new FinanceDataError(message, 'invalid-request', { retryable: false })
}

function drift(provider: string, message: string, cause?: unknown): FinanceDataError {
  return new FinanceDataError(`provider ${provider} returned invalid reconciliation data: ${message}`, 'schema-drift', {
    provider,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })
}
