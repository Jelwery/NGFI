import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assumptionId,
  claimId,
  evidenceId,
  modelRunId,
  researchRunId,
  type Assumption,
  type Claim,
  type Evidence,
  type ModelRun,
  type ResearchRunManifest,
} from '@finance2dsh/research-core'
import {
  ResearchWorkspace,
  ResearchWorkspaceError,
  createSnapshot,
  diffResearchRuns,
  hashBytes,
  seedFrozenReplay,
  verifyFrozenReplay,
  verifySnapshot,
} from '@finance2dsh/research-workspace'

const temporaryDirectories: string[] = []
const clock = '2026-09-06T08:00:00.000Z'
const subject = {
  kind: 'instrument' as const,
  instrument: { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' },
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ngfi-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function createWorkspace(): { workspace: ResearchWorkspace; root: string; caseId: string } {
  const root = temporaryDirectory('research-workspace')
  const workspace = new ResearchWorkspace({ root, now: () => new Date(clock), lockTimeoutMs: 20 })
  const created = workspace.create({
    subject,
    mandate: 'Assess earnings durability',
    asOf: '2026-09-06',
  })
  return { workspace, root, caseId: created.case.caseId }
}

function makeEvidence(value = 181_200_000_000): Evidence {
  const content = {
    kind: 'structured' as const,
    subject,
    field: 'revenue',
    value,
    period: 'FY2025',
    unit: 'CNY',
    currency: 'CNY',
    quality: 'high' as const,
    sourceRef: {
      provider: 'fixture',
      upstream: 'annual-report',
      sourceKind: 'official' as const,
      hash: `sha256:${'a'.repeat(64)}` as const,
      publishedAt: '2026-03-30T02:00:00.000Z',
      availableAt: '2026-03-30T02:05:00.000Z',
      retrievedAt: clock,
    },
    limitations: [],
  }
  return { id: evidenceId(content), ...content }
}

function makeAssumption(evidenceRef: string): Assumption {
  const content = {
    kind: 'range' as const,
    name: 'Revenue growth',
    range: { lower: 0.06, upper: 0.1 },
    unit: 'ratio',
    scenario: 'base',
    rationale: 'Normalized from reported growth',
    evidenceRefs: [evidenceRef],
    owner: 'analyst' as const,
    version: 1,
  }
  return { id: assumptionId(content), ...content }
}

function makeClaim(evidenceRef: string): Claim {
  const content = {
    text: 'Reported revenue supports durable growth.',
    status: 'supported' as const,
    confidenceLabel: 'medium' as const,
    evidenceRefs: [evidenceRef],
    counterEvidenceRefs: [],
    falsifiers: ['Two periods below 3% growth'],
  }
  return { id: claimId(content), ...content }
}

function makeModelRun(evidenceRef: string, assumptionRef: string): ModelRun {
  const content: Omit<ModelRun, 'id'> = {
    model: 'dcf',
    version: '1.0.0',
    inputRefs: [
      { kind: 'evidence', id: evidenceRef },
      { kind: 'assumption', id: assumptionRef },
    ],
    parameters: { scenario: 'base' },
    output: { status: 'ok', value: { enterpriseValue: 2_300_000_000_000 } },
    warnings: [],
    createdAt: clock,
  }
  return { id: modelRunId(content), ...content }
}

function makeManifest(
  caseId: string,
  startedAt: string,
  status: 'complete' | 'failed',
  artifactHashes: ResearchRunManifest['artifactHashes'],
): ResearchRunManifest {
  const common = {
    caseId,
    asOf: '2026-09-06',
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    codeVersion: 'git:09e8404',
    configVersion: 'company-research@1',
    configHash: `sha256:${'b'.repeat(64)}` as const,
    modelVersion: 'fixture-model@1',
    artifactHashes,
    status,
    gaps: status === 'failed'
      ? [{
          operation: 'render memo',
          reasonCode: 'error' as const,
          detail: 'fixture failure',
          attemptedCapabilities: [],
        }]
      : [],
  }
  return { runId: researchRunId(common), ...common }
}

function expectWorkspaceError(action: () => unknown, code: ResearchWorkspaceError['code']): void {
  let caught: unknown
  try { action() } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(ResearchWorkspaceError)
  expect(caught).toMatchObject({ code })
}

describe('research workspace persistence', () => {
  it('creates, opens, updates, persists every case object, and archives with revision control', () => {
    const { workspace, caseId } = createWorkspace()
    const evidence = makeEvidence()
    const assumption = makeAssumption(evidence.id)
    const claim = makeClaim(evidence.id)
    const modelRun = makeModelRun(evidence.id, assumption.id)

    expect(workspace.open(caseId)).toMatchObject({ revision: 0, case: { status: 'draft' } })
    expect(workspace.update(caseId, 0, { status: 'active' })).toEqual({ revision: 1, changed: true })
    expect(workspace.appendEvidence(caseId, 1, [evidence])).toMatchObject({ revision: 2, appendedIds: [evidence.id] })
    expect(workspace.saveAssumptions(caseId, 2, [assumption])).toEqual({ revision: 3, changed: true })
    expect(workspace.saveClaims(caseId, 3, [claim])).toEqual({ revision: 4, changed: true })
    expect(workspace.saveModelRun(caseId, 4, modelRun)).toMatchObject({ revision: 5, changed: true })
    expect(workspace.saveMemo(caseId, 5, '# Durable growth\n')).toEqual({ revision: 6, changed: true })
    expect(workspace.appendDecision(caseId, 6, {
      kind: 'assumption-approved',
      actor: 'user',
      summary: 'Use the base growth range.',
      refs: [assumption.id],
      decidedAt: clock,
    })).toMatchObject({ revision: 7, changed: true })

    const reopened = new ResearchWorkspace({ root: workspace.root }).open(caseId)
    expect(reopened).toMatchObject({
      revision: 7,
      case: { status: 'active' },
      evidence: [{ id: evidence.id }],
      assumptions: [{ id: assumption.id }],
      claims: [{ id: claim.id }],
      modelRuns: [{ id: modelRun.id }],
      memo: '# Durable growth\n',
      decisions: [{ kind: 'assumption-approved' }],
    })

    expect(workspace.archive(caseId, 7)).toEqual({ revision: 8, changed: true })
    expect(workspace.archive(caseId, 8)).toEqual({ revision: 8, changed: false })
    expectWorkspaceError(() => workspace.saveMemo(caseId, 8, 'new'), 'archived')
  })

  it('rejects stale revisions and duplicate append ids without changing disk state', () => {
    const { workspace, caseId } = createWorkspace()
    const evidence = makeEvidence()
    workspace.appendEvidence(caseId, 0, [evidence])
    const before = fs.readFileSync(path.join(workspace.casePath(caseId), 'evidence.jsonl'), 'utf8')

    expectWorkspaceError(() => workspace.saveMemo(caseId, 0, 'stale'), 'revision-conflict')
    expectWorkspaceError(() => workspace.appendEvidence(caseId, 1, [evidence]), 'duplicate-entry')
    workspace.appendDecision(caseId, 1, {
      kind: 'scope-approved',
      actor: 'user',
      summary: 'Use the declared research scope.',
      refs: [],
      decidedAt: clock,
    })
    const duplicateDecision = workspace.open(caseId).decisions[0]
    expect(duplicateDecision).toBeDefined()
    expectWorkspaceError(() => workspace.appendDecision(caseId, 2, duplicateDecision!), 'duplicate-entry')
    expect(fs.readFileSync(path.join(workspace.casePath(caseId), 'evidence.jsonl'), 'utf8')).toBe(before)
    expect(workspace.open(caseId).revision).toBe(2)
  })

  it('never treats corrupt or old-schema files as empty, and preserves their bytes', () => {
    const { workspace, caseId } = createWorkspace()
    const directory = workspace.casePath(caseId)
    const evidencePath = path.join(directory, 'evidence.jsonl')
    const corrupt = '{not-json}\n'
    fs.writeFileSync(evidencePath, corrupt)
    const casePath = path.join(directory, 'case.json')
    const caseFile = JSON.parse(fs.readFileSync(casePath, 'utf8')) as { fileHashes: Record<string, string> }
    caseFile.fileHashes['evidence.jsonl'] = hashBytes(corrupt)
    fs.writeFileSync(casePath, jsonText(caseFile))

    expectWorkspaceError(() => workspace.open(caseId), 'corrupt')
    expectWorkspaceError(() => workspace.appendEvidence(caseId, 0, [makeEvidence()]), 'corrupt')
    expect(fs.readFileSync(evidencePath, 'utf8')).toBe(corrupt)

    fs.writeFileSync(evidencePath, '')
    caseFile.fileHashes['evidence.jsonl'] = hashBytes('')
    const assumptionsPath = path.join(directory, 'assumptions.json')
    const oldSchema = jsonText({ schemaVersion: 0, items: [] })
    fs.writeFileSync(assumptionsPath, oldSchema)
    caseFile.fileHashes['assumptions.json'] = hashBytes(oldSchema)
    fs.writeFileSync(casePath, jsonText(caseFile))

    expectWorkspaceError(() => workspace.open(caseId), 'schema-mismatch')
    expect(fs.readFileSync(assumptionsPath, 'utf8')).toBe(oldSchema)
  })

  it('rejects traversal and symlinks instead of reading or writing through them', () => {
    const { workspace, root, caseId } = createWorkspace()
    expectWorkspaceError(() => workspace.writeArtifact(caseId, 0, '../escape.json', '{}'), 'invalid-path')
    expect(fs.existsSync(path.join(root, 'escape.json'))).toBe(false)

    const outside = path.join(temporaryDirectory('outside'), 'memo.md')
    fs.writeFileSync(outside, 'outside')
    const memo = path.join(workspace.casePath(caseId), 'memo.md')
    fs.rmSync(memo)
    fs.symlinkSync(outside, memo)
    expectWorkspaceError(() => workspace.open(caseId), 'symlink')
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')
  })

  it('refuses a concurrently locked case without mutating it', () => {
    const { workspace, caseId } = createWorkspace()
    const lockPath = path.join(workspace.casePath(caseId), '.case.lock')
    fs.writeFileSync(lockPath, jsonText({ pid: process.pid, token: 'test', createdAt: clock }))
    expectWorkspaceError(() => workspace.saveMemo(caseId, 0, 'blocked'), 'locked')
    fs.rmSync(lockPath)
    expect(workspace.open(caseId)).toMatchObject({ revision: 0, memo: '' })
  })

  it('preserves the previous file when an atomic replacement fails', () => {
    const { workspace, caseId } = createWorkspace()
    const directory = workspace.casePath(caseId)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated rename failure')
    })

    expect(() => workspace.saveMemo(caseId, 0, 'must not become visible')).toThrow('simulated rename failure')
    rename.mockRestore()
    expect(workspace.open(caseId)).toMatchObject({ revision: 0, memo: '' })
    expect(fs.readdirSync(directory).filter(name => name.startsWith('.tmp-'))).toEqual([])
  })
})

