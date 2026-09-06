import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { ContentHash } from '@finance2dsh/research-core'

export type WorkspaceErrorCode =
  | 'already-exists'
  | 'archived'
  | 'corrupt'
  | 'duplicate-entry'
  | 'immutable-artifact'
  | 'invalid-input'
  | 'invalid-path'
  | 'locked'
  | 'not-found'
  | 'revision-conflict'
  | 'schema-mismatch'
  | 'snapshot-invalid'
  | 'symlink'

export class ResearchWorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResearchWorkspaceError'
  }
}

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/u
const CASE_ID_RE = /^case-[0-9a-f]{64}$/u
const RUN_ID_RE = /^run-[0-9a-f]{64}$/u

export function assertContentHash(value: unknown, label: string): asserts value is ContentHash {
  if (typeof value !== 'string' || !CONTENT_HASH_RE.test(value)) {
    throw new ResearchWorkspaceError('corrupt', `${label} is not a canonical sha256 hash`)
  }
}

export function assertCaseId(caseId: string): void {
  if (!CASE_ID_RE.test(caseId)) {
    throw new ResearchWorkspaceError('invalid-path', `Invalid research case id: ${JSON.stringify(caseId)}`)
  }
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new ResearchWorkspaceError('invalid-path', `Invalid research run id: ${JSON.stringify(runId)}`)
  }
}

export function assertSafeRelativePath(relativePath: string): void {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new ResearchWorkspaceError('invalid-path', 'A non-empty relative path is required')
  }
  if (relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z]:/u.test(relativePath)) {
    throw new ResearchWorkspaceError('invalid-path', `Unsafe relative path: ${JSON.stringify(relativePath)}`)
  }
  const parts = relativePath.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new ResearchWorkspaceError('invalid-path', `Unsafe relative path segment: ${JSON.stringify(relativePath)}`)
  }
}

export function hashBytes(value: string | Buffer): ContentHash {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function treeHash(files: Readonly<Record<string, ContentHash>>): ContentHash {
  const body = Object.keys(files).sort().map(file => `${file}\0${files[file]}`).join('\n')
  return hashBytes(body)
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function ensureDirectoryNoSymlink(directory: string): string {
  const absolute = path.resolve(directory)
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      throw new ResearchWorkspaceError('symlink', `Refusing symlink directory: ${absolute}`)
    }
    if (!stat.isDirectory()) {
      throw new ResearchWorkspaceError('invalid-path', `Expected a directory: ${absolute}`)
    }
  } else {
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 })
  }
  return absolute
}

export function existingDirectoryNoSymlink(directory: string): string {
  const absolute = path.resolve(directory)
  if (!fs.existsSync(absolute)) {
    throw new ResearchWorkspaceError('not-found', `Directory does not exist: ${absolute}`)
  }
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink()) {
    throw new ResearchWorkspaceError('symlink', `Refusing symlink directory: ${absolute}`)
  }
  if (!stat.isDirectory()) {
    throw new ResearchWorkspaceError('invalid-path', `Expected a directory: ${absolute}`)
  }
  return absolute
}

export function assertNoSymlink(root: string, relativePath: string, allowMissing = false): string {
  assertSafeRelativePath(relativePath)
  const resolvedRoot = path.resolve(root)
  let current = resolvedRoot
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw new ResearchWorkspaceError(
          'symlink',
          `Refusing symlink inside research workspace: ${path.relative(resolvedRoot, current)}`,
        )
      }
    } catch (error) {
      if (error instanceof ResearchWorkspaceError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' && allowMissing) break
      throw error
    }
  }
  const target = path.resolve(resolvedRoot, ...relativePath.split('/'))
  const relation = path.relative(resolvedRoot, target)
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new ResearchWorkspaceError('invalid-path', `Path escapes research workspace: ${relativePath}`)
  }
  return target
}

