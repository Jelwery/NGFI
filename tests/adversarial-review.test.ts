import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  evidenceId,
  researchCaseId,
  researchRunId,
  type ContentHash,
  type Evidence,
  type ResearchCase,
  type ResearchRunManifest,
  type StructuredEvidence,
} from '@finance2dsh/research-core'
import {
  ResearchWorkspace,
  createSnapshot,
  hashBytes,
  type FrozenReplayManifest,
  type ResearchCaseState,
} from '@finance2dsh/research-workspace'
import {
  ADJUDICATION_SECTIONS,
  AdversarialReviewError,
  createFrozenEvidenceDossier,
  loadFrozenEvidenceDossier,
  startAdversarialReview,
  type AdversarialChatExecutor,
  type AdversarialChatRequest,
  type FrozenEvidenceDossier,
} from '@finance2dsh/research-workflow'

const clock = '2026-09-06T08:00:00.000Z'
const hash = (character: string): ContentHash => `sha256:${character.repeat(64)}`
const subject = {
  kind: 'instrument' as const,
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
}

function evidence(excerpt = 'Audited revenue'): Evidence {
  const content: Omit<StructuredEvidence, 'id'> = {
    kind: 'structured',
    subject,
    field: 'revenue',
    value: 181_200_000_000,
    period: 'FY2025',
    unit: 'CNY',
    quality: 'high',
    sourceRef: {
      provider: 'annual-report',
      upstream: 'annual-report',
      sourceKind: 'official',
      retrievedAt: clock,
    },
    excerpt,
    limitations: [],
  }
  return { id: evidenceId(content), ...content }
}

function frozenFixture(excerpt?: string, maxCharacters?: number): {
  dossier: FrozenEvidenceDossier
  evidence: Evidence
} {
  const ev = evidence(excerpt)
  const evidenceItems = excerpt === undefined ? [ev] : [ev, evidence(excerpt + '-second')]
  const caseContent = {
    subject,
    mandate: 'Challenge the durability of reported earnings',
    asOf: '2026-09-06',
    status: 'active' as const,
    createdAt: clock,
    updatedAt: clock,
  }
  const researchCase: ResearchCase = { caseId: researchCaseId(caseContent), ...caseContent }
  const startedAt = clock
  const sourceRunId = researchRunId({ caseId: researchCase.caseId, asOf: researchCase.asOf, startedAt })
  const sourceManifestHash = hash('b')
  const artifactHash = hash('c')
  const run: ResearchRunManifest = {
    runId: sourceRunId,
    caseId: researchCase.caseId,
    asOf: researchCase.asOf,
    startedAt,
    finishedAt: '2026-09-06T08:01:00.000Z',
    codeVersion: 'git:test',
    configVersion: 'company-research-v1',
    configHash: hash('d'),
    modelVersion: 'fixture',
    artifactHashes: { [`artifacts/${sourceRunId}/report.md`]: artifactHash },
    status: 'complete',
    gaps: [],
  }
  const state: ResearchCaseState = {
    revision: 4,
    case: researchCase,
    evidence: evidenceItems,
    assumptions: [],
    claims: [],
    modelRuns: [],
    memo: '',
    decisions: [],
    runManifests: [run],
    fileHashes: {
      'evidence.jsonl': hash('e'),
      [`artifacts/${sourceRunId}/report.md`]: artifactHash,
      [`runs/${sourceRunId}/manifest.json`]: sourceManifestHash,
      [`runs/${sourceRunId}/artifact-manifest.json`]: hash('6'),
    },
  }
  const files = {
    [`${researchCase.caseId}/evidence.jsonl`]: hash('e'),
    [`${researchCase.caseId}/artifacts/${sourceRunId}/report.md`]: artifactHash,
    [`${researchCase.caseId}/runs/${sourceRunId}/manifest.json`]: sourceManifestHash,
    [`${researchCase.caseId}/runs/${sourceRunId}/artifact-manifest.json`]: hash('6'),
  }
  const treeBody = Object.keys(files).sort().map(file => `${file}\0${files[file as keyof typeof files]}`).join('\n')
  const snapshot: FrozenReplayManifest = {
    schemaVersion: 1,
    kind: 'ngfi-research-frozen-replay',
    caseId: researchCase.caseId,
    sourceRunId,
    sourceRevision: state.revision,
    createdAt: clock,
    sourceManifestHash,
    files,
    treeHash: hashBytes(treeBody),
  }
  return {
    dossier: createFrozenEvidenceDossier({
      state,
      snapshot,
      ...(maxCharacters === undefined ? {} : { maxCharacters }),
    }),
    evidence: ev,
  }
}

