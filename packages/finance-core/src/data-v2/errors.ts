export const DATA_ERROR_KINDS = [
  'invalid-request',
  'ambiguous-instrument',
  'conflicting-instrument',
  'unsupported',
  'no-data',
  'unauthorized',
  'insufficient-permission',
  'rate-limited',
  'provider-error',
  'schema-drift',
  'timeout',
  'transport',
  'aborted',
  'circuit-open',
  'stale',
] as const

export type DataErrorKind = typeof DATA_ERROR_KINDS[number]

const NON_RETRYABLE_KINDS: ReadonlySet<DataErrorKind> = new Set([
  'invalid-request',
  'ambiguous-instrument',
  'conflicting-instrument',
  'unsupported',
  'no-data',
  'unauthorized',
  'insufficient-permission',
  'schema-drift',
  'aborted',
])

export interface DataErrorOptions extends ErrorOptions {
  provider?: string
  statusCode?: number
  retryAfterMs?: number
  details?: Readonly<Record<string, unknown>>
  retryable?: boolean
}

export class FinanceDataError extends Error {
  readonly retryable: boolean
  readonly provider?: string
  readonly statusCode?: number
  readonly retryAfterMs?: number
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    message: string,
    readonly kind: DataErrorKind,
    options: DataErrorOptions = {},
  ) {
    super(message, options)
    this.name = 'FinanceDataError'
    this.retryable = options.retryable ?? !NON_RETRYABLE_KINDS.has(kind)
    if (options.provider !== undefined) this.provider = options.provider
    if (options.statusCode !== undefined) this.statusCode = options.statusCode
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.details !== undefined) this.details = options.details
  }
}

export function isFinanceDataError(value: unknown): value is FinanceDataError {
  return value instanceof FinanceDataError
}

export function dataErrorKind(value: unknown): DataErrorKind {
  if (value instanceof FinanceDataError) return value.kind
  if (value instanceof DOMException && value.name === 'AbortError') return 'aborted'
  if (value !== null && typeof value === 'object') {
    const candidate = value as { kind?: unknown; status?: unknown; statusCode?: unknown; code?: unknown }
    if (typeof candidate.kind === 'string' && DATA_ERROR_KINDS.includes(candidate.kind as DataErrorKind)) {
      return candidate.kind as DataErrorKind
    }
    const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode
    if (status === 401) return 'unauthorized'
    if (status === 403) return 'insufficient-permission'
    if (status === 429) return 'rate-limited'
    if (typeof status === 'number' && status >= 500) return 'provider-error'
    if (status === 404) return 'no-data'
    if (typeof status === 'number' && status >= 400) return 'invalid-request'
    if (candidate.code === 'ETIMEDOUT') return 'timeout'
  }
  return 'provider-error'
}

export function isRetryableDataError(value: unknown): boolean {
  if (value instanceof FinanceDataError) return value.retryable
  if (value !== null && typeof value === 'object'
    && typeof (value as { retryable?: unknown }).retryable === 'boolean') {
    return (value as { retryable: boolean }).retryable
  }
  const kind = dataErrorKind(value)
  return !NON_RETRYABLE_KINDS.has(kind)
}