export function readFileSecure(root: string, relativePath: string): Buffer {
  const target = assertNoSymlink(root, relativePath)
  const flags = process.platform === 'win32'
    ? fs.constants.O_RDONLY
    : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  let descriptor: number
  try {
    descriptor = fs.openSync(target, flags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ResearchWorkspaceError('not-found', `Required workspace file is missing: ${relativePath}`, { cause: error })
    }
    throw error
  }
  try {
    return fs.readFileSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

export function atomicWriteFile(root: string, relativePath: string, data: string | Buffer): ContentHash {
  const target = assertNoSymlink(root, relativePath, true)
  const parentRelative = path.posix.dirname(relativePath)
  if (parentRelative !== '.') {
    let current = root
    for (const segment of parentRelative.split('/')) {
      current = path.join(current, segment)
      if (fs.existsSync(current)) {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new ResearchWorkspaceError('symlink', `Refusing symlink directory: ${current}`)
        }
      } else {
        fs.mkdirSync(current, { mode: 0o700 })
      }
    }
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new ResearchWorkspaceError('symlink', `Refusing to replace symlink: ${relativePath}`)
  }
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const temporary = path.join(
    path.dirname(target),
    `.tmp-${path.basename(target)}-${process.pid}-${randomBytes(8).toString('hex')}.part`,
  )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
    try {
      const parent = fs.openSync(path.dirname(target), fs.constants.O_RDONLY)
      try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
    } catch {
      // Some filesystems do not support fsync on directories. The file itself is already durable.
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
    throw error
  }
  return hashBytes(bytes)
}

export function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new ResearchWorkspaceError('corrupt', `${label} is not valid JSON; the original file was preserved`, { cause: error })
  }
}

export function listFilesRecursively(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isSymbolicLink()) {
        throw new ResearchWorkspaceError('symlink', `Refusing symlink inside research workspace: ${relative}`)
      }
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.push(relative)
      else throw new ResearchWorkspaceError('corrupt', `Unsupported filesystem entry: ${relative}`)
    }
  }
  walk(root)
  return files.sort()
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function withFileLock<T>(root: string, lockName: string, timeoutMs: number, action: () => T): T {
  assertSafeRelativePath(lockName)
  const lockPath = assertNoSymlink(root, lockName, true)
  const token = randomBytes(12).toString('hex')
  const body = jsonText({ pid: process.pid, token, createdAt: new Date().toISOString() })
  const deadline = Date.now() + timeoutMs
  let owned: { dev: number; ino: number } | undefined
  for (;;) {
    try {
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)
      const descriptor = fs.openSync(lockPath, flags, 0o600)
      try {
        fs.writeFileSync(descriptor, body)
        fs.fsyncSync(descriptor)
        const stat = fs.fstatSync(descriptor)
        owned = { dev: stat.dev, ino: stat.ino }
      } finally {
        fs.closeSync(descriptor)
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (fs.lstatSync(lockPath).isSymbolicLink()) {
        throw new ResearchWorkspaceError('symlink', `Refusing symlink lock: ${lockPath}`)
      }
      let holder = 'unknown'
      try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown }
        if (typeof parsed.pid === 'number') {
          holder = String(parsed.pid)
          if (!processAlive(parsed.pid)) holder = `${holder} (not running; remove the stale lock explicitly)`
        }
      } catch {
        holder = 'unreadable'
      }
      if (Date.now() >= deadline) {
        throw new ResearchWorkspaceError('locked', `Research case is locked by process ${holder}: ${lockPath}`)
      }
      pause(15)
    }
  }

  try {
    return action()
  } finally {
    if (owned !== undefined) {
      try {
        const current = fs.statSync(lockPath)
        if (current.dev === owned.dev && current.ino === owned.ino) fs.rmSync(lockPath)
      } catch {
        // A missing lock cannot be safely reconstructed during release.
      }
    }
  }
}

export function assertDisjointDirectories(first: string, second: string): void {
  const resolveThroughExistingAncestor = (input: string): string => {
    let existing = path.resolve(input)
    const missing: string[] = []
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing)
      if (parent === existing) break
      missing.unshift(path.basename(existing))
      existing = parent
    }
    const resolved = fs.existsSync(existing) ? fs.realpathSync(existing) : existing
    return path.resolve(resolved, ...missing)
  }
  const left = resolveThroughExistingAncestor(first)
  const right = resolveThroughExistingAncestor(second)
  const leftToRight = path.relative(left, right)
  const rightToLeft = path.relative(right, left)
  const nested = (relation: string): boolean => relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))
  if (nested(leftToRight) || nested(rightToLeft)) {
    throw new ResearchWorkspaceError('invalid-path', `Source and destination must be disjoint: ${left} / ${right}`)
  }
}
