import {
  ADJUSTMENT_MODES,
  DATA_CAPABILITIES,
  SOURCE_KINDS,
  canonicalInstrumentId,
  type DataCapability,
  type DataProvenance,
  type InstrumentId,
} from '@finance2dsh/core'

import {
  ASSUMPTION_OWNERS,
  CLAIM_STATUSES,
  CONFIDENCE_LABELS,
  EVIDENCE_QUALITIES,
  GAP_REASON_CODES,
  RESEARCH_REF_KINDS,
  RESEARCH_CASE_STATUSES,
  type Assumption,
  type Claim,
  type ContentHash,
  type Evidence,
  type Gap,
  type JsonObject,
  type JsonValue,
  type ModelInputRef,
  type ModelRun,
  type ModelRunOutput,
  type ResearchCase,
  type ResearchRunManifest,
  type ResearchSubject,
  type SourceRef,
} from './contracts.js'
import {
  assumptionId,
  canonicalJson,
  claimId,
  evidenceId,
  modelRunId,
  researchCaseId,
  researchRunId,
} from './identity.js'

type RecordValue = Record<string, unknown>
type Validator<T> = (value: unknown, path: string) => T

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/u
const ID_RE = /^(case|ev|asm|claim|model|run)-[0-9a-f]{64}$/u
const CURRENCY_RE = /^[A-Z]{3}$/u

export class ResearchValidationError extends TypeError {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ResearchValidationError'
  }
}

function fail(path: string, message: string): never {
  throw new ResearchValidationError(path, message)
}

function object(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object')
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected a plain object')
  return value as RecordValue
}

function exactKeys(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown property')
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required property is missing')
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'expected a non-empty string')
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path)
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean')
  return value
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number')
  return value
}

function integer(value: unknown, path: string, minimum = 0): number {
  const parsed = finiteNumber(value, path)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    fail(path, `expected an integer greater than or equal to ${minimum}`)
  }
  return parsed
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(path, `expected one of: ${allowed.join(', ')}`)
  }
  return value as T[number]
}

function array<T>(value: unknown, path: string, validate: Validator<T>): T[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  return value.map((item, index) => validate(item, `${path}[${index}]`))
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path, string)
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= (monthLengths[month - 1] ?? 0)
}

function date(value: unknown, path: string): string {
  const parsed = string(value, path)
  const match = DATE_RE.exec(parsed)
  if (match === null || !validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    fail(path, 'expected a valid ISO calendar date (YYYY-MM-DD)')
  }
  return parsed
}

function timestamp(value: unknown, path: string): string {
  const parsed = string(value, path)
  const match = TIMESTAMP_RE.exec(parsed)
  if (match === null
    || !validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
    || Number(match[4]) > 23
    || Number(match[5]) > 59
    || Number(match[6]) > 59
    || !Number.isFinite(Date.parse(parsed))) {
    fail(path, 'expected a valid RFC 3339 timestamp with a timezone')
  }
  return parsed
}

function temporal(value: unknown, path: string): string {
  if (typeof value === 'string' && DATE_RE.test(value)) return date(value, path)
  return timestamp(value, path)
}

function optionalTemporal(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : temporal(value, path)
}

function contentHash(value: unknown, path: string): ContentHash {
  const parsed = string(value, path)
  if (!CONTENT_HASH_RE.test(parsed)) fail(path, 'expected sha256:<64 lowercase hexadecimal characters>')
  return parsed as ContentHash
}

function id(value: unknown, prefix: string, path: string): string {
  const parsed = string(value, path)
  if (!ID_RE.test(parsed) || !parsed.startsWith(`${prefix}-`)) {
    fail(path, `expected a ${prefix} content id`)
  }
  return parsed
}

function jsonValue(value: unknown, path: string): JsonValue {
  try {
    canonicalJson(value)
  } catch (error) {
    fail(path, error instanceof Error ? error.message : 'expected a JSON-safe value')
  }
  return value as JsonValue
}

function jsonObject(value: unknown, path: string): JsonObject {
  object(value, path)
  return jsonValue(value, path) as JsonObject
}

