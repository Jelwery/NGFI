import { canonicalJson, type ContentHash, type ResearchRunManifest } from '@finance2dsh/research-core'

import { type ResearchRunDiff, type StructuredValueChange } from './contracts.js'
import { ResearchWorkspaceError, parseJson, readFileSecure } from './fs.js'
import { ResearchWorkspace } from './workspace.js'

function logicalPath(actualPath: string, runId: string): string {
  const prefix = `artifacts/${runId}/`
  return actualPath.startsWith(prefix) ? actualPath.slice(prefix.length) : actualPath
}

function artifactMap(manifest: ResearchRunManifest): Map<string, { actualPath: string; hash: ContentHash }> {
  const result = new Map<string, { actualPath: string; hash: ContentHash }>()
  for (const [actualPath, hash] of Object.entries(manifest.artifactHashes)) {
    const key = logicalPath(actualPath, manifest.runId)
    if (result.has(key)) {
      throw new ResearchWorkspaceError('corrupt', `Run manifest maps multiple artifacts to logical path ${key}`)
    }
    result.set(key, { actualPath, hash })
  }
  return result
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`
  return base === '$' ? `$.${key}` : `${base}.${key}`
}

export function diffStructuredValues(before: unknown, after: unknown, path = '$'): StructuredValueChange[] {
  if (canonicalJson(before) === canonicalJson(after)) return []
  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: StructuredValueChange[] = []
    const length = Math.max(before.length, after.length)
    for (let index = 0; index < length; index += 1) {
      const itemPath = joinPath(path, index)
      if (index >= before.length) changes.push({ path: itemPath, kind: 'added', after: after[index] })
      else if (index >= after.length) changes.push({ path: itemPath, kind: 'removed', before: before[index] })
      else changes.push(...diffStructuredValues(before[index], after[index], itemPath))
    }
    return changes
  }
  const beforeObject = before !== null && typeof before === 'object' && !Array.isArray(before)
  const afterObject = after !== null && typeof after === 'object' && !Array.isArray(after)
  if (beforeObject && afterObject) {
    const left = before as Record<string, unknown>
    const right = after as Record<string, unknown>
    const changes: StructuredValueChange[] = []
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const itemPath = joinPath(path, key)
      if (!Object.hasOwn(left, key)) changes.push({ path: itemPath, kind: 'added', after: right[key] })
      else if (!Object.hasOwn(right, key)) changes.push({ path: itemPath, kind: 'removed', before: left[key] })
      else changes.push(...diffStructuredValues(left[key], right[key], itemPath))
    }
    return changes
  }
  return [{ path, kind: 'changed', before, after }]
}

function parseJsonLines(bytes: Buffer, label: string): unknown[] {
  const text = bytes.toString('utf8')
  if (text === '') return []
  if (!text.endsWith('\n')) throw new ResearchWorkspaceError('corrupt', `${label} has a partial final line`)
  return text.slice(0, -1).split('\n').map((line, index) => {
    try { return JSON.parse(line) as unknown } catch (error) {
      throw new ResearchWorkspaceError('corrupt', `${label}:${index + 1} is not valid JSON`, { cause: error })
    }
  })
}

function structuredArtifact(
  directory: string,
  beforePath: string,
  afterPath: string,
): { format: 'json' | 'jsonl' | 'opaque'; changes?: StructuredValueChange[] } {
  if (beforePath.endsWith('.json') && afterPath.endsWith('.json')) {
    const before = parseJson(readFileSecure(directory, beforePath), beforePath)
    const after = parseJson(readFileSecure(directory, afterPath), afterPath)
    return { format: 'json', changes: diffStructuredValues(before, after) }
  }
  if (beforePath.endsWith('.jsonl') && afterPath.endsWith('.jsonl')) {
    const before = parseJsonLines(readFileSecure(directory, beforePath), beforePath)
    const after = parseJsonLines(readFileSecure(directory, afterPath), afterPath)
    return { format: 'jsonl', changes: diffStructuredValues(before, after) }
  }
  return { format: 'opaque' }
}

export function diffResearchRuns(
  workspace: ResearchWorkspace,
  caseId: string,
  beforeRunId: string,
  afterRunId: string,
): ResearchRunDiff {
  const beforeManifest = workspace.getRunManifest(caseId, beforeRunId)
  const afterManifest = workspace.getRunManifest(caseId, afterRunId)
  const before = artifactMap(beforeManifest)
  const after = artifactMap(afterManifest)
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
  const directory = workspace.casePath(caseId)
  const artifacts: ResearchRunDiff['artifacts'] = { added: [], removed: [], changed: [], unchanged: [] }
  for (const key of keys) {
    const left = before.get(key)
    const right = after.get(key)
    if (left === undefined && right !== undefined) {
      artifacts.added.push({ path: key, actualPath: right.actualPath, hash: right.hash })
    } else if (left !== undefined && right === undefined) {
      artifacts.removed.push({ path: key, actualPath: left.actualPath, hash: left.hash })
    } else if (left !== undefined && right !== undefined && left.hash === right.hash) {
      artifacts.unchanged.push(key)
    } else if (left !== undefined && right !== undefined) {
      const structured = structuredArtifact(directory, left.actualPath, right.actualPath)
      artifacts.changed.push({
        path: key,
        beforePath: left.actualPath,
        afterPath: right.actualPath,
        beforeHash: left.hash,
        afterHash: right.hash,
        format: structured.format,
        ...(structured.changes === undefined ? {} : { changes: structured.changes }),
      })
    }
  }
  const withoutIdentity = (manifest: ResearchRunManifest): Record<string, unknown> => {
    const { runId: _runId, startedAt: _startedAt, finishedAt: _finishedAt, artifactHashes: _artifactHashes, ...rest }
      = manifest as ResearchRunManifest & { finishedAt?: string }
    return rest
  }
  return {
    caseId,
    beforeRunId,
    afterRunId,
    manifestChanges: diffStructuredValues(withoutIdentity(beforeManifest), withoutIdentity(afterManifest)),
    artifacts,
    summary: {
      added: artifacts.added.length,
      removed: artifacts.removed.length,
      changed: artifacts.changed.length,
      unchanged: artifacts.unchanged.length,
    },
  }
}