function citedText(ev: Evidence, label: string): string {
  return `${label} is grounded in the frozen record [${ev.id}].`
}

function judgeText(ev: Evidence): string {
  return [
    `## ${ADJUDICATION_SECTIONS[0]}`,
    `Reported revenue is in the dossier [${ev.id}].`,
    `## ${ADJUDICATION_SECTIONS[1]}`,
    `Its durability remains disputed [${ev.id}].`,
    `## ${ADJUDICATION_SECTIONS[2]}`,
    `A comparable later period is absent [${ev.id}].`,
    `## ${ADJUDICATION_SECTIONS[3]}`,
    `A later filing using the same basis would resolve the dispute [${ev.id}].`,
  ].join('\n')
}

function stageResponse(request: AdversarialChatRequest, ev: Evidence): string {
  return request.stage.id === 'judge' ? judgeText(ev) : citedText(ev, request.stage.label)
}

describe('frozen adversarial dossier', () => {
  it('rejects an empty or tampered dossier before any chat session starts', () => {
    const fixture = frozenFixture()
    const executor: AdversarialChatExecutor = async () => 'unused'
    expect(() => startAdversarialReview({
      id: 'empty',
      dossier: { ...fixture.dossier, evidence: [] },
      executor,
    })).toThrowError(expect.objectContaining({ code: 'empty-dossier' }))
    expect(() => startAdversarialReview({
      id: 'tampered',
      dossier: { ...fixture.dossier, text: fixture.dossier.text + ' changed' },
      executor,
    })).toThrowError(expect.objectContaining({ code: 'invalid-dossier' }))
  })

  it('records truncation as a visible gap and exposes a deeply immutable dossier', () => {
    const { dossier } = frozenFixture('x'.repeat(500), 2_100)
    expect(dossier.truncated).toBe(true)
    expect(dossier.text.length).toBeLessThanOrEqual(2_100)
    expect(dossier.visibleEvidenceRefs).toHaveLength(1)
    expect(dossier.gaps).toContainEqual(expect.objectContaining({
      operation: 'adversarial-review:dossier',
      reasonCode: 'insufficient',
    }))
    expect(Object.isFrozen(dossier)).toBe(true)
    expect(Object.isFrozen(dossier.evidence)).toBe(true)
    expect(Object.isFrozen(dossier.evidence[0]?.sourceRef)).toBe(true)

    const runner = startAdversarialReview({
      id: 'review-truncated',
      dossier,
      executor: async request => request.stage.id === 'judge'
        ? judgeText(dossier.evidence[0]!)
        : citedText(dossier.evidence[0]!, request.stage.label),
    })
    return expect(runner.runToCompletion()).resolves.toMatchObject({
      done: true,
      outcome: 'completed_with_errors',
      gaps: [expect.objectContaining({ operation: 'adversarial-review:dossier' })],
    })
  })

  it('loads only after the research-workspace frozen replay verifies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-adversarial-workspace-'))
    const snapshotParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-adversarial-snapshot-'))
    const workspace = new ResearchWorkspace({ root, now: () => new Date(clock) })
    let state = workspace.create({ subject, mandate: 'Review evidence', asOf: '2026-09-06', status: 'active' })
    state = workspace.open(state.case.caseId)
    const ev = evidence()
    let revision = workspace.appendEvidence(state.case.caseId, state.revision, [ev]).revision
    const sourceRunId = researchRunId({ caseId: state.case.caseId, asOf: '2026-09-06', startedAt: clock })
    const artifact = workspace.writeArtifact(
      state.case.caseId,
      revision,
      `${sourceRunId}/report.md`,
      `Revenue [${ev.id}].`,
    )
    revision = artifact.revision
    workspace.saveRunManifest(state.case.caseId, revision, {
      runId: sourceRunId,
      caseId: state.case.caseId,
      asOf: '2026-09-06',
      startedAt: clock,
      finishedAt: '2026-09-06T08:01:00.000Z',
      codeVersion: 'git:test',
      configVersion: 'company-research-v1',
      configHash: hash('8'),
      modelVersion: 'fixture',
      artifactHashes: { [artifact.path]: artifact.hash },
      status: 'complete',
      gaps: [],
    })
    const destination = path.join(snapshotParent, 'frozen')
    const snapshot = createSnapshot({
      workspace,
      caseId: state.case.caseId,
      runId: sourceRunId,
      destination,
      createdAt: clock,
    })

    const dossier = loadFrozenEvidenceDossier({ snapshotDirectory: destination })
    expect(dossier).toMatchObject({
      caseId: state.case.caseId,
      sourceRunId,
      sourceTreeHash: snapshot.treeHash,
      visibleEvidenceRefs: [ev.id],
    })
    fs.writeFileSync(path.join(destination, state.case.caseId, 'evidence.jsonl'), '')
    expect(() => loadFrozenEvidenceDossier({ snapshotDirectory: destination })).toThrow(/modified/u)
  })
})

