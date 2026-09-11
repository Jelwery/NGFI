import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY = 'https://github.com/simonlin1212/a-stock-data.git'
export const EXTRACTION_SPEC_VERSION = 1
export const GENERATED_HEADER_LINES = 9
export const CAPABILITY_STATUSES = Object.freeze([
  'implemented-canonical',
  'implemented-experimental',
  'implemented-optional-auth',
  'blocked-auth',
  'deferred-policy',
  'unsupported',
])
export const SOURCE_IDS = Object.freeze([
  'mootdx', 'tencent-finance', 'eastmoney-datacenter', 'eastmoney-push2',
  'iwencai', 'eastmoney-reportapi', 'ths-hot', 'ths-hsgt',
  'baidu-gushitong', 'sina-finance', 'ths-basic', 'cailianpress', 'cninfo',
  'sse-official', 'szse-official', 'baostock', 'sw-research', 'pboc', 'nbs',
  'csi', 'cni', 'bse-official',
])
const REQUIRED_SNAPSHOT_FILES = Object.freeze([
  'SKILL.md', 'LICENSE', 'CHANGELOG.md', 'tests/test_official_data.py', 'docs/source-integration-v3.8.0.md',
])
const OPTIONAL_LEGAL_FILES = Object.freeze(['NOTICE'])
const APACHE_2_TERMS_SHA256 = 'a14c5bd2f88659c252bbac195ceb4c19e26f829132b552ffbddd26cb8b41a7d8'
const SOURCE_MANIFEST_IDENTITY_KEYS = Object.freeze([
  ['repository', 'repository'],
  ['upstreamVersion', 'version'],
  ['tagObject', 'tagObject'],
  ['peeledCommit', 'peeledCommit'],
  ['tree', 'tree'],
])

export class VendorError extends Error {
  constructor(message, { code = 'vendor-invalid', blocked = false, details } = {}) {
    super(message)
    this.name = 'VendorError'
    this.code = code
    this.blocked = blocked
    this.details = details
  }
}

export function resolveRepoPaths(root = resolve(THIS_DIR, '../..')) {
  const repositoryRoot = resolve(root)
  const providerRoot = join(repositoryRoot, 'packages/finance-data-service/providers/astock')
  const upstreamRoot = join(providerRoot, 'upstream')
  const generatedRoot = join(providerRoot, 'python/generated')
  return Object.freeze({
    root: repositoryRoot,
    providerRoot,
    upstreamRoot,
    lock: join(upstreamRoot, 'upstream.lock.json'),
    skill: join(upstreamRoot, 'SKILL.md'),
    license: join(upstreamRoot, 'LICENSE'),
    notice: join(upstreamRoot, 'NOTICE'),
    changelog: join(upstreamRoot, 'CHANGELOG.md'),
    upstreamTests: join(upstreamRoot, 'tests/test_official_data.py'),
    integrationDoc: join(upstreamRoot, 'docs/source-integration-v3.8.0.md'),
    sourceManifest: join(upstreamRoot, 'source-manifest.json'),
    capabilityManifest: join(upstreamRoot, 'capability-manifest.json'),
    generatedRoot,
    featureRegistry: join(providerRoot, 'feature-registry.json'),
    generatedModule: join(generatedRoot, 'astock_upstream.py'),
    generatedInit: join(generatedRoot, '__init__.py'),
    blocksRoot: join(generatedRoot, 'blocks'),
    blocksManifest: join(generatedRoot, 'blocks/blocks-manifest.json'),
    extractionSpec: join(repositoryRoot, 'scripts/a-stock-data/extraction-spec.json'),
  })
}

export const ROOTS = resolveRepoPaths()

export function normalizeLf(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  if (text.charCodeAt(0) === 0xfeff) {
    throw new VendorError('UTF-8 BOM is not permitted in vendored text', { code: 'text-bom' })
  }
  return text.replace(/\r\n?/gu, '\n')
}

export function sha256(value, prefix = false) {
  const digest = createHash('sha256').update(value).digest('hex')
  return prefix ? `sha256:${digest}` : digest
}

