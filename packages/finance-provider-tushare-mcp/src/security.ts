import { FinanceDataError } from '@finance2dsh/core'
import type { DataErrorKind } from '@finance2dsh/core'

export const REDACTED = '[REDACTED]'

const SENSITIVE_KEY = /(?:^|[-_.])(access[-_]?token|api[-_]?key|apikey|auth[-_]?token|bearer[-_]?token|client[-_]?secret|authorization|auth|cookie|credential|password|secret|signature|sig|token)(?:$|[-_.])/i
const LONG_SECRET = /^[A-Za-z0-9_~+./=-]{20,}$/
const OFFICIAL_HOST = 'api.tushare.pro'

export interface ResolvedTushareEndpoint {
  url: URL
  redactedUrl: string
  secrets: readonly string[]
}

export type TushareFailureReason =
  | 'missing-configuration'
  | 'invalid-token'
  | 'insufficient-points'
  | 'insufficient-permission'
  | 'rate-limited'
  | 'no-data'
  | 'timeout'
  | 'aborted'
  | 'transport'
  | 'schema-drift'
  | 'provider-error'

export class TushareMcpError extends FinanceDataError {
  constructor(
    message: string,
    kind: DataErrorKind,
    readonly reason: TushareFailureReason,
    options: ConstructorParameters<typeof FinanceDataError>[2] = {},
  ) {
    super(message, kind, { ...options, provider: 'tushare-mcp' })
    this.name = 'TushareMcpError'
  }
}

function redactPath(pathname: string): string {
  const parts = pathname.split('/')
  let redactNext = false
  return parts.map(part => {
    if (part === '') return part
    if (redactNext) {
      redactNext = false
      return REDACTED
    }
    const separator = part.indexOf('=')
    if (separator > 0 && SENSITIVE_KEY.test(part.slice(0, separator))) {
      return `${part.slice(0, separator + 1)}${REDACTED}`
    }
    if (LONG_SECRET.test(part)) return REDACTED
    if (SENSITIVE_KEY.test(part)) redactNext = true
    return part
  }).join('/')
}

export function redactTushareUrl(value: string | URL): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return REDACTED
  }
  if (!['http:', 'https:'].includes(url.protocol)) return REDACTED
  const path = redactPath(url.pathname)
  const query = new URLSearchParams()
  for (const [key, item] of url.searchParams) {
    query.append(key, SENSITIVE_KEY.test(key) || LONG_SECRET.test(item) ? REDACTED : item)
  }
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return `${url.origin}${path}${suffix}`.replaceAll('%5BREDACTED%5D', REDACTED)
}

