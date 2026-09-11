import { execFile as execFileCallback } from 'node:child_process'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(THIS_DIR, '../..')
const MANIFEST_TYPES = Object.freeze(['lock', 'capability', 'source'])
const MANIFEST_PATHS = Object.freeze({
  lock: 'packages/finance-data-service/providers/astock/upstream/upstream.lock.json',
  capability: 'packages/finance-data-service/providers/astock/upstream/capability-manifest.json',
  source: 'packages/finance-data-service/providers/astock/upstream/source-manifest.json',
})
const DIRECT_FILENAMES = Object.freeze({
  lock: 'upstream.lock.json',
  capability: 'capability-manifest.json',
  source: 'source-manifest.json',
})
const VOLATILE_KEYS = new Set([
  'capturedat', 'checkedat', 'createdat', 'fetchedat', 'generatedat',
  'lastcheckedat', 'timestamp', 'updatedat', 'verifiedat',
])
const SENSITIVE_URL_KEY = /(?:api[-_]?key|access[-_]?token|auth|authorization|cookie|credential|password|secret|token)/iu

export class ReportInputError extends Error {
  constructor(message, code = 'invalid-input') {
    super(message)
    this.name = 'ReportInputError'
    this.code = code
  }
}

function compareText(left, right) {
  const a = String(left)
  const b = String(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalize(value, options = {}) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const values = value.map(item => canonicalize(item, options))
    return options.preserveArrayOrder
      ? values
      : values.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)))
  }
  const result = {}
  for (const key of Object.keys(value).sort(compareText)) {
    if (options.stripVolatile && VOLATILE_KEYS.has(key.replace(/[^a-z0-9]/giu, '').toLowerCase())) continue
    if (value[key] !== undefined) result[key] = canonicalize(value[key], options)
  }
  return result
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function valuesEqual(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function cleanKey(value) {
  return String(value).replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function entityId(value, fallback) {
  if (isPlainObject(value)) {
    for (const key of ['id', 'sourceId', 'capabilityId', 'providerId', 'name', 'path', 'file', 'symbol']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
  }
  return fallback
}

function redactUrl(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return text
  try {
    const parsed = new URL(text)
    if (parsed.username) parsed.username = '[redacted]'
    if (parsed.password) parsed.password = '[redacted]'
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY.test(key)) parsed.searchParams.set(key, '[redacted]')
    }
    parsed.searchParams.sort()
    return parsed.toString()
  } catch {
    return text.replace(/([?&](?:api[-_]?key|access[-_]?token|auth|authorization|password|secret|token)=)[^&#\s]*/giu, '$1[redacted]')
  }
}

function scrubUrl(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return text
  try {
    const parsed = new URL(text)
    parsed.username = ''
    parsed.password = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY.test(key)) parsed.searchParams.delete(key)
    }
    parsed.searchParams.sort()
    return parsed.toString()
  } catch {
    return redactUrl(text).replace(/([?&](?:api[-_]?key|access[-_]?token|auth|authorization|password|secret|token)=)%5Bredacted%5D/giu, '')
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path, label = path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ReportInputError(`cannot read ${label}: ${error.message}`, 'read-failed')
  }
  try {
    const value = JSON.parse(text)
    if (!isPlainObject(value)) throw new Error('top-level value must be an object')
    return value
  } catch (error) {
    throw new ReportInputError(`invalid JSON in ${label}: ${error.message}`, 'json-invalid')
  }
}

function emptyManifestSet() {
  return { lock: null, capability: null, source: null }
}

function classifyManifest(value, filename = '') {
  const lower = filename.toLowerCase()
  if (lower.endsWith('upstream.lock.json') || lower.endsWith('lock.json')) return 'lock'
  if (lower.includes('capability') && lower.includes('manifest')) return 'capability'
  if (lower.includes('source') && lower.includes('manifest')) return 'source'
  if (Array.isArray(value?.functionInventory) || Array.isArray(value?.capabilities)) return 'capability'
  if (Array.isArray(value?.sources)) return 'source'
  if (value?.refType || (value?.repository && value?.version && value?.files)) return 'lock'
  return null
}

function unpackManifestObject(value, hint = null) {
  if (!isPlainObject(value)) throw new ReportInputError('manifest input must be an object')
  const result = emptyManifestSet()
  const bundleKeys = {
    lock: ['lock', 'upstreamLock'],
    capability: ['capability', 'capabilityManifest'],
    source: ['source', 'sourceManifest'],
  }
  let foundBundle = false
  for (const type of MANIFEST_TYPES) {
    for (const key of bundleKeys[type]) {
      if (isPlainObject(value[key])) {
        result[type] = value[key]
        foundBundle = true
        break
      }
    }
  }
  if (foundBundle) return result
  const type = classifyManifest(value) ?? hint
  if (!type) throw new ReportInputError('unable to identify manifest type; expected a lock, capability manifest, source manifest, or manifest bundle')
  result[type] = value
  return result
}

function mergeManifestSets(target, source) {
  for (const type of MANIFEST_TYPES) if (source[type]) target[type] = source[type]
  return target
}

async function loadManifestFile(path, hint = null) {
  const value = await readJson(path)
  return unpackManifestObject(value, hint ?? classifyManifest(value, path))
}

function candidatePaths(root, type) {
  const filename = DIRECT_FILENAMES[type]
  return [...new Set([
    join(root, filename),
    join(root, 'upstream', filename),
    join(root, MANIFEST_PATHS[type]),
  ])]
}

async function loadManifestDirectory(path) {
  const result = emptyManifestSet()
  for (const type of MANIFEST_TYPES) {
    for (const candidate of candidatePaths(path, type)) {
      if (!(await exists(candidate))) continue
      result[type] = await readJson(candidate)
      break
    }
  }
  if (MANIFEST_TYPES.some(type => result[type])) return result

  let names
  try {
    names = await readdir(path)
  } catch (error) {
    throw new ReportInputError(`cannot list manifest directory: ${error.message}`, 'read-failed')
  }
  for (const name of names.sort(compareText)) {
    if (!/\.json$/iu.test(name) || !/(?:lock|manifest)/iu.test(name)) continue
    const candidate = join(path, name)
    let loaded
    try {
      loaded = await loadManifestFile(candidate)
    } catch (error) {
      if (error instanceof ReportInputError && error.code === 'invalid-input') continue
      throw error
    }
    mergeManifestSets(result, loaded)
  }
  if (!MANIFEST_TYPES.some(type => result[type])) {
    throw new ReportInputError('directory contains no recognizable A-stock lock, capability, or source manifest', 'manifest-missing')
  }
  return result
}

export async function loadManifestSet(input, options = {}) {
  if (isPlainObject(input)) return unpackManifestObject(input, options.hint ?? null)
  if (typeof input !== 'string' || !input.trim()) throw new ReportInputError('manifest path must be a non-empty string')
  const path = resolve(options.root ?? process.cwd(), input)
  let metadata
  try {
    metadata = await stat(path)
  } catch (error) {
    throw new ReportInputError(`manifest path does not exist: ${input}`, 'path-missing')
  }
  if (metadata.isDirectory()) return loadManifestDirectory(path)
  if (metadata.isFile()) return loadManifestFile(path, options.hint ?? null)
  throw new ReportInputError(`manifest path is neither a file nor a directory: ${input}`)
}

async function git(root, args) {
  try {
    const result = await execFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return result.stdout
  } catch (error) {
    const detail = String(error.stderr ?? '').trim() || error.message
    throw new ReportInputError(`local git command failed: ${detail}`, 'git-invalid')
  }
}

async function loadManifestRef(ref, root) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/u.test(ref)) {
    throw new ReportInputError('base ref contains unsupported characters', 'git-ref-invalid')
  }
  const repositoryRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  await git(repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
  const result = emptyManifestSet()
  for (const type of MANIFEST_TYPES) {
    try {
      const text = await git(repositoryRoot, ['show', `${ref}:${MANIFEST_PATHS[type]}`])
      const value = JSON.parse(text)
      if (!isPlainObject(value)) throw new Error('top-level value must be an object')
      result[type] = value
    } catch (error) {
      if (error instanceof SyntaxError) throw new ReportInputError(`invalid JSON for ${type} manifest at ${ref}`, 'json-invalid')
      if (error instanceof ReportInputError && error.code === 'git-invalid'
        && /(?:does not exist|exists on disk, but not in|path .* not in|invalid object name)/iu.test(error.message)) continue
      throw error
    }
  }
  if (!MANIFEST_TYPES.some(type => result[type])) {
    throw new ReportInputError(`base ref ${ref} contains no A-stock manifests`, 'manifest-missing')
  }
  return result
}

