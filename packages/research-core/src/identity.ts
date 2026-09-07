import { createHash } from 'node:crypto'

import type {
  Assumption,
  Claim,
  Evidence,
  JsonValue,
  ModelRun,
  ResearchCase,
  ResearchRunManifest,
} from './contracts.js'

const ID_PREFIXES = ['case', 'ev', 'asm', 'claim', 'model', 'run'] as const
export type ResearchIdPrefix = typeof ID_PREFIXES[number]
type WithoutId<T extends { id: string }> = T extends unknown ? Omit<T, 'id'> : never

function canonicalize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`)
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Non-JSON value at ${path}: ${typeof value}`)
  }
  if (seen.has(value)) throw new TypeError(`Circular JSON value at ${path}`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError(`Sparse array entry at ${path}[${index}]`)
        items.push(canonicalize(value[index], `${path}[${index}]`, seen))
      }
      return `[${items.join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain JSON object at ${path}`)
    }
    const record = value as Record<string, unknown>
    const entries = Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, seen)}`
    ))
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

/** Deterministic JSON: object keys are sorted recursively; array order is retained. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, '$', new Set())
}

export function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

export function researchContentId(prefix: ResearchIdPrefix, value: unknown): string {
  return `${prefix}-${sha256(value).slice('sha256:'.length)}`
}

export function researchCaseId(
  value: Pick<ResearchCase, 'subject' | 'mandate' | 'asOf' | 'createdAt'>,
): string {
  return researchContentId('case', {
    subject: value.subject,
    mandate: value.mandate,
    asOf: value.asOf,
    createdAt: value.createdAt,
  })
}

export function evidenceId(value: WithoutId<Evidence>): string {
  return researchContentId('ev', value)
}

export function assumptionId(value: WithoutId<Assumption>): string {
  return researchContentId('asm', value)
}

export function claimId(value: Omit<Claim, 'id'>): string {
  return researchContentId('claim', value)
}

export function modelRunId(value: Omit<ModelRun, 'id'>): string {
  return researchContentId('model', value)
}

export function researchRunId(
  value: Pick<ResearchRunManifest, 'caseId' | 'asOf' | 'startedAt'>,
): string {
  return researchContentId('run', {
    caseId: value.caseId,
    asOf: value.asOf,
    startedAt: value.startedAt,
  })
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalJson(value)
    return true
  } catch {
    return false
  }
}
