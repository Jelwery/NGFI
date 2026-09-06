import fs from 'node:fs'
import path from 'node:path'

import type { ContentHash } from '@finance2dsh/research-core'

import {
  FROZEN_REPLAY_SCHEMA_VERSION,
  type FrozenReplayManifest,
  type FrozenReplayReceipt,
  type ResearchCaseFile,
  type ResearchCaseState,
} from './contracts.js'
import {
  ResearchWorkspaceError,
  assertCaseId,
  assertContentHash,
  assertDisjointDirectories,
  assertNoSymlink,
  assertRunId,
  assertSafeRelativePath,
  atomicWriteFile,
  ensureDirectoryNoSymlink,
  existingDirectoryNoSymlink,
  hashBytes,
  jsonText,
  listFilesRecursively,
  parseJson,
  readFileSecure,
  treeHash,
} from './fs.js'
import { RESEARCH_WORKSPACE_SCHEMA_VERSION } from './contracts.js'
import { ResearchWorkspace } from './workspace.js'

export const FROZEN_REPLAY_MANIFEST = '_frozen-replay.json'

export interface CreateSnapshotOptions {
  workspace: ResearchWorkspace
  caseId: string
  runId: string
  destination: string
  createdAt?: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchWorkspaceError('snapshot-invalid', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ResearchWorkspaceError('snapshot-invalid', `${label} must be a valid timestamp`)
  }
  return value
}

function validateFrozenReplayManifest(value: unknown): FrozenReplayManifest {
  const record = object(value, FROZEN_REPLAY_MANIFEST)
  const allowed = new Set([
    'schemaVersion', 'kind', 'caseId', 'sourceRunId', 'sourceRevision', 'createdAt',
    'sourceManifestHash', 'files', 'treeHash',
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new ResearchWorkspaceError('snapshot-invalid', `Unknown snapshot field: ${key}`)
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) throw new ResearchWorkspaceError('snapshot-invalid', `Missing snapshot field: ${key}`)
  }
  if (record.schemaVersion !== FROZEN_REPLAY_SCHEMA_VERSION) {
    throw new ResearchWorkspaceError(
      'schema-mismatch',
      `Frozen replay schema ${String(record.schemaVersion)} is not supported`,
    )
  }
  if (record.kind !== 'ngfi-research-frozen-replay') {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Unexpected frozen replay kind')
  }
  if (typeof record.caseId !== 'string') throw new ResearchWorkspaceError('snapshot-invalid', 'Snapshot caseId is invalid')
  if (typeof record.sourceRunId !== 'string') throw new ResearchWorkspaceError('snapshot-invalid', 'Snapshot runId is invalid')
  assertCaseId(record.caseId)
  assertRunId(record.sourceRunId)
  if (!Number.isInteger(record.sourceRevision) || (record.sourceRevision as number) < 0) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Snapshot sourceRevision is invalid')
  }
  const files = object(record.files, 'snapshot.files')
  const parsedFiles: Record<string, ContentHash> = {}
  for (const [relativePath, hash] of Object.entries(files)) {
    assertSafeRelativePath(relativePath)
    if (!relativePath.startsWith(`${record.caseId}/`)) {
      throw new ResearchWorkspaceError('snapshot-invalid', `Snapshot file belongs to another case: ${relativePath}`)
    }
    assertContentHash(hash, `snapshot.files[${JSON.stringify(relativePath)}]`)
    parsedFiles[relativePath] = hash
  }
  if (Object.keys(parsedFiles).length === 0) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Frozen replay cannot be empty')
  }
  assertContentHash(record.sourceManifestHash, 'snapshot.sourceManifestHash')
  assertContentHash(record.treeHash, 'snapshot.treeHash')
  if (record.treeHash !== treeHash(parsedFiles)) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Frozen replay tree hash is invalid')
  }
  return {
    schemaVersion: FROZEN_REPLAY_SCHEMA_VERSION,
    kind: 'ngfi-research-frozen-replay',
    caseId: record.caseId,
    sourceRunId: record.sourceRunId,
    sourceRevision: record.sourceRevision as number,
    createdAt: timestamp(record.createdAt, 'snapshot.createdAt'),
    sourceManifestHash: record.sourceManifestHash,
    files: parsedFiles,
    treeHash: record.treeHash,
  }
}

