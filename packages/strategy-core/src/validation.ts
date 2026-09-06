import type { InstrumentId } from '@finance2dsh/core'
import {
  BACKTEST_ENGINE_TIERS,
  BACKTEST_RUN_STATUSES,
  EXECUTION_CONFIRMATION_TIMES,
  EXECUTION_EARLIEST_FILL_TIMES,
  EXECUTION_PRICE_FIELDS,
  QUANT_RESULT_STATUSES,
  STRATEGY_RESEARCH_STATUSES,
  type BacktestRun,
  type CanonicalBar,
  type ExecutionDefinition,
  type JsonObject,
  type ScreenerMatch,
  type ScreenerDefinition,
  type SignalObservation,
  type StrategyDefinition,
  type StrategyParameterSpec,
  type StrategyRunInput,
  type StrategySpec,
} from './contracts.js'
import {
  backtestRunId,
  canonicalJson,
  configHash,
  isStableHash,
  signalObservationId,
} from './identity.js'

export type StrategyValidationCode =
  | 'invalid-type'
  | 'unknown-field'
  | 'missing-field'
  | 'invalid-value'
  | 'invalid-time'
  | 'future-time'
  | 'non-finite-number'
  | 'invalid-bar-order'
  | 'invalid-signal-order'
  | 'invalid-position-transition'
  | 'unknown-execution-definition'
  | 'identity-mismatch'
  | 'duplicate-parameter'

export interface StrategyValidationIssue {
  readonly code: StrategyValidationCode
  readonly path: string
  readonly message: string
}

export type StrategyValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly StrategyValidationIssue[] }

export class StrategyValidationError extends TypeError {
  readonly issues: readonly StrategyValidationIssue[]

  constructor(message: string, issues: readonly StrategyValidationIssue[]) {
    super(message)
    this.name = 'StrategyValidationError'
    this.issues = issues
  }
}

type MutableIssues = StrategyValidationIssue[]
type UnknownRecord = Record<string, unknown>