function explicitManifestSet(options, side) {
  const result = emptyManifestSet()
  const entries = [
    ['lock', options[`${side}Lock`]],
    ['capability', options[`${side}CapabilityManifest`] ?? options[`${side}Capability`]],
    ['source', options[`${side}SourceManifest`] ?? options[`${side}Source`]],
  ]
  let found = false
  for (const [type, value] of entries) {
    if (value === undefined) continue
    if (!isPlainObject(value)) throw new ReportInputError(`${side}${type} must be an object`)
    result[type] = value
    found = true
  }
  return found ? result : null
}

async function resolveSide(options, side, root, baseScope = null) {
  const explicit = explicitManifestSet(options, side)
  if (explicit) return { manifests: explicit, scope: MANIFEST_TYPES.filter(type => explicit[type]) }

  const manifestOption = options[`${side}Manifest`] ?? options[`${side}ManifestPath`]
  if (manifestOption !== undefined) {
    const inMemory = isPlainObject(manifestOption)
    const manifests = await loadManifestSet(manifestOption, { root, hint: inMemory ? null : 'capability' })
    const scope = MANIFEST_TYPES.filter(type => manifests[type])
    return { manifests, scope }
  }

  const ref = options[`${side}Ref`]
  if (ref !== undefined) {
    const manifests = await loadManifestRef(ref, root)
    return { manifests, scope: MANIFEST_TYPES.filter(type => manifests[type]) }
  }

  const input = options[side] ?? options[`${side}Path`]
  if (input !== undefined) {
    const manifests = await loadManifestSet(input, { root })
    return { manifests, scope: MANIFEST_TYPES.filter(type => manifests[type]) }
  }

  if (side === 'base') throw new ReportInputError('a base snapshot is required (--base, --base-manifest, or --base-ref)')
  const manifests = emptyManifestSet()
  for (const type of baseScope ?? MANIFEST_TYPES) {
    const candidate = join(root, MANIFEST_PATHS[type])
    if (candidate && await exists(candidate)) manifests[type] = await readJson(candidate)
  }
  if (!(baseScope ?? MANIFEST_TYPES).some(type => manifests[type])) {
    throw new ReportInputError('current repository contains no requested A-stock manifests', 'manifest-missing')
  }
  return { manifests, scope: baseScope ?? MANIFEST_TYPES.filter(type => manifests[type]) }
}