function snapshotSourceFiles(state: ResearchCaseState, runId: string): string[] {
  const run = state.runManifests.find(candidate => candidate.runId === runId)
  if (run === undefined) throw new ResearchWorkspaceError('not-found', `Research run not found: ${runId}`)
  if (run.status !== 'complete') {
    throw new ResearchWorkspaceError('snapshot-invalid', `Only complete runs can be frozen: ${run.status}`)
  }
  if (Object.keys(run.artifactHashes).length === 0) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'A complete frozen replay must contain at least one artifact')
  }
  const selected = new Set<string>([
    'evidence.jsonl',
    'assumptions.json',
    'claims.json',
    'memo.md',
    'decision-log.jsonl',
    `runs/${runId}/manifest.json`,
    `runs/${runId}/artifact-manifest.json`,
    ...Object.keys(run.artifactHashes),
  ])
  for (const relativePath of Object.keys(state.fileHashes)) {
    if (relativePath.startsWith('model-runs/')) selected.add(relativePath)
  }
  return [...selected].sort()
}

function prepareDestination(destination: string): { destination: string; temporary: string } {
  const absolute = path.resolve(destination)
  if (fs.existsSync(absolute)) {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      throw new ResearchWorkspaceError('symlink', `Refusing symlink snapshot destination: ${absolute}`)
    }
    throw new ResearchWorkspaceError('already-exists', `Snapshot destination already exists: ${absolute}`)
  }
  ensureDirectoryNoSymlink(path.dirname(absolute))
  const temporary = path.join(path.dirname(absolute), `.tmp-snapshot-${process.pid}-${Date.now()}`)
  if (fs.existsSync(temporary)) {
    throw new ResearchWorkspaceError('already-exists', `Temporary snapshot destination already exists: ${temporary}`)
  }
  fs.mkdirSync(temporary, { mode: 0o700 })
  return { destination: absolute, temporary }
}