function issue(issues: MutableIssues, code: StrategyValidationCode, path: string, message: string): void {
  issues.push({ code, path, message })
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: MutableIssues,
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issue(issues, 'unknown-field', `${path}.${key}`, `unknown field ${key}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) issue(issues, 'missing-field', `${path}.${key}`, `missing field ${key}`)
  }
}

function nonEmptyString(value: unknown, path: string, issues: MutableIssues, max = 2_048): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    issue(issues, 'invalid-value', path, `must be a non-empty string of at most ${max} characters`)
    return false
  }
  return true
}

function finiteNumber(value: unknown, path: string, issues: MutableIssues): value is number {
  if (typeof value !== 'number') {
    issue(issues, 'invalid-type', path, 'must be a number')
    return false
  }
  if (!Number.isFinite(value)) {
    issue(issues, 'non-finite-number', path, 'must be finite')
    return false
  }
  return true
}

function nullableFiniteNumber(value: unknown, path: string, issues: MutableIssues): value is number | null {
  return value === null || finiteNumber(value, path, issues)
}

function timestamp(value: unknown, path: string, issues: MutableIssues): value is string {
  const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/
  const match = typeof value === 'string' ? rfc3339.exec(value) : null
  const year = Number(match?.[1])
  const month = Number(match?.[2])
  const day = Number(match?.[3])
  const hour = Number(match?.[4])
  const minute = Number(match?.[5])
  const second = Number(match?.[6])
  const offsetHour = Number(match?.[7] ?? 0)
  const offsetMinute = Number(match?.[8] ?? 0)
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0
  if (match === null || year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
    || !Number.isFinite(Date.parse(value as string))) {
    issue(issues, 'invalid-time', path, 'must be an RFC 3339 timestamp with an explicit timezone')
    return false
  }
  return true
}

function stringArray(value: unknown, path: string, issues: MutableIssues, allowEmpty: boolean): value is string[] {
  if (!Array.isArray(value)) {
    issue(issues, 'invalid-type', path, 'must be an array')
    return false
  }
  if (!allowEmpty && value.length === 0) issue(issues, 'invalid-value', path, 'must not be empty')
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      issue(issues, 'invalid-value', `${path}[${index}]`, 'must not be a sparse array entry')
      continue
    }
    nonEmptyString(value[index], `${path}[${index}]`, issues)
  }
  return true
}

function stableHash(value: unknown, path: string, issues: MutableIssues): value is string {
  if (!isStableHash(value)) {
    issue(issues, 'invalid-value', path, 'must be a sha256:<64 lowercase hex> hash')
    return false
  }
  return true
}

function jsonValue(value: unknown, path: string, issues: MutableIssues, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return finiteNumber(value, path, issues)
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      issue(issues, 'invalid-value', path, 'must not contain cycles')
      return false
    }
    const next = new Set(ancestors).add(value)
    let valid = true
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        issue(issues, 'invalid-value', `${path}[${index}]`, 'must not be a sparse array entry')
        valid = false
        continue
      }
      valid = jsonValue(value[index], `${path}[${index}]`, issues, next) && valid
    }
    return valid
  }
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', path, 'must be JSON-safe')
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    issue(issues, 'invalid-type', path, 'must be a plain JSON object')
    return false
  }
  if (ancestors.has(value)) {
    issue(issues, 'invalid-value', path, 'must not contain cycles')
    return false
  }
  const next = new Set(ancestors).add(value)
  return Object.entries(value).map(([key, item]) => jsonValue(item, `${path}.${key}`, issues, next)).every(Boolean)
}

function instrument(value: unknown, path: string, issues: MutableIssues): value is InstrumentId {
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', path, 'must be an InstrumentId object')
    return false
  }
  exactKeys(value, ['market', 'exchange', 'symbol', 'assetType'], ['market', 'exchange', 'symbol', 'assetType'], path, issues)
  return ['market', 'exchange', 'symbol', 'assetType']
    .map(key => nonEmptyString(value[key], `${path}.${key}`, issues, 32)).every(Boolean)
}

function parameter(value: unknown, index: number, issues: MutableIssues): value is StrategyParameterSpec {
  const path = `$.parameters[${index}]`
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', path, 'must be a parameter object')
    return false
  }
  const base = ['key', 'type', 'default', 'description']
  const required = ['key', 'type', 'default']
  nonEmptyString(value.key, `${path}.key`, issues, 64)
  if (value.description !== undefined) nonEmptyString(value.description, `${path}.description`, issues)
  if (value.type === 'number') {
    exactKeys(value, [...base, 'min', 'max', 'step', 'integer'], [...required, 'min', 'max'], path, issues)
    const validDefault = finiteNumber(value.default, `${path}.default`, issues)
    const validMin = finiteNumber(value.min, `${path}.min`, issues)
    const validMax = finiteNumber(value.max, `${path}.max`, issues)
    const defaultValue = value.default
    const minValue = value.min
    const maxValue = value.max
    if (validMin && validMax && (minValue as number) >= (maxValue as number)) {
      issue(issues, 'invalid-value', path, 'min must be less than max')
    }
    if (validDefault && validMin && validMax
      && ((defaultValue as number) < (minValue as number) || (defaultValue as number) > (maxValue as number))) {
      issue(issues, 'invalid-value', `${path}.default`, 'must lie within [min, max]')
    }
    if (value.step !== undefined && (!finiteNumber(value.step, `${path}.step`, issues) || value.step <= 0)) {
      issue(issues, 'invalid-value', `${path}.step`, 'must be greater than zero')
    }
    if (value.integer !== undefined && typeof value.integer !== 'boolean') {
      issue(issues, 'invalid-type', `${path}.integer`, 'must be boolean')
    }
    if (value.integer === true && validDefault && !Number.isInteger(value.default)) {
      issue(issues, 'invalid-value', `${path}.default`, 'must be an integer')
    }
    return true
  }
  if (value.type === 'boolean') {
    exactKeys(value, base, required, path, issues)
    if (typeof value.default !== 'boolean') issue(issues, 'invalid-type', `${path}.default`, 'must be boolean')
    return true
  }
  if (value.type === 'string') {
    exactKeys(value, [...base, 'allowedValues'], [...required, 'allowedValues'], path, issues)
    const validDefault = nonEmptyString(value.default, `${path}.default`, issues)
    const validAllowed = stringArray(value.allowedValues, `${path}.allowedValues`, issues, false)
    const defaultValue = value.default
    const allowedValues = value.allowedValues
    if (validDefault && validAllowed && !(allowedValues as string[]).includes(defaultValue as string)) {
      issue(issues, 'invalid-value', `${path}.default`, 'must be one of allowedValues')
    }
    if (validAllowed && new Set(allowedValues as string[]).size !== (allowedValues as string[]).length) {
      issue(issues, 'invalid-value', `${path}.allowedValues`, 'must not contain duplicates')
    }
    return true
  }
  issue(issues, 'invalid-value', `${path}.type`, 'must be number, boolean, or string')
  return false
}

function result<T>(value: unknown, issues: MutableIssues): StrategyValidationResult<T> {
  return issues.length === 0
    ? { ok: true, value: value as T }
    : { ok: false, issues }
}

function assertResult<T>(label: string, checked: StrategyValidationResult<T>): asserts checked is { ok: true; value: T } {
  if (!checked.ok) throw new StrategyValidationError(`${label} validation failed`, checked.issues)
}

export function validateStrategySpec(value: unknown): StrategyValidationResult<StrategySpec> {
  const issues: MutableIssues = []
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be a StrategySpec object')
    return result(value, issues)
  }
  exactKeys(
    value,
    ['id', 'version', 'horizon', 'economicAssumption', 'failureConditions', 'parameters', 'researchStatus'],
    ['id', 'version', 'horizon', 'economicAssumption', 'failureConditions', 'parameters', 'researchStatus'],
    '$', issues,
  )
  if (nonEmptyString(value.id, '$.id', issues, 96)
    && !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value.id)) {
    issue(issues, 'invalid-value', '$.id', 'must use a stable lowercase dotted, dashed, or underscored id')
  }
  if (nonEmptyString(value.version, '$.version', issues, 64)
    && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    issue(issues, 'invalid-value', '$.version', 'must be a semantic version')
  }
  if (!isRecord(value.horizon)) {
    issue(issues, 'invalid-type', '$.horizon', 'must be a horizon object')
  } else {
    exactKeys(value.horizon, ['unit', 'min', 'max'], ['unit', 'min', 'max'], '$.horizon', issues)
    if (!['bars', 'trading-days', 'calendar-days'].includes(String(value.horizon.unit))) {
      issue(issues, 'invalid-value', '$.horizon.unit', 'has an unknown horizon unit')
    }
    const min = finiteNumber(value.horizon.min, '$.horizon.min', issues)
    const max = finiteNumber(value.horizon.max, '$.horizon.max', issues)
    const minValue = value.horizon.min
    const maxValue = value.horizon.max
    if (min && (!Number.isInteger(minValue) || (minValue as number) <= 0)) {
      issue(issues, 'invalid-value', '$.horizon.min', 'must be a positive integer')
    }
    if (max && (!Number.isInteger(maxValue) || (maxValue as number) <= 0)) {
      issue(issues, 'invalid-value', '$.horizon.max', 'must be a positive integer')
    }
    if (min && max && (minValue as number) > (maxValue as number)) {
      issue(issues, 'invalid-value', '$.horizon', 'min must not exceed max')
    }
  }
  nonEmptyString(value.economicAssumption, '$.economicAssumption', issues)
  stringArray(value.failureConditions, '$.failureConditions', issues, false)
  if (!Array.isArray(value.parameters)) {
    issue(issues, 'invalid-type', '$.parameters', 'must be an array')
  } else {
    value.parameters.forEach((item, index) => parameter(item, index, issues))
    const keys = value.parameters.filter(isRecord).map(item => item.key).filter((key): key is string => typeof key === 'string')
    for (const key of new Set(keys)) {
      if (keys.filter(candidate => candidate === key).length > 1) {
        issue(issues, 'duplicate-parameter', '$.parameters', `duplicate parameter key ${key}`)
      }
    }
  }
  if (!STRATEGY_RESEARCH_STATUSES.includes(value.researchStatus as never)) {
    issue(issues, 'invalid-value', '$.researchStatus', 'has an unknown research status')
  }
  return result(value, issues)
}

export function assertStrategySpec(value: unknown): asserts value is StrategySpec {
  const checked = validateStrategySpec(value)
  assertResult('StrategySpec', checked)
}

export function validateStrategyDefinition(value: unknown): StrategyValidationResult<StrategyDefinition> {
  const issues: MutableIssues = []
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be a StrategyDefinition object')
    return result(value, issues)
  }
  exactKeys(value, ['kind', 'spec', 'executionDefinitionId', 'evaluate'],
    ['kind', 'spec', 'executionDefinitionId', 'evaluate'], '$', issues)
  if (value.kind !== 'strategy') issue(issues, 'invalid-value', '$.kind', 'must be strategy')
  const checkedSpec = validateStrategySpec(value.spec)
  if (!checkedSpec.ok) {
    issues.push(...checkedSpec.issues.map(item => ({ ...item, path: `$.spec${item.path.slice(1)}` })))
  }
  nonEmptyString(value.executionDefinitionId, '$.executionDefinitionId', issues, 96)
  if (typeof value.evaluate !== 'function') issue(issues, 'invalid-type', '$.evaluate', 'must be a function')
  return result(value, issues)
}

export function assertStrategyDefinition(value: unknown): asserts value is StrategyDefinition {
  const checked = validateStrategyDefinition(value)
  assertResult('StrategyDefinition', checked)
}

export function validateScreenerDefinition(value: unknown): StrategyValidationResult<ScreenerDefinition> {
  const issues: MutableIssues = []
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be a ScreenerDefinition object')
    return result(value, issues)
  }
  exactKeys(value, ['kind', 'spec', 'evaluate'], ['kind', 'spec', 'evaluate'], '$', issues)
  if (value.kind !== 'screener') issue(issues, 'invalid-value', '$.kind', 'must be screener')
  const checkedSpec = validateStrategySpec(value.spec)
  if (!checkedSpec.ok) {
    issues.push(...checkedSpec.issues.map(item => ({ ...item, path: `$.spec${item.path.slice(1)}` })))
  }
  if (typeof value.evaluate !== 'function') issue(issues, 'invalid-type', '$.evaluate', 'must be a function')
  return result(value, issues)
}

export function assertScreenerDefinition(value: unknown): asserts value is ScreenerDefinition {
  const checked = validateScreenerDefinition(value)
  assertResult('ScreenerDefinition', checked)
}

export function validateExecutionDefinition(value: unknown): StrategyValidationResult<ExecutionDefinition> {
  const issues: MutableIssues = []
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be an ExecutionDefinition object')
    return result(value, issues)
  }
  exactKeys(
    value,
    ['id', 'version', 'confirmationTime', 'earliestFillTime', 'priceField', 'unfillableConditions'],
    ['id', 'version', 'confirmationTime', 'earliestFillTime', 'priceField', 'unfillableConditions'],
    '$', issues,
  )
  nonEmptyString(value.id, '$.id', issues, 96)
  if (nonEmptyString(value.version, '$.version', issues, 64)
    && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    issue(issues, 'invalid-value', '$.version', 'must be a semantic version')
  }
  if (!EXECUTION_CONFIRMATION_TIMES.includes(value.confirmationTime as never)) {
    issue(issues, 'invalid-value', '$.confirmationTime', 'has an unknown confirmation time')
  }
  if (!EXECUTION_EARLIEST_FILL_TIMES.includes(value.earliestFillTime as never)) {
    issue(issues, 'invalid-value', '$.earliestFillTime', 'has an unknown earliest fill time')
  }
  if (!EXECUTION_PRICE_FIELDS.includes(value.priceField as never)) {
    issue(issues, 'invalid-value', '$.priceField', 'has an unknown execution price field')
  }
  stringArray(value.unfillableConditions, '$.unfillableConditions', issues, false)
  return result(value, issues)
}

export function assertExecutionDefinition(value: unknown): asserts value is ExecutionDefinition {
  const checked = validateExecutionDefinition(value)
  assertResult('ExecutionDefinition', checked)
}

export interface SignalValidationContext {
  readonly asOf?: string
  readonly executionDefinitionIds: readonly string[]
}

function quality(value: unknown, path: string, issues: MutableIssues): boolean {
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', path, 'must be a SignalQuality object')
    return false
  }
  exactKeys(value, ['level', 'inputStatus', 'limitations'], ['level', 'inputStatus', 'limitations'], path, issues)
  if (!['unknown', 'low', 'medium', 'high'].includes(String(value.level))) {
    issue(issues, 'invalid-value', `${path}.level`, 'has an unknown quality level')
  }
  if (!['complete', 'partial', 'stale', 'insufficient'].includes(String(value.inputStatus))) {
    issue(issues, 'invalid-value', `${path}.inputStatus`, 'has an unknown input status')
  }
  stringArray(value.limitations, `${path}.limitations`, issues, true)
  return true
}

export function validateSignalObservation(
  value: unknown,
  context: SignalValidationContext,
): StrategyValidationResult<SignalObservation> {
  const issues: MutableIssues = []
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be a SignalObservation object')
    return result(value, issues)
  }
  const keys = [
    'id', 'strategyId', 'strategyHash', 'inputHash', 'snapshotId', 'instrument', 'signalAt',
    'availableAt', 'configHash', 'action', 'direction', 'confirmationPrice',
    'executionDefinitionId', 'payload', 'explanation', 'quality',
  ]
  exactKeys(value, keys, keys, '$', issues)
  stableHash(value.id, '$.id', issues)
  nonEmptyString(value.strategyId, '$.strategyId', issues, 96)
  stableHash(value.strategyHash, '$.strategyHash', issues)
  stableHash(value.inputHash, '$.inputHash', issues)
  nonEmptyString(value.snapshotId, '$.snapshotId', issues, 512)
  instrument(value.instrument, '$.instrument', issues)
  const validSignalAt = timestamp(value.signalAt, '$.signalAt', issues)
  const validAvailableAt = timestamp(value.availableAt, '$.availableAt', issues)
  stableHash(value.configHash, '$.configHash', issues)
  if (value.action !== 'entry' && value.action !== 'exit') {
    issue(issues, 'invalid-value', '$.action', 'must be entry or exit')
  }
  if (value.direction !== 'long' && value.direction !== 'flat') {
    issue(issues, 'invalid-value', '$.direction', 'must be long or flat')
  }
  if ((value.action === 'entry' && value.direction !== 'long')
    || (value.action === 'exit' && value.direction !== 'flat')) {
    issue(issues, 'invalid-value', '$.direction', 'entry must be long and exit must be flat')
  }
  if (finiteNumber(value.confirmationPrice, '$.confirmationPrice', issues) && value.confirmationPrice <= 0) {
    issue(issues, 'invalid-value', '$.confirmationPrice', 'must be greater than zero')
  }
  if (nonEmptyString(value.executionDefinitionId, '$.executionDefinitionId', issues, 96)
    && !context.executionDefinitionIds.includes(value.executionDefinitionId)) {
    issue(issues, 'unknown-execution-definition', '$.executionDefinitionId',
      `execution definition ${value.executionDefinitionId} is not registered`)
  }
  if (!isRecord(value.payload)) issue(issues, 'invalid-type', '$.payload', 'must be a JSON object')
  else jsonValue(value.payload, '$.payload', issues)
  nonEmptyString(value.explanation, '$.explanation', issues, 4_096)
  quality(value.quality, '$.quality', issues)

  if (validSignalAt && validAvailableAt
    && Date.parse(value.availableAt as string) < Date.parse(value.signalAt as string)) {
    issue(issues, 'invalid-time', '$.availableAt', 'must not precede signalAt')
  }
  if (context.asOf !== undefined && timestamp(context.asOf, '$context.asOf', issues)
    && validAvailableAt && Date.parse(value.availableAt as string) > Date.parse(context.asOf)) {
    issue(issues, 'future-time', '$.availableAt', 'must not be later than the evaluation asOf')
  }
  if (issues.length === 0) {
    try {
      const expectedId = signalObservationId(value as unknown as SignalObservation)
      if (value.id !== expectedId) issue(issues, 'identity-mismatch', '$.id', `expected ${expectedId}`)
    } catch (error) {
      issue(issues, 'invalid-value', '$', `cannot compute identity: ${String(error)}`)
    }
  }
  return result(value, issues)
}

export function assertSignalObservation(
  value: unknown,
  context: SignalValidationContext,
): asserts value is SignalObservation {
  const checked = validateSignalObservation(value, context)
  assertResult('SignalObservation', checked)
}

export function validateCanonicalBars(
  bars: unknown,
  options: { readonly asOf?: string } = {},
): StrategyValidationResult<readonly CanonicalBar[]> {
  const issues: MutableIssues = []
  if (!Array.isArray(bars)) {
    issue(issues, 'invalid-type', '$', 'must be an array of CanonicalBar')
    return result(bars, issues)
  }
  let previousOpen = Number.NEGATIVE_INFINITY
  let previousClose = Number.NEGATIVE_INFINITY
  bars.forEach((bar, index) => {
    const path = `$[${index}]`
    if (!isRecord(bar)) {
      issue(issues, 'invalid-type', path, 'must be a CanonicalBar object')
      return
    }
    const required = ['openAt', 'closeAt', 'availableAt', 'open', 'high', 'low', 'close', 'volume']
    exactKeys(bar, [...required, 'turnover'], required, path, issues)
    const validOpenAt = timestamp(bar.openAt, `${path}.openAt`, issues)
    const validCloseAt = timestamp(bar.closeAt, `${path}.closeAt`, issues)
    const validAvailableAt = timestamp(bar.availableAt, `${path}.availableAt`, issues)
    if (validOpenAt && validCloseAt
      && Date.parse(bar.closeAt as string) < Date.parse(bar.openAt as string)) {
      issue(issues, 'invalid-time', `${path}.closeAt`, 'must not precede openAt')
    }
    if (validCloseAt && validAvailableAt
      && Date.parse(bar.availableAt as string) < Date.parse(bar.closeAt as string)) {
      issue(issues, 'invalid-time', `${path}.availableAt`, 'must not precede closeAt')
    }
    if (validOpenAt && Date.parse(bar.openAt as string) <= previousOpen) {
      issue(issues, 'invalid-bar-order', `${path}.openAt`, 'bars must be strictly ordered without duplicates')
    }
    if (validCloseAt && Date.parse(bar.closeAt as string) <= previousClose) {
      issue(issues, 'invalid-bar-order', `${path}.closeAt`, 'bars must be strictly ordered without duplicates')
    }
    if (validOpenAt) previousOpen = Date.parse(bar.openAt as string)
    if (validCloseAt) previousClose = Date.parse(bar.closeAt as string)
    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      nullableFiniteNumber(bar[field], `${path}.${field}`, issues)
    }
    if (bar.turnover !== undefined) nullableFiniteNumber(bar.turnover, `${path}.turnover`, issues)
    if (typeof bar.volume === 'number' && Number.isFinite(bar.volume) && bar.volume < 0) {
      issue(issues, 'invalid-value', `${path}.volume`, 'must not be negative')
    }
    for (const field of ['open', 'high', 'low', 'close'] as const) {
      if (typeof bar[field] === 'number' && Number.isFinite(bar[field]) && bar[field] <= 0) {
        issue(issues, 'invalid-value', `${path}.${field}`, 'must be greater than zero when available')
      }
    }
    if (typeof bar.turnover === 'number' && Number.isFinite(bar.turnover) && bar.turnover < 0) {
      issue(issues, 'invalid-value', `${path}.turnover`, 'must not be negative')
    }
    if (['open', 'high', 'low', 'close'].every(field => typeof bar[field] === 'number' && Number.isFinite(bar[field]))) {
      const open = bar.open as number
      const high = bar.high as number
      const low = bar.low as number
      const close = bar.close as number
      if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
        issue(issues, 'invalid-value', path, 'OHLC values are inconsistent')
      }
    }
    if (options.asOf !== undefined && validAvailableAt && timestamp(options.asOf, '$context.asOf', issues)
      && Date.parse(bar.availableAt as string) > Date.parse(options.asOf)) {
      issue(issues, 'future-time', `${path}.availableAt`, 'bar was not available by asOf')
    }
  })
  return result(bars, issues)
}

export function assertCanonicalBars(
  bars: unknown,
  options: { readonly asOf?: string } = {},
): asserts bars is readonly CanonicalBar[] {
  const checked = validateCanonicalBars(bars, options)
  assertResult('CanonicalBar[]', checked)
}

function sameInstrument(left: InstrumentId, right: InstrumentId): boolean {
  return left.market === right.market
    && left.exchange === right.exchange
    && left.symbol === right.symbol
    && left.assetType === right.assetType
}

export interface SignalSequenceValidationContext extends SignalValidationContext {
  readonly expectedStrategyId?: string
  readonly expectedStrategyHash?: string
  readonly expectedInputHash?: string
  readonly expectedSnapshotId?: string
  readonly expectedConfigHash?: string
  readonly expectedInstrument?: InstrumentId
  readonly expectedExecutionDefinitionId?: string
}

export function validateSignalSequence(
  signals: unknown,
  bars: unknown,
  context: SignalSequenceValidationContext,
): StrategyValidationResult<readonly SignalObservation[]> {
  const issues: MutableIssues = []
  const checkedBars = validateCanonicalBars(bars, context.asOf === undefined ? {} : { asOf: context.asOf })
  if (!checkedBars.ok) issues.push(...checkedBars.issues)
  if (!Array.isArray(signals)) {
    issue(issues, 'invalid-type', '$signals', 'must be a SignalObservation array')
    return result(signals, issues)
  }
  let previousIndex = -1
  let position: 'flat' | 'long' = 'flat'
  signals.forEach((signal, index) => {
    const checked = validateSignalObservation(signal, context)
    if (!checked.ok) {
      for (const item of checked.issues) issues.push({ ...item, path: `$signals[${index}]${item.path.slice(1)}` })
      return
    }
    const observation = checked.value
    const barIndex = Array.isArray(bars)
      ? bars.findIndex(bar => isRecord(bar) && bar.closeAt === observation.signalAt)
      : -1
    if (barIndex < 0) {
      issue(issues, 'invalid-signal-order', `$signals[${index}].signalAt`, 'must match one input bar closeAt')
    } else {
      if (barIndex <= previousIndex) {
        issue(issues, 'invalid-signal-order', `$signals[${index}].signalAt`,
          'signal bars must be strictly increasing without duplicates')
      }
      previousIndex = barIndex
      const bar = (bars as readonly CanonicalBar[])[barIndex] as CanonicalBar
      if (bar.close === null || Math.abs(observation.confirmationPrice - bar.close)
        > Math.max(1e-9, Math.abs(bar.close) * 1e-9)) {
        issue(issues, 'invalid-value', `$signals[${index}].confirmationPrice`,
          'must equal the finite close of the confirmation bar')
      }
      if (Date.parse(observation.availableAt) < Date.parse(bar.availableAt)) {
        issue(issues, 'invalid-time', `$signals[${index}].availableAt`,
          'must not precede the confirmation bar availableAt')
      }
    }
    if (observation.action === 'entry' && position === 'long') {
      issue(issues, 'invalid-position-transition', `$signals[${index}].action`, 'cannot enter while already long')
    } else if (observation.action === 'exit' && position === 'flat') {
      issue(issues, 'invalid-position-transition', `$signals[${index}].action`, 'cannot exit while flat')
    } else {
      position = observation.action === 'entry' ? 'long' : 'flat'
    }
    const expectedPairs: Array<[unknown, unknown, string]> = [
      [observation.strategyId, context.expectedStrategyId, 'strategyId'],
      [observation.strategyHash, context.expectedStrategyHash, 'strategyHash'],
      [observation.inputHash, context.expectedInputHash, 'inputHash'],
      [observation.snapshotId, context.expectedSnapshotId, 'snapshotId'],
      [observation.configHash, context.expectedConfigHash, 'configHash'],
      [observation.executionDefinitionId, context.expectedExecutionDefinitionId, 'executionDefinitionId'],
    ]
    for (const [actual, expected, field] of expectedPairs) {
      if (expected !== undefined && actual !== expected) {
        issue(issues, 'identity-mismatch', `$signals[${index}].${field}`, 'does not match evaluation context')
      }
    }
    if (context.expectedInstrument !== undefined
      && !sameInstrument(observation.instrument, context.expectedInstrument)) {
      issue(issues, 'identity-mismatch', `$signals[${index}].instrument`, 'does not match evaluation context')
    }
  })
  return result(signals, issues)
}

export function assertSignalSequence(
  signals: unknown,
  bars: unknown,
  context: SignalSequenceValidationContext,
): asserts signals is readonly SignalObservation[] {
  const checked = validateSignalSequence(signals, bars, context)
  assertResult('SignalObservation[]', checked)
}

export function validateScreenerMatch(value: unknown): StrategyValidationResult<ScreenerMatch | null> {
  const issues: MutableIssues = []
  if (value === null) return { ok: true, value: null }
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be a ScreenerMatch object or null')
    return result(value, issues)
  }
  exactKeys(value, ['payload', 'explanation', 'quality'], ['payload', 'explanation', 'quality'], '$', issues)
  if (!isRecord(value.payload)) issue(issues, 'invalid-type', '$.payload', 'must be a JSON object')
  else jsonValue(value.payload, '$.payload', issues)
  nonEmptyString(value.explanation, '$.explanation', issues, 4_096)
  quality(value.quality, '$.quality', issues)
  return result(value, issues)
}

export function assertScreenerMatch(value: unknown): asserts value is ScreenerMatch | null {
  const checked = validateScreenerMatch(value)
  assertResult('ScreenerMatch', checked)
}

export function resolveStrategyConfig(
  spec: StrategySpec,
  config: unknown,
): Readonly<JsonObject> {
  assertStrategySpec(spec)
  const issues: MutableIssues = []
  if (!isRecord(config)) {
    issue(issues, 'invalid-type', '$config', 'must be a JSON object')
    throw new StrategyValidationError('Strategy config validation failed', issues)
  }
  jsonValue(config, '$config', issues)
  const definitions = new Map(spec.parameters.map(item => [item.key, item]))
  for (const key of Object.keys(config)) {
    if (!definitions.has(key)) issue(issues, 'unknown-field', `$config.${key}`, 'unknown strategy parameter')
  }
  const resolved: Record<string, string | number | boolean> = {}
  for (const definition of spec.parameters) {
    const value = Object.hasOwn(config, definition.key) ? config[definition.key] : definition.default
    const path = `$config.${definition.key}`
    if (definition.type === 'number') {
      if (finiteNumber(value, path, issues)) {
        if (value < definition.min || value > definition.max) issue(issues, 'invalid-value', path, 'is outside parameter bounds')
        if (definition.integer === true && !Number.isInteger(value)) issue(issues, 'invalid-value', path, 'must be an integer')
      }
    } else if (definition.type === 'boolean') {
      if (typeof value !== 'boolean') issue(issues, 'invalid-type', path, 'must be boolean')
    } else if (typeof value !== 'string' || !definition.allowedValues.includes(value)) {
      issue(issues, 'invalid-value', path, 'must be one of allowedValues')
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      resolved[definition.key] = value
    }
  }
  if (issues.length > 0) throw new StrategyValidationError('Strategy config validation failed', issues)
  return Object.freeze(resolved)
}

export function assertStrategyRunInput(value: unknown): asserts value is StrategyRunInput {
  const issues: MutableIssues = []
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be a StrategyRunInput object')
    throw new StrategyValidationError('StrategyRunInput validation failed', issues)
  }
  exactKeys(value, ['instrument', 'interval', 'adjustment', 'snapshotId', 'asOf', 'bars'],
    ['instrument', 'interval', 'adjustment', 'snapshotId', 'asOf', 'bars'], '$', issues)
  instrument(value.instrument, '$.instrument', issues)
  nonEmptyString(value.interval, '$.interval', issues, 32)
  if (!['none', 'qfq', 'hfq'].includes(String(value.adjustment))) {
    issue(issues, 'invalid-value', '$.adjustment', 'must be none, qfq, or hfq')
  }
  nonEmptyString(value.snapshotId, '$.snapshotId', issues, 512)
  const validAsOf = timestamp(value.asOf, '$.asOf', issues)
  const checkedBars = validateCanonicalBars(value.bars, validAsOf ? { asOf: value.asOf as string } : {})
  if (!checkedBars.ok) issues.push(...checkedBars.issues.map(item => ({ ...item, path: `$.bars${item.path.slice(1)}` })))
  if (issues.length > 0) throw new StrategyValidationError('StrategyRunInput validation failed', issues)
}

function metric(value: unknown, path: string, issues: MutableIssues): void {
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', path, 'must be a BacktestMetric object')
    return
  }
  if (value.status === 'available') {
    exactKeys(value, ['status', 'value', 'unit'], ['status', 'value', 'unit'], path, issues)
    finiteNumber(value.value, `${path}.value`, issues)
    nonEmptyString(value.unit, `${path}.unit`, issues, 64)
    return
  }
  exactKeys(value, ['status', 'value', 'reason'], ['status', 'value', 'reason'], path, issues)
  if (!QUANT_RESULT_STATUSES.includes(value.status as never) || value.status === 'available') {
    issue(issues, 'invalid-value', `${path}.status`, 'has an unknown unavailable-result status')
  }
  if (value.value !== null) issue(issues, 'invalid-value', `${path}.value`, 'must be null when status is not available')
  nonEmptyString(value.reason, `${path}.reason`, issues)
}

export function validateBacktestRun(value: unknown): StrategyValidationResult<BacktestRun> {
  const issues: MutableIssues = []
  if (!isRecord(value)) {
    issue(issues, 'invalid-type', '$', 'must be a BacktestRun object')
    return result(value, issues)
  }
  const keys = [
    'id', 'engine', 'engineVersion', 'engineTier', 'dataset', 'strategyHash', 'configHash',
    'executionHash', 'costModel', 'benchmark', 'metrics', 'artifacts', 'status', 'warnings',
    'startedAt', 'completedAt',
  ]
  exactKeys(value, keys, keys, '$', issues)
  stableHash(value.id, '$.id', issues)
  nonEmptyString(value.engine, '$.engine', issues, 128)
  nonEmptyString(value.engineVersion, '$.engineVersion', issues, 64)
  if (!BACKTEST_ENGINE_TIERS.includes(value.engineTier as never)) issue(issues, 'invalid-value', '$.engineTier', 'is unknown')
  if (!isRecord(value.dataset)) issue(issues, 'invalid-type', '$.dataset', 'must be an object')
  else {
    exactKeys(value.dataset, ['snapshotId', 'hash', 'asOf'], ['snapshotId', 'hash'], '$.dataset', issues)
    nonEmptyString(value.dataset.snapshotId, '$.dataset.snapshotId', issues, 512)
    stableHash(value.dataset.hash, '$.dataset.hash', issues)
    if (value.dataset.asOf !== undefined) timestamp(value.dataset.asOf, '$.dataset.asOf', issues)
  }
  stableHash(value.strategyHash, '$.strategyHash', issues)
  stableHash(value.configHash, '$.configHash', issues)
  stableHash(value.executionHash, '$.executionHash', issues)
  if (!isRecord(value.costModel)) issue(issues, 'invalid-type', '$.costModel', 'must be an object')
  else {
    exactKeys(value.costModel, ['id', 'version', 'hash', 'parameters'], ['id', 'version', 'hash'], '$.costModel', issues)
    nonEmptyString(value.costModel.id, '$.costModel.id', issues, 128)
    nonEmptyString(value.costModel.version, '$.costModel.version', issues, 64)
    stableHash(value.costModel.hash, '$.costModel.hash', issues)
    if (value.costModel.parameters !== undefined) jsonValue(value.costModel.parameters, '$.costModel.parameters', issues)
  }
  if (!isRecord(value.benchmark)) issue(issues, 'invalid-type', '$.benchmark', 'must be an object')
  else if (value.benchmark.status === 'available') {
    exactKeys(value.benchmark, ['status', 'instrument', 'datasetHash'], ['status', 'instrument', 'datasetHash'], '$.benchmark', issues)
    instrument(value.benchmark.instrument, '$.benchmark.instrument', issues)
    stableHash(value.benchmark.datasetHash, '$.benchmark.datasetHash', issues)
  } else {
    exactKeys(value.benchmark, ['status', 'reason'], ['status', 'reason'], '$.benchmark', issues)
    if (!['missing', 'insufficient', 'not-meaningful', 'error'].includes(String(value.benchmark.status))) {
      issue(issues, 'invalid-value', '$.benchmark.status', 'has an unknown unavailable benchmark status')
    }
    nonEmptyString(value.benchmark.reason, '$.benchmark.reason', issues)
  }
  if (!isRecord(value.metrics)) issue(issues, 'invalid-type', '$.metrics', 'must be an object')
  else Object.entries(value.metrics).forEach(([key, item]) => metric(item, `$.metrics.${key}`, issues))
  if (!Array.isArray(value.artifacts)) issue(issues, 'invalid-type', '$.artifacts', 'must be an array')
  else value.artifacts.forEach((artifact, index) => {
    const path = `$.artifacts[${index}]`
    if (!isRecord(artifact)) { issue(issues, 'invalid-type', path, 'must be an object'); return }
    exactKeys(artifact, ['kind', 'ref', 'hash'], ['kind', 'ref', 'hash'], path, issues)
    nonEmptyString(artifact.kind, `${path}.kind`, issues, 128)
    nonEmptyString(artifact.ref, `${path}.ref`, issues, 1_024)
    stableHash(artifact.hash, `${path}.hash`, issues)
  })
  if (!BACKTEST_RUN_STATUSES.includes(value.status as never)) issue(issues, 'invalid-value', '$.status', 'is unknown')
  stringArray(value.warnings, '$.warnings', issues, true)
  const validStarted = timestamp(value.startedAt, '$.startedAt', issues)
  const validCompleted = timestamp(value.completedAt, '$.completedAt', issues)
  if (validStarted && validCompleted
    && Date.parse(value.completedAt as string) < Date.parse(value.startedAt as string)) {
    issue(issues, 'invalid-time', '$.completedAt', 'must not precede startedAt')
  }
  if (issues.length === 0) {
    try {
      const expectedId = backtestRunId(value as unknown as BacktestRun)
      if (value.id !== expectedId) issue(issues, 'identity-mismatch', '$.id', `expected ${expectedId}`)
    } catch (error) {
      issue(issues, 'invalid-value', '$', `cannot compute identity: ${String(error)}`)
    }
  }
  return result(value, issues)
}

export function assertBacktestRun(value: unknown): asserts value is BacktestRun {
  const checked = validateBacktestRun(value)
  assertResult('BacktestRun', checked)
}

export function assertJsonObject(value: unknown): asserts value is JsonObject {
  const issues: MutableIssues = []
  if (!isRecord(value)) issue(issues, 'invalid-type', '$', 'must be a JSON object')
  else jsonValue(value, '$', issues)
  if (issues.length > 0) throw new StrategyValidationError('JSON object validation failed', issues)
  canonicalJson(value as JsonObject)
}

export function validatedConfigHash(spec: StrategySpec, config: unknown): string {
  return configHash(resolveStrategyConfig(spec, config))
}
