import type { Evidence, JsonValue, ModelRun } from '@finance2dsh/research-core'

import {
  type NumberFidelityResult,
  type NumberLexicon,
  type NumberToken,
} from './contracts.js'
import { createFinancialNumberLexicon } from './financial-lexicon.js'

const REFERENCE_RE = /(?<![\w-])(?:ev|model)-[0-9a-f]{64}(?![\w-])/gu
const NUMBER_RE = /(?<![\w.])[-+−－]?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?\s*(?:万亿元|亿元|万元|百分点|万亿|亿|万|千|元|%|倍|[xX])?/giu

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\$\{\}()|[\]\\]/gu, '\\$&')
}

function sectionLines(report: string): Array<{ line: number; section?: string; text: string }> {
  let section: string | undefined
  return report.split(/\r?\n/u).map((text, index) => {
    const heading = /^##\s+(.+?)\s*$/u.exec(text)
    if (heading?.[1] !== undefined) section = heading[1]
    return { line: index + 1, ...(section === undefined ? {} : { section }), text }
  })
}

function stripIgnored(line: string, lexicon: NumberLexicon): string {
  let stripped = line.replace(REFERENCE_RE, match => ' '.repeat(match.length))
  for (const pattern of lexicon.ignoredPatterns) {
    stripped = stripped.replace(new RegExp(pattern.source, pattern.flags), match => ' '.repeat(match.length))
  }
  for (const code of lexicon.subjectCodes ?? []) {
    const pattern = new RegExp('(?<![\\w.])' + escapeRegExp(code) + '(?![\\w.])', 'gu')
    stripped = stripped.replace(pattern, match => ' '.repeat(match.length))
  }
  return stripped
}

function uniqueFinite(values: readonly number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))]
}

export function extractNumberTokens(
  line: string,
  lexicon: NumberLexicon = createFinancialNumberLexicon(),
): NumberToken[] {
  const stripped = stripIgnored(line, lexicon)
  const tokens: NumberToken[] = []
  for (const match of stripped.matchAll(NUMBER_RE)) {
    const raw = match[0].trim()
    const numericText = /^[-+−－]?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?/iu.exec(raw)?.[0]
    if (numericText === undefined) continue
    const numeric = Number(numericText.replace(/[−－]/gu, '-').replace(/,/gu, ''))
    if (!Number.isFinite(numeric)) continue
    const suffix = raw.slice(numericText.length).trim()
    const scale = lexicon.unitScales[suffix] ?? 1
    const normalized = numeric * scale
    const values = lexicon.percentSuffixes.includes(suffix)
      ? [normalized, normalized / 100]
      : [normalized]
    tokens.push({ raw, numeric, normalizedValues: uniqueFinite(values), index: match.index ?? 0 })
  }
  return tokens
}

function numericLeaves(value: JsonValue | undefined, depth = 0): number[] {
  if (value === undefined || value === null || depth > 8) return []
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : []
  if (typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(item => numericLeaves(item, depth + 1))
  return Object.values(value).flatMap(item => numericLeaves(item, depth + 1))
}

interface DisplayProjection {
  value?: number
  display: string
}

function displayProjections(value: JsonValue | undefined, depth = 0): DisplayProjection[] {
  if (value === undefined || value === null || typeof value !== 'object' || depth > 8) return []
  if (Array.isArray(value)) return value.flatMap(item => displayProjections(item, depth + 1))
  const record = value as Readonly<Record<string, JsonValue>>
  const own = typeof record.display === 'string'
    ? [{
        ...(typeof record.value === 'number' ? { value: record.value } : {}),
        display: record.display,
      }]
    : []
  return own.concat(Object.values(record).flatMap(item => displayProjections(item, depth + 1)))
}

function approximatelyEqual(left: number, right: number): boolean {
  const tolerance = Math.max(0.005, Math.abs(right) * 0.0005)
  return Math.abs(left - right) <= tolerance
}

function bindsEvidence(token: NumberToken, evidence: readonly Evidence[], lexicon: NumberLexicon): boolean {
  const pool = evidence.flatMap(item => {
    const scale = lexicon.unitScales[item.unit ?? ''] ?? 1
    return numericLeaves(item.value).map(value => value * scale)
  })
  return token.normalizedValues.some(candidate => pool.some(value => approximatelyEqual(candidate, value)))
}

function normalizeDisplay(value: string): string {
  return value.replace(/[−－]/gu, '-').replace(/,/gu, '').replace(/\s+/gu, '').trim()
}

function bindsModelDisplay(token: NumberToken, modelRuns: readonly ModelRun[]): 'bound' | 'missing-display' | 'unbound' {
  const successful = modelRuns.flatMap(run => run.output.status === 'ok' ? [run.output] : [])
  const projections = successful.flatMap(output => displayProjections(output.value))
  const normalizedToken = normalizeDisplay(token.raw)
  if (projections.some(item => normalizeDisplay(item.display) === normalizedToken)) return 'bound'
  const rawOutputs = successful.flatMap(output => numericLeaves(output.value))
  if (rawOutputs.some(value => token.normalizedValues.some(candidate => approximatelyEqual(candidate, value)))) {
    return 'missing-display'
  }
  return 'unbound'
}

/** Check every numeric claim against evidence or calculation display cited on the same line. */
export function checkNumberFidelity(
  report: string,
  evidence: readonly Evidence[],
  modelRuns: readonly ModelRun[],
  lexicon: NumberLexicon = createFinancialNumberLexicon(),
): NumberFidelityResult {
  const evidenceById = new Map(evidence.map(item => [item.id, item]))
  const modelById = new Map(modelRuns.map(item => [item.id, item]))
  const findings: NumberFidelityResult['findings'] = []
  let checked = 0
  let bound = 0

  for (const row of sectionLines(report)) {
    if (/^\s*#{1,6}\s/u.test(row.text) || /^\s*\u0060\u0060\u0060/u.test(row.text)) continue
    const refs = [...row.text.matchAll(REFERENCE_RE)].map(match => match[0])
    const citedEvidence = refs.flatMap(id => evidenceById.get(id) ?? [])
    const citedModels = refs.flatMap(id => modelById.get(id) ?? [])
    for (const token of extractNumberTokens(row.text, lexicon)) {
      checked += 1
      if (bindsEvidence(token, citedEvidence, lexicon)) {
        bound += 1
        continue
      }
      const modelBinding = bindsModelDisplay(token, citedModels)
      if (modelBinding === 'bound') {
        bound += 1
        continue
      }
      findings.push({
        line: row.line,
        ...(row.section === undefined ? {} : { section: row.section }),
        token: token.raw,
        refs,
        reason: modelBinding,
      })
    }
  }
  return { checked, bound, findings }
}