function mapFromRecords(records) {
  const grouped = new Map()
  for (const [id, value] of records) {
    const key = String(id)
    const values = grouped.get(key) ?? []
    values.push(canonicalize(value, { stripVolatile: true }))
    grouped.set(key, values)
  }
  const result = new Map()
  for (const [id, values] of grouped) {
    values.sort((a, b) => compareText(stableStringify(a), stableStringify(b)))
    result.set(id, values.length === 1 ? values[0] : values)
  }
  return result
}

function diffMaps(base, current) {
  const added = [...current.keys()].filter(key => !base.has(key)).sort(compareText)
  const removed = [...base.keys()].filter(key => !current.has(key)).sort(compareText)
  const changed = [...base.keys()]
    .filter(key => current.has(key) && !valuesEqual(base.get(key), current.get(key)))
    .sort(compareText)
    .map(id => ({ id, before: base.get(id), after: current.get(id) }))
  return { added, removed, changed }
}

function capabilities(manifest) {
  if (Array.isArray(manifest?.capabilities)) return manifest.capabilities
  if (Array.isArray(manifest?.capabilityInventory)) return manifest.capabilityInventory
  return []
}

function functions(manifest) {
  if (Array.isArray(manifest?.functionInventory)) return manifest.functionInventory
  if (Array.isArray(manifest?.functions)) return manifest.functions
  if (Array.isArray(manifest?.function_inventory)) return manifest.function_inventory
  if (Array.isArray(manifest?.inventory?.functions)) return manifest.inventory.functions
  return []
}

function sources(manifest) {
  return Array.isArray(manifest?.sources) ? manifest.sources : []
}

function functionMap(manifest) {
  const grouped = new Map()
  for (const item of functions(manifest)) {
    if (!isPlainObject(item)) continue
    const name = entityId(item, null)
    if (!name) continue
    const signature = {
      signature: item.signature ?? null,
      signatureSha256: item.signatureSha256 ?? item.signatureHash ?? null,
      kind: item.kind ?? null,
    }
    const entry = grouped.get(name) ?? { signatures: [], occurrences: 0 }
    entry.signatures.push(canonicalize(signature))
    entry.occurrences += Number.isInteger(item.occurrences) && item.occurrences > 1 ? item.occurrences : 1
    grouped.set(name, entry)
  }
  for (const entry of grouped.values()) {
    const unique = new Map(entry.signatures.map(value => [stableStringify(value), value]))
    entry.signatures = [...unique.values()].sort((a, b) => compareText(stableStringify(a), stableStringify(b)))
  }
  return grouped
}

function compareFunctions(baseManifest, currentManifest) {
  const base = functionMap(baseManifest)
  const current = functionMap(currentManifest)
  const added = [...current.keys()].filter(name => !base.has(name)).sort(compareText)
  const removed = [...base.keys()].filter(name => !current.has(name)).sort(compareText)
  const signatureChanged = [...base.keys()]
    .filter(name => current.has(name) && !valuesEqual(base.get(name).signatures, current.get(name).signatures))
    .sort(compareText)
    .map(name => ({
      name,
      before: base.get(name).signatures,
      after: current.get(name).signatures,
    }))
  return { added, removed, signatureChanged }
}

function sourceFieldValue(source, predicate, transform = value => canonicalize(value, { stripVolatile: true })) {
  const result = {}
  for (const key of Object.keys(source).sort(compareText)) {
    if (predicate(cleanKey(key))) {
      result[key] = canonicalizeUrls(source[key], transform)
    }
  }
  return result
}

function canonicalizeUrls(value, transform) {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map(item => canonicalizeUrls(item, transform))
    .sort((a, b) => compareText(stableStringify(a), stableStringify(b)))
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareText).map(key => [key, canonicalizeUrls(value[key], transform)]))
  }
  return canonicalize(value, { stripVolatile: true })
}

function sourcePolicyMap(manifest, predicate, transform) {
  return mapFromRecords(sources(manifest).filter(isPlainObject).map((source, index) => [
    entityId(source, `source-${String(index + 1).padStart(3, '0')}`),
    sourceFieldValue(source, predicate, transform),
  ]).filter(([, value]) => Object.keys(value).length > 0))
}

const SPECIAL_SOURCE_KEYS = new Set([
  'auth', 'authentication', 'authmode', 'authtype', 'authrequired', 'requiresauth',
  'license', 'licenses', 'licenseid', 'licensename', 'licensing',
  'dependency', 'dependencies', 'runtimedependencies', 'optionaldependencies', 'pythondependencies', 'requirements', 'packages',
  'url', 'urls', 'sourceurl', 'sourceurls', 'homepage', 'endpoint', 'endpoints', 'repository',
  'host', 'hosts', 'domain', 'domains',
  'test', 'tests', 'testfiles', 'testpaths', 'offlinetests', 'livetests', 'validationtests',
  'canonicalmapping', 'mappings', 'mapping', 'capabilityids', 'sourceids', 'upstreamcallables',
  'status', 'state', 'supportstatus', 'policystatus',
])

function sourceCore(value) {
  const result = {}
  for (const key of Object.keys(value).sort(compareText)) {
    const normalized = cleanKey(key)
    if (SPECIAL_SOURCE_KEYS.has(normalized) || VOLATILE_KEYS.has(normalized)) continue
    result[key] = canonicalize(isUrlKey(normalized) ? canonicalizeUrls(value[key], redactUrl) : value[key], { stripVolatile: true })
  }
  return result
}