export function createSnapshot(options: CreateSnapshotOptions): FrozenReplayManifest {
  assertCaseId(options.caseId)
  assertRunId(options.runId)
  const sourceDirectory = options.workspace.casePath(options.caseId)
  assertDisjointDirectories(sourceDirectory, options.destination)
  const state = options.workspace.open(options.caseId)
  const sourceFiles = snapshotSourceFiles(state, options.runId)
  const runManifestPath = `runs/${options.runId}/manifest.json`
  const sourceManifestHash = state.fileHashes[runManifestPath]
  if (sourceManifestHash === undefined) {
    throw new ResearchWorkspaceError('corrupt', `Run manifest is not registered: ${runManifestPath}`)
  }
  const { destination, temporary } = prepareDestination(options.destination)
  try {
    const copiedHashes: Record<string, ContentHash> = {}
    const filteredCaseHashes: Record<string, ContentHash> = {}
    for (const relativePath of sourceFiles) {
      const expectedHash = state.fileHashes[relativePath]
      if (expectedHash === undefined) {
        throw new ResearchWorkspaceError('corrupt', `Snapshot source is not registered: ${relativePath}`)
      }
      const bytes = readFileSecure(sourceDirectory, relativePath)
      if (relativePath.startsWith('artifacts/') && bytes.length === 0) {
        throw new ResearchWorkspaceError('snapshot-invalid', `Frozen replay artifact is empty: ${relativePath}`)
      }
      const destinationPath = `${options.caseId}/${relativePath}`
      const copiedHash = atomicWriteFile(temporary, destinationPath, bytes)
      if (copiedHash !== expectedHash) {
        throw new ResearchWorkspaceError('snapshot-invalid', `Snapshot source changed while copying: ${relativePath}`)
      }
      copiedHashes[destinationPath] = copiedHash
      filteredCaseHashes[relativePath] = copiedHash
    }
    const snapshotCaseFile: ResearchCaseFile = {
      schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION,
      revision: state.revision,
      case: state.case,
      fileHashes: filteredCaseHashes,
    }
    const caseHash = atomicWriteFile(temporary, `${options.caseId}/case.json`, jsonText(snapshotCaseFile))
    copiedHashes[`${options.caseId}/case.json`] = caseHash
    for (const directory of ['model-runs', 'runs', 'artifacts']) {
      fs.mkdirSync(path.join(temporary, options.caseId, directory), { recursive: true, mode: 0o700 })
    }
    const createdAt = options.createdAt ?? new Date().toISOString()
    timestamp(createdAt, 'snapshot.createdAt')
    const manifest: FrozenReplayManifest = {
      schemaVersion: FROZEN_REPLAY_SCHEMA_VERSION,
      kind: 'ngfi-research-frozen-replay',
      caseId: options.caseId,
      sourceRunId: options.runId,
      sourceRevision: state.revision,
      createdAt,
      sourceManifestHash,
      files: copiedHashes,
      treeHash: treeHash(copiedHashes),
    }
    atomicWriteFile(temporary, FROZEN_REPLAY_MANIFEST, jsonText(manifest))
    verifySnapshot(temporary)
    fs.renameSync(temporary, destination)
    return manifest
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function verifySnapshot(snapshotDirectory: string): FrozenReplayManifest {
  const root = existingDirectoryNoSymlink(snapshotDirectory)
  const manifest = validateFrozenReplayManifest(
    parseJson(readFileSecure(root, FROZEN_REPLAY_MANIFEST), FROZEN_REPLAY_MANIFEST),
  )
  const declared = new Set(Object.keys(manifest.files))
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const bytes = readFileSecure(root, relativePath)
    if (hashBytes(bytes) !== expectedHash) {
      throw new ResearchWorkspaceError('snapshot-invalid', `Frozen replay file was modified: ${relativePath}`)
    }
  }
  const actual = listFilesRecursively(root).filter(file => file !== FROZEN_REPLAY_MANIFEST)
  const extras = actual.filter(file => !declared.has(file))
  const missing = [...declared].filter(file => !actual.includes(file))
  if (extras.length > 0 || missing.length > 0) {
    throw new ResearchWorkspaceError(
      'snapshot-invalid',
      `Frozen replay file set differs from manifest (extra: ${extras.join(', ') || '-'}; missing: ${missing.join(', ') || '-'})`,
    )
  }
  const workspace = new ResearchWorkspace({ root })
  const state = workspace.open(manifest.caseId)
  const run = state.runManifests.find(candidate => candidate.runId === manifest.sourceRunId)
  if (run?.status !== 'complete' || Object.keys(run.artifactHashes).length === 0) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Frozen replay does not contain a complete, non-empty source run')
  }
  const manifestPath = `${manifest.caseId}/runs/${manifest.sourceRunId}/manifest.json`
  if (manifest.files[manifestPath] !== manifest.sourceManifestHash) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Frozen replay source manifest hash is inconsistent')
  }
  return manifest
}