function instrument(value: unknown, path: string): InstrumentId {
  const record = object(value, path)
  exactKeys(record, ['market', 'exchange', 'symbol', 'assetType'], [], path)
  string(record.market, `${path}.market`)
  string(record.exchange, `${path}.exchange`)
  string(record.symbol, `${path}.symbol`)
  string(record.assetType, `${path}.assetType`)
  try {
    canonicalInstrumentId(value as InstrumentId)
  } catch (error) {
    fail(path, error instanceof Error ? error.message : 'invalid canonical instrument')
  }
  return value as InstrumentId
}

function subject(value: unknown, path: string): ResearchSubject {
  const record = object(value, path)
  const kind = oneOf(record.kind, ['instrument', 'portfolio', 'topic'] as const, `${path}.kind`)
  if (kind === 'instrument') {
    exactKeys(record, ['kind', 'instrument'], [], path)
    instrument(record.instrument, `${path}.instrument`)
  } else if (kind === 'portfolio') {
    exactKeys(record, ['kind', 'portfolioId'], [], path)
    string(record.portfolioId, `${path}.portfolioId`)
  } else {
    exactKeys(record, ['kind', 'topic'], [], path)
    string(record.topic, `${path}.topic`)
  }
  return value as ResearchSubject
}

function fallbackAttempt(value: unknown, path: string): DataProvenance['fallbackChain'][number] {
  const record = object(value, path)
  exactKeys(record, ['provider', 'outcome'], ['reason', 'qualityTier', 'qualityDowngrade'], path)
  string(record.provider, `${path}.provider`)
  string(record.outcome, `${path}.outcome`)
  optionalString(record.reason, `${path}.reason`)
  optionalString(record.qualityTier, `${path}.qualityTier`)
  if (record.qualityDowngrade !== undefined) boolean(record.qualityDowngrade, `${path}.qualityDowngrade`)
  return value as DataProvenance['fallbackChain'][number]
}

function derivedLineage(value: unknown, path: string): NonNullable<DataProvenance['derived']> {
  const record = object(value, path)
  exactKeys(record, ['inputRefs', 'algorithm', 'algorithmVersion'], ['methodology'], path)
  stringArray(record.inputRefs, `${path}.inputRefs`)
  string(record.algorithm, `${path}.algorithm`)
  string(record.algorithmVersion, `${path}.algorithmVersion`)
  optionalString(record.methodology, `${path}.methodology`)
  return value as NonNullable<DataProvenance['derived']>
}

function provenance(value: unknown, path: string): DataProvenance {
  const record = object(value, path)
  exactKeys(
    record,
    ['actualProvider', 'provider', 'upstreamSource', 'sourceKind', 'fetchedAt', 'fallbackChain'],
    [
      'requestedProvider', 'sourceUrl', 'observedAt', 'publishedAt', 'availableAt', 'fiscalPeriod',
      'timezone', 'currency', 'unit', 'adjustment', 'upstreamVersion', 'upstreamCommit',
      'qualityTier', 'qualityDowngrade', 'derived',
    ],
    path,
  )
  optionalString(record.requestedProvider, `${path}.requestedProvider`)
  string(record.actualProvider, `${path}.actualProvider`)
  string(record.provider, `${path}.provider`)
  string(record.upstreamSource, `${path}.upstreamSource`)
  oneOf(record.sourceKind, SOURCE_KINDS, `${path}.sourceKind`)
  optionalString(record.sourceUrl, `${path}.sourceUrl`)
  timestamp(record.fetchedAt, `${path}.fetchedAt`)
  optionalTemporal(record.observedAt, `${path}.observedAt`)
  optionalTemporal(record.publishedAt, `${path}.publishedAt`)
  optionalTemporal(record.availableAt, `${path}.availableAt`)
  optionalString(record.fiscalPeriod, `${path}.fiscalPeriod`)
  optionalString(record.timezone, `${path}.timezone`)
  if (record.currency !== undefined) {
    const parsedCurrency = string(record.currency, `${path}.currency`)
    if (!CURRENCY_RE.test(parsedCurrency)) fail(`${path}.currency`, 'expected a three-letter uppercase currency')
  }
  optionalString(record.unit, `${path}.unit`)
  if (record.adjustment !== undefined) oneOf(record.adjustment, ADJUSTMENT_MODES, `${path}.adjustment`)
  optionalString(record.upstreamVersion, `${path}.upstreamVersion`)
  optionalString(record.upstreamCommit, `${path}.upstreamCommit`)
  array(record.fallbackChain, `${path}.fallbackChain`, fallbackAttempt)
  optionalString(record.qualityTier, `${path}.qualityTier`)
  if (record.qualityDowngrade !== undefined) boolean(record.qualityDowngrade, `${path}.qualityDowngrade`)
  if (record.derived !== undefined) derivedLineage(record.derived, `${path}.derived`)
  return value as DataProvenance
}

