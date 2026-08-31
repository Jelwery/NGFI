import type { FieldStatus, ObservedField } from './contracts.js'

export function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function observedNumber(
  value: unknown,
  status: FieldStatus = 'missing',
  note?: string,
): ObservedField<number> {
  const normalized = finiteNumber(value)
  if (normalized !== null) return { status: 'available', value: normalized }
  return note === undefined ? { status, value: null } : { status, value: null, note }
}

export function observedString(
  value: unknown,
  status: FieldStatus = 'missing',
  note?: string,
): ObservedField<string> {
  const normalized = nonEmptyString(value)
  if (normalized !== null) return { status: 'available', value: normalized }
  return note === undefined ? { status, value: null } : { status, value: null, note }
}

export function assertJsonSafe(value: unknown, path = '$'): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Non-finite number at ${path}`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertJsonSafe(child, `${path}.${key}`)
    }
  }
}

export function requireTicker(value: string): string {
  const ticker = value.trim().toUpperCase()
  if (!/^[A-Z0-9^.=/-]{1,32}$/.test(ticker)) {
    throw new TypeError('ticker must be 1-32 characters using letters, digits, ^, ., =, / or -')
  }
  return ticker
}