function sourceMap(manifest) {
  return mapFromRecords(sources(manifest).filter(isPlainObject).map((source, index) => [
    entityId(source, `source-${String(index + 1).padStart(3, '0')}`),
    sourceCore(source),
  ]))
}

function safeSource(value) {
  if (Array.isArray(value)) return value.map(safeSource)
  if (!isPlainObject(value)) return value
  const result = {}
  for (const key of Object.keys(value).sort(compareText)) {
    const normalized = cleanKey(key)
    result[key] = isUrlKey(normalized)
      ? canonicalizeUrls(value[key], scrubUrl)
      : safeSource(value[key])
  }
  return result
}

function compareSources(baseManifest, currentManifest) {
  const base = mapFromRecords(sources(baseManifest).filter(isPlainObject).map((source, index) => [
    entityId(source, `source-${String(index + 1).padStart(3, '0')}`),
    safeSource(source),
  ]))
  const current = mapFromRecords(sources(currentManifest).filter(isPlainObject).map((source, index) => [
    entityId(source, `source-${String(index + 1).padStart(3, '0')}`),
    safeSource(source),
  ]))
  const differences = diffMaps(base, current)
  differences.changed = differences.changed.map(change => {
    const before = change.before
    const after = change.after
    const fields = {
      dependencies: [sourceFieldValue(before, isDependencyKey), sourceFieldValue(after, isDependencyKey)],
      licenses: [sourceFieldValue(before, isLicenseKey), sourceFieldValue(after, isLicenseKey)],
      auth: [sourceFieldValue(before, isAuthKey), sourceFieldValue(after, isAuthKey)],
      sourceUrls: [sourceFieldValue(before, isUrlKey), sourceFieldValue(after, isUrlKey)],
      mappings: [sourceFieldValue(before, isMappingKey), sourceFieldValue(after, isMappingKey)],
      status: [sourceFieldValue(before, isStatusKey), sourceFieldValue(after, isStatusKey)],
      core: [sourceCore(before), sourceCore(after)],
    }
    return {
      ...change,
      changedFields: Object.entries(fields).filter(([, values]) => !valuesEqual(values[0], values[1])).map(([name]) => name),
    }
  })
  return differences
}

function capabilityMap(manifest) {
  return mapFromRecords(capabilities(manifest).filter(isPlainObject).map((capability, index) => [
    entityId(capability, `capability-${String(index + 1).padStart(3, '0')}`),
    capability,
  ]))
}

function pathIdentity(value, index) {
  const id = entityId(value, null)
  if (id) return id
  if (value === null || typeof value !== 'object') return String(value)
  return `item-${String(index + 1).padStart(3, '0')}-${stableStringify(canonicalize(value, { stripVolatile: true }))}`
}

function walkFields(value, visitor, path = 'manifest') {
  if (Array.isArray(value)) {
    const entries = value.map((item, index) => ({ item, id: pathIdentity(item, index) }))
      .sort((a, b) => compareText(a.id, b.id))
    for (const entry of entries) walkFields(entry.item, visitor, `${path}[${entry.id}]`)
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value).sort(compareText)) {
    visitor({ owner: path, key, normalizedKey: cleanKey(key), value: value[key] })
    walkFields(value[key], visitor, `${path}.${key}`)
  }
}

function isLicenseKey(key) {
  return ['license', 'licenses', 'licenseid', 'licensename', 'licensing'].includes(key)
}

function isAuthKey(key) {
  return ['auth', 'authentication', 'authmode', 'authtype', 'authrequired', 'requiresauth'].includes(key)
}

function isUrlKey(key) {
  return ['url', 'urls', 'sourceurl', 'sourceurls', 'homepage', 'endpoint', 'endpoints', 'repository',
    'host', 'hosts', 'domain', 'domains'].includes(key)
    || key.endsWith('url') || key.endsWith('urls')
}

function isDependencyKey(key) {
  return ['dependency', 'dependencies', 'runtimedependencies', 'optionaldependencies', 'pythondependencies', 'requirements', 'packages'].includes(key)
    || key.endsWith('dependencies')
}

function isTestKey(key) {
  return ['test', 'tests', 'testfiles', 'testpaths', 'offlinetests', 'livetests', 'validationtests'].includes(key)
}

function isMappingKey(key) {
  return ['canonicalmapping', 'mapping', 'mappings', 'capabilityids', 'sourceids', 'upstreamcallables', 'tool', 'tools', 'toolids', 'operations'].includes(key)
}

function isStatusKey(key) {
  return ['status', 'state', 'supportstatus', 'policystatus'].includes(key) || key.endsWith('status')
}

function addFieldRecords(records, prefix, owner, key, value, transform = item => item) {
  const baseId = `${prefix}:${owner}.${key}`
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const itemId = pathIdentity(item, index)
      records.push([`${baseId}[${itemId}]`, transform(item)])
    }
    return
  }
  if (isPlainObject(value) && isDependencyKey(cleanKey(key))) {
    for (const name of Object.keys(value).sort(compareText)) records.push([`${baseId}.${name}`, transform(value[name])])
    return
  }
  records.push([baseId, transform(value)])
}

function collectFields(manifests, predicate, prefix, transform = value => canonicalize(value, { stripVolatile: true })) {
  const records = []
  for (const type of MANIFEST_TYPES) {
    const manifest = manifests[type]
    if (!manifest) continue
    walkFields(manifest, field => {
      if (predicate(field.normalizedKey)) addFieldRecords(records, `${prefix}:${type}`, field.owner, field.key, field.value, transform)
    }, type)
  }
  return mapFromRecords(records)
}