function assertSame(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`)
}

function sourceRef(value: unknown, path: string): SourceRef {
  const record = object(value, path)
  exactKeys(
    record,
    ['provider', 'upstream', 'sourceKind', 'retrievedAt'],
    ['url', 'hash', 'observedAt', 'publishedAt', 'availableAt', 'provenance'],
    path,
  )
  string(record.provider, `${path}.provider`)
  string(record.upstream, `${path}.upstream`)
  oneOf(record.sourceKind, SOURCE_KINDS, `${path}.sourceKind`)
  optionalString(record.url, `${path}.url`)
  if (typeof record.url === 'string') {
    try {
      new URL(record.url)
    } catch {
      fail(`${path}.url`, 'expected an absolute URL')
    }
  }
  if (record.hash !== undefined) contentHash(record.hash, `${path}.hash`)
  optionalTemporal(record.observedAt, `${path}.observedAt`)
  optionalTemporal(record.publishedAt, `${path}.publishedAt`)
  optionalTemporal(record.availableAt, `${path}.availableAt`)
  timestamp(record.retrievedAt, `${path}.retrievedAt`)
  if (record.provenance !== undefined) {
    const parsed = provenance(record.provenance, `${path}.provenance`)
    assertSame(record.provider, parsed.actualProvider, `${path}.provider`)
    assertSame(record.upstream, parsed.upstreamSource, `${path}.upstream`)
    assertSame(record.sourceKind, parsed.sourceKind, `${path}.sourceKind`)
    assertSame(record.url, parsed.sourceUrl, `${path}.url`)
    assertSame(record.observedAt, parsed.observedAt, `${path}.observedAt`)
    assertSame(record.publishedAt, parsed.publishedAt, `${path}.publishedAt`)
    assertSame(record.availableAt, parsed.availableAt, `${path}.availableAt`)
    assertSame(record.retrievedAt, parsed.fetchedAt, `${path}.retrievedAt`)
  }
  return value as SourceRef
}

function verifyContentId(actual: string, expected: string, path: string): void {
  if (actual !== expected) fail(path, `does not match canonical content id ${expected}`)
}

export function validateSourceRef(value: unknown): SourceRef {
  jsonValue(value, '$')
  return sourceRef(value, '$')
}

export function sourceRefFromProvenance(
  value: DataProvenance,
  options: { hash?: ContentHash } = {},
): SourceRef {
  jsonValue(value, '$.provenance')
  provenance(value, '$.provenance')
  const result: SourceRef = {
    provider: value.actualProvider,
    upstream: value.upstreamSource,
    sourceKind: value.sourceKind,
    ...(value.sourceUrl === undefined ? {} : { url: value.sourceUrl }),
    ...(options.hash === undefined ? {} : { hash: options.hash }),
    ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
    ...(value.publishedAt === undefined ? {} : { publishedAt: value.publishedAt }),
    ...(value.availableAt === undefined ? {} : { availableAt: value.availableAt }),
    retrievedAt: value.fetchedAt,
    provenance: value,
  }
  return sourceRef(result, '$')
}

export function validateResearchCase(value: unknown): ResearchCase {
  jsonValue(value, '$')
  const record = object(value, '$')
  exactKeys(record, ['caseId', 'subject', 'mandate', 'asOf', 'status', 'createdAt', 'updatedAt'], [], '$')
  const actualId = id(record.caseId, 'case', '$.caseId')
  subject(record.subject, '$.subject')
  string(record.mandate, '$.mandate')
  temporal(record.asOf, '$.asOf')
  oneOf(record.status, RESEARCH_CASE_STATUSES, '$.status')
  const createdAt = timestamp(record.createdAt, '$.createdAt')
  const updatedAt = timestamp(record.updatedAt, '$.updatedAt')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('$.updatedAt', 'cannot precede createdAt')
  verifyContentId(actualId, researchCaseId(value as ResearchCase), '$.caseId')
  return value as ResearchCase
}

function evidence(value: unknown, path: string, verifyId: boolean): Evidence {
  const record = object(value, path)
  const commonRequired = ['id', 'kind', 'subject', 'quality', 'sourceRef', 'limitations']
  const commonOptional = ['period', 'unit', 'currency']
  const kind = oneOf(record.kind, ['structured', 'filing', 'web', 'user', 'calculation'] as const, `${path}.kind`)
  const required = kind === 'structured'
    ? [...commonRequired, 'field', 'value']
    : kind === 'calculation'
      ? [...commonRequired, 'field', 'value', 'modelRunRef']
      : [...commonRequired, 'excerpt']
  const optional = kind === 'structured' || kind === 'calculation'
    ? [...commonOptional, 'excerpt']
    : [...commonOptional, 'field', 'value']
  exactKeys(record, required, optional, path)
  const actualId = id(record.id, 'ev', `${path}.id`)
  subject(record.subject, `${path}.subject`)
  optionalString(record.period, `${path}.period`)
  optionalString(record.unit, `${path}.unit`)
  if (record.currency !== undefined) {
    const parsedCurrency = string(record.currency, `${path}.currency`)
    if (!CURRENCY_RE.test(parsedCurrency)) fail(`${path}.currency`, 'expected a three-letter uppercase currency')
  }
  oneOf(record.quality, EVIDENCE_QUALITIES, `${path}.quality`)
  sourceRef(record.sourceRef, `${path}.sourceRef`)
  stringArray(record.limitations, `${path}.limitations`)
  if (record.field !== undefined) string(record.field, `${path}.field`)
  if (record.value !== undefined) {
    jsonValue(record.value, `${path}.value`)
    if ((kind === 'structured' || kind === 'calculation') && record.value === null) {
      fail(`${path}.value`, `${kind} evidence requires a non-null value`)
    }
  }
  if (record.excerpt !== undefined) string(record.excerpt, `${path}.excerpt`)
  if (kind === 'calculation') id(record.modelRunRef, 'model', `${path}.modelRunRef`)
  if (verifyId) {
    const { id: _discarded, ...content } = value as Evidence
    verifyContentId(actualId, evidenceId(content as Parameters<typeof evidenceId>[0]), `${path}.id`)
  }
  return value as Evidence
}

export function validateEvidence(value: unknown): Evidence {
  jsonValue(value, '$')
  return evidence(value, '$', true)
}

function assumption(value: unknown, path: string, verifyId: boolean): Assumption {
  const record = object(value, path)
  const kind = oneOf(record.kind, ['point', 'range'] as const, `${path}.kind`)
  const required = ['id', 'kind', 'name', kind === 'point' ? 'value' : 'range', 'scenario', 'rationale', 'evidenceRefs', 'owner', 'version']
  exactKeys(record, required, ['unit'], path)
  const actualId = id(record.id, 'asm', `${path}.id`)
  string(record.name, `${path}.name`)
  optionalString(record.unit, `${path}.unit`)
  string(record.scenario, `${path}.scenario`)
  string(record.rationale, `${path}.rationale`)
  for (const [index, ref] of stringArray(record.evidenceRefs, `${path}.evidenceRefs`).entries()) {
    id(ref, 'ev', `${path}.evidenceRefs[${index}]`)
  }
  oneOf(record.owner, ASSUMPTION_OWNERS, `${path}.owner`)
  integer(record.version, `${path}.version`, 1)
  if (kind === 'point') {
    jsonValue(record.value, `${path}.value`)
    if (record.value === null) fail(`${path}.value`, 'point assumption requires a non-null value')
  } else {
    const range = object(record.range, `${path}.range`)
    exactKeys(range, [], ['lower', 'upper'], `${path}.range`)
    if (range.lower === undefined && range.upper === undefined) {
      fail(`${path}.range`, 'at least one bound is required')
    }
    if (range.lower !== undefined) finiteNumber(range.lower, `${path}.range.lower`)
    if (range.upper !== undefined) finiteNumber(range.upper, `${path}.range.upper`)
    if (typeof range.lower === 'number' && typeof range.upper === 'number' && range.lower > range.upper) {
      fail(`${path}.range`, 'lower cannot exceed upper')
    }
  }
  if (verifyId) {
    const { id: _discarded, ...content } = value as Assumption
    verifyContentId(actualId, assumptionId(content as Parameters<typeof assumptionId>[0]), `${path}.id`)
  }
  return value as Assumption
}

export function validateAssumption(value: unknown): Assumption {
  jsonValue(value, '$')
  return assumption(value, '$', true)
}

export function validateClaim(value: unknown): Claim {
  jsonValue(value, '$')
  const record = object(value, '$')
  exactKeys(
    record,
    ['id', 'text', 'status', 'confidenceLabel', 'evidenceRefs', 'counterEvidenceRefs', 'falsifiers'],
    [],
    '$',
  )
  const actualId = id(record.id, 'claim', '$.id')
  string(record.text, '$.text')
  oneOf(record.status, CLAIM_STATUSES, '$.status')
  oneOf(record.confidenceLabel, CONFIDENCE_LABELS, '$.confidenceLabel')
  for (const key of ['evidenceRefs', 'counterEvidenceRefs'] as const) {
    for (const [index, ref] of stringArray(record[key], `$.${key}`).entries()) {
      id(ref, 'ev', `$.${key}[${index}]`)
    }
  }
  stringArray(record.falsifiers, '$.falsifiers')
  const { id: _discarded, ...content } = value as Claim
  verifyContentId(actualId, claimId(content), '$.id')
  return value as Claim
}

function modelInputRef(value: unknown, path: string): ModelInputRef {
  const record = object(value, path)
  exactKeys(record, ['kind', 'id'], [], path)
  const kind = oneOf(record.kind, RESEARCH_REF_KINDS, `${path}.kind`)
  const prefix = kind === 'evidence'
    ? 'ev'
    : kind === 'assumption'
      ? 'asm'
      : kind === 'claim'
        ? 'claim'
        : 'model'
  id(record.id, prefix, `${path}.id`)
  return value as ModelInputRef
}

function modelRunOutput(value: unknown, path: string): ModelRunOutput {
  const record = object(value, path)
  const status = oneOf(
    record.status,
    ['ok', 'missing', 'unfillable', 'insufficient', 'not-meaningful', 'error'] as const,
    `${path}.status`,
  )
  if (status === 'ok') {
    exactKeys(record, ['status', 'value'], [], path)
    jsonValue(record.value, `${path}.value`)
    if (record.value === null) fail(`${path}.value`, 'successful model output requires a non-null value')
  } else {
    exactKeys(record, ['status', 'reason'], ['details'], path)
    string(record.reason, `${path}.reason`)
    if (record.details !== undefined) jsonObject(record.details, `${path}.details`)
  }
  return value as ModelRunOutput
}

export function validateModelRun(value: unknown): ModelRun {
  jsonValue(value, '$')
  const record = object(value, '$')
  exactKeys(record, ['id', 'model', 'version', 'inputRefs', 'parameters', 'output', 'warnings', 'createdAt'], [], '$')
  const actualId = id(record.id, 'model', '$.id')
  string(record.model, '$.model')
  string(record.version, '$.version')
  const refs = array(record.inputRefs, '$.inputRefs', modelInputRef)
  if (refs.length === 0) fail('$.inputRefs', 'at least one input reference is required')
  jsonObject(record.parameters, '$.parameters')
  modelRunOutput(record.output, '$.output')
  stringArray(record.warnings, '$.warnings')
  timestamp(record.createdAt, '$.createdAt')
  const { id: _discarded, ...content } = value as ModelRun
  verifyContentId(actualId, modelRunId(content), '$.id')
  return value as ModelRun
}

function gap(value: unknown, path: string): Gap {
  const record = object(value, path)
  exactKeys(record, ['operation', 'reasonCode', 'detail', 'attemptedCapabilities'], [], path)
  string(record.operation, `${path}.operation`)
  oneOf(record.reasonCode, GAP_REASON_CODES, `${path}.reasonCode`)
  string(record.detail, `${path}.detail`)
  array(record.attemptedCapabilities, `${path}.attemptedCapabilities`, (entry, entryPath) => (
    oneOf(entry, DATA_CAPABILITIES, entryPath) as DataCapability
  ))
  return value as Gap
}

export function validateGap(value: unknown): Gap {
  jsonValue(value, '$')
  return gap(value, '$')
}

export function validateResearchRunManifest(value: unknown): ResearchRunManifest {
  jsonValue(value, '$')
  const record = object(value, '$')
  const status = oneOf(record.status, ['running', 'complete', 'incomplete', 'failed', 'stale'] as const, '$.status')
  const required = [
    'runId', 'caseId', 'asOf', 'startedAt', 'codeVersion', 'configVersion', 'configHash',
    'modelVersion', 'artifactHashes', 'status', 'gaps',
  ]
  exactKeys(record, status === 'running' ? required : [...required, 'finishedAt'], [], '$')
  const actualId = id(record.runId, 'run', '$.runId')
  id(record.caseId, 'case', '$.caseId')
  temporal(record.asOf, '$.asOf')
  const startedAt = timestamp(record.startedAt, '$.startedAt')
  string(record.codeVersion, '$.codeVersion')
  string(record.configVersion, '$.configVersion')
  contentHash(record.configHash, '$.configHash')
  string(record.modelVersion, '$.modelVersion')
  const hashes = object(record.artifactHashes, '$.artifactHashes')
  for (const [artifactPath, hash] of Object.entries(hashes)) {
    string(artifactPath, '$.artifactHashes.<key>')
    if (artifactPath.startsWith('/') || artifactPath.split('/').includes('..')) {
      fail(`$.artifactHashes.${artifactPath}`, 'artifact path must be relative and cannot traverse parents')
    }
    contentHash(hash, `$.artifactHashes.${artifactPath}`)
  }
  array(record.gaps, '$.gaps', gap)
  if (status !== 'running') {
    const finishedAt = timestamp(record.finishedAt, '$.finishedAt')
    if (Date.parse(finishedAt) < Date.parse(startedAt)) fail('$.finishedAt', 'cannot precede startedAt')
  }
  verifyContentId(actualId, researchRunId(value as ResearchRunManifest), '$.runId')
  return value as ResearchRunManifest
}

export function isResearchCase(value: unknown): value is ResearchCase {
  try { validateResearchCase(value); return true } catch { return false }
}

export function isSourceRef(value: unknown): value is SourceRef {
  try { validateSourceRef(value); return true } catch { return false }
}

export function isEvidence(value: unknown): value is Evidence {
  try { validateEvidence(value); return true } catch { return false }
}

export function isAssumption(value: unknown): value is Assumption {
  try { validateAssumption(value); return true } catch { return false }
}

export function isClaim(value: unknown): value is Claim {
  try { validateClaim(value); return true } catch { return false }
}

export function isModelRun(value: unknown): value is ModelRun {
  try { validateModelRun(value); return true } catch { return false }
}

export function isGap(value: unknown): value is Gap {
  try { validateGap(value); return true } catch { return false }
}

export function isResearchRunManifest(value: unknown): value is ResearchRunManifest {
  try { validateResearchRunManifest(value); return true } catch { return false }
}
