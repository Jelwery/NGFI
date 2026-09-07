import {
  canonicalJson,
  sha256,
  type Evidence,
  type ModelInputRef,
  type ModelRun,
  type ResearchRefKind,
} from '@finance2dsh/research-core'

import {
  type AuditFinding,
  type AuditReviewSample,
  type ResearchAuditInput,
  type ResearchAuditResult,
  type SourceConflict,
  type SourceConflictResolution,
} from './contracts.js'
import { createFinancialNumberLexicon } from './financial-lexicon.js'
import { checkNumberFidelity, extractNumberTokens } from './number-fidelity.js'

const REFERENCE_RE = /(?<![\w-])(?:ev|model)-[0-9a-f]{64}(?![\w-])/gu

function finding(
  code: AuditFinding['code'],
  message: string,
  details: Partial<Omit<AuditFinding, 'code' | 'severity' | 'message'>> = {},
): AuditFinding {
  return { code, severity: 'error', message, refs: [], ...details }
}

function findDuplicateIds(groups: readonly (readonly { id: string }[])[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) duplicates.add(item.id)
      seen.add(item.id)
    }
  }
  return [...duplicates].sort()
}

function factKey(item: Evidence): string | undefined {
  if (item.field === undefined) return undefined
  return canonicalJson({
    subject: item.subject,
    field: item.field,
    period: item.period ?? null,
    unit: item.unit ?? null,
    currency: item.currency ?? null,
    adjustment: item.sourceRef.provenance?.adjustment ?? null,
  })
}

export function detectSourceConflicts(evidence: readonly Evidence[]): SourceConflict[] {
  const groups = new Map<string, Evidence[]>()
  for (const item of evidence) {
    const key = factKey(item)
    if (key === undefined || item.value === undefined) continue
    const values = groups.get(key) ?? []
    values.push(item)
    groups.set(key, values)
  }
  const conflicts: SourceConflict[] = []
  for (const [key, values] of groups) {
    const sources = new Set(values.map(item => item.sourceRef.provider + '\u0000' + item.sourceRef.upstream))
    const distinct = new Set(values.map(item => canonicalJson(item.value)))
    if (sources.size < 2 || distinct.size < 2) continue
    const evidenceRefs = values.map(item => item.id).sort()
    conflicts.push({
      id: sha256({ factKey: key, evidenceRefs }),
      factKey: key,
      evidenceRefs,
      values: values.map(item => ({
        evidenceId: item.id,
        provider: item.sourceRef.provider,
        value: item.value,
      })),
    })
  }
  return conflicts.sort((left, right) => left.id.localeCompare(right.id))
}

function resolutionCovers(conflict: SourceConflict, resolutions: readonly SourceConflictResolution[]): boolean {
  const required = new Set(conflict.evidenceRefs)
  return resolutions.some(resolution => (
    resolution.conflictId === conflict.id
    && resolution.rationale.trim() !== ''
    && [...required].every(id => resolution.evidenceRefs.includes(id))
  ))
}

function inputExists(
  ref: ModelInputRef,
  indices: Readonly<Record<ResearchRefKind, ReadonlySet<string>>>,
): boolean {
  return indices[ref.kind].has(ref.id)
}