export function seedFrozenReplay(
  snapshotDirectory: string,
  destinationRoot: string,
  seededAt = new Date().toISOString(),
): FrozenReplayReceipt {
  const manifest = verifySnapshot(snapshotDirectory)
  timestamp(seededAt, 'seededAt')
  assertDisjointDirectories(snapshotDirectory, destinationRoot)
  const destination = ensureDirectoryNoSymlink(destinationRoot)
  const caseDestination = path.join(destination, manifest.caseId)
  if (fs.existsSync(caseDestination)) {
    throw new ResearchWorkspaceError('already-exists', `Replay case already exists: ${caseDestination}`)
  }
  const temporary = path.join(destination, `.tmp-replay-${process.pid}-${Date.now()}`)
  fs.mkdirSync(temporary, { mode: 0o700 })
  try {
    const seededFiles: Record<string, ContentHash> = {}
    const prefix = `${manifest.caseId}/`
    for (const [snapshotPath, expectedHash] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
      const targetPath = snapshotPath.slice(prefix.length)
      const sourceBytes = readFileSecure(snapshotDirectory, snapshotPath)
      const copiedHash = atomicWriteFile(temporary, targetPath, sourceBytes)
      if (copiedHash !== expectedHash) {
        throw new ResearchWorkspaceError('snapshot-invalid', `Frozen replay changed while seeding: ${snapshotPath}`)
      }
      seededFiles[targetPath] = copiedHash
    }
    for (const directory of ['model-runs', 'runs', 'artifacts']) {
      fs.mkdirSync(path.join(temporary, directory), { recursive: true, mode: 0o700 })
    }
    fs.renameSync(temporary, caseDestination)
    const receipt: FrozenReplayReceipt = {
      schemaVersion: FROZEN_REPLAY_SCHEMA_VERSION,
      kind: 'ngfi-research-frozen-replay-seed',
      caseId: manifest.caseId,
      sourceRunId: manifest.sourceRunId,
      sourceTreeHash: manifest.treeHash,
      seededAt,
      files: seededFiles,
    }
    verifyFrozenReplay(destinationRoot, receipt)
    return receipt
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    if (fs.existsSync(caseDestination)) fs.rmSync(caseDestination, { recursive: true, force: true })
    throw error
  }
}

export function verifyFrozenReplay(destinationRoot: string, receipt: FrozenReplayReceipt): ResearchCaseState {
  if (receipt.schemaVersion !== FROZEN_REPLAY_SCHEMA_VERSION
    || receipt.kind !== 'ngfi-research-frozen-replay-seed') {
    throw new ResearchWorkspaceError('schema-mismatch', 'Frozen replay receipt schema is not supported')
  }
  assertCaseId(receipt.caseId)
  assertRunId(receipt.sourceRunId)
  timestamp(receipt.seededAt, 'receipt.seededAt')
  assertContentHash(receipt.sourceTreeHash, 'receipt.sourceTreeHash')
  const root = existingDirectoryNoSymlink(destinationRoot)
  const caseRoot = assertNoSymlink(root, receipt.caseId)
  const expectedSnapshotFiles: Record<string, ContentHash> = {}
  for (const [relativePath, expectedHash] of Object.entries(receipt.files)) {
    assertSafeRelativePath(relativePath)
    assertContentHash(expectedHash, `receipt.files[${JSON.stringify(relativePath)}]`)
    const bytes = readFileSecure(caseRoot, relativePath)
    if (hashBytes(bytes) !== expectedHash) {
      throw new ResearchWorkspaceError('snapshot-invalid', `Seeded replay file was modified: ${relativePath}`)
    }
    expectedSnapshotFiles[`${receipt.caseId}/${relativePath}`] = expectedHash
  }
  if (treeHash(expectedSnapshotFiles) !== receipt.sourceTreeHash) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Seeded replay no longer matches its source tree hash')
  }
  const actualFiles = listFilesRecursively(caseRoot)
  const declared = new Set(Object.keys(receipt.files))
  const extras = actualFiles.filter(file => !declared.has(file))
  if (extras.length > 0) {
    throw new ResearchWorkspaceError('snapshot-invalid', `Seeded replay contains undeclared files: ${extras.join(', ')}`)
  }
  const workspace = new ResearchWorkspace({ root })
  const state = workspace.open(receipt.caseId)
  if (!state.runManifests.some(run => run.runId === receipt.sourceRunId && run.status === 'complete')) {
    throw new ResearchWorkspaceError('snapshot-invalid', 'Seeded replay source run is unavailable or not complete')
  }
  return state
}

export const createFrozenReplay = createSnapshot
export const verifyFrozenReplaySnapshot = verifySnapshot