function collectDependencies(manifests) {
  const records = []
  for (const type of MANIFEST_TYPES) {
    const manifest = manifests[type]
    if (!manifest) continue
    walkFields(manifest, field => {
      if (!isDependencyKey(field.normalizedKey)) return
      if (Array.isArray(field.value)) {
        for (const [index, item] of field.value.entries()) {
          const name = entityId(item, `item-${index + 1}`)
          records.push([`dependency:${type}:${field.owner}.${field.key}[${name}]`, item])
        }
        return
      }
      addFieldRecords(records, `dependency:${type}`, field.owner, field.key, field.value)
    }, type)
  }
  return mapFromRecords(records)
}

function collectTests(manifests) {
  const records = []
  const lockFiles = manifests.lock?.files
  if (isPlainObject(lockFiles)) {
    for (const path of Object.keys(lockFiles).sort(compareText)) {
      if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)test[_-]/iu.test(path)) {
        records.push([`test:lock-file:${path}`, lockFiles[path]])
      }
    }
  } else if (Array.isArray(lockFiles)) {
    for (const [index, entry] of lockFiles.entries()) {
      if (!isPlainObject(entry)) continue
      const path = entityId(entry, `file-${index + 1}`)
      if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)test[_-]/iu.test(path)) {
        records.push([`test:lock-file:${path}`, entry])
      }
    }
  }
  for (const [index, entry] of (manifests.source?.snapshotFiles ?? []).entries()) {
    if (!isPlainObject(entry)) continue
    const path = entityId(entry, `file-${index + 1}`)
    if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)test[_-]/iu.test(path)) {
      records.push([`test:snapshot-file:${path}`, entry])
    }
  }
  const generic = collectFields(manifests, isTestKey, 'test')
  for (const entry of generic) records.push(entry)
  return mapFromRecords(records)
}

function collectUncovered(manifests) {
  const records = []
  const capabilityManifest = manifests.capability
  for (const [index, capability] of capabilities(capabilityManifest).entries()) {
    if (!isPlainObject(capability)) continue
    const id = entityId(capability, `capability-${index + 1}`)
    const status = String(capability.status ?? '').toLowerCase()
    const hasMapping = capability.canonicalMapping !== null
      && capability.canonicalMapping !== undefined
      && capability.canonicalMapping !== ''
    if (!hasMapping || /(?:deferred|unsupported|uncovered|unmapped)/u.test(status)) {
      records.push([`capability:${id}`, { status: capability.status ?? null, reason: capability.reason ?? null }])
    }
  }
  for (const [index, item] of functions(capabilityManifest).entries()) {
    if (!isPlainObject(item)) continue
    const name = entityId(item, `function-${index + 1}`)
    const ids = item.capabilityIds
    const publicTopLevel = item.topLevel !== false && !String(name).startsWith('_')
    if (publicTopLevel && Array.isArray(ids) && ids.length === 0) {
      records.push([`function:${name}`, { reason: item.nonCapabilityReason ?? 'no-capability-mapping' }])
    }
  }
  for (const type of MANIFEST_TYPES) {
    const manifest = manifests[type]
    if (!manifest) continue
    walkFields(manifest, field => {
      if (!['uncovered', 'unmapped'].includes(field.normalizedKey)) return
      addFieldRecords(records, `uncovered:${type}`, field.owner, field.key, field.value)
    }, type)
  }
  return mapFromRecords(records)
}

function collectLock(manifests) {
  const lock = manifests.lock
  if (!lock) return new Map()
  const records = []
  for (const key of ['repository', 'version', 'refType', 'tagObject', 'peeledCommit', 'commit', 'tree', 'snapshotSha256', 'generatedCodeSha256']) {
    if (lock[key] !== undefined) records.push([`lock:${key}`, lock[key]])
  }
  if (isPlainObject(lock.generated)) records.push(['lock:generated', lock.generated])
  if (isPlainObject(lock.files)) {
    for (const path of Object.keys(lock.files).sort(compareText)) records.push([`lock:file:${path}`, lock.files[path]])
  } else if (Array.isArray(lock.files)) {
    for (const [index, entry] of lock.files.entries()) {
      records.push([`lock:file:${entityId(entry, `file-${index + 1}`)}`, entry])
    }
  }
  return mapFromRecords(records)
}

function comparableSnapshotEntry(entry) {
  if (!isPlainObject(entry)) return entry
  return {
    path: entry.path ?? null,
    sha256: typeof entry.sha256 === 'string' ? entry.sha256.replace(/^sha256:/u, '') : null,
    gitBlob: entry.gitBlob ?? null,
    size: entry.size ?? null,
    lines: entry.lines ?? null,
  }
}

function snapshotFileMap(entries, side, owner, blockers) {
  const result = new Map()
  if (!Array.isArray(entries)) {
    blockers.push(`${side} ${owner} snapshotFiles must be an array`)
    return result
  }
  for (const entry of entries) {
    const value = comparableSnapshotEntry(entry)
    const path = value?.path
    if (typeof path !== 'string' || !path) {
      blockers.push(`${side} ${owner} contains a snapshot file without a path`)
      continue
    }
    if (result.has(path)) blockers.push(`${side} ${owner} contains duplicate snapshot path ${path}`)
    result.set(path, value)
  }
  return result
}