export function redactTushareText(value: string, secrets: readonly string[] = []): string {
  let result = value
  result = result.replace(/https?:\/\/[^\s<>"']+/gi, match => redactTushareUrl(match))
  result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, `$1 ${REDACTED}`)
  result = result.replace(
    /\b(access[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|token|api[-_]?key|apikey|authorization|auth|cookie|credential|password|secret|signature|sig)\b(\s*[:=]\s*)([^\s,;]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  )
  for (const secret of secrets) {
    if (secret !== '') result = result.split(secret).join(REDACTED)
  }
  return result
}

export function resolveTushareEndpoint(options: {
  url?: string
  token?: string
  env?: NodeJS.ProcessEnv
} = {}): ResolvedTushareEndpoint | undefined {
  const env = options.env ?? process.env
  const explicitToken = options.token?.trim() || env.TUSHARE_TOKEN?.trim()
  const configuredUrl = options.url?.trim() || env.TUSHARE_MCP_URL?.trim()
  if (configuredUrl === undefined && explicitToken === undefined) return undefined

  let url: URL
  try {
    const tokenEndpoint = 'https://api.tushare.pro/mcp/' + 'token='
      + encodeURIComponent(explicitToken as string)
    url = new URL(configuredUrl ?? tokenEndpoint)
  } catch {
    throw new TushareMcpError('TUSHARE_MCP_URL is not a valid URL', 'invalid-request', 'missing-configuration')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== OFFICIAL_HOST) {
    throw new TushareMcpError(
      `TuShare MCP endpoint must use https://${OFFICIAL_HOST}`,
      'invalid-request',
      'missing-configuration',
    )
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new TushareMcpError(
      'TuShare MCP endpoint cannot contain user-info or a fragment',
      'invalid-request',
      'missing-configuration',
    )
  }
  if (explicitToken !== undefined && configuredUrl !== undefined) {
    const parts = url.pathname.split('/')
    const pathToken = parts.findIndex(part => /^token=/i.test(part))
    if (pathToken >= 0) {
      parts.splice(pathToken, 1)
      url.pathname = parts.join('/')
    }
    url.searchParams.set('token', explicitToken)
  }

  const secrets = new Set<string>()
  if (explicitToken !== undefined) secrets.add(explicitToken)
  for (const [key, value] of url.searchParams) {
    if (SENSITIVE_KEY.test(key) && value !== '') secrets.add(value)
  }
  const pathParts = url.pathname.split('/')
  for (const [index, part] of pathParts.entries()) {
    const separator = part.indexOf('=')
    if (separator > 0 && SENSITIVE_KEY.test(part.slice(0, separator))) {
      const value = part.slice(separator + 1)
      if (value !== '') secrets.add(value)
    } else if (SENSITIVE_KEY.test(part)) {
      const value = pathParts[index + 1]
      if (value !== undefined && value !== '') secrets.add(value)
    }
  }

  return { url, redactedUrl: redactTushareUrl(url), secrets: [...secrets] }
}

function numericStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown }
  for (const value of [candidate.status, candidate.statusCode, candidate.code]) {
    if (typeof value === 'number' && value >= 100 && value <= 599) return value
  }
  return undefined
}

export function classifyTushareError(error: unknown, secrets: readonly string[] = []): TushareMcpError {
  if (error instanceof TushareMcpError) {
    const safeMessage = redactTushareText(error.message, secrets).slice(0, 2_048)
    if (safeMessage === error.message && error.cause === undefined) return error
    return new TushareMcpError(safeMessage, error.kind, error.reason, {
      retryable: error.retryable,
      ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    })
  }
  const original = error instanceof Error ? error : new Error(String(error))
  const message = redactTushareText(original.message || original.name, secrets).slice(0, 2_048)
  const normalized = `${original.name} ${message}`.toLowerCase()
  const status = numericStatus(error)

  let kind: DataErrorKind = 'provider-error'
  let reason: TushareFailureReason = 'provider-error'
  if (original.name === 'AbortError' || /\babort(?:ed)?\b|取消/.test(normalized)) {
    kind = 'aborted'; reason = 'aborted'
  } else if (/timeout|timed out|超时/.test(normalized)) {
    kind = 'timeout'; reason = 'timeout'
  } else if (status === 401 || /invalid.{0,12}token|token.{0,12}(invalid|expired|无效|过期)|无效.{0,4}token|未授权|认证失败/.test(normalized)) {
    kind = 'unauthorized'; reason = 'invalid-token'
  } else if (/积分|insufficient.{0,12}(points?|credits?)|points?.{0,12}insufficient/.test(normalized)) {
    kind = 'insufficient-permission'; reason = 'insufficient-points'
  } else if (status === 403 || /40203|无.{0,4}权限|没有接口.*访问权限|permission denied|insufficient.{0,12}(permission|scope)/.test(normalized)) {
    kind = 'insufficient-permission'; reason = 'insufficient-permission'
  } else if (status === 429 || /rate.?limit|too many requests|频率|限流/.test(normalized)) {
    kind = 'rate-limited'; reason = 'rate-limited'
  } else if (/no data|empty result|暂无数据|没有数据/.test(normalized)) {
    kind = 'no-data'; reason = 'no-data'
  } else if (/schema|malformed|invalid .*result|unexpected content|duplicate tool|pagination/.test(normalized)) {
    kind = 'schema-drift'; reason = 'schema-drift'
  } else if (/fetch failed|network|econn|connection|socket|streamable http|transport/.test(normalized)) {
    kind = status !== undefined && status >= 500 ? 'provider-error' : 'transport'
    reason = kind === 'transport' ? 'transport' : 'provider-error'
  }

  return new TushareMcpError(message, kind, reason, {
    retryable: !['aborted', 'unauthorized', 'insufficient-permission', 'no-data', 'schema-drift', 'invalid-request'].includes(kind),
    ...(status === undefined ? {} : { statusCode: status }),
  })
}
