import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u

export function quantCodeIdentity(project: string) {
  const digest = createHash('sha256')
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new TypeError('quant code must not contain symlinks')
      if (entry.isDirectory() && entry.name !== '__pycache__') visit(join(directory, entry.name), `${prefix}${entry.name}/`)
      else if (entry.isFile() && entry.name.endsWith('.py')) digest.update(`${prefix}${entry.name}\0`).update(readFileSync(join(directory, entry.name)))
    }
  }
  visit(join(project, 'ngfi_quant'), 'ngfi_quant/')
  return {
    codeVersion: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim(),
    codeContentHash: `sha256:${digest.digest('hex')}`,
    dependencyLockHash: `sha256:${createHash('sha256').update(readFileSync(join(project, 'uv.lock'))).digest('hex')}`,
  }
}

export function requireRuntimeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must match ${SAFE_ID.source}`)
  }
  return value
}

export function containedPath(root: string, ...ids: string[]): string {
  const resolvedRoot = resolve(root)
  const absoluteRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot
  const target = resolve(absoluteRoot, ...ids)
  if (!target.startsWith(absoluteRoot + sep)) throw new TypeError('runtime path escapes its configured root')
  return target
}

export function ensurePlainDirectory(path: string): void {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const segment of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new TypeError(`runtime directory must not contain a symlink: ${current}`)
      if (!stat.isDirectory()) throw new TypeError(`runtime path must be a directory: ${current}`)
    } else {
      mkdirSync(current, { mode: 0o700 })
    }
  }
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return structuredClone(fallback)
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new TypeError(`runtime state must be a regular file: ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    throw new TypeError(`runtime state is corrupt: ${path}`, { cause: error })
  }
}

export interface ContentAddressedRead {
  readonly value: unknown
  readonly hash: `sha256:${string}`
  readonly bytes: number
}

/**
 * Reads a JSON artifact by content address: the file is streamed in chunks so a
 * hostile size cannot be loaded whole before the cap trips, the hash is computed
 * over the exact bytes, and the caller supplies the expected sha256. Regular-file
 * and symlink protection is enforced. Optional schemaVersion and row-count checks
 * fail closed. This is not merely a larger byte limit: reads are bounded and the
 * returned hash always matches the bytes actually parsed.
 */
export function readContentAddressedJson(
  path: string,
  expectedHash: `sha256:${string}`,
  options: { maxBytes?: number; schemaVersion?: string; maxRows?: number; rowsField?: string } = {},
): ContentAddressedRead {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  if (!existsSync(path)) throw new TypeError(`content-addressed artifact is missing: ${path}`)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError(`content-addressed artifact must be a regular file: ${path}`)
  if (stat.size > maxBytes) throw new RangeError(`content-addressed artifact exceeds ${maxBytes} bytes`)
  const digest = createHash('sha256')
  const descriptor = openSync(path, 'r')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  const collected: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      total += read
      if (total > maxBytes) throw new RangeError(`content-addressed artifact exceeds ${maxBytes} bytes`)
      const slice = Buffer.from(chunk.subarray(0, read))
      digest.update(slice)
      collected.push(slice)
    }
  } finally {
    closeSync(descriptor)
  }
  const hash = `sha256:${digest.digest('hex')}` as const
  if (hash !== expectedHash) throw new Error('content-addressed artifact hash mismatch')
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(collected).toString('utf8'))
  } catch (error) {
    throw new TypeError(`content-addressed artifact is not valid JSON: ${path}`, { cause: error })
  }
  if (value === null || typeof value !== 'object') throw new TypeError('content-addressed artifact must be a JSON object or array')
  if (options.schemaVersion !== undefined) {
    const declared = (value as Record<string, unknown>).schemaVersion
    if (declared !== options.schemaVersion) throw new TypeError(`content-addressed artifact schemaVersion must be ${options.schemaVersion}`)
  }
  if (options.maxRows !== undefined) {
    const field = options.rowsField
    const rows = field === undefined ? value : (value as Record<string, unknown>)[field]
    if (!Array.isArray(rows)) throw new TypeError('content-addressed artifact rows must be an array')
    if (rows.length > options.maxRows) throw new RangeError(`content-addressed artifact exceeds ${options.maxRows} rows`)
  }
  return { value, hash, bytes: total }
}

export function atomicJsonWrite(path: string, value: unknown): void {
  const directory = dirname(resolve(path))
  ensurePlainDirectory(directory)
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TypeError(`runtime state must not be a symlink: ${path}`)
  const temporary = join(directory, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function withExclusiveLock<T>(directory: string, action: () => T): T {
  ensurePlainDirectory(directory)
  const lock = join(directory, '.lock')
  let descriptor: number | undefined
  try {
    descriptor = openSync(lock, 'wx', 0o600)
  } catch (error) {
    throw new Error('runtime workspace is locked by another writer', { cause: error })
  }
  try {
    return action()
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(lock)) unlinkSync(lock)
  }
}

export function requireRevision(actual: number, expected: unknown): number {
  if (!Number.isSafeInteger(expected) || (expected as number) < 0) throw new TypeError('expected_revision must be a non-negative integer')
  if (actual !== expected) throw new Error(`revision conflict: expected ${String(expected)}, found ${actual}`)
  return expected as number
}

export function strictTool(tool: ToolDefinition): ToolDefinition {
  const allowed = new Set(Object.keys(tool.parameters.properties ?? {}))
  const execute = tool.execute.bind(tool)
  return {
    ...tool,
    parameters: { ...tool.parameters, additionalProperties: false },
    async execute(args, context) {
      if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
        const unknown = Object.keys(args).filter(key => !allowed.has(key))
        if (unknown.length > 0) throw new TypeError(`unsupported tool parameters: ${unknown.sort().join(', ')}`)
      }
      return execute(args, context)
    },
  }
}
