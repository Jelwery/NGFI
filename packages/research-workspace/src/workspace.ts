import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  canonicalJson,
  researchCaseId,
  sha256,
  validateAssumption,
  validateClaim,
  validateEvidence,
  validateModelRun,
  validateResearchCase,
  validateResearchRunManifest,
  type Assumption,
  type Claim,
  type ContentHash,
  type Evidence,
  type JsonObject,
  type ModelRun,
  type ResearchCase,
  type ResearchRunManifest,
} from '@finance2dsh/research-core'

import {
  RESEARCH_WORKSPACE_SCHEMA_VERSION,
  type AppendResult,
  type ArtifactHashManifest,
  type ArtifactWriteResult,
  type CreateResearchCaseInput,
  type DecisionActor,
  type DecisionLogEntry,
  type NewDecisionLogEntry,
  type PersistedCollection,
  type ResearchCaseFile,
  type ResearchCaseState,
  type ResearchCaseUpdate,
  type WorkspaceMutationResult,
} from './contracts.js'
import {
  ResearchWorkspaceError,
  assertCaseId,
  assertContentHash,
  assertNoSymlink,
  assertRunId,
  assertSafeRelativePath,
  atomicWriteFile,
  ensureDirectoryNoSymlink,
  hashBytes,
  jsonText,
  listFilesRecursively,
  parseJson,
  readFileSecure,
  treeHash,
  withFileLock,
} from './fs.js'

const REQUIRED_MUTABLE_FILES = [
  'evidence.jsonl',
  'assumptions.json',
  'claims.json',
  'memo.md',
  'decision-log.jsonl',
] as const
const MANAGED_DIRECTORIES = ['model-runs', 'runs', 'artifacts'] as const
const CASE_FILE = 'case.json'
const LOCK_FILE = '.case.lock'
const DECISION_ID_RE = /^decision-[0-9a-f]{64}$/u
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