function validateManifestConsistency(manifests, side) {
  const blockers = []
  const { lock, source } = manifests
  if (!lock || !source) return blockers
  const identities = [
    ['repository', 'repository'], ['upstreamVersion', 'version'], ['tagObject', 'tagObject'],
    ['peeledCommit', lock.peeledCommit === undefined ? 'commit' : 'peeledCommit'], ['tree', 'tree'],
  ]
  for (const [sourceKey, lockKey] of identities) {
    if (source[sourceKey] !== lock[lockKey]) {
      blockers.push(`${side} source manifest ${sourceKey} differs from upstream lock`)
    }
  }
  const lockEntries = Array.isArray(lock.files)
    ? lock.files
    : Object.entries(lock.files ?? {}).map(([path, entry]) => isPlainObject(entry) ? { path, ...entry } : { path, sha256: entry })
  const lockFiles = snapshotFileMap(lockEntries, side, 'upstream lock', blockers)
  const sourceFiles = snapshotFileMap(source.snapshotFiles, side, 'source manifest', blockers)
  if (lockFiles.size !== sourceFiles.size
    || [...lockFiles].some(([path, entry]) => !valuesEqual(entry, sourceFiles.get(path)))) {
    blockers.push(`${side} source manifest snapshotFiles differ from upstream lock`)
  }
  return blockers
}

function snapshotCounts(collections, manifests) {
  return {
    functions: functionMap(manifests.capability).size,
    sources: sourceMap(manifests.source).size,
    dependencies: collections.dependencies.size,
    licenses: collections.licenses.size,
    auth: collections.auth.size,
    sourceUrls: collections.sourceUrls.size,
    tests: collections.tests.size,
    mappings: collections.mappings.size,
    statuses: collections.status.size,
    uncovered: collections.uncovered.size,
  }
}

function categoryCounts(category) {
  const result = {}
  for (const [key, value] of Object.entries(category)) if (Array.isArray(value)) result[key] = value.length
  return result
}

function countChanges(changes) {
  return Object.values(changes).reduce((total, category) => (
    total + Object.values(category).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
  ), 0)
}

function statusSeverity(value) {
  const status = String(value ?? '').toLowerCase()
  if (/^(?:available|active|clean|healthy|implemented-canonical|passed|supported|up-to-date)$/u.test(status)) return 0
  if (/^(?:implemented-experimental|unknown)$/u.test(status)) return 1
  if (/(?:deferred|degraded|dormant|partial|warning)/u.test(status)) return 2
  if (/(?:blocked|error|failed|missing|unauthorized|unavailable|unsupported)/u.test(status)) return 3
  return 1
}

function scalarStatus(value) {
  if (isPlainObject(value) && Object.hasOwn(value, 'status')) return value.status
  return value
}

function addBlockers(changes, baseManifests, currentManifests, initial = []) {
  const blockers = new Set(initial)
  const action = { added: 'added', removed: 'removed', changed: 'changed' }
  for (const name of changes.functions.removed) blockers.add(`function removed: ${name}`)
  for (const item of changes.functions.signatureChanged) blockers.add(`function signature changed: ${item.name}`)
  for (const id of changes.sources.removed) blockers.add(`source removed: ${id}`)
  for (const item of changes.sources.changed) {
    const fields = item.changedFields ?? []
    if (fields.some(field => ['dependencies', 'licenses', 'auth', 'sourceUrls'].includes(field))) {
      blockers.add(`source policy changed: ${item.id} (${fields.filter(field => ['dependencies', 'licenses', 'auth', 'sourceUrls'].includes(field)).join(', ')})`)
    }
  }
  for (const kind of ['added', 'removed', 'changed']) {
    for (const item of changes.dependencies[kind]) blockers.add(`dependency ${action[kind]}: ${typeof item === 'string' ? item : item.id}`)
    for (const item of changes.licenses[kind]) blockers.add(`license ${action[kind]}: ${typeof item === 'string' ? item : item.id}`)
    for (const item of changes.auth[kind]) blockers.add(`authentication ${action[kind]}: ${typeof item === 'string' ? item : item.id}`)
    for (const item of changes.sourceUrls[kind]) blockers.add(`source URL ${action[kind]}: ${typeof item === 'string' ? item : item.id}`)
  }
  for (const id of changes.tests.removed) blockers.add(`test removed: ${id}`)
  for (const id of changes.mappings.removed) blockers.add(`mapping removed: ${id}`)
  for (const item of changes.mappings.changed) blockers.add(`mapping changed: ${item.id}`)
  for (const item of changes.status.changed) {
    if (statusSeverity(scalarStatus(item.after)) > statusSeverity(scalarStatus(item.before))) {
      blockers.add(`status regressed: ${item.id}`)
    }
  }
  for (const id of changes.uncovered.added) blockers.add(`new uncovered item: ${id}`)
  for (const item of changes.uncovered.changed) blockers.add(`uncovered item changed: ${item.id}`)
  for (const id of changes.upstream.removed) if (id.startsWith('lock:file:')) blockers.add(`upstream file removed: ${id.slice('lock:file:'.length)}`)
  const legalFiles = new Set(['LICENSE', 'NOTICE'])
  for (const id of changes.upstream.added) {
    const path = id.startsWith('lock:file:') ? id.slice('lock:file:'.length) : null
    if (legalFiles.has(path)) blockers.add(`legal file added: ${path}`)
  }
  for (const id of changes.upstream.removed) {
    const path = id.startsWith('lock:file:') ? id.slice('lock:file:'.length) : null
    if (legalFiles.has(path)) blockers.add(`legal file removed: ${path}`)
  }
  for (const item of changes.upstream.changed) {
    const path = item.id.startsWith('lock:file:') ? item.id.slice('lock:file:'.length) : null
    if (legalFiles.has(path)) blockers.add(`legal file changed: ${path}`)
  }

  const baseLock = baseManifests.lock
  const currentLock = currentManifests.lock
  if (baseLock && currentLock) {
    const baseCommit = baseLock.peeledCommit ?? baseLock.commit
    const currentCommit = currentLock.peeledCommit ?? currentLock.commit
    if (baseLock.version && baseLock.version === currentLock.version
      && (baseLock.tagObject !== currentLock.tagObject || baseCommit !== currentCommit)) {
      blockers.add(`immutable upstream tag moved: ${baseLock.version}`)
    }
    if (baseLock.repository && currentLock.repository && baseLock.repository !== currentLock.repository) {
      blockers.add('upstream repository changed')
    }
  }
  return [...blockers].sort(compareText)
}