function countOccurrences(text, needle) {
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

function headingBefore(text, index) {
  return text.slice(0, index).split('\n').reverse().find(line => /^#{1,6}\s+/u.test(line)) ?? null
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

export function parsePythonBlocks(skillText) {
  const text = normalizeLf(skillText)
  const lines = text.split('\n')
  let openFence = null
  for (const [index, line] of lines.entries()) {
    const opening = /^([`~]{3,})(.*)$/u.exec(line)
    if (!openFence && opening) {
      openFence = { character: opening[1][0], length: opening[1].length, line: index + 1 }
      continue
    }
    if (openFence) {
      const closing = new RegExp(`^${openFence.character}{${openFence.length},}[ \t]*$`, 'u')
      if (closing.test(line)) openFence = null
    }
  }
  if (openFence) {
    throw new VendorError(`unclosed Markdown fence at line ${openFence.line}`, { code: 'fence-unclosed', blocked: true })
  }
  const blocks = []
  const fencePattern = /^([`~]{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gmu
  for (const match of text.matchAll(fencePattern)) {
    const label = match[2].trim().toLowerCase()
    if (!['python', 'py'].includes(label)) continue
    const body = match[3].endsWith('\n') ? match[3] : `${match[3]}\n`
    const fenceStart = match.index
    const bodyStart = fenceStart + match[0].indexOf(match[3])
    blocks.push(Object.freeze({
      index: blocks.length + 1,
      label,
      heading: headingBefore(text, fenceStart),
      startLine: lineAt(text, bodyStart),
      endLine: lineAt(text, bodyStart + match[3].length) - (match[3].endsWith('\n') ? 1 : 0),
      body,
      bodySha256: sha256(body),
      fence: match[0],
      fenceStart,
      fenceEnd: fenceStart + match[0].length,
      selectedBlock: null,
    }))
  }
  return blocks
}

function extractDefinitionSpans(body) {
  const lines = body.split('\n')
  const results = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)$/u.exec(lines[index])
    if (!match) continue
    const indent = match[1].replace(/\t/gu, '    ').length
    let signatureEnd = index
    let balance = 0
    let seenParen = false
    let quote = null
    let escaped = false
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      for (const char of `${lines[cursor]}\n`) {
        if (escaped) { escaped = false; continue }
        if (char === '\\') { escaped = true; continue }
        if (quote) { if (char === quote) quote = null; continue }
        if (char === '"' || char === "'") { quote = char; continue }
        if (char === '(') { balance += 1; seenParen = true }
        if (char === ')') balance -= 1
      }
      signatureEnd = cursor
      if (seenParen && balance === 0 && /:\s*(?:#.*)?$/u.test(lines[cursor])) break
    }
    let end = lines.length - 1
    for (let cursor = signatureEnd + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) continue
      const nextIndent = /^\s*/u.exec(lines[cursor])[0].replace(/\t/gu, '    ').length
      if (nextIndent <= indent) { end = cursor - 1; break }
    }
    while (end > index && !lines[end].trim()) end -= 1
    const source = lines.slice(index, end + 1).join('\n') + '\n'
    const signature = lines.slice(index, signatureEnd + 1).join('\n').trim()
    results.push({
      name: match[3],
      kind: match[2] ? 'async-function' : 'function',
      indent,
      startLine: index + 1,
      endLine: end + 1,
      signature,
      signatureSha256: sha256(signature),
      bodySha256: sha256(source),
      source,
    })
  }
  return results
}

function importedBindings(body) {
  const bindings = []
  for (const line of body.split('\n')) {
    if (/^import\s+/u.test(line)) {
      for (const item of line.slice(7).split(',')) {
        const value = item.trim()
        const match = /^([\w.]+)(?:\s+as\s+(\w+))?$/u.exec(value)
        if (match) bindings.push({ binding: match[2] ?? match[1].split('.')[0], statement: line.trim() })
      }
    } else if (/^from\s+/u.test(line)) {
      const match = /^from\s+([\w.]+)\s+import\s+(.+)$/u.exec(line.trim())
      if (!match) continue
      for (const item of match[2].replace(/[()]/gu, '').split(',')) {
        const value = item.trim()
        const name = /^(\w+)(?:\s+as\s+(\w+))?$/u.exec(value)
        if (name) bindings.push({ binding: name[2] ?? name[1], statement: line.trim() })
      }
    }
  }
  return bindings
}

function assignedNames(body) {
  const names = []
  for (const [offset, line] of body.split('\n').entries()) {
    const match = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/u.exec(line)
    if (match) names.push({ name: match[1], line: offset + 1, source: line })
  }
  return names
}

export function buildFunctionInventory(blocks) {
  const inventory = []
  for (const block of blocks) {
    for (const definition of extractDefinitionSpans(block.body)) {
      inventory.push({
        name: definition.name,
        kind: definition.kind,
        fenceIndex: block.index,
        sourceLocation: {
          file: 'SKILL.md',
          startLine: block.startLine + definition.startLine - 1,
          endLine: block.startLine + definition.endLine - 1,
          fenceIndex: block.index,
          selectedBlock: block.selectedBlock ?? null,
        },
        signature: definition.signature,
        signatureSha256: definition.signatureSha256,
        bodySha256: definition.bodySha256,
        topLevel: definition.indent === 0,
        disposition: block.selectedBlock && definition.indent === 0 ? 'generated' : 'inventory-only',
      })
    }
  }
  return inventory
}

export function analyzePythonBlocks(blocks, spec = {}) {
  const functions = buildFunctionInventory(blocks)
  const topLevelFunctions = functions.filter(item => item.topLevel)
  const byName = new Map()
  for (const item of topLevelFunctions) {
    const values = byName.get(item.name) ?? []
    values.push(item)
    byName.set(item.name, values)
  }
  const collisionRules = new Map((spec.definitionCollisionRules ?? []).map(rule => [rule.name, rule]))
  const duplicateDefinitions = []
  const unapprovedDuplicateDefinitions = []
  for (const [name, occurrences] of byName) {
    if (occurrences.length < 2) continue
    const rule = collisionRules.get(name)
    const approved = Boolean(rule && rule.expectedOccurrences === occurrences.length)
    const finding = { name, count: occurrences.length, approved, strategy: rule?.strategy ?? null, occurrences }
    duplicateDefinitions.push(finding)
    if (!approved) unapprovedDuplicateDefinitions.push(finding)
  }
  const importMap = new Map()
  const assignmentMap = new Map()
  for (const block of blocks) {
    for (const entry of importedBindings(block.body)) {
      const values = importMap.get(entry.binding) ?? []
      values.push({ ...entry, fenceIndex: block.index })
      importMap.set(entry.binding, values)
    }
    for (const entry of assignedNames(block.body)) {
      const values = assignmentMap.get(entry.name) ?? []
      values.push({ ...entry, fenceIndex: block.index })
      assignmentMap.set(entry.name, values)
    }
  }
  const importConflicts = [...importMap].flatMap(([binding, entries]) => {
    const statements = [...new Set(entries.map(item => item.statement))]
    return statements.length > 1 ? [{ binding, statements, entries }] : []
  })
  const assignmentCollisions = [...assignmentMap].flatMap(([name, entries]) => {
    if (entries.length < 2) return []
    const rule = (spec.assignmentCollisionRules ?? []).find(item => item.name === name)
    const uniqueSources = [...new Set(entries.map(item => item.source.trim()))]
    const approved = rule?.strategy === 'dedupe-identical' && uniqueSources.length === 1
    return [{ name, entries, approved, strategy: rule?.strategy ?? null }]
  })
  const definitions = new Set(topLevelFunctions.map(item => item.name))
  const imports = new Set([...importMap.keys()])
  const assignments = new Set([...assignmentMap.keys()])
  const builtins = new Set(['True', 'False', 'None', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'len', 'range', 'enumerate', 'zip', 'sorted', 'sum', 'min', 'max', 'abs', 'round', 'print', 'isinstance', 'getattr', 'setattr', 'hasattr', 'type', 'Exception', 'ValueError', 'RuntimeError'])
  const crossBlockReferences = []
  for (const block of blocks) {
    const local = new Set([
      ...extractDefinitionSpans(block.body).filter(item => item.indent === 0).map(item => item.name),
      ...importedBindings(block.body).map(item => item.binding),
      ...assignedNames(block.body).map(item => item.name),
    ])
    const scrubbed = block.body.replace(/(?:'''|""")[\s\S]*?(?:'''|""")/gu, '').replace(/#[^\n]*/gu, '').replace(/(?:r|f|b|u)?(?:'[^'\n]*'|"[^"\n]*")/giu, '')
    const referenced = new Set([...scrubbed.matchAll(/\b([A-Za-z_]\w*)\b/gu)].map(match => match[1]))
    for (const name of referenced) {
      if (local.has(name) || builtins.has(name)) continue
      if (definitions.has(name) || assignments.has(name) || imports.has(name)) {
        crossBlockReferences.push({ fenceIndex: block.index, name })
      }
    }
  }
  return {
    pythonFenceCount: blocks.length,
    definitionOccurrences: functions.length,
    topLevelDefinitionOccurrences: topLevelFunctions.length,
    uniqueDefinitions: new Set(functions.map(item => item.name)).size,
    uniqueTopLevelDefinitions: byName.size,
    functions,
    duplicateDefinitions,
    unapprovedDuplicateDefinitions,
    importConflicts,
    assignmentCollisions,
    crossBlockReferences: crossBlockReferences.sort((a, b) => a.fenceIndex - b.fenceIndex || a.name.localeCompare(b.name)),
  }
}

function markerRegion(text, selector) {
  if (countOccurrences(text, selector.startMarker) !== 1 || countOccurrences(text, selector.endMarker) !== 1) {
    throw new VendorError(`selector ${selector.id} markers must each occur exactly once`, { code: 'marker-drift', blocked: true })
  }
  const start = text.indexOf(selector.startMarker)
  const end = text.indexOf(selector.endMarker)
  if (end <= start) throw new VendorError(`selector ${selector.id} markers are reversed`, { code: 'marker-drift', blocked: true })
  const heading = text.lastIndexOf(selector.heading, start)
  if (heading === -1) throw new VendorError(`selector ${selector.id} heading is missing`, { code: 'heading-drift', blocked: true })
  return { start, end, text: text.slice(start + selector.startMarker.length, end) }
}

function attachSelectors(skillText, blocks, spec) {
  const declaredMarkers = new Set(spec.selectors.flatMap(item => [item.startMarker, item.endMarker]))
  const observedMarkers = [...skillText.matchAll(/<!--\s*official-data-[\w-]+:(?:start|end)\s*-->/gu)].map(match => match[0])
  for (const marker of observedMarkers) {
    if (!declaredMarkers.has(marker)) {
      throw new VendorError(`undeclared extraction marker: ${marker}`, { code: 'marker-drift', blocked: true })
    }
  }
  return blocks.map(block => {
    const selector = spec.selectors.find(item => {
      const region = markerRegion(skillText, item)
      return block.fenceStart > region.start && block.fenceEnd < region.end
    })
    return selector ? Object.freeze({ ...block, selectedBlock: selector.id }) : block
  })
}

function generatedHeader(lock, bodySha256) {
  const snapshotHash = unprefixedHash(fileEntry(lock, 'SKILL.md')?.sha256 ?? lock.snapshotSha256)
  const commit = lock.peeledCommit ?? lock.commit
  return [
    '# GENERATED FILE - DO NOT EDIT.',
    `# Source: ${lock.repository}`,
    `# Upstream tag: ${lock.version}`,
    `# Upstream tag object: ${lock.tagObject}`,
    `# Upstream peeled commit: ${commit}`,
    `# Snapshot SHA-256: ${snapshotHash}`,
    `# Extraction spec version: ${EXTRACTION_SPEC_VERSION}`,
    `# Generated body SHA-256: ${bodySha256}`,
    '# Local changes belong in ../ngfi_overrides/.',
  ].join('\n') + '\n\n'
}

const NGFI_MODIFICATION_NOTICE_LINES = 4

function ngfiModificationNotice(lock, fenceCount) {
  return [
    `# Modified/generated by NGFI from a-stock-data ${lock.version}.`,
    '# Runtime module: mechanically extracted official-data-core and',
    `# official-data-backups in source order; blocks/ preserves all ${fenceCount} Python fences.`,
    '',
  ].join('\n')
}

function fileEntry(lock, path) {
  const entry = Array.isArray(lock?.files)
    ? lock.files.find(item => item?.path === path)
    : lock?.files?.[path]
  if (typeof entry === 'string') return { sha256: entry }
  return entry
}

function unprefixedHash(value) {
  return typeof value === 'string' ? value.replace(/^sha256:/u, '') : value
}

export async function readExtractionSpec(path = ROOTS.extractionSpec) {
  const spec = JSON.parse(await readFile(path, 'utf8'))
  if (spec.schemaVersion !== EXTRACTION_SPEC_VERSION || !Array.isArray(spec.selectors) || spec.selectors.length === 0) {
    throw new VendorError('unsupported or empty extraction spec', { code: 'spec-invalid' })
  }
  if (!Array.isArray(spec.capabilityRuntimeLedger) || spec.capabilityRuntimeLedger.length === 0) {
    throw new VendorError('extraction spec must define a capability runtime ledger', { code: 'spec-invalid' })
  }
  return spec
}

export function extractPythonModule({ skillText, lock, spec }) {
  const rawText = Buffer.isBuffer(skillText) ? skillText.toString('utf8') : String(skillText)
  if (rawText.includes('\r')) throw new VendorError('SKILL.md must use LF line endings', { code: 'line-endings', blocked: true })
  const text = normalizeLf(rawText)
  const parsed = attachSelectors(text, parsePythonBlocks(text), spec)
  if (parsed.length !== spec.expectedPythonFenceCount) {
    throw new VendorError(`expected ${spec.expectedPythonFenceCount} Python fences, found ${parsed.length}`, { code: 'fence-drift', blocked: true })
  }
  if (!Array.isArray(spec.pythonBlocks) || spec.pythonBlocks.length !== parsed.length) {
    throw new VendorError('extraction spec must inventory every Python fence', { code: 'spec-block-inventory', blocked: true })
  }
  for (const [offset, block] of parsed.entries()) {
    const expected = spec.pythonBlocks[offset]
    if (expected.index !== block.index || expected.heading !== block.heading || expected.expectedBodySha256 !== block.bodySha256) {
      throw new VendorError(`Python fence ${block.index} differs from the extraction spec`, {
        code: 'fence-drift', blocked: true,
        details: { expected, actual: { index: block.index, heading: block.heading, expectedBodySha256: block.bodySha256 } },
      })
    }
  }
  const selected = []
  for (const selector of spec.selectors) {
    const matching = parsed.filter(block => block.selectedBlock === selector.id)
    if (matching.length !== 1) throw new VendorError(`selector ${selector.id} must contain exactly one Python fence`, { code: 'fence-drift', blocked: true })
    const block = matching[0]
    if (block.label !== 'python') throw new VendorError(`selector ${selector.id} must use a python fence`, { code: 'fence-label', blocked: true })
    if (block.bodySha256 !== selector.expectedBodySha256) throw new VendorError(`selector ${selector.id} body hash changed`, { code: 'selected-body-drift', blocked: true })
    const names = extractDefinitionSpans(block.body).filter(item => item.indent === 0).map(item => item.name)
    if (JSON.stringify(names) !== JSON.stringify(selector.requiredDefinitions)) {
      throw new VendorError(`selector ${selector.id} definition inventory changed`, { code: 'selected-symbol-drift', blocked: true, details: { expected: selector.requiredDefinitions, actual: names } })
    }
    selected.push(block)
  }
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index - 1].fenceStart >= selected[index].fenceStart) {
      throw new VendorError('selected extraction blocks are reordered', { code: 'marker-order', blocked: true })
    }
  }
  const analysis = analyzePythonBlocks(parsed, spec)
  if (analysis.definitionOccurrences !== spec.expectedDefinitionOccurrences) {
    throw new VendorError(`expected ${spec.expectedDefinitionOccurrences} definitions, found ${analysis.definitionOccurrences}`, { code: 'definition-drift', blocked: true })
  }
  if (analysis.topLevelDefinitionOccurrences !== spec.expectedTopLevelDefinitionOccurrences) {
    throw new VendorError(`expected ${spec.expectedTopLevelDefinitionOccurrences} top-level definitions, found ${analysis.topLevelDefinitionOccurrences}`, { code: 'definition-drift', blocked: true })
  }
  if (analysis.uniqueDefinitions !== spec.expectedUniqueDefinitions || analysis.uniqueTopLevelDefinitions !== spec.expectedUniqueTopLevelDefinitions) {
    throw new VendorError('unique definition inventory changed', { code: 'definition-drift', blocked: true })
  }
  const observedImportConflicts = analysis.importConflicts.map(item => item.binding).sort()
  if (JSON.stringify(observedImportConflicts) !== JSON.stringify([...(spec.expectedImportConflictBindings ?? [])].sort())) {
    throw new VendorError('import conflict inventory changed', { code: 'import-conflict-drift', blocked: true, details: observedImportConflicts })
  }
  const observedAssignments = analysis.assignmentCollisions.map(item => item.name).sort()
  if (JSON.stringify(observedAssignments) !== JSON.stringify([...(spec.expectedAssignmentCollisionNames ?? [])].sort())) {
    throw new VendorError('assignment collision inventory changed', { code: 'assignment-conflict-drift', blocked: true, details: observedAssignments })
  }
  if (analysis.crossBlockReferences.length !== spec.expectedCrossBlockReferenceCount) {
    throw new VendorError('cross-block reference inventory changed', { code: 'cross-block-drift', blocked: true })
  }
  if (analysis.unapprovedDuplicateDefinitions.length) {
    throw new VendorError('unapproved duplicate top-level definitions detected', { code: 'definition-conflict', blocked: true, details: analysis.unapprovedDuplicateDefinitions })
  }
  const body = ngfiModificationNotice(lock, parsed.length) + selected.map(block => block.body.trimEnd()).join('\n\n') + '\n'
  const bodyHash = sha256(body)
  return {
    code: generatedHeader(lock, bodyHash) + body,
    body,
    bodySha256: bodyHash,
    blocks: parsed,
    selectedBlocks: selected,
    analysis,
  }
}

const SOURCE_NAME_MAP = new Map([
  ['通达信', ['mootdx']], ['腾讯', ['tencent-finance']], ['百度', ['baidu-gushitong']],
  ['新浪', ['sina-finance']], ['同花顺', ['ths-hot']], ['iwencai', ['iwencai']],
  ['财联社', ['cailianpress']], ['巨潮', ['cninfo']], ['baostock', ['baostock']],
  ['申万', ['sw-research']], ['人民银行', ['pboc']], ['国家统计局', ['nbs']],
  ['中证', ['csi']], ['国证', ['cni']], ['深交所', ['szse-official']],
  ['北交所', ['bse-official']], ['上交所', ['sse-official']], ['本地', []],
  ['本地计算', []],
])

function sourceIdsForCell(cell, expression) {
  if (expression.includes('iwencai')) return ['iwencai']
  if (/ths_eps_forecast/u.test(expression)) return ['ths-basic']
  if (/hsgt_realtime/u.test(expression)) return ['ths-hsgt']
  if (/em_hot_rank|em_hot_concept/u.test(expression)) return ['eastmoney-push2']
  if (/limit_up_sentiment/u.test(expression)) return ['eastmoney-push2']
  if (/chip_distribution/u.test(expression)) return ['mootdx', 'baostock']
  if (/dragon_tiger_backup/u.test(expression)) return ['sse-official', 'szse-official', 'sina-finance', 'eastmoney-push2']
  if (cell === '东财') {
    if (/report|download_pdf/u.test(expression)) return ['eastmoney-reportapi']
    if (/concept|fund_flow|industry_comparison|stock_news|global_news|stock_info|zt_pool|zb_pool|dt_pool|yzt_pool|monitor|anomaly|hot_rank|hot_concept/u.test(expression)) return ['eastmoney-push2']
    return ['eastmoney-datacenter']
  }
  const result = []
  for (const [name, ids] of SOURCE_NAME_MAP) if (cell.includes(name)) result.push(...ids)
  return [...new Set(result)]
}

function normalizeCallable(token) {
  const trimmed = token.trim()
  if (trimmed.startsWith('.')) return `tdx_client${trimmed.replace(/\(.*$/u, '')}`
  if (trimmed.startsWith('client.')) return `tdx_client.${trimmed.slice(7).replace(/\(.*$/u, '')}`
  return trimmed.replace(/\(.*$/u, '')
}

export function parseCapabilityTable(skillText) {
  const text = normalizeLf(skillText)
  const start = text.indexOf('## 端点路由速查')
  const end = text.indexOf('## 数据源优先级', start)
  if (start === -1 || end === -1) throw new VendorError('endpoint routing table is missing', { code: 'capability-table-drift', blocked: true })
  const candidates = []
  for (const line of text.slice(start, end).split('\n')) {
    if (!line.startsWith('|') || /^\|[- :]+\|/u.test(line) || line.includes('| 函数 |')) continue
    const cells = line.slice(1, -1).split('|').map(cell => cell.trim())
    if (cells.length < 4) continue
    const [section, expression, description, source] = cells
    const callables = [...expression.matchAll(/`([^`]+)`/gu)].map(match => normalizeCallable(match[1]))
    if (!callables.length) continue
    candidates.push({ section, expression, description, source, callables })
  }
  const capabilities = []
  for (const row of candidates) {
    let groups = row.callables.map(item => [item])
    if (row.section === '前置') continue
    if (row.section === '1.1') groups = [['tdx_client.bars', 'tdx_client.quotes', 'tdx_client.transaction']]
    if (row.section === '1.4') groups = [row.callables]
    if (row.section === '2.1' && row.callables.includes('eastmoney_reports')) groups = [['eastmoney_reports'], ['download_pdf']]
    if (row.section === '2.1' && row.callables.includes('eastmoney_industry_reports')) continue
    if (row.section === '2.3') groups = [row.callables]
    if (row.section === '6.7') groups = [row.callables]
    if (row.section === '8.1') groups = row.callables.map(item => [item])
    if (row.section === '8.5') groups = row.callables.map(item => [item])
    if (row.section === '9.1') groups = row.callables.map(item => [item])
    if (row.section === '10.2') groups = row.callables.map(item => [item])
    if (row.section === '备用源速查') groups = [row.callables]
    if (row.section === '估值公式') continue
    for (const callables of groups) {
      const callableExpression = callables.join(' / ')
      capabilities.push({
        id: `capability-${String(capabilities.length + 1).padStart(3, '0')}`,
        section: row.section,
        name: callables.join(' / '),
        expression: row.expression,
        description: row.description,
        upstreamCallables: callables,
        sourceIds: sourceIdsForCell(row.source, callableExpression),
      })
    }
  }
  if (capabilities.length !== 60) {
    throw new VendorError(`upstream advertises 60 capabilities but parser found ${capabilities.length}`, { code: 'capability-count', blocked: true, details: capabilities })
  }
  return capabilities
}

function generatedLocationFor(item, selectedBlocks) {
  const block = selectedBlocks.find(value => value.index === item.fenceIndex)
  if (!block) return []
  let before = NGFI_MODIFICATION_NOTICE_LINES
  for (const current of selectedBlocks) {
    if (current.index === block.index) break
    before += current.body.trimEnd().split('\n').length + 1
  }
  const localStart = item.sourceLocation.startLine - block.startLine + 1
  const localEnd = item.sourceLocation.endLine - block.startLine + 1
  return [{ file: 'python/generated/astock_upstream.py', bodyStartLine: before + localStart - 1, bodyEndLine: before + localEnd - 1 }]
}

function runtimeLedgerByCapability(spec, ledger, sourceIds) {
  const configured = spec?.capabilityRuntimeLedger
  if (!Array.isArray(configured)) {
    throw new VendorError('extraction spec must define a capability runtime ledger', { code: 'runtime-ledger', blocked: true })
  }
  if (configured.length !== ledger.length) {
    throw new VendorError(`capability runtime ledger must inventory all ${ledger.length} capabilities`, { code: 'runtime-ledger', blocked: true })
  }
  const result = new Map()
  for (const entry of configured) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      throw new VendorError('capability runtime ledger entries require an id', { code: 'runtime-ledger', blocked: true })
    }
    if (result.has(entry.id)) {
      throw new VendorError(`duplicate capability runtime ledger entry ${entry.id}`, { code: 'runtime-ledger', blocked: true })
    }
    result.set(entry.id, entry)
  }
  for (const capability of ledger) {
    const entry = result.get(capability.id)
    if (!entry) {
      throw new VendorError(`capability runtime ledger is missing ${capability.id}`, { code: 'runtime-ledger', blocked: true })
    }
    if (entry.section !== capability.section) {
      throw new VendorError(`capability runtime ledger section differs for ${capability.id}`, { code: 'runtime-ledger', blocked: true })
    }
    if (JSON.stringify(entry.upstreamCallables) !== JSON.stringify(capability.upstreamCallables)) {
      throw new VendorError(`capability runtime ledger callables differ for ${capability.id}`, { code: 'runtime-ledger', blocked: true })
    }
    if (!CAPABILITY_STATUSES.includes(entry.status)) {
      throw new VendorError(`capability runtime ledger has invalid status for ${capability.id}`, { code: 'runtime-ledger', blocked: true })
    }
    if (!Array.isArray(entry.runtimeMappings) || entry.runtimeMappings.length !== capability.upstreamCallables.length) {
      throw new VendorError(`capability runtime ledger must map every callable for ${capability.id}`, { code: 'runtime-ledger', blocked: true })
    }
    const expected = [...capability.upstreamCallables].sort()
    const actual = entry.runtimeMappings.map(item => item?.upstreamCallable).sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new VendorError(`capability runtime mappings differ for ${capability.id}`, { code: 'runtime-ledger', blocked: true })
    }
    for (const mapping of entry.runtimeMappings) {
      if (!CAPABILITY_STATUSES.includes(mapping.status)) {
        throw new VendorError(`capability runtime mapping has invalid status for ${capability.id}:${mapping.upstreamCallable}`, { code: 'runtime-ledger', blocked: true })
      }
      const hasRoute = typeof mapping.providerId === 'string' && mapping.providerId.length > 0
        && typeof mapping.operation === 'string' && mapping.operation.length > 0
      if (['implemented-canonical', 'implemented-experimental', 'implemented-optional-auth'].includes(mapping.status) && !hasRoute) {
        throw new VendorError(`implemented runtime mapping requires providerId and operation for ${capability.id}:${mapping.upstreamCallable}`, { code: 'runtime-ledger', blocked: true })
      }
      if (!Array.isArray(mapping.runtimeSourceIds)
        || mapping.runtimeSourceIds.some(sourceId => !sourceIds.has(sourceId))) {
        throw new VendorError(`capability runtime mapping has invalid runtimeSourceIds for ${capability.id}:${mapping.upstreamCallable}`, { code: 'runtime-ledger', blocked: true })
      }
    }
    const mappedStatuses = entry.runtimeMappings.map(mapping => mapping.status)
    const aggregateStatus = mappedStatuses.every(status => status === 'implemented-optional-auth')
      ? 'implemented-optional-auth'
      : mappedStatuses.every(status => status === 'implemented-canonical')
      ? 'implemented-canonical'
      : mappedStatuses.some(status => ['implemented-canonical', 'implemented-experimental', 'implemented-optional-auth'].includes(status))
        ? 'implemented-experimental'
        : mappedStatuses.every(status => status === 'blocked-auth')
          ? 'blocked-auth'
          : mappedStatuses.every(status => status === 'unsupported')
            ? 'unsupported'
            : 'deferred-policy'
    if (entry.status !== aggregateStatus) {
      throw new VendorError(`capability runtime ledger status differs from its callable mappings for ${capability.id}: expected ${aggregateStatus}`, { code: 'runtime-ledger', blocked: true })
    }
  }
  return result
}

export function buildCapabilityManifest({ skillText, lock, extraction, sourceManifest, spec }) {
  const ledger = parseCapabilityTable(skillText)
  const sourceIds = new Set((sourceManifest?.sources ?? []).map(item => item.id))
  const inventoryByName = new Map()
  for (const item of extraction.analysis.functions) {
    const values = inventoryByName.get(item.name) ?? []
    values.push(item)
    inventoryByName.set(item.name, values)
  }
  const runtimeLedger = runtimeLedgerByCapability(spec, ledger, sourceIds)
  const generated = new Set(extraction.analysis.functions.filter(item => item.disposition === 'generated').map(item => item.name))
  for (const capability of ledger) {
    for (const sourceId of capability.sourceIds) {
      if (sourceManifest && !sourceIds.has(sourceId)) throw new VendorError(`unknown sourceId ${sourceId} in ${capability.id}`, { code: 'manifest-source' })
    }
    const names = capability.upstreamCallables.map(value => value.replace(/^tdx_client\./u, ''))
    const runtime = runtimeLedger.get(capability.id)
    capability.status = runtime.status
    capability.generated = names.some(name => generated.has(name))
    capability.auth = runtime.auth ?? (capability.status === 'implemented-optional-auth' ? 'api-key' : 'none')
    capability.canonicalMapping = capability.status === 'implemented-canonical'
      ? [...new Set(runtime.runtimeMappings.map(mapping => `${mapping.providerId}.${mapping.operation}`))].join(' / ')
      : null
    capability.runtimeMappings = runtime.runtimeMappings.map(mapping => ({
      ...mapping,
      sourceIds: mapping.runtimeSourceIds,
    }))
    capability.reason = runtime.reason ?? null
  }
  const functionInventory = extraction.analysis.functions.map(item => ({
    ...item,
    occurrences: inventoryByName.get(item.name).length,
    generated: item.disposition === 'generated',
    generatedLocations: generatedLocationFor(item, extraction.selectedBlocks),
    capabilityIds: ledger.filter(capability => capability.upstreamCallables.some(value => value === item.name || value.endsWith(`.${item.name}`))).map(capability => capability.id),
    nonCapabilityReason: ledger.some(capability => capability.upstreamCallables.some(value => value === item.name || value.endsWith(`.${item.name}`)))
      ? null
      : item.name.startsWith('_') ? 'private-helper' : item.topLevel ? 'supporting-public-callable' : 'nested-helper',
  }))
  const statusCounts = Object.fromEntries(CAPABILITY_STATUSES.map(status => [status, ledger.filter(item => item.status === status).length]))
  return {
    schemaVersion: 1,
    upstream: {
      repository: lock.repository, version: lock.version, tagObject: lock.tagObject,
      peeledCommit: lock.peeledCommit ?? lock.commit, tree: lock.tree ?? null,
    },
    extraction: {
      specVersion: EXTRACTION_SPEC_VERSION,
      selectors: extraction.selectedBlocks.map(block => ({ id: block.selectedBlock, fenceIndex: block.index, bodySha256: block.bodySha256 })),
    },
    summary: {
      advertisedCapabilities: ledger.length,
      definitionOccurrences: extraction.analysis.definitionOccurrences,
      topLevelDefinitionOccurrences: extraction.analysis.topLevelDefinitionOccurrences,
      uniqueDefinitions: extraction.analysis.uniqueDefinitions,
      generatedDefinitions: functionInventory.filter(item => item.generated).length,
      statusCounts,
    },
    capabilities: ledger,
    functionInventory,
    diagnostics: {
      duplicateDefinitions: extraction.analysis.duplicateDefinitions.map(item => ({ name: item.name, count: item.count, approved: item.approved, strategy: item.strategy })),
      importConflicts: extraction.analysis.importConflicts,
      assignmentCollisions: extraction.analysis.assignmentCollisions,
      crossBlockReferences: extraction.analysis.crossBlockReferences,
    },
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function blockFilename(index) {
  return `block-${String(index).padStart(3, '0')}.py`
}

function buildBlocksArtifacts(blocks, lock) {
  const files = new Map()
  const manifestBlocks = []
  for (const block of blocks) {
    const filename = blockFilename(block.index)
    const content = block.body
    files.set(`blocks/${filename}`, content)
    manifestBlocks.push({ index: block.index, file: filename, heading: block.heading, sourceStartLine: block.startLine, sourceEndLine: block.endLine, bodySha256: block.bodySha256, fileSha256: sha256(content), selectedBlock: block.selectedBlock })
  }
  files.set('blocks/blocks-manifest.json', stableJson({
    schemaVersion: 1,
    warning: 'Audit-only raw Python fences. Do not import or execute these files as a package.',
    upstream: { repository: lock.repository, version: lock.version, commit: lock.peeledCommit ?? lock.commit },
    count: blocks.length,
    blocks: manifestBlocks,
  }))
  return files
}

function normalizeFileHashEntry(entry) {
  return unprefixedHash(typeof entry === 'string' ? entry : entry?.sha256)
}

export function validateLock(lock) {
  const errors = []
  if (!lock || typeof lock !== 'object') errors.push('lock must be an object')
  if (lock?.repository !== REPOSITORY) errors.push(`repository must be ${REPOSITORY}`)
  if (!['tag', 'annotated-tag'].includes(lock?.refType)) errors.push('refType must be annotated-tag (legacy tag is also accepted)')
  if (!/^v\d+\.\d+\.\d+$/u.test(lock?.version ?? '')) errors.push('version must be a stable vMAJOR.MINOR.PATCH tag')
  if (!/^[0-9a-f]{40}$/u.test(lock?.tagObject ?? '')) errors.push('tagObject must be a 40-character lowercase SHA-1')
  if (!/^[0-9a-f]{40}$/u.test(lock?.peeledCommit ?? lock?.commit ?? '')) errors.push('peeledCommit/commit must be a 40-character lowercase SHA-1')
  if (lock?.license !== 'Apache-2.0') errors.push('license must be Apache-2.0')
  if (lock?.extractionSpecVersion !== undefined && lock.extractionSpecVersion !== EXTRACTION_SPEC_VERSION) errors.push('extractionSpecVersion is unsupported')
  if (!lock?.files || typeof lock.files !== 'object') errors.push('files must be an array or object')
  const fileEntries = Array.isArray(lock?.files)
    ? lock.files.map(entry => [entry?.path, entry])
    : Object.entries(lock?.files ?? {})
  const seenPaths = new Set()
  for (const [path, entry] of fileEntries) {
    if (typeof path !== 'string' || !path) { errors.push('lock file entry is missing path'); continue }
    if (isAbsolute(path) || path.split('/').includes('..') || path.includes('\\') || path.startsWith('./') || path.includes('//')) {
      errors.push(`unsafe lock file path: ${path}`)
    }
    if (seenPaths.has(path)) errors.push(`duplicate lock file path: ${path}`)
    seenPaths.add(path)
    if (!/^[0-9a-f]{64}$/u.test(normalizeFileHashEntry(entry) ?? '')) errors.push(`invalid SHA-256 for ${path}`)
  }
  const allowedSnapshotPaths = new Set([...REQUIRED_SNAPSHOT_FILES, ...OPTIONAL_LEGAL_FILES])
  for (const path of seenPaths) if (!allowedSnapshotPaths.has(path)) errors.push(`unexpected lock file path: ${path}`)
  for (const path of REQUIRED_SNAPSHOT_FILES) if (!seenPaths.has(path)) errors.push(`lock files must include ${path}`)
  if (lock?.inventory) {
    const expectedInventory = { advertisedCapabilities: 60, advertisedSources: 22, pythonFenceCount: 62, discoveredDefOccurrences: 112, discoveredUniqueDefinitions: 111, topLevelDefOccurrences: 107 }
    for (const [name, expected] of Object.entries(expectedInventory)) if (lock.inventory[name] !== expected) errors.push(`inventory.${name} must be ${expected}`)
  }
  if (errors.length) throw new VendorError(`invalid upstream lock: ${errors.join('; ')}`, { code: 'lock-invalid', blocked: true, details: errors })
  return lock
}

async function pathExists(path) {
  try { await access(path); return true } catch { return false }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function loadSourceManifest(path) {
  if (!(await pathExists(path))) return null
  const value = await readJson(path)
  if (!Array.isArray(value.sources) || value.sources.length !== 22) throw new VendorError('source manifest must contain 22 sources', { code: 'source-manifest' })
  const ids = value.sources.map(item => item.id)
  if (new Set(ids).size !== ids.length) throw new VendorError('source manifest contains duplicate IDs', { code: 'source-manifest' })
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...SOURCE_IDS].sort())) throw new VendorError('source manifest IDs differ from the pinned 22-source vocabulary', { code: 'source-manifest' })
  return value
}

function snapshotEntries(value) {
  return Array.isArray(value) ? value : []
}

function snapshotEntryComparable(entry) {
  if (!entry || typeof entry !== 'object') return entry
  return {
    path: entry.path, sha256: unprefixedHash(entry.sha256), gitBlob: entry.gitBlob,
    size: entry.size, lines: entry.lines,
  }
}

function validateSourceManifestAgainstLock(sourceManifest, lock) {
  if (!sourceManifest) {
    throw new VendorError('source manifest is missing and cannot be mechanically rebuilt', { code: 'source-manifest', blocked: true })
  }
  const errors = []
  for (const [sourceKey, lockKey] of SOURCE_MANIFEST_IDENTITY_KEYS) {
    const expected = lockKey === 'peeledCommit' ? (lock.peeledCommit ?? lock.commit) : lock[lockKey]
    if (sourceManifest[sourceKey] !== expected) errors.push(`${sourceKey} differs from upstream lock`)
  }
  const sourceFiles = snapshotEntries(sourceManifest.snapshotFiles).map(snapshotEntryComparable)
  const lockFiles = snapshotEntries(lock.files).map(snapshotEntryComparable)
  if (sourceFiles.length !== lockFiles.length
    || sourceFiles.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(lockFiles[index]))) {
    errors.push('snapshotFiles differ from upstream lock')
  }
  if (errors.length) {
    throw new VendorError(`source manifest differs from upstream lock: ${errors.join('; ')}`, {
      code: 'source-lock-mismatch', blocked: true, details: errors,
    })
  }
  return sourceManifest
}

function rebuildSourceManifest(previous, lock) {
  if (!previous || !Array.isArray(previous.sources) || !Array.isArray(previous.pythonDependencies)) {
    throw new VendorError('source manifest cannot be mechanically rebuilt', { code: 'source-manifest-rebuild', blocked: true })
  }
  return {
    ...previous,
    schemaVersion: 1,
    repository: lock.repository,
    upstreamVersion: lock.version,
    tagObject: lock.tagObject,
    peeledCommit: lock.peeledCommit ?? lock.commit,
    tree: lock.tree,
    snapshotFiles: lock.files.map(entry => ({ ...entry })),
  }
}

function apacheTerms(text) {
  const normalized = normalizeLf(text)
  const start = normalized.indexOf('Apache License')
  const marker = 'END OF TERMS AND CONDITIONS'
  const end = normalized.indexOf(marker, start)
  if (start === -1 || end === -1) return null
  return normalized.slice(start, end + marker.length).replace(/\s+/gu, ' ').trim()
}

function validateApacheLicense(text) {
  const terms = apacheTerms(text)
  if (!terms || sha256(terms) !== APACHE_2_TERMS_SHA256) {
    throw new VendorError('candidate LICENSE is not the canonical Apache-2.0 license text', { code: 'license-policy', blocked: true })
  }
}

async function validateAttribution(paths, lock) {
  const errors = []
  const requirements = [
    [join(paths.root, 'THIRD_PARTY_NOTICES.md'), ['a-stock-data', lock.version, lock.tagObject, lock.peeledCommit ?? lock.commit, 'modified', 'generated']],
    [join(paths.providerRoot, 'python/ngfi_overrides/README.md'), ['a-stock-data']],
    [join(paths.providerRoot, 'patches/README.md'), ['a-stock-data']],
  ]
  for (const [path, needles] of requirements) {
    try {
      const text = await readFile(path, 'utf8')
      for (const needle of needles) if (!text.toLowerCase().includes(String(needle).toLowerCase())) errors.push(`${relative(paths.root, path)} is missing attribution text: ${needle}`)
    } catch { errors.push(`${relative(paths.root, path)} is missing`) }
  }
  return errors
}

export async function buildArtifacts(options = {}) {
  const paths = options.paths ?? resolveRepoPaths(options.root)
  const lock = validateLock(options.lock ?? await readJson(options.lockPath ?? paths.lock))
  const skillText = options.skillText ?? await readFile(options.skillPath ?? paths.skill, 'utf8')
  const licenseText = options.licenseText ?? await readFile(options.licensePath ?? paths.license, 'utf8')
  validateApacheLicense(licenseText)
  const spec = options.spec ?? await readExtractionSpec(options.specPath ?? paths.extractionSpec)
  const skillHash = sha256(Buffer.from(skillText))
  const expectedSkillHash = normalizeFileHashEntry(fileEntry(lock, 'SKILL.md'))
  if (expectedSkillHash && skillHash !== expectedSkillHash) throw new VendorError('SKILL.md does not match upstream.lock.json', { code: 'snapshot-hash', blocked: true })
  const extraction = extractPythonModule({ skillText, lock, spec })
  const sourceManifest = options.sourceManifest ?? await loadSourceManifest(options.sourceManifestPath ?? paths.sourceManifest)
  validateSourceManifestAgainstLock(sourceManifest, lock)
  const capabilityManifest = buildCapabilityManifest({ skillText, lock, extraction, sourceManifest, spec })
  const files = new Map([
    ['astock_upstream.py', extraction.code],
    ['__init__.py', [
      '"""Generated a-stock-data compatibility surface."""',
      'from importlib import import_module',
      '',
      '__all__ = (',
      '    "index_constituents", "index_weights", "index_valuation",',
      '    "trading_calendar", "margin_trading_backup", "bse_quote_backup",',
      ')',
      '',
      'def __getattr__(name):',
      '    if name not in __all__:',
      '        raise AttributeError(name)',
      '    return getattr(import_module(".astock_upstream", __name__), name)',
      '',
    ].join('\n')],
    ...buildBlocksArtifacts(extraction.blocks, lock),
  ])
  return { paths, lock, spec, extraction, sourceManifest, capabilityManifest, files }
}

async function validateSnapshotFiles(lock, upstreamRoot) {
  const errors = []
  const entries = Array.isArray(lock.files)
    ? lock.files.map(entry => [entry.path, entry])
    : Object.entries(lock.files ?? {})
  for (const [relativePath, entry] of entries) {
    const path = resolve(upstreamRoot, relativePath)
    if (!path.startsWith(`${resolve(upstreamRoot)}${sep}`)) { errors.push(`unsafe snapshot path: ${relativePath}`); continue }
    try {
      const bytes = await readFile(path)
      const actual = sha256(bytes)
      const expected = normalizeFileHashEntry(entry)
      if (actual !== expected) errors.push(`${relativePath}: expected ${expected}, found ${actual}`)
      if (typeof entry === 'object' && entry.size !== undefined && bytes.length !== entry.size) errors.push(`${relativePath}: size mismatch`)
      if (typeof entry === 'object' && entry.lines !== undefined) {
        const lines = normalizeLf(bytes).split('\n').length - (normalizeLf(bytes).endsWith('\n') ? 1 : 0)
        if (lines !== entry.lines) errors.push(`${relativePath}: line count mismatch`)
      }
    } catch (error) { errors.push(`${relativePath}: ${error.message}`) }
  }
  return errors
}

async function enumerateTree(root) {
  const entries = []
  async function visit(directory) {
    let children
    try { children = await readdir(directory, { withFileTypes: true }) }
    catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const child of children) {
      const absolute = join(directory, child.name)
      if (child.isDirectory()) await visit(absolute)
      else entries.push({
        path: relative(root, absolute).split(sep).join('/'),
        regular: child.isFile(),
      })
    }
  }
  await visit(root)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function validateClosedTree(root, expectedPaths, label) {
  const errors = []
  const expectedList = [...expectedPaths]
  const expected = new Set(expectedList)
  const actual = await enumerateTree(root)
  const actualPaths = new Set(actual.map(entry => entry.path))
  for (const entry of actual) {
    if (!entry.regular) errors.push(`${label} entry is not a regular file: ${entry.path}`)
    else if (!expected.has(entry.path)) errors.push(`unexpected ${label} file: ${entry.path}`)
  }
  for (const path of expectedList) if (!actualPaths.has(path)) errors.push(`missing ${label} file: ${path}`)
  return errors
}

function lockSnapshotPaths(lock) {
  return Array.isArray(lock.files) ? lock.files.map(entry => entry.path) : Object.keys(lock.files ?? {})
}

function expectedGeneratedHash(lock) {
  return unprefixedHash(lock.generated?.sha256 ?? lock.generatedCodeSha256)
}

export async function checkVendor(options = {}) {
  const paths = options.paths ?? resolveRepoPaths(options.root)
  const errors = []
  const blockers = []
  let artifacts
  let lock
  try {
    lock = validateLock(options.lock ?? await readJson(options.lockPath ?? paths.lock))
    errors.push(...await validateSnapshotFiles(lock, options.upstreamRoot ?? paths.upstreamRoot))
    errors.push(...await validateClosedTree(options.upstreamRoot ?? paths.upstreamRoot, [
      ...lockSnapshotPaths(lock), 'upstream.lock.json', 'source-manifest.json', 'capability-manifest.json',
    ], 'upstream'))
    errors.push(...await validateAttribution(paths, lock))
    artifacts = await buildArtifacts({ ...options, paths, lock })
    const featureRegistry = await readJson(paths.featureRegistry)
    errors.push(...validateFeatureRegistry(featureRegistry, artifacts.capabilityManifest, artifacts.sourceManifest, lock))
    errors.push(...await validateClosedTree(paths.generatedRoot, artifacts.files.keys(), 'generated'))
    const expected = expectedGeneratedHash(lock)
    if (expected && expected !== sha256(artifacts.extraction.code)) errors.push('generated module hash differs from lock')
    const expectedBody = unprefixedHash(lock.generated?.bodySha256)
    if (expectedBody && expectedBody !== artifacts.extraction.bodySha256) errors.push('generated body hash differs from lock')
    const diskFiles = new Map(artifacts.files)
    diskFiles.set('../upstream/capability-manifest.json', stableJson(artifacts.capabilityManifest))
    for (const [relativePath, content] of diskFiles) {
      const path = relativePath.startsWith('../upstream/')
        ? join(paths.upstreamRoot, basename(relativePath))
        : join(paths.generatedRoot, relativePath)
      try {
        const disk = await readFile(path, 'utf8')
        if (disk !== content) errors.push(`${relative(paths.root, path)} is missing or stale`)
      } catch { errors.push(`${relative(paths.root, path)} is missing`) }
    }
    if (artifacts.sourceManifest) {
      const capabilityIds = new Set(artifacts.capabilityManifest.capabilities.map(item => item.id))
      const capabilities = new Map(artifacts.capabilityManifest.capabilities.map(item => [item.id, item]))
      const sourceToCapabilities = new Map(artifacts.sourceManifest.sources.map(source => [source.id, new Set(source.capabilityIds ?? [])]))
      for (const source of artifacts.sourceManifest.sources) for (const id of source.capabilityIds ?? []) {
        if (!capabilityIds.has(id)) errors.push(`source ${source.id} references unknown capability ${id}`)
        else if (!capabilities.get(id).sourceIds.includes(source.id)) errors.push(`source ${source.id} has stale capability link ${id}`)
      }
      for (const capability of artifacts.capabilityManifest.capabilities) for (const sourceId of capability.sourceIds) {
        if (!sourceToCapabilities.get(sourceId)?.has(capability.id)) errors.push(`capability ${capability.id} is missing reverse source link ${sourceId}`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ;(error?.blocked ? blockers : errors).push(message)
  }
  return {
    schemaVersion: 1,
    status: blockers.length ? 'blocked' : errors.length ? 'drift' : 'clean',
    ok: errors.length === 0 && blockers.length === 0,
    changed: errors.length > 0,
    version: lock?.version ?? null,
    errors: errors.sort(),
    blockers: blockers.sort(),
    summary: artifacts ? artifacts.capabilityManifest.summary : null,
  }
}

function validateFeatureRegistry(registry, capabilityManifest, sourceManifest, lock) {
  const errors = []
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.features) || registry.features.length !== 60) {
    return ['feature registry must contain exactly 60 version-1 features']
  }
  for (const key of ['repository', 'version', 'tagObject', 'peeledCommit']) {
    const lockKey = key === 'peeledCommit' ? (lock.peeledCommit ?? lock.commit) : lock[key]
    if (registry.upstream?.[key] !== lockKey) errors.push(`feature registry upstream ${key} differs from lock`)
  }
  const capabilities = new Map(capabilityManifest.capabilities.map(item => [item.id, item]))
  const sources = new Map((sourceManifest?.sources ?? []).map(item => [item.id, item]))
  const seenFeatures = new Set()
  const seenCapabilities = new Set()
  for (const feature of registry.features) {
    const label = feature?.featureId ?? '<unknown>'
    if (typeof feature?.featureId !== 'string' || seenFeatures.has(feature.featureId)) errors.push(`duplicate or invalid featureId ${label}`)
    else seenFeatures.add(feature.featureId)
    if (typeof feature?.upstreamCapabilityId !== 'string' || seenCapabilities.has(feature.upstreamCapabilityId)) errors.push(`duplicate or invalid capability for ${label}`)
    else seenCapabilities.add(feature.upstreamCapabilityId)
    const capability = capabilities.get(feature?.upstreamCapabilityId)
    if (!capability) { errors.push(`feature ${label} references unknown capability`); continue }
    const mapped = [...new Set((feature.variants ?? []).map(item => item?.upstreamCallable))].sort()
    if (JSON.stringify(mapped) !== JSON.stringify([...capability.upstreamCallables].sort())) errors.push(`feature ${label} callable coverage differs from manifest`)
    if (feature.implementation !== capability.status) errors.push(`feature ${label} status differs from manifest`)
    if (feature.auth !== capability.auth && !(feature.auth === 'client' && capability.auth === 'none') && !(feature.auth === 'session' && capability.auth === 'none')) errors.push(`feature ${label} auth differs from manifest`)
    for (const sourceId of feature.sources ?? []) if (!sources.has(sourceId)) errors.push(`feature ${label} references unknown source ${sourceId}`)
    for (const variant of feature.variants ?? []) {
      if (!variant?.toolName || !variant?.dataCapability || !variant?.dataset || !variant?.runtime?.symbol) errors.push(`feature ${label} has incomplete runtime variant`)
    }
    if (!feature.fixture || !feature.liveProbe || !feature.contractTier) errors.push(`feature ${label} is missing fixture/live/contract metadata`)
  }
  if (seenCapabilities.size !== capabilities.size) errors.push('feature registry does not cover every capability')
  const optional = registry.features.filter(item => item.auth === 'api-key')
  if (optional.length !== 1 || optional[0]?.upstreamCapabilityId !== 'capability-008') errors.push('iWenCai capability-008 must be the only api-key feature')
  return errors
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

async function writeIfChanged(path, content, dryRun) {
  let previous
  try { previous = await readFile(path) } catch {}
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content)
  if (previous?.equals(next)) return false
  if (!dryRun) await atomicWrite(path, next)
  return true
}

async function git(args, cwd) {
  try { return (await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout.trim() }
  catch (error) { throw new VendorError(`git ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`, { code: 'git-failed', blocked: true }) }
}

async function sourceIdentity(sourceDir, version) {
  const tagObject = await git(['rev-parse', version], sourceDir)
  const peeledCommit = await git(['rev-parse', `${version}^{}`], sourceDir)
  const type = await git(['cat-file', '-t', version], sourceDir)
  if (type !== 'tag') throw new VendorError(`${version} is not an annotated tag`, { code: 'tag-policy', blocked: true })
  const tree = await git(['rev-parse', `${peeledCommit}^{tree}`], sourceDir)
  const taggedAt = await git(['for-each-ref', `refs/tags/${version}`, '--format=%(taggerdate:iso-strict)'], sourceDir)
  const fetchedAt = new Date(taggedAt).toISOString().replace('.000Z', 'Z')
  return { tagObject, peeledCommit, tree, fetchedAt }
}

async function snapshotFileEntry(path, sourceDir) {
  const bytes = await readFile(join(sourceDir, path))
  const gitBlob = await git(['rev-parse', `HEAD:${path}`], sourceDir)
  const text = bytes.toString('utf8')
  return { sha256: sha256(bytes), gitBlob, size: bytes.length, lines: normalizeLf(text).split('\n').length - (normalizeLf(text).endsWith('\n') ? 1 : 0) }
}

async function snapshotPathsForSource(sourceDir) {
  const files = [...REQUIRED_SNAPSHOT_FILES]
  for (const path of OPTIONAL_LEGAL_FILES) if (await pathExists(join(sourceDir, path))) files.push(path)
  return files.sort()
}

function legalSnapshot(lock, path) {
  const entry = fileEntry(lock, path)
  return entry ? normalizeFileHashEntry(entry) : null
}

function validateLegalUpgrade(previousLock, nextLock) {
  if (!previousLock) return
  for (const path of ['LICENSE', ...OPTIONAL_LEGAL_FILES]) {
    const before = legalSnapshot(previousLock, path)
    const after = legalSnapshot(nextLock, path)
    if (before !== after) {
      const action = before === null ? 'appeared' : after === null ? 'disappeared' : 'changed'
      throw new VendorError(`${path} ${action}; legal review is required`, { code: 'legal-review', blocked: true })
    }
  }
}

async function buildLockFromSource(sourceDir, version, previousLock) {
  const identity = await sourceIdentity(sourceDir, version)
  const files = []
  for (const path of await snapshotPathsForSource(sourceDir)) files.push({ path, ...await snapshotFileEntry(path, sourceDir) })
  const noOpIdentity = previousLock?.version === version && previousLock?.tagObject === identity.tagObject && (previousLock?.peeledCommit ?? previousLock?.commit) === identity.peeledCommit
  return {
    schemaVersion: 1, repository: REPOSITORY, refType: 'annotated-tag', version,
    tagObject: identity.tagObject, peeledCommit: identity.peeledCommit,
    tree: identity.tree, fetchedAt: noOpIdentity ? previousLock.fetchedAt : identity.fetchedAt,
    license: 'Apache-2.0', extractionSpecVersion: EXTRACTION_SPEC_VERSION, files,
    generated: { path: 'python/generated/astock_upstream.py', bodySha256: '' },
    inventory: {
      advertisedCapabilities: 60, advertisedSources: 22,
      pythonFenceCount: 62, discoveredDefOccurrences: 112,
      discoveredUniqueDefinitions: 111, topLevelDefOccurrences: 107,
    },
  }
}

async function ensureCleanSource(sourceDir) {
  if (!(await pathExists(join(sourceDir, '.git')))) throw new VendorError('--source-dir must be a Git checkout', { code: 'source-dir' })
  const status = await git(['status', '--porcelain=v1'], sourceDir)
  if (status) throw new VendorError('--source-dir worktree must be clean', { code: 'source-dirty', blocked: true })
}

export async function syncVendor(options = {}) {
  const paths = options.paths ?? resolveRepoPaths(options.root)
  const version = options.version
  if (!/^v\d+\.\d+\.\d+$/u.test(version ?? '')) throw new VendorError('sync requires --version vMAJOR.MINOR.PATCH', { code: 'version' })
  let sourceDir = options.sourceDir ? resolve(options.sourceDir) : null
  let temporaryRoot = null
  if (!sourceDir) {
    if (options.allowNetwork !== true) throw new VendorError('network sync requires allowNetwork=true or the explicit sync CLI path', { code: 'network-policy' })
    temporaryRoot = await mkdtemp(join(tmpdir(), 'ngfi-a-stock-data-'))
    sourceDir = join(temporaryRoot, 'repo')
    await git(['clone', '--quiet', '--no-checkout', REPOSITORY, sourceDir], paths.root)
    await git(['checkout', '--quiet', '--detach', version], sourceDir)
  }
  try {
    await ensureCleanSource(sourceDir)
    const resolvedVersion = await git(['rev-parse', version], sourceDir)
    const currentHead = await git(['rev-parse', 'HEAD'], sourceDir)
    const peeledVersion = await git(['rev-parse', `${version}^{}`], sourceDir)
    if (currentHead !== peeledVersion) {
      throw new VendorError(`--source-dir HEAD ${currentHead} does not match ${version} (${peeledVersion})`, { code: 'source-version', blocked: true })
    }
    if (!resolvedVersion) throw new VendorError(`cannot resolve ${version}`, { code: 'source-version', blocked: true })
    let previousLock = null
    try { previousLock = await readJson(paths.lock) } catch {}
    const previousSourceManifest = options.sourceManifest ?? await loadSourceManifest(paths.sourceManifest)
    if (previousLock) {
      validateLock(previousLock)
      validateSourceManifestAgainstLock(previousSourceManifest, previousLock)
    }
    const lock = await buildLockFromSource(sourceDir, version, previousLock)
    const snapshotSkill = await readFile(join(sourceDir, 'SKILL.md'), 'utf8')
    const licenseText = await readFile(join(sourceDir, 'LICENSE'), 'utf8')
    validateApacheLicense(licenseText)
    validateLegalUpgrade(previousLock, lock)
    const sourceManifest = rebuildSourceManifest(previousSourceManifest, lock)
    const artifacts = await buildArtifacts({ paths, lock, skillText: snapshotSkill, licenseText, sourceManifest })
    lock.generated.bodySha256 = artifacts.extraction.bodySha256
    const writes = []
    for (const path of await snapshotPathsForSource(sourceDir)) writes.push([join(paths.upstreamRoot, path), await readFile(join(sourceDir, path))])
    writes.push([paths.lock, stableJson(lock)])
    writes.push([paths.sourceManifest, stableJson(sourceManifest)])
    writes.push([paths.capabilityManifest, stableJson(buildCapabilityManifest({ skillText: snapshotSkill, lock, extraction: artifacts.extraction, sourceManifest, spec: artifacts.spec }))])
    for (const [relativePath, content] of artifacts.files) writes.push([join(paths.generatedRoot, relativePath), content])
    const changedFiles = []
    for (const [path, content] of writes) if (await writeIfChanged(path, content, options.dryRun === true)) changedFiles.push(relative(paths.root, path))
    return { schemaVersion: 1, status: changedFiles.length ? 'updated' : 'up-to-date', changed: changedFiles.length > 0, version, tagObject: lock.tagObject, commit: lock.peeledCommit, generatedSha256: sha256(artifacts.extraction.code), generatedBodySha256: lock.generated.bodySha256, changedFiles: changedFiles.sort(), dryRun: options.dryRun === true }
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function compareVersions(left, right) {
  const a = left.slice(1).split('.').map(Number)
  const b = right.slice(1).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

export async function discoverLatestStableTag(options = {}) {
  if (options.allowNetwork !== true && !options.sourceDir && !options.refsText) throw new VendorError('tag discovery is network-enabled only through an explicit discovery path', { code: 'network-policy' })
  const refsText = options.refsText ?? await git(['ls-remote', '--tags', options.repository ?? REPOSITORY], options.root ?? ROOTS.root)
  const tags = new Map()
  for (const line of refsText.split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/u.exec(line.trim())
    if (!match) continue
    const entry = tags.get(match[2]) ?? {}
    if (match[3]) entry.commit = match[1]; else entry.tagObject = match[1]
    tags.set(match[2], entry)
  }
  const stable = [...tags].filter(([, value]) => value.tagObject && value.commit).sort((a, b) => compareVersions(b[0], a[0]))
  if (!stable.length) throw new VendorError('no stable annotated semver tag found', { code: 'tag-discovery', blocked: true })
  const [version, identity] = stable[0]
  const current = options.currentLock ?? (await pathExists((options.paths ?? ROOTS).lock) ? await readJson((options.paths ?? ROOTS).lock) : null)
  const sameVersionMoved = current?.version === version && (current.tagObject !== identity.tagObject || (current.peeledCommit ?? current.commit) !== identity.commit)
  const updateReady = !current || compareVersions(version, current.version) > 0
  return {
    schemaVersion: 1, status: sameVersionMoved ? 'blocked' : updateReady ? 'update-ready' : 'up-to-date',
    changed: updateReady, current: current ? { version: current.version, tagObject: current.tagObject, commit: current.peeledCommit ?? current.commit } : null,
    candidate: { version, tagObject: identity.tagObject, commit: identity.commit },
    blockers: sameVersionMoved ? [`tag ${version} moved`] : [],
  }
}

export async function buildDiffReport(options = {}) {
  const module = await import('./report.mjs')
  return module.buildDiffReport(options)
}

export default {
  ROOTS, resolveRepoPaths, sha256, normalizeLf, parsePythonBlocks, extractPythonModule,
  analyzePythonBlocks, buildFunctionInventory, parseCapabilityTable, validateLock,
  buildArtifacts, checkVendor, syncVendor, buildDiffReport, discoverLatestStableTag,
}