export interface ResearchWorkspaceOptions {
  root: string
  now?: () => Date
  lockTimeoutMs?: number
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchWorkspaceError('corrupt', `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ResearchWorkspaceError('corrupt', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ResearchWorkspaceError('corrupt', `${label}.${key} is not supported`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ResearchWorkspaceError('corrupt', `${label}.${key} is required`)
  }
}

function assertSchema(value: unknown, label: string): void {
  if (value !== RESEARCH_WORKSPACE_SCHEMA_VERSION) {
    throw new ResearchWorkspaceError(
      'schema-mismatch',
      `${label} uses workspace schema ${String(value)}; expected ${RESEARCH_WORKSPACE_SCHEMA_VERSION}`,
    )
  }
}

function validateIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ResearchWorkspaceError('corrupt', `${label} must be an RFC 3339 timestamp with a timezone`)
  }
  return value
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResearchWorkspaceError('corrupt', `${label} must be a non-empty string`)
  }
  return value
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new ResearchWorkspaceError('corrupt', `${label} must be an array`)
  return value.map((entry, index) => assertString(entry, `${label}[${index}]`))
}

function assertJsonObject(value: unknown, label: string): JsonObject {
  plainObject(value, label)
  try { canonicalJson(value) } catch (error) {
    throw new ResearchWorkspaceError('corrupt', `${label} must be JSON-safe`, { cause: error })
  }
  return value as JsonObject
}

function validateCaseFile(value: unknown): ResearchCaseFile {
  const record = plainObject(value, 'case.json')
  exactKeys(record, ['schemaVersion', 'revision', 'case', 'fileHashes'], [], 'case.json')
  assertSchema(record.schemaVersion, 'case.json')
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) {
    throw new ResearchWorkspaceError('corrupt', 'case.json.revision must be a non-negative integer')
  }
  let researchCase: ResearchCase
  try { researchCase = validateResearchCase(record.case) } catch (error) {
    throw new ResearchWorkspaceError('corrupt', 'case.json.case is invalid', { cause: error })
  }
  const hashes = plainObject(record.fileHashes, 'case.json.fileHashes')
  for (const [relativePath, hash] of Object.entries(hashes)) {
    assertSafeRelativePath(relativePath)
    if (relativePath === CASE_FILE || relativePath === LOCK_FILE) {
      throw new ResearchWorkspaceError('corrupt', `case.json cannot hash control file ${relativePath}`)
    }
    assertContentHash(hash, `case.json.fileHashes[${JSON.stringify(relativePath)}]`)
  }
  for (const required of REQUIRED_MUTABLE_FILES) {
    if (!Object.hasOwn(hashes, required)) {
      throw new ResearchWorkspaceError('corrupt', `case.json.fileHashes is missing ${required}`)
    }
  }
  return {
    schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION,
    revision: record.revision as number,
    case: researchCase,
    fileHashes: hashes as Record<string, ContentHash>,
  }
}

function validateCollection<T>(
  value: unknown,
  label: string,
  validate: (entry: unknown) => T,
): T[] {
  const record = plainObject(value, label)
  exactKeys(record, ['schemaVersion', 'items'], [], label)
  assertSchema(record.schemaVersion, label)
  if (!Array.isArray(record.items)) throw new ResearchWorkspaceError('corrupt', `${label}.items must be an array`)
  const seen = new Set<string>()
  return record.items.map((entry, index) => {
    let validated: T
    try {
      validated = validate(entry)
    } catch (error) {
      throw new ResearchWorkspaceError('corrupt', `${label}.items[${index}] is invalid`, { cause: error })
    }
    const id = (validated as { id?: unknown }).id
    if (typeof id !== 'string') throw new ResearchWorkspaceError('corrupt', `${label}.items[${index}].id is invalid`)
    if (seen.has(id)) throw new ResearchWorkspaceError('corrupt', `${label} contains duplicate id ${id}`)
    seen.add(id)
    return validated
  })
}

function parseJsonLines<T>(
  bytes: Buffer,
  label: string,
  validate: (entry: unknown, line: number) => T,
): T[] {
  const text = bytes.toString('utf8')
  if (text === '') return []
  if (!text.endsWith('\n')) {
    throw new ResearchWorkspaceError('corrupt', `${label} has a partial final line; the original file was preserved`)
  }
  const lines = text.slice(0, -1).split('\n')
  const seen = new Set<string>()
  return lines.map((line, index) => {
    if (line.trim() === '') throw new ResearchWorkspaceError('corrupt', `${label}:${index + 1} is blank`)
    let raw: unknown
    try { raw = JSON.parse(line) as unknown } catch (error) {
      throw new ResearchWorkspaceError('corrupt', `${label}:${index + 1} is not valid JSON`, { cause: error })
    }
    let entry: T
    try { entry = validate(raw, index + 1) } catch (error) {
      if (error instanceof ResearchWorkspaceError) throw error
      throw new ResearchWorkspaceError('corrupt', `${label}:${index + 1} is invalid`, { cause: error })
    }
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string') throw new ResearchWorkspaceError('corrupt', `${label}:${index + 1} has no id`)
    if (seen.has(id)) throw new ResearchWorkspaceError('corrupt', `${label} contains duplicate id ${id}`)
    seen.add(id)
    return entry
  })
}

export function decisionLogEntryId(value: Omit<DecisionLogEntry, 'schemaVersion' | 'id'>): string {
  return `decision-${sha256(value).slice('sha256:'.length)}`
}

export function validateDecisionLogEntry(value: unknown): DecisionLogEntry {
  const record = plainObject(value, 'decision')
  exactKeys(
    record,
    ['schemaVersion', 'id', 'kind', 'actor', 'summary', 'refs', 'decidedAt'],
    ['rationale', 'details'],
    'decision',
  )
  assertSchema(record.schemaVersion, 'decision')
  const id = assertString(record.id, 'decision.id')
  if (!DECISION_ID_RE.test(id)) throw new ResearchWorkspaceError('corrupt', 'decision.id is invalid')
  const kind = assertString(record.kind, 'decision.kind')
  const actor = assertString(record.actor, 'decision.actor')
  if (!(['user', 'agent', 'system'] as DecisionActor[]).includes(actor as DecisionActor)) {
    throw new ResearchWorkspaceError('corrupt', 'decision.actor is invalid')
  }
  const summary = assertString(record.summary, 'decision.summary')
  const refs = assertStringArray(record.refs, 'decision.refs')
  const decidedAt = validateIsoTimestamp(record.decidedAt, 'decision.decidedAt')
  const rationale = record.rationale === undefined ? undefined : assertString(record.rationale, 'decision.rationale')
  const details = record.details === undefined ? undefined : assertJsonObject(record.details, 'decision.details')
  const content: Omit<DecisionLogEntry, 'schemaVersion' | 'id'> = {
    kind,
    actor: actor as DecisionActor,
    summary,
    ...(rationale === undefined ? {} : { rationale }),
    refs,
    decidedAt,
    ...(details === undefined ? {} : { details }),
  }
  const expected = decisionLogEntryId(content)
  if (id !== expected) throw new ResearchWorkspaceError('corrupt', `decision.id must equal ${expected}`)
  return { schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION, id, ...content }
}

function collectionText<T>(items: readonly T[]): string {
  const envelope: PersistedCollection<T> = { schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION, items: [...items] }
  return jsonText(envelope)
}

function modelRunPath(modelRunId: string): string {
  return `model-runs/${modelRunId}.json`
}

function runManifestPath(runId: string): string {
  return `runs/${runId}/manifest.json`
}

function artifactManifestPath(runId: string): string {
  return `runs/${runId}/artifact-manifest.json`
}

function validateArtifactManifest(value: unknown, expected: ResearchRunManifest): ArtifactHashManifest {
  const record = plainObject(value, 'artifact manifest')
  exactKeys(record, ['schemaVersion', 'caseId', 'runId', 'createdAt', 'files', 'treeHash'], [], 'artifact manifest')
  assertSchema(record.schemaVersion, 'artifact manifest')
  if (record.caseId !== expected.caseId || record.runId !== expected.runId) {
    throw new ResearchWorkspaceError('corrupt', 'Artifact manifest identity does not match the research run')
  }
  validateIsoTimestamp(record.createdAt, 'artifact manifest.createdAt')
  const files = plainObject(record.files, 'artifact manifest.files')
  const parsedFiles: Record<string, ContentHash> = {}
  for (const [file, hash] of Object.entries(files)) {
    assertSafeRelativePath(file)
    assertContentHash(hash, `artifact manifest.files[${JSON.stringify(file)}]`)
    parsedFiles[file] = hash
  }
  assertContentHash(record.treeHash, 'artifact manifest.treeHash')
  if (canonicalJson(parsedFiles) !== canonicalJson(expected.artifactHashes)) {
    throw new ResearchWorkspaceError('corrupt', 'Artifact manifest files differ from the research run manifest')
  }
  if (record.treeHash !== treeHash(parsedFiles)) {
    throw new ResearchWorkspaceError('corrupt', 'Artifact manifest tree hash is invalid')
  }
  return {
    schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION,
    caseId: expected.caseId,
    runId: expected.runId,
    createdAt: record.createdAt as string,
    files: parsedFiles,
    treeHash: record.treeHash,
  }
}

function copyState(state: ResearchCaseState): ResearchCaseState {
  return structuredClone(state)
}

export class ResearchWorkspace {
  readonly root: string
  private readonly now: () => Date
  private readonly lockTimeoutMs: number

  constructor(options: ResearchWorkspaceOptions) {
    this.root = ensureDirectoryNoSymlink(options.root)
    this.now = options.now ?? (() => new Date())
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000
  }

  create(input: CreateResearchCaseInput): ResearchCaseState {
    const createdAt = (input.createdAt === undefined ? this.now() : new Date(input.createdAt)).toISOString()
    const content = {
      subject: input.subject,
      mandate: input.mandate,
      asOf: input.asOf,
      status: input.status ?? 'draft',
      createdAt,
      updatedAt: createdAt,
    } as const
    const researchCase = validateResearchCase({ caseId: researchCaseId(content), ...content })
    const destination = this.caseDirectory(researchCase.caseId, true)
    if (fs.existsSync(destination)) {
      throw new ResearchWorkspaceError('already-exists', `Research case already exists: ${researchCase.caseId}`)
    }
    const temporary = path.join(this.root, `.tmp-case-${process.pid}-${randomBytes(8).toString('hex')}`)
    fs.mkdirSync(temporary, { mode: 0o700 })
    try {
      for (const directory of MANAGED_DIRECTORIES) fs.mkdirSync(path.join(temporary, directory), { mode: 0o700 })
      const hashes: Record<string, ContentHash> = {}
      hashes['evidence.jsonl'] = atomicWriteFile(temporary, 'evidence.jsonl', '')
      hashes['assumptions.json'] = atomicWriteFile(temporary, 'assumptions.json', collectionText([]))
      hashes['claims.json'] = atomicWriteFile(temporary, 'claims.json', collectionText([]))
      hashes['memo.md'] = atomicWriteFile(temporary, 'memo.md', '')
      hashes['decision-log.jsonl'] = atomicWriteFile(temporary, 'decision-log.jsonl', '')
      const caseFile: ResearchCaseFile = {
        schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION,
        revision: 0,
        case: researchCase,
        fileHashes: hashes,
      }
      atomicWriteFile(temporary, CASE_FILE, jsonText(caseFile))
      fs.renameSync(temporary, destination)
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true })
      throw error
    }
    return this.open(researchCase.caseId)
  }

  open(caseId: string): ResearchCaseState {
    const directory = this.caseDirectory(caseId)
    const caseFile = validateCaseFile(parseJson(readFileSecure(directory, CASE_FILE), CASE_FILE))
    if (caseFile.case.caseId !== caseId) {
      throw new ResearchWorkspaceError('corrupt', `case.json identity does not match directory ${caseId}`)
    }
    this.verifyRegisteredFiles(directory, caseFile)

    const evidence = parseJsonLines(readFileSecure(directory, 'evidence.jsonl'), 'evidence.jsonl', validateEvidence)
    const assumptions = validateCollection(
      parseJson(readFileSecure(directory, 'assumptions.json'), 'assumptions.json'),
      'assumptions.json',
      validateAssumption,
    )
    const claims = validateCollection(
      parseJson(readFileSecure(directory, 'claims.json'), 'claims.json'),
      'claims.json',
      validateClaim,
    )
    const decisions = parseJsonLines(
      readFileSecure(directory, 'decision-log.jsonl'),
      'decision-log.jsonl',
      validateDecisionLogEntry,
    )
    const memo = readFileSecure(directory, 'memo.md').toString('utf8')
    const modelRuns: ModelRun[] = []
    const runManifests: ResearchRunManifest[] = []
    for (const relativePath of Object.keys(caseFile.fileHashes).sort()) {
      if (relativePath.startsWith('model-runs/') && relativePath.endsWith('.json')) {
        const expectedModelRunId = path.posix.basename(relativePath, '.json')
        try {
          const modelRun = validateModelRun(parseJson(readFileSecure(directory, relativePath), relativePath))
          if (modelRun.id !== expectedModelRunId) {
            throw new ResearchWorkspaceError('corrupt', `${relativePath} contains model run ${modelRun.id}`)
          }
          modelRuns.push(modelRun)
        } catch (error) {
          throw new ResearchWorkspaceError('corrupt', `${relativePath} is invalid`, { cause: error })
        }
      }
      if (/^runs\/run-[0-9a-f]{64}\/manifest\.json$/u.test(relativePath)) {
        let manifest: ResearchRunManifest
        try {
          manifest = validateResearchRunManifest(parseJson(readFileSecure(directory, relativePath), relativePath))
        } catch (error) {
          throw new ResearchWorkspaceError('corrupt', `${relativePath} is invalid`, { cause: error })
        }
        if (manifest.caseId !== caseId) {
          throw new ResearchWorkspaceError('corrupt', `${relativePath} belongs to another research case`)
        }
        if (relativePath !== runManifestPath(manifest.runId)) {
          throw new ResearchWorkspaceError('corrupt', `${relativePath} contains research run ${manifest.runId}`)
        }
        this.verifyRunArtifacts(directory, manifest)
        const artifactPath = artifactManifestPath(manifest.runId)
        if (!Object.hasOwn(caseFile.fileHashes, artifactPath)) {
          throw new ResearchWorkspaceError('corrupt', `${relativePath} is missing its artifact manifest`)
        }
        validateArtifactManifest(parseJson(readFileSecure(directory, artifactPath), artifactPath), manifest)
        runManifests.push(manifest)
      }
    }
    return copyState({
      revision: caseFile.revision,
      case: caseFile.case,
      evidence,
      assumptions,
      claims,
      modelRuns,
      memo,
      decisions,
      runManifests,
      fileHashes: caseFile.fileHashes,
    })
  }

  update(caseId: string, expectedRevision: number, update: ResearchCaseUpdate): WorkspaceMutationResult {
    if ((update as { status?: unknown }).status === 'archived') {
      throw new ResearchWorkspaceError('invalid-input', 'Use archive() to archive a research case')
    }
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      if (current.case.status === 'archived') {
        throw new ResearchWorkspaceError('archived', `Research case is archived: ${caseId}`)
      }
      if (current.case.status === update.status) return { revision: current.revision, changed: false }
      const nextCase = validateResearchCase({
        ...current.case,
        status: update.status,
        updatedAt: this.timestamp(),
      })
      return this.commit(directory, current, nextCase, {})
    })
  }

  archive(caseId: string, expectedRevision: number): WorkspaceMutationResult {
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      if (current.case.status === 'archived') return { revision: current.revision, changed: false }
      const nextCase = validateResearchCase({ ...current.case, status: 'archived', updatedAt: this.timestamp() })
      return this.commit(directory, current, nextCase, {})
    })
  }

  appendEvidence(caseId: string, expectedRevision: number, entries: readonly Evidence[]): AppendResult {
    if (entries.length === 0) return this.noopAppend(caseId, expectedRevision)
    const validated = entries.map((entry, index) => {
      try { return validateEvidence(entry) } catch (error) {
        throw new ResearchWorkspaceError('invalid-input', `Evidence entry ${index + 1} is invalid`, { cause: error })
      }
    })
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      this.assertWritable(current)
      const ids = new Set(current.evidence.map(entry => entry.id))
      for (const entry of validated) {
        if (ids.has(entry.id)) throw new ResearchWorkspaceError('duplicate-entry', `Evidence already exists: ${entry.id}`)
        ids.add(entry.id)
      }
      const existing = readFileSecure(directory, 'evidence.jsonl').toString('utf8')
      const addition = validated.map(entry => JSON.stringify(entry)).join('\n') + '\n'
      const hash = atomicWriteFile(directory, 'evidence.jsonl', existing + addition)
      const result = this.commit(directory, current, undefined, { 'evidence.jsonl': hash })
      return { ...result, appendedIds: validated.map(entry => entry.id) }
    })
  }

  appendDecision(caseId: string, expectedRevision: number, input: NewDecisionLogEntry): AppendResult {
    let entry: DecisionLogEntry
    try {
      const content: Omit<DecisionLogEntry, 'schemaVersion' | 'id'> = {
        kind: input.kind,
        actor: input.actor,
        summary: input.summary,
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
        refs: [...input.refs],
        decidedAt: input.decidedAt,
        ...(input.details === undefined ? {} : { details: input.details }),
      }
      entry = validateDecisionLogEntry({
        schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION,
        id: input.id ?? decisionLogEntryId(content),
        ...content,
      })
    } catch (error) {
      throw new ResearchWorkspaceError('invalid-input', 'Decision log entry is invalid', { cause: error })
    }
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      this.assertWritable(current)
      if (current.decisions.some(existing => existing.id === entry.id)) {
        throw new ResearchWorkspaceError('duplicate-entry', `Decision already exists: ${entry.id}`)
      }
      const existing = readFileSecure(directory, 'decision-log.jsonl').toString('utf8')
      const hash = atomicWriteFile(directory, 'decision-log.jsonl', `${existing}${JSON.stringify(entry)}\n`)
      const result = this.commit(directory, current, undefined, { 'decision-log.jsonl': hash })
      return { ...result, appendedIds: [entry.id] }
    })
  }

  saveAssumptions(caseId: string, expectedRevision: number, items: readonly Assumption[]): WorkspaceMutationResult {
    return this.saveCollection(caseId, expectedRevision, 'assumptions.json', items, validateAssumption)
  }

  saveClaims(caseId: string, expectedRevision: number, items: readonly Claim[]): WorkspaceMutationResult {
    return this.saveCollection(caseId, expectedRevision, 'claims.json', items, validateClaim)
  }

  saveModelRun(caseId: string, expectedRevision: number, input: ModelRun): ArtifactWriteResult {
    let modelRun: ModelRun
    try { modelRun = validateModelRun(input) } catch (error) {
      throw new ResearchWorkspaceError('invalid-input', 'Model run is invalid', { cause: error })
    }
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      this.assertWritable(current)
      const relativePath = modelRunPath(modelRun.id)
      const bytes = jsonText(modelRun)
      const hash = hashBytes(bytes)
      const existing = current.fileHashes[relativePath]
      if (existing !== undefined) {
        if (existing !== hash) throw new ResearchWorkspaceError('immutable-artifact', `Model run id collision: ${modelRun.id}`)
        return { revision: current.revision, changed: false, path: relativePath, hash }
      }
      atomicWriteFile(directory, relativePath, bytes)
      const result = this.commit(directory, current, undefined, { [relativePath]: hash })
      return { ...result, path: relativePath, hash }
    })
  }

  saveMemo(caseId: string, expectedRevision: number, memo: string): WorkspaceMutationResult {
    if (typeof memo !== 'string') throw new ResearchWorkspaceError('invalid-input', 'Memo must be a string')
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      this.assertWritable(current)
      if (current.memo === memo) return { revision: current.revision, changed: false }
      const hash = atomicWriteFile(directory, 'memo.md', memo)
      return this.commit(directory, current, undefined, { 'memo.md': hash })
    })
  }

  writeArtifact(
    caseId: string,
    expectedRevision: number,
    relativeArtifactPath: string,
    data: string | Buffer,
  ): ArtifactWriteResult {
    assertSafeRelativePath(relativeArtifactPath)
    const relativePath = `artifacts/${relativeArtifactPath}`
    const hash = hashBytes(data)
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      this.assertWritable(current)
      const existing = current.fileHashes[relativePath]
      if (existing !== undefined) {
        if (existing !== hash) {
          throw new ResearchWorkspaceError('immutable-artifact', `Artifact is immutable once written: ${relativePath}`)
        }
        return { revision: current.revision, changed: false, path: relativePath, hash }
      }
      atomicWriteFile(directory, relativePath, data)
      const result = this.commit(directory, current, undefined, { [relativePath]: hash })
      return { ...result, path: relativePath, hash }
    })
  }

  saveRunManifest(
    caseId: string,
    expectedRevision: number,
    input: ResearchRunManifest,
  ): ArtifactWriteResult {
    let manifest: ResearchRunManifest
    try { manifest = validateResearchRunManifest(input) } catch (error) {
      throw new ResearchWorkspaceError('invalid-input', 'Research run manifest is invalid', { cause: error })
    }
    if (manifest.caseId !== caseId) {
      throw new ResearchWorkspaceError('invalid-input', 'Research run manifest belongs to another case')
    }
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      this.assertWritable(current)
      this.verifyRunArtifacts(directory, manifest)
      for (const [artifact, expectedHash] of Object.entries(manifest.artifactHashes)) {
        if (current.fileHashes[artifact] !== expectedHash) {
          throw new ResearchWorkspaceError(
            'invalid-input',
            `Research run artifact is not registered at the expected hash: ${artifact}`,
          )
        }
      }
      const manifestPath = runManifestPath(manifest.runId)
      const artifactPath = artifactManifestPath(manifest.runId)
      const existing = current.runManifests.find(candidate => candidate.runId === manifest.runId)
      const manifestBytes = jsonText(manifest)
      const manifestHash = hashBytes(manifestBytes)
      if (existing !== undefined) {
        if (current.fileHashes[manifestPath] === manifestHash) {
          return { revision: current.revision, changed: false, path: manifestPath, hash: manifestHash }
        }
        if (existing.status !== 'running' || manifest.status === 'running') {
          throw new ResearchWorkspaceError(
            'immutable-artifact',
            `Only a running research run can transition once to a terminal manifest: ${manifest.runId}`,
          )
        }
        const immutableKeys = ['caseId', 'asOf', 'startedAt', 'codeVersion', 'configVersion', 'configHash', 'modelVersion'] as const
        for (const key of immutableKeys) {
          if (existing[key] !== manifest[key]) {
            throw new ResearchWorkspaceError('invalid-input', `Research run changed immutable field ${key}`)
          }
        }
      } else if (current.fileHashes[manifestPath] !== undefined || current.fileHashes[artifactPath] !== undefined) {
        throw new ResearchWorkspaceError('corrupt', `Research run files exist without a loaded manifest: ${manifest.runId}`)
      }
      const artifactManifest: ArtifactHashManifest = {
        schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION,
        caseId,
        runId: manifest.runId,
        createdAt: this.timestamp(),
        files: { ...manifest.artifactHashes },
        treeHash: treeHash(manifest.artifactHashes),
      }
      const artifactBytes = jsonText(artifactManifest)
      atomicWriteFile(directory, manifestPath, manifestBytes)
      const artifactHash = atomicWriteFile(directory, artifactPath, artifactBytes)
      const result = this.commit(directory, current, undefined, {
        [manifestPath]: manifestHash,
        [artifactPath]: artifactHash,
      })
      return { ...result, path: manifestPath, hash: manifestHash }
    })
  }

  getRunManifest(caseId: string, runId: string): ResearchRunManifest {
    assertRunId(runId)
    const state = this.open(caseId)
    const found = state.runManifests.find(manifest => manifest.runId === runId)
    if (found === undefined) throw new ResearchWorkspaceError('not-found', `Research run not found: ${runId}`)
    return structuredClone(found)
  }

  casePath(caseId: string): string {
    return this.caseDirectory(caseId)
  }

  private saveCollection<T extends { id: string }>(
    caseId: string,
    expectedRevision: number,
    relativePath: 'assumptions.json' | 'claims.json',
    items: readonly T[],
    validate: (value: unknown) => T,
  ): WorkspaceMutationResult {
    const seen = new Set<string>()
    const validated = items.map((entry, index) => {
      let parsed: T
      try { parsed = validate(entry) } catch (error) {
        throw new ResearchWorkspaceError('invalid-input', `${relativePath} item ${index + 1} is invalid`, { cause: error })
      }
      if (seen.has(parsed.id)) throw new ResearchWorkspaceError('duplicate-entry', `${relativePath} repeats id ${parsed.id}`)
      seen.add(parsed.id)
      return parsed
    })
    const bytes = collectionText(validated)
    const nextHash = hashBytes(bytes)
    return this.mutate(caseId, expectedRevision, (directory, current) => {
      this.assertWritable(current)
      if (current.fileHashes[relativePath] === nextHash) return { revision: current.revision, changed: false }
      atomicWriteFile(directory, relativePath, bytes)
      return this.commit(directory, current, undefined, { [relativePath]: nextHash })
    })
  }

  private noopAppend(caseId: string, expectedRevision: number): AppendResult {
    const state = this.open(caseId)
    this.assertRevision(state, expectedRevision)
    this.assertWritable(state)
    return { revision: state.revision, changed: false, appendedIds: [] }
  }

  private mutate<T>(
    caseId: string,
    expectedRevision: number,
    action: (directory: string, current: ResearchCaseState) => T,
  ): T {
    const directory = this.caseDirectory(caseId)
    return withFileLock(directory, LOCK_FILE, this.lockTimeoutMs, () => {
      const current = this.open(caseId)
      this.assertRevision(current, expectedRevision)
      return action(directory, current)
    })
  }

  private commit(
    directory: string,
    current: ResearchCaseState,
    nextCase: ResearchCase | undefined,
    changedHashes: Readonly<Record<string, ContentHash>>,
  ): WorkspaceMutationResult {
    const caseFile: ResearchCaseFile = {
      schemaVersion: RESEARCH_WORKSPACE_SCHEMA_VERSION,
      revision: current.revision + 1,
      case: nextCase ?? validateResearchCase({ ...current.case, updatedAt: this.timestamp() }),
      fileHashes: { ...current.fileHashes, ...changedHashes },
    }
    atomicWriteFile(directory, CASE_FILE, jsonText(caseFile))
    return { revision: caseFile.revision, changed: true }
  }

  private assertRevision(state: ResearchCaseState, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new ResearchWorkspaceError('invalid-input', 'Expected revision must be a non-negative integer')
    }
    if (state.revision !== expectedRevision) {
      throw new ResearchWorkspaceError(
        'revision-conflict',
        `Research case revision conflict: expected ${expectedRevision}, found ${state.revision}`,
      )
    }
  }

  private assertWritable(state: ResearchCaseState): void {
    if (state.case.status === 'archived') {
      throw new ResearchWorkspaceError('archived', `Research case is archived: ${state.case.caseId}`)
    }
  }

  private verifyRegisteredFiles(directory: string, caseFile: ResearchCaseFile): void {
    for (const [relativePath, expectedHash] of Object.entries(caseFile.fileHashes)) {
      const actual = hashBytes(readFileSecure(directory, relativePath))
      if (actual !== expectedHash) {
        throw new ResearchWorkspaceError(
          'corrupt',
          `Workspace file hash mismatch for ${relativePath}; the original file was preserved`,
        )
      }
    }
    for (const managed of MANAGED_DIRECTORIES) {
      const directoryPath = assertNoSymlink(directory, managed)
      if (!fs.lstatSync(directoryPath).isDirectory()) {
        throw new ResearchWorkspaceError('corrupt', `Expected workspace directory: ${managed}`)
      }
    }
    const allowed = new Set([CASE_FILE, LOCK_FILE, ...Object.keys(caseFile.fileHashes)])
    for (const relativePath of listFilesRecursively(directory)) {
      if (relativePath.startsWith('.tmp-')) {
        throw new ResearchWorkspaceError('corrupt', `Interrupted atomic write remains: ${relativePath}`)
      }
      if (!allowed.has(relativePath)) {
        throw new ResearchWorkspaceError('corrupt', `Unregistered workspace file: ${relativePath}`)
      }
    }
  }

  private verifyRunArtifacts(directory: string, manifest: ResearchRunManifest): void {
    for (const [relativePath, expectedHash] of Object.entries(manifest.artifactHashes)) {
      assertSafeRelativePath(relativePath)
      if (!relativePath.startsWith('artifacts/')) {
        throw new ResearchWorkspaceError('corrupt', `Run artifact must be under artifacts/: ${relativePath}`)
      }
      const actualHash = hashBytes(readFileSecure(directory, relativePath))
      if (actualHash !== expectedHash) {
        throw new ResearchWorkspaceError('corrupt', `Research run artifact hash mismatch: ${relativePath}`)
      }
    }
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private caseDirectory(caseId: string, allowMissing = false): string {
    assertCaseId(caseId)
    const directory = path.join(this.root, caseId)
    if (!fs.existsSync(directory)) {
      if (allowMissing) return directory
      throw new ResearchWorkspaceError('not-found', `Research case not found: ${caseId}`)
    }
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink()) throw new ResearchWorkspaceError('symlink', `Refusing symlink research case: ${caseId}`)
    if (!stat.isDirectory()) throw new ResearchWorkspaceError('corrupt', `Research case path is not a directory: ${caseId}`)
    return directory
  }
}