function validateManifestSchemas(manifests, side) {
  const blockers = []
  for (const type of MANIFEST_TYPES) {
    const value = manifests[type]
    if (value === null || value === undefined) continue
    if (Object.hasOwn(value, 'schemaVersion') && typeof value.schemaVersion === 'number' && value.schemaVersion === 1) continue
    blockers.push(`${side} ${type} manifest must own numeric schemaVersion 1 (received ${String(value.schemaVersion)})`)
  }
  return blockers
}

function shortValue(value, limit = 180) {
  let text
  if (typeof value === 'string') text = value
  else text = stableStringify(value)
  text = text.replace(/\s+/gu, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function code(value) {
  return `\`${shortValue(value).replace(/`/gu, '\\`')}\``
}

function identity(manifests) {
  const lock = manifests.lock
  if (!lock) return 'manifest snapshot'
  const commit = lock.peeledCommit ?? lock.commit
  return [lock.version, commit ? String(commit).slice(0, 12) : null].filter(Boolean).join(' @ ') || 'lock snapshot'
}

function renderSimpleList(lines, title, values) {
  if (!values.length) return
  lines.push(`### ${title}`, '')
  for (const value of values) lines.push(`- ${code(value)}`)
  lines.push('')
}

function renderChangedList(lines, title, values, nameKey = 'id') {
  if (!values.length) return
  lines.push(`### ${title}`, '')
  for (const item of values) {
    lines.push(`- ${code(item[nameKey])}: ${code(item.before)} \u2192 ${code(item.after)}`)
  }
  lines.push('')
}

export function renderMarkdown(report, context = {}) {
  const lines = [
    '# A-stock data vendor diff report',
    '',
    `- Status: **${report.status}**`,
    `- Base: ${code(context.baseIdentity ?? 'manifest snapshot')}`,
    `- Current: ${code(context.currentIdentity ?? 'manifest snapshot')}`,
    `- Changes: **${report.summary.totalChanges}**`,
    `- Blockers: **${report.summary.blockerCount}**`,
    '',
    '## Summary',
    '',
    '| Category | Added | Removed | Changed |',
    '|---|---:|---:|---:|',
  ]
  const rows = [
    ['Upstream lock', report.changes.upstream, 'changed'],
    ['Functions', report.changes.functions, 'signatureChanged'],
    ['Sources', report.changes.sources, 'changed'],
    ['Dependencies', report.changes.dependencies, 'changed'],
    ['Licenses', report.changes.licenses, 'changed'],
    ['Authentication', report.changes.auth, 'changed'],
    ['Source URLs', report.changes.sourceUrls, 'changed'],
    ['Tests', report.changes.tests, 'changed'],
    ['Mappings', report.changes.mappings, 'changed'],
    ['Statuses', report.changes.status, 'changed'],
    ['Uncovered', report.changes.uncovered, 'changed'],
  ]
  for (const [label, category, changedKey] of rows) {
    lines.push(`| ${label} | ${category.added?.length ?? 0} | ${category.removed?.length ?? 0} | ${category[changedKey]?.length ?? 0} |`)
  }
  lines.push('')

  if (report.blockers.length) {
    lines.push('## Blockers', '')
    for (const blocker of report.blockers) lines.push(`- ${blocker}`)
    lines.push('')
  }

  renderSimpleList(lines, 'Functions added', report.changes.functions.added)
  renderSimpleList(lines, 'Functions removed', report.changes.functions.removed)
  renderChangedList(lines, 'Function signature changes', report.changes.functions.signatureChanged, 'name')
  renderSimpleList(lines, 'Sources added', report.changes.sources.added)
  renderSimpleList(lines, 'Sources removed', report.changes.sources.removed)
  renderChangedList(lines, 'Sources changed', report.changes.sources.changed)

  for (const [label, category] of [
    ['Upstream lock', report.changes.upstream],
    ['Dependencies', report.changes.dependencies],
    ['Licenses', report.changes.licenses],
    ['Authentication', report.changes.auth],
    ['Source URLs', report.changes.sourceUrls],
    ['Tests', report.changes.tests],
    ['Mappings', report.changes.mappings],
    ['Statuses', report.changes.status],
    ['Uncovered items', report.changes.uncovered],
  ]) {
    renderSimpleList(lines, `${label} added`, category.added ?? [])
    renderSimpleList(lines, `${label} removed`, category.removed ?? [])
    renderChangedList(lines, `${label} changed`, category.changed ?? [])
  }

  if (!report.changed && !report.blocked) lines.push('No manifest differences were detected.', '')
  return `${lines.join('\n').trimEnd()}\n`
}