describe('adversarial review orchestration with an injected chat executor', () => {
  it('uses one immutable dossier, a distinct session per role, and exact sees dependencies', async () => {
    const { dossier, evidence: ev } = frozenFixture()
    const calls: AdversarialChatRequest[] = []
    const executor: AdversarialChatExecutor = async request => {
      calls.push(request)
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.dossier)).toBe(true)
      return stageResponse(request, ev)
    }
    const runner = startAdversarialReview({
      id: 'review-sees',
      dossier,
      executor,
      now: () => new Date(clock),
      sessionIdFactory: ({ stageId }) => `session-${stageId}`,
    })
    const result = await runner.runToCompletion()

    expect(result).toMatchObject({ done: true, outcome: 'completed', dossierHash: dossier.hash })
    expect(new Set(calls.map(call => call.sessionId)).size).toBe(5)
    expect(new Set(calls.map(call => call.dossier)).size).toBe(1)
    expect(calls.map(call => [call.stage.id, call.visibleStages.map(stage => stage.id)])).toEqual([
      ['bull', []],
      ['bear', []],
      ['bull-rebuttal', ['bear']],
      ['bear-rebuttal', ['bull']],
      ['judge', ['bull', 'bear', 'bull-rebuttal', 'bear-rebuttal']],
    ])
    expect(result.stages.every(stage => stage.audit?.passed === true)).toBe(true)
  })

  it('rejects concurrent advancement before a second executor call can start', async () => {
    const { dossier, evidence: ev } = frozenFixture()
    let release: ((text: string) => void) | undefined
    let calls = 0
    const executor: AdversarialChatExecutor = () => {
      calls += 1
      return new Promise(resolve => { release = resolve })
    }
    const runner = startAdversarialReview({ id: 'review-race', dossier, executor })
    const first = runner.advance()
    await expect(runner.advance()).rejects.toMatchObject({ code: 'review-busy' })
    expect(calls).toBe(1)
    release?.(citedText(ev, 'Bull case'))
    await first
  })

  it('finishes later stages after a stage failure and separates done from outcome', async () => {
    const { dossier, evidence: ev } = frozenFixture()
    const calls: AdversarialChatRequest[] = []
    const runner = startAdversarialReview({
      id: 'review-partial',
      dossier,
      executor: async request => {
        calls.push(request)
        if (request.stage.id === 'bull') throw new Error('model unavailable')
        return stageResponse(request, ev)
      },
    })
    const result = await runner.runToCompletion()

    expect(calls.map(call => call.stage.id)).toEqual(['bull', 'bear', 'bull-rebuttal', 'bear-rebuttal', 'judge'])
    expect(result).toMatchObject({ done: true, outcome: 'completed_with_errors' })
    expect(result.stages[0]).toMatchObject({ state: 'done', outcome: 'failed', error: 'model unavailable' })
    expect(result.stages.some(stage => stage.state === 'running')).toBe(false)
    expect(calls.find(call => call.stage.id === 'bear-rebuttal')?.visibleStages).toContainEqual(
      expect.objectContaining({ id: 'bull', outcome: 'failed', text: '' }),
    )
    expect(calls.find(call => call.stage.id === 'judge')?.visibleStages).toContainEqual(
      expect.objectContaining({ id: 'bull', outcome: 'failed' }),
    )
    expect(result.gaps).toContainEqual(expect.objectContaining({
      operation: 'adversarial-review:bull',
      reasonCode: 'error',
    }))
  })

  it('reports done with a failed outcome when every independent stage fails', async () => {
    const { dossier } = frozenFixture()
    const runner = startAdversarialReview({
      id: 'review-failed',
      dossier,
      executor: async () => { throw new Error('offline') },
    })
    const result = await runner.runToCompletion()
    expect(result).toMatchObject({ done: true, outcome: 'failed' })
    expect(result.stages.every(stage => stage.state === 'done' && stage.outcome === 'failed')).toBe(true)
  })

  it('audits every segment and keeps an ungrounded number as an incomplete stage', async () => {
    const { dossier, evidence: ev } = frozenFixture()
    const calls: AdversarialChatRequest[] = []
    const runner = startAdversarialReview({
      id: 'review-audit',
      dossier,
      executor: async request => {
        calls.push(request)
        return request.stage.id === 'bull'
          ? `Revenue was 1912亿元 [${ev.id}].`
          : stageResponse(request, ev)
      },
    })
    const result = await runner.runToCompletion()
    const bull = result.stages.find(stage => stage.id === 'bull')

    expect(bull).toMatchObject({ state: 'done', outcome: 'incomplete', audit: { passed: false } })
    expect(bull?.audit?.findings).toContainEqual(expect.objectContaining({ code: 'unbound-number' }))
    expect(calls.find(call => call.stage.id === 'bear-rebuttal')?.visibleStages.map(stage => stage.id)).toEqual(['bull'])
    expect(result).toMatchObject({ done: true, outcome: 'completed_with_errors' })
  })

  it('distinguishes an all-incomplete review from an all-failed review', async () => {
    const { dossier, evidence: ev } = frozenFixture()
    const runner = startAdversarialReview({
      id: 'review-incomplete',
      dossier,
      executor: async request => request.stage.id === 'judge'
        ? judgeText(ev) + `\nUnsupported 999亿元 [${ev.id}].`
        : `Unsupported 999亿元 [${ev.id}].`,
    })
    const result = await runner.runToCompletion()

    expect(result.stages.every(stage => stage.outcome === 'incomplete')).toBe(true)
    expect(result).toMatchObject({ done: true, outcome: 'completed_with_errors' })
  })

  it('rejects judge voting or trading weights even when citations and numbers pass audit', async () => {
    const { dossier, evidence: ev } = frozenFixture()
    const runner = startAdversarialReview({
      id: 'review-judge-contract',
      dossier,
      executor: async request => request.stage.id === 'judge'
        ? judgeText(ev) + `\nThe bull side wins by vote; use portfolio weights [${ev.id}].`
        : stageResponse(request, ev),
    })
    const result = await runner.runToCompletion()
    const judge = result.stages.find(stage => stage.id === 'judge')

    expect(judge?.audit?.passed).toBe(true)
    expect(judge).toMatchObject({ outcome: 'incomplete' })
    expect(judge?.contractFindings).toContainEqual(expect.objectContaining({ code: 'forbidden-judge-output' }))
  })

  it('rejects duplicate session identities at construction', () => {
    const { dossier } = frozenFixture()
    expect(() => startAdversarialReview({
      id: 'review-session-collision',
      dossier,
      executor: async () => 'unused',
      sessionIdFactory: () => 'same-session',
    })).toThrowError(expect.objectContaining({ code: 'invalid-session' } satisfies Partial<AdversarialReviewError>))
  })
})

describe('adversarial-research skill', () => {
  it('documents the frozen-input, visibility, audit, and no-voting boundaries', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'skills/adversarial-research/SKILL.md'), 'utf8')
    expect(content).toMatch(/^---\n[\s\S]*?name: adversarial-research[\s\S]*?\n---\n/u)
    for (const term of [
      'loadFrozenEvidenceDossier',
      'AdversarialChatExecutor',
      '`bull-rebuttal` sees the dossier plus `bear`',
      '`bear-rebuttal` sees the dossier plus `bull`',
      '`judge` sees the dossier and all four preceding outputs',
      'research-audit',
      '`done` means no stage remains pending',
      'never infer success from `done` alone',
    ]) expect(content).toContain(term)
    expect(content).toContain('Do not name a winner')
    expect(content).toContain('assign trading/portfolio weights')
  })
})