function calculationFindings(input: ResearchAuditInput): AuditFinding[] {
  const assumptions = input.assumptions ?? []
  const claims = input.claims ?? []
  const indices: Record<ResearchRefKind, ReadonlySet<string>> = {
    evidence: new Set(input.evidence.map(item => item.id)),
    assumption: new Set(assumptions.map(item => item.id)),
    claim: new Set(claims.map(item => item.id)),
    'model-run': new Set(input.modelRuns.map(item => item.id)),
  }
  const findings: AuditFinding[] = []
  for (const assumption of assumptions) {
    for (const ref of assumption.evidenceRefs) {
      if (!indices.evidence.has(ref)) {
        findings.push(finding('missing-input-ref', 'Assumption ' + assumption.id + ' has missing evidence input ' + ref, {
          refs: [assumption.id, ref],
        }))
      }
    }
  }
  for (const claim of claims) {
    for (const ref of [...claim.evidenceRefs, ...claim.counterEvidenceRefs]) {
      if (!indices.evidence.has(ref)) {
        findings.push(finding('missing-input-ref', 'Claim ' + claim.id + ' has missing evidence input ' + ref, {
          refs: [claim.id, ref],
        }))
      }
    }
  }
  for (const run of input.modelRuns) {
    for (const ref of run.inputRefs) {
      if (!inputExists(ref, indices)) {
        findings.push(finding(
          'missing-input-ref',
          'Calculation ' + run.id + ' has missing ' + ref.kind + ' input ' + ref.id,
          { refs: [run.id, ref.id] },
        ))
      }
    }
  }

  const byId = new Map(input.modelRuns.map(run => [run.id, run]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const reported = new Set<string>()
  const visit = (run: ModelRun): void => {
    const current = state.get(run.id)
    if (current === 'visited') return
    if (current === 'visiting') {
      const start = stack.indexOf(run.id)
      const cycle = [...stack.slice(start), run.id]
      const key = [...new Set(cycle)].sort().join('|')
      if (!reported.has(key)) {
        reported.add(key)
        findings.push(finding('calculation-cycle', 'Calculation dependency cycle: ' + cycle.join(' -> '), {
          refs: cycle,
        }))
      }
      return
    }
    state.set(run.id, 'visiting')
    stack.push(run.id)
    for (const ref of run.inputRefs) {
      if (ref.kind !== 'model-run') continue
      const dependency = byId.get(ref.id)
      if (dependency !== undefined) visit(dependency)
    }
    stack.pop()
    state.set(run.id, 'visited')
  }
  for (const run of input.modelRuns) visit(run)
  return findings
}

function reportStructureFindings(input: ResearchAuditInput): AuditFinding[] {
  const findings: AuditFinding[] = []
  if (input.report.trim() === '') findings.push(finding('empty-report', 'Report is empty'))
  const headings = new Set(
    input.report.split(/\r?\n/u).flatMap(line => /^##\s+(.+?)\s*$/u.exec(line)?.[1]?.trim() ?? []),
  )
  for (const section of input.requiredSections ?? []) {
    if (!headings.has(section)) {
      findings.push(finding('missing-section', 'Required report section is missing: ' + section, { section }))
    }
  }
  const available = new Set([...input.evidence.map(item => item.id), ...input.modelRuns.map(item => item.id)])
  const cited = [...input.report.matchAll(REFERENCE_RE)].map(match => match[0])
  for (const id of [...new Set(cited)].sort()) {
    if (!available.has(id)) findings.push(finding('invalid-citation', 'Report cites unknown reference ' + id, { refs: [id] }))
  }
  if (input.report.trim() !== '' && input.evidence.length === 0 && input.modelRuns.length === 0) {
    findings.push(finding('missing-citation', 'A non-empty report requires evidence or calculations'))
  } else if (input.report.trim() !== '' && cited.length === 0) {
    findings.push(finding('missing-citation', 'Report contains no evidence or calculation citations'))
  }
  return findings
}

function sampleReviewItems(
  report: string,
  checked: number,
  size: number,
  seed: string,
  lexicon: NonNullable<ResearchAuditInput['lexicon']>,
): AuditReviewSample[] {
  if (size <= 0) return []
  const candidates: AuditReviewSample[] = []
  const lines = report.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const refs = [...line.matchAll(REFERENCE_RE)].map(match => match[0])
    if (refs.length === 0) continue
    for (const token of extractNumberTokens(line, lexicon)) {
      candidates.push({ line: index + 1, token: token.raw, refs })
    }
  }
  return candidates
    .map(item => ({ item, order: sha256({ seed, ...item }) }))
    .sort((left, right) => left.order.localeCompare(right.order))
    .slice(0, Math.min(size, checked, candidates.length))
    .map(entry => entry.item)
}

/** Run all report gates without mutating the report or workspace. */
export function auditResearchReport(input: ResearchAuditInput): ResearchAuditResult {
  const assumptions = input.assumptions ?? []
  const claims = input.claims ?? []
  const findings: AuditFinding[] = reportStructureFindings(input)
  for (const duplicate of findDuplicateIds([input.evidence, assumptions, claims, input.modelRuns])) {
    findings.push(finding('duplicate-id', 'Research objects repeat id ' + duplicate, { refs: [duplicate] }))
  }
  findings.push(...calculationFindings(input))

  const lexicon = input.lexicon ?? createFinancialNumberLexicon()
  const numberFidelity = checkNumberFidelity(
    input.report,
    input.evidence,
    input.modelRuns,
    lexicon,
  )
  for (const issue of numberFidelity.findings) {
    findings.push(finding(
      issue.reason === 'missing-display' ? 'missing-display' : 'unbound-number',
      issue.reason === 'missing-display'
        ? 'Calculation number ' + issue.token + ' must use its declared display value'
        : 'Number ' + issue.token + ' is not bound to a same-line citation',
      {
        line: issue.line,
        ...(issue.section === undefined ? {} : { section: issue.section }),
        refs: issue.refs,
        token: issue.token,
      },
    ))
  }

  const conflicts = detectSourceConflicts(input.evidence)
  for (const conflict of conflicts) {
    if (!resolutionCovers(conflict, input.conflictResolutions ?? [])) {
      findings.push(finding(
        'unhandled-source-conflict',
        'Source conflict ' + conflict.id + ' is not explicitly resolved',
        { refs: conflict.evidenceRefs },
      ))
    }
  }

  const gaps = [
    ...(input.manifest?.gaps ?? []),
    ...(input.gaps ?? []),
  ]
  if (input.manifest?.status === 'complete' && gaps.length > 0) {
    findings.push(finding('status-gap-mismatch', 'A complete run cannot contain unresolved gaps'))
  }
  if (input.manifest !== undefined && input.manifest.status !== 'complete' && input.manifest.status !== 'running'
      && gaps.length === 0) {
    findings.push(finding('status-gap-mismatch', 'A non-complete terminal run must explain its outcome with a gap'))
  }
  if (input.manifest?.status === 'running') {
    findings.push(finding('status-gap-mismatch', 'A running manifest cannot pass a final report gate'))
  }
  const passed = findings.every(item => item.severity !== 'error')
  const sampleSize = Math.max(0, Math.floor(input.sampleSize ?? 0))
  return {
    passed,
    allowedStatus: passed && gaps.length === 0 ? 'complete' : 'incomplete',
    findings,
    conflicts,
    numberFidelity,
    reviewSample: sampleReviewItems(
      input.report,
      numberFidelity.checked,
      sampleSize,
      input.sampleSeed ?? 'research-audit-v1',
      lexicon,
    ),
  }
}