export function compareManifestSets(baseManifests, currentManifests, options = {}) {
  const scope = options.scope ?? MANIFEST_TYPES
  const base = emptyManifestSet()
  const current = emptyManifestSet()
  for (const type of scope) {
    base[type] = baseManifests[type] ?? null
    current[type] = currentManifests[type] ?? null
  }

  const initialBlockers = [
    ...validateManifestSchemas(base, 'base'),
    ...validateManifestSchemas(current, 'current'),
    ...validateManifestConsistency(base, 'base'),
    ...validateManifestConsistency(current, 'current'),
  ]
  for (const type of scope) {
    if (base[type] && !current[type]) initialBlockers.push(`current snapshot is missing the ${type} manifest`)
    if (!base[type] && current[type]) initialBlockers.push(`base snapshot is missing the ${type} manifest`)
  }

  const baseCollections = {
    dependencies: collectDependencies(base),
    licenses: collectFields(base, isLicenseKey, 'license'),
    auth: collectFields(base, isAuthKey, 'auth'),
    sourceUrls: collectFields(base, isUrlKey, 'source-url', value => canonicalize(typeof value === 'string' ? redactUrl(value) : value, { stripVolatile: true })),
    tests: collectTests(base),
    mappings: collectFields(base, isMappingKey, 'mapping'),
    status: collectFields(base, isStatusKey, 'status'),
    uncovered: collectUncovered(base),
    upstream: collectLock(base),
  }
  const currentCollections = {
    dependencies: collectDependencies(current),
    licenses: collectFields(current, isLicenseKey, 'license'),
    auth: collectFields(current, isAuthKey, 'auth'),
    sourceUrls: collectFields(current, isUrlKey, 'source-url', value => canonicalize(typeof value === 'string' ? redactUrl(value) : value, { stripVolatile: true })),
    tests: collectTests(current),
    mappings: collectFields(current, isMappingKey, 'mapping'),
    status: collectFields(current, isStatusKey, 'status'),
    uncovered: collectUncovered(current),
    upstream: collectLock(current),
  }
  const baseSourcePolicy = {
    dependencies: sourcePolicyMap(base.source, isDependencyKey),
    licenses: sourcePolicyMap(base.source, isLicenseKey),
    auth: sourcePolicyMap(base.source, isAuthKey),
    sourceUrls: sourcePolicyMap(base.source, isUrlKey, scrubUrl),
  }
  const currentSourcePolicy = {
    dependencies: sourcePolicyMap(current.source, isDependencyKey),
    licenses: sourcePolicyMap(current.source, isLicenseKey),
    auth: sourcePolicyMap(current.source, isAuthKey),
    sourceUrls: sourcePolicyMap(current.source, isUrlKey, scrubUrl),
  }

  const changes = {
    upstream: diffMaps(baseCollections.upstream, currentCollections.upstream),
    functions: compareFunctions(base.capability, current.capability),
    capabilities: diffMaps(capabilityMap(base.capability), capabilityMap(current.capability)),
    sources: compareSources(base.source, current.source),
    dependencies: diffMaps(baseSourcePolicy.dependencies, currentSourcePolicy.dependencies),
    licenses: diffMaps(baseSourcePolicy.licenses, currentSourcePolicy.licenses),
    auth: diffMaps(baseSourcePolicy.auth, currentSourcePolicy.auth),
    sourceUrls: diffMaps(baseSourcePolicy.sourceUrls, currentSourcePolicy.sourceUrls),
    tests: diffMaps(baseCollections.tests, currentCollections.tests),
    mappings: diffMaps(baseCollections.mappings, currentCollections.mappings),
    status: diffMaps(baseCollections.status, currentCollections.status),
    uncovered: diffMaps(baseCollections.uncovered, currentCollections.uncovered),
  }
  const totalChanges = countChanges(changes)
  const blockers = addBlockers(changes, base, current, initialBlockers)
  const blocked = blockers.length > 0
  const changed = totalChanges > 0
  const summary = {
    base: snapshotCounts(baseCollections, base),
    current: snapshotCounts(currentCollections, current),
    upstream: categoryCounts(changes.upstream),
    functions: categoryCounts(changes.functions),
    capabilities: categoryCounts(changes.capabilities),
    sources: categoryCounts(changes.sources),
    dependencies: categoryCounts(changes.dependencies),
    licenses: categoryCounts(changes.licenses),
    auth: categoryCounts(changes.auth),
    sourceUrls: categoryCounts(changes.sourceUrls),
    tests: categoryCounts(changes.tests),
    mappings: categoryCounts(changes.mappings),
    status: categoryCounts(changes.status),
    uncovered: categoryCounts(changes.uncovered),
    totalChanges,
    blockerCount: blockers.length,
  }
  const report = {
    schemaVersion: 1,
    status: blocked ? 'blocked' : changed ? 'changed' : 'clean',
    changed,
    blocked,
    blockers,
    summary,
    changes,
    markdown: '',
  }
  report.markdown = renderMarkdown(report, {
    baseIdentity: identity(base),
    currentIdentity: identity(current),
  })
  return report
}

export async function buildDiffReport(options = {}) {
  if (!isPlainObject(options)) throw new ReportInputError('buildDiffReport options must be an object')
  const root = resolve(options.root ?? DEFAULT_ROOT)
  const baseResult = await resolveSide(options, 'base', root)
  const currentResult = await resolveSide(options, 'current', root, baseResult.scope)
  const scope = baseResult.scope.length === 1 && baseResult.scope[0] === 'capability'
    ? ['capability']
    : [...new Set([...baseResult.scope, ...currentResult.scope])].sort(compareText)
  return compareManifestSets(baseResult.manifests, currentResult.manifests, { scope })
}

export default buildDiffReport