describe('artifact manifests, frozen replay, and research run diff', () => {
  it('allows one running-to-terminal manifest transition while keeping run identity immutable', () => {
    const { workspace, caseId } = createWorkspace()
    const startedAt = '2026-09-06T08:10:00.000Z'
    const common = {
      caseId,
      asOf: '2026-09-06',
      startedAt,
      codeVersion: 'git:09e8404',
      configVersion: 'company-research@1',
      configHash: `sha256:${'b'.repeat(64)}` as const,
      modelVersion: 'fixture-model@1',
      artifactHashes: {},
      gaps: [],
    }
    const running: ResearchRunManifest = { runId: researchRunId(common), ...common, status: 'running' }
    const first = workspace.saveRunManifest(caseId, 0, running)
    const complete: ResearchRunManifest = {
      ...running,
      status: 'complete',
      finishedAt: '2026-09-06T08:11:00.000Z',
    }
    const terminal = workspace.saveRunManifest(caseId, first.revision, complete)
    expect(terminal).toMatchObject({ revision: 2, changed: true })
    expect(workspace.saveRunManifest(caseId, terminal.revision, complete)).toMatchObject({
      revision: 2,
      changed: false,
    })
    expectWorkspaceError(
      () => workspace.saveRunManifest(caseId, terminal.revision, { ...complete, modelVersion: 'changed' }),
      'immutable-artifact',
    )
  })

  it('hashes run artifacts and reports structured differences across two runs', () => {
    const { workspace, caseId } = createWorkspace()
    let revision = 0
    const firstStartedAt = '2026-09-06T08:10:00.000Z'
    const firstId = researchRunId({ caseId, asOf: '2026-09-06', startedAt: firstStartedAt })
    const firstPath = `${firstId}/result.json`
    const firstArtifact = workspace.writeArtifact(caseId, revision, firstPath, jsonText({ score: 1, stable: true }))
    revision = firstArtifact.revision
    const firstManifest = makeManifest(caseId, firstStartedAt, 'complete', {
      [firstArtifact.path]: firstArtifact.hash,
    })
    revision = workspace.saveRunManifest(caseId, revision, firstManifest).revision

    const secondStartedAt = '2026-09-06T09:10:00.000Z'
    const secondId = researchRunId({ caseId, asOf: '2026-09-06', startedAt: secondStartedAt })
    const secondPath = `${secondId}/result.json`
    const secondArtifact = workspace.writeArtifact(caseId, revision, secondPath, jsonText({ score: 2, stable: true }))
    revision = secondArtifact.revision
    const note = workspace.writeArtifact(caseId, revision, `${secondId}/note.txt`, 'added')
    revision = note.revision
    const secondManifest = makeManifest(caseId, secondStartedAt, 'complete', {
      [secondArtifact.path]: secondArtifact.hash,
      [note.path]: note.hash,
    })
    workspace.saveRunManifest(caseId, revision, secondManifest)

    const diff = diffResearchRuns(workspace, caseId, firstId, secondId)
    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 0 })
    expect(diff.artifacts.added[0]).toMatchObject({ path: 'note.txt' })
    expect(diff.artifacts.changed[0]).toMatchObject({
      path: 'result.json',
      format: 'json',
      changes: [{ path: '$.score', kind: 'changed', before: 1, after: 2 }],
    })
  })

  it('creates, verifies, seeds, and verifies a frozen replay without network access', () => {
    const { workspace, caseId } = createWorkspace()
    const startedAt = '2026-09-06T08:10:00.000Z'
    const runId = researchRunId({ caseId, asOf: '2026-09-06', startedAt })
    const artifact = workspace.writeArtifact(caseId, 0, `${runId}/result.json`, jsonText({ result: 'ok' }))
    const manifest = makeManifest(caseId, startedAt, 'complete', { [artifact.path]: artifact.hash })
    const saved = workspace.saveRunManifest(caseId, artifact.revision, manifest)
    const snapshotDirectory = path.join(temporaryDirectory('snapshot-parent'), 'fixture')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const frozen = createSnapshot({
      workspace,
      caseId,
      runId,
      destination: snapshotDirectory,
      createdAt: clock,
    })
    expect(frozen.sourceRevision).toBe(saved.revision)
    expect(verifySnapshot(snapshotDirectory)).toEqual(frozen)

    const replayRoot = temporaryDirectory('replay')
    const receipt = seedFrozenReplay(snapshotDirectory, replayRoot, clock)
    const replay = verifyFrozenReplay(replayRoot, receipt)
    expect(replay).toMatchObject({ revision: saved.revision, case: { caseId } })
    expect(replay.runManifests).toContainEqual(manifest)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('detects artifact and snapshot tampering', () => {
    const { workspace, caseId } = createWorkspace()
    const startedAt = '2026-09-06T08:10:00.000Z'
    const runId = researchRunId({ caseId, asOf: '2026-09-06', startedAt })
    const artifact = workspace.writeArtifact(caseId, 0, `${runId}/result.json`, jsonText({ result: 'ok' }))
    workspace.saveRunManifest(
      caseId,
      artifact.revision,
      makeManifest(caseId, startedAt, 'complete', { [artifact.path]: artifact.hash }),
    )
    fs.writeFileSync(path.join(workspace.casePath(caseId), artifact.path), '{}\n')
    expectWorkspaceError(() => workspace.open(caseId), 'corrupt')

    const clean = createWorkspace()
    const cleanRunId = researchRunId({ caseId: clean.caseId, asOf: '2026-09-06', startedAt })
    const cleanArtifact = clean.workspace.writeArtifact(
      clean.caseId,
      0,
      `${cleanRunId}/result.json`,
      jsonText({ result: 'ok' }),
    )
    clean.workspace.saveRunManifest(
      clean.caseId,
      cleanArtifact.revision,
      makeManifest(clean.caseId, startedAt, 'complete', { [cleanArtifact.path]: cleanArtifact.hash }),
    )
    const snapshotDirectory = path.join(temporaryDirectory('tamper-parent'), 'fixture')
    createSnapshot({ workspace: clean.workspace, caseId: clean.caseId, runId: cleanRunId, destination: snapshotDirectory })
    fs.writeFileSync(path.join(snapshotDirectory, clean.caseId, cleanArtifact.path), '{"result":"tampered"}\n')
    expectWorkspaceError(() => verifySnapshot(snapshotDirectory), 'snapshot-invalid')
  })

  it('does not replace a valid snapshot with failed or empty run output', () => {
    const { workspace, caseId } = createWorkspace()
    const completeAt = '2026-09-06T08:10:00.000Z'
    const completeId = researchRunId({ caseId, asOf: '2026-09-06', startedAt: completeAt })
    const artifact = workspace.writeArtifact(caseId, 0, `${completeId}/result.json`, jsonText({ result: 'ok' }))
    let revision = workspace.saveRunManifest(
      caseId,
      artifact.revision,
      makeManifest(caseId, completeAt, 'complete', { [artifact.path]: artifact.hash }),
    ).revision
    const snapshotDirectory = path.join(temporaryDirectory('stable-parent'), 'fixture')
    createSnapshot({ workspace, caseId, runId: completeId, destination: snapshotDirectory })
    const before = fs.readFileSync(path.join(snapshotDirectory, '_frozen-replay.json'), 'utf8')

    const failedAt = '2026-09-06T09:10:00.000Z'
    const failed = makeManifest(caseId, failedAt, 'failed', {})
    revision = workspace.saveRunManifest(caseId, revision, failed).revision
    expectWorkspaceError(
      () => createSnapshot({ workspace, caseId, runId: failed.runId, destination: snapshotDirectory }),
      'snapshot-invalid',
    )

    const emptyAt = '2026-09-06T10:10:00.000Z'
    const empty = makeManifest(caseId, emptyAt, 'complete', {})
    workspace.saveRunManifest(caseId, revision, empty)
    expectWorkspaceError(() => createSnapshot({
      workspace,
      caseId,
      runId: empty.runId,
      destination: path.join(path.dirname(snapshotDirectory), 'empty'),
    }), 'snapshot-invalid')
    expect(fs.readFileSync(path.join(snapshotDirectory, '_frozen-replay.json'), 'utf8')).toBe(before)
    expect(verifySnapshot(snapshotDirectory).sourceRunId).toBe(completeId)
  })

  it('rejects old snapshot schemas, undeclared files, and snapshot symlinks', () => {
    const { workspace, caseId } = createWorkspace()
    const startedAt = '2026-09-06T08:10:00.000Z'
    const runId = researchRunId({ caseId, asOf: '2026-09-06', startedAt })
    const artifact = workspace.writeArtifact(caseId, 0, `${runId}/result.json`, jsonText({ result: 'ok' }))
    workspace.saveRunManifest(
      caseId,
      artifact.revision,
      makeManifest(caseId, startedAt, 'complete', { [artifact.path]: artifact.hash }),
    )
    const snapshotDirectory = path.join(temporaryDirectory('negative-parent'), 'fixture')
    createSnapshot({ workspace, caseId, runId, destination: snapshotDirectory })
    const manifestPath = path.join(snapshotDirectory, '_frozen-replay.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { schemaVersion: number }
    manifest.schemaVersion = 0
    fs.writeFileSync(manifestPath, jsonText(manifest))
    expectWorkspaceError(() => verifySnapshot(snapshotDirectory), 'schema-mismatch')

    manifest.schemaVersion = 1
    fs.writeFileSync(manifestPath, jsonText(manifest))
    fs.writeFileSync(path.join(snapshotDirectory, caseId, 'extra.txt'), 'extra')
    expectWorkspaceError(() => verifySnapshot(snapshotDirectory), 'snapshot-invalid')
    fs.rmSync(path.join(snapshotDirectory, caseId, 'extra.txt'))

    const memo = path.join(snapshotDirectory, caseId, 'memo.md')
    fs.rmSync(memo)
    fs.symlinkSync(path.join(workspace.casePath(caseId), 'memo.md'), memo)
    expectWorkspaceError(() => verifySnapshot(snapshotDirectory), 'symlink')
  })
})
