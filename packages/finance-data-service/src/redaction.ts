const SENSITIVE_KEY = /(?:^|[-_.])(access[-_]?token|api[-_]?key|apikey|auth[-_]?token|bearer[-_]?token|client[-_]?secret|authorization|auth|cookie|credential|password|secret|signature|sig|token)(?:$|[-_.])/i
const LONG_SECRET = /^(?=[A-Za-z0-9_~+./=-]{20,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_~+./=-]+$/
export const REDACTED = '[REDACTED]'

function redactPath(pathname: string): string {
  const parts = pathname.split('/')
  let redactNext = false
  return parts.map(part => {
    if (part === '') return part
    if (redactNext || LONG_SECRET.test(part)) {
      redactNext = false
      return REDACTED
    }
    const separator = part.indexOf('=')
    if (separator > 0 && SENSITIVE_KEY.test(part.slice(0, separator))) {
      return `${part.slice(0, separator + 1)}${REDACTED}`
    }
    if (SENSITIVE_KEY.test(part)) redactNext = true
    return part
  }).join('/')
}

/** Returns an origin plus a sanitized path/query; credentials and fragments never survive. */
export function redactUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return REDACTED
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return REDACTED
  const safe = new URL(parsed.origin)
  safe.pathname = redactPath(parsed.pathname)
  for (const [key, queryValue] of parsed.searchParams) {
    safe.searchParams.append(key, SENSITIVE_KEY.test(key) || LONG_SECRET.test(queryValue) ? REDACTED : queryValue)
  }
  return safe.toString().replace(/\/$/, parsed.pathname === '/' && parsed.search === '' ? '/' : '')
}

/** Redacts URLs, authorization values, cookies, and common key/value secret forms. */
export function redactSensitiveText(value: string, secrets: readonly string[] = []): string {
  let redacted = value
  redacted = redacted.replace(/https?:\/\/[^\s<>"']+/gi, match => redactUrl(match))
  redacted = redacted.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, `$1 ${REDACTED}`)
  redacted = redacted.replace(
    /\b(access[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|token|api[-_]?key|apikey|authorization|auth|cookie|credential|password|secret|signature|sig)\b(\s*[:=]\s*)([^\s,;]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  )
  redacted = redacted.replace(/[A-Za-z0-9_~+./=-]{20,}/g, candidate => (
    LONG_SECRET.test(candidate) ? REDACTED : candidate
  ))
  redacted = redacted.replace(
    /\b(access[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|token|api[-_]?key|apikey|authorization|auth|cookie|credential|password|secret|signature|sig)\b(\s+)([A-Za-z0-9._~+\/=-]{8,})/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  )
  for (const secret of secrets) {
    if (secret !== '') redacted = redacted.split(secret).join(REDACTED)
  }
  return redacted
}
