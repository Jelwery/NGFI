import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_STATUSES,
  analyzePythonBlocks,
  buildArtifacts,
  buildCapabilityManifest,
  checkVendor,
  extractPythonModule,
  parsePythonBlocks,
  readExtractionSpec,
  sha256,
  validateLock,
// @ts-expect-error The vendoring implementation is intentionally plain Node ESM.
} from '../scripts/a-stock-data/vendor-lib.mjs'

const execFile = promisify(execFileCallback)
const ROOT = process.cwd()
const UPSTREAM = join(ROOT, 'packages/finance-provider-astock/upstream')
const GENERATED = join(ROOT, 'packages/finance-provider-astock/python/generated')
const LOCK_PATH = join(UPSTREAM, 'upstream.lock.json')
const SKILL_PATH = join(UPSTREAM, 'SKILL.md')
const CAPABILITY_PATH = join(UPSTREAM, 'capability-manifest.json')
const SOURCE_PATH = join(UPSTREAM, 'source-manifest.json')

async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function filesBelow(root: string): Promise<string[]> {
  const names = await readdir(root, { recursive: true, withFileTypes: true })
  return names
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
}

async function fingerprint(paths: string[]) {
  return Promise.all(paths.map(async path => {
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)])
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: metadata.mtimeMs }
  }))
}

describe('a-stock-data immutable snapshot', () => {
  it('pins the annotated v3.8.0 tag, peeled commit, and every vendored byte', async () => {
    const lock = await json(LOCK_PATH)
    expect(lock).toMatchObject({
      schemaVersion: 1,
      repository: 'https://github.com/simonlin1212/a-stock-data.git',
      refType: 'annotated-tag',
      version: 'v3.8.0',
      tagObject: '9f995e66ee792255e492a15627f98615627041c6',
      peeledCommit: '2012ce7cd0e75d379c5e6cbd3115514f300f3bc8',
      tree: '8a7a81801271bda328d6015ad6304e5c0960a01f',
      license: 'Apache-2.0',
    })
    expect(lock.tagObject).not.toBe(lock.peeledCommit)
    expect(lock.files.map((entry: { path: string }) => entry.path)).toEqual([
      'CHANGELOG.md',
      'LICENSE',
      'SKILL.md',
      'docs/source-integration-v3.8.0.md',
      'tests/test_official_data.py',
    ])

    for (const entry of lock.files) {
      const bytes = await readFile(join(UPSTREAM, entry.path))
      expect(sha256(bytes), entry.path).toBe(entry.sha256)
      expect(bytes.length, entry.path).toBe(entry.size)
      expect(entry.gitBlob, entry.path).toMatch(/^[0-9a-f]{40}$/u)
    }
    expect(lock.files.find((entry: { path: string }) => entry.path === 'SKILL.md').sha256)
      .toBe('a914594fef090d4d23535b3572573986a6e663f0b4c837cd95b357ca569c5975')
  })

  it('extracts deterministically from all 62 inventoried Python fences', async () => {
    const [skill, lock, spec] = await Promise.all([
      readFile(SKILL_PATH, 'utf8'),
      json(LOCK_PATH),
      readExtractionSpec(),
    ])
    const first = extractPythonModule({ skillText: skill, lock, spec })
    const second = extractPythonModule({ skillText: skill, lock, spec })

    expect(first.code).toBe(second.code)
    expect(first.blocks).toHaveLength(62)
    expect(spec.pythonBlocks).toHaveLength(62)
    expect(first.analysis).toMatchObject({
      pythonFenceCount: 62,
      definitionOccurrences: 112,
      topLevelDefinitionOccurrences: 107,
      uniqueDefinitions: 111,
      uniqueTopLevelDefinitions: 106,
    })
    expect(first.analysis.duplicateDefinitions.map((item: { name: string; count: number; approved: boolean }) => ({
      name: item.name, count: item.count, approved: item.approved,
    }))).toEqual([{ name: '_macro_get', count: 2, approved: true }])

    for (const block of first.blocks) {
      const expected = spec.pythonBlocks[block.index - 1]
      expect({ index: block.index, heading: block.heading, expectedBodySha256: block.bodySha256 }).toEqual(expected)
      expect(await readFile(join(GENERATED, 'blocks', `block-${String(block.index).padStart(3, '0')}.py`), 'utf8'))
        .toBe(block.body)
    }

    const header = first.code.split('\n').slice(0, 9)
    expect(header).toEqual([
      '# GENERATED FILE - DO NOT EDIT.',
      '# Source: https://github.com/simonlin1212/a-stock-data.git',
      '# Upstream tag: v3.8.0',
      '# Upstream tag object: 9f995e66ee792255e492a15627f98615627041c6',
      '# Upstream peeled commit: 2012ce7cd0e75d379c5e6cbd3115514f300f3bc8',
      '# Snapshot SHA-256: a914594fef090d4d23535b3572573986a6e663f0b4c837cd95b357ca569c5975',
      '# Extraction spec version: 1',
      `# Generated body SHA-256: ${first.bodySha256}`,
      '# Local changes belong in ../ngfi_overrides/.',
    ])
    expect(first.code).not.toMatch(/^sh_margins*=/mu)
    expect(first.code).not.toMatch(/^print\(/mu)
    for (const name of ['index_constituents', 'index_weights', 'index_valuation', 'trading_calendar', 'margin_trading_backup', 'bse_quote_backup']) {
      expect(first.code).toContain(`def ${name}(`)
    }
  })

  it('fails closed on line-ending, marker, and any Python-fence drift', async () => {
    const [skill, lock, spec] = await Promise.all([readFile(SKILL_PATH, 'utf8'), json(LOCK_PATH), readExtractionSpec()])
    expect(() => extractPythonModule({ skillText: skill.replace(/\n/gu, '\r\n'), lock, spec })).toThrow(/LF line endings/u)
    expect(() => extractPythonModule({
      skillText: skill.replace('<!-- official-data-core:start -->', '<!-- official-data-core:changed -->'),
      lock, spec,
    })).toThrow(/markers must each occur exactly once/u)
    expect(() => extractPythonModule({
      skillText: skill.replace('def _probe(ip, port, timeout=2.0):', 'def _probe_changed(ip, port, timeout=2.0):'),
      lock, spec,
    })).toThrow(/Python fence 1 differs/u)
  })

  it('accounts for all functions, capabilities, sources, and reverse links', async () => {
    const [capability, source, skill, spec] = await Promise.all([
      json(CAPABILITY_PATH), json(SOURCE_PATH), readFile(SKILL_PATH, 'utf8'), readExtractionSpec(),
    ])
    expect(capability.capabilities).toHaveLength(60)
    expect(capability.functionInventory).toHaveLength(112)
    expect(source.sources).toHaveLength(22)
    expect(source.pythonDependencies).toHaveLength(8)
    expect(new Set(source.sources.map((item: { id: string }) => item.id)).size).toBe(22)
    expect(new Set(capability.capabilities.map((item: { id: string }) => item.id)).size).toBe(60)

    const statuses = new Set(CAPABILITY_STATUSES)
    const reverse = new Map<string, Set<string>>(source.sources.map((item: { id: string; capabilityIds: string[] }) => [item.id, new Set(item.capabilityIds)]))
    for (const item of capability.capabilities) {
      expect(statuses.has(item.status), item.id).toBe(true)
      expect(item.sourceIds.length, item.id).toBeGreaterThan(0)
      for (const sourceId of item.sourceIds) expect(reverse.get(sourceId)?.has(item.id), `${item.id} -> ${sourceId}`).toBe(true)
    }
    const capabilities = new Map<string, Set<string>>(capability.capabilities.map((item: { id: string; sourceIds: string[] }) => [item.id, new Set(item.sourceIds)]))
    for (const sourceItem of source.sources) {
      for (const capabilityId of sourceItem.capabilityIds) {
        expect(capabilities.get(capabilityId)?.has(sourceItem.id), `${sourceItem.id} -> ${capabilityId}`).toBe(true)
      }
    }
    for (const item of capability.functionInventory) {
      expect(['generated', 'inventory-only']).toContain(item.disposition)
      expect(item.capabilityIds.length > 0 || typeof item.nonCapabilityReason === 'string', item.name).toBe(true)
    }

    const analysis = analyzePythonBlocks(parsePythonBlocks(skill), spec)
    expect(analysis.definitionOccurrences).toBe(capability.summary.definitionOccurrences)
  })

  it('records runtime exposure per upstream entry without promoting partial groups', async () => {
    const [capability, spec] = await Promise.all([json(CAPABILITY_PATH), readExtractionSpec()])
    const byId = new Map<string, any>(capability.capabilities.map((item: { id: string }) => [item.id, item]))

    expect(spec.capabilityRuntimeLedger).toHaveLength(60)
    expect(new Set(spec.capabilityRuntimeLedger.map((item: { id: string }) => item.id)).size).toBe(60)
    expect(spec.capabilityRuntimeLedger.map((item: { id: string }) => item.id))
      .toEqual(capability.capabilities.map((item: { id: string }) => item.id))
    expect(capability.summary.statusCounts).toEqual({
      'implemented-canonical': 5,
      'implemented-experimental': 1,
      'blocked-auth': 1,
      'deferred-policy': 53,
      unsupported: 0,
    })

    expect(byId.get('capability-001')).toMatchObject({
      name: 'tdx_client.bars / tdx_client.quotes / tdx_client.transaction',
      status: 'implemented-experimental',
      canonicalMapping: null,
      runtimeMappings: [
        {
          upstreamCallable: 'tdx_client.bars',
          status: 'implemented-canonical',
          providerId: 'tdx-community',
          operation: 'market-bars',
          coverage: 'full',
          sourceIds: ['mootdx'],
        },
        {
          upstreamCallable: 'tdx_client.quotes',
          status: 'implemented-experimental',
          providerId: 'tdx-community',
          operation: 'quote',
          coverage: 'partial',
          sourceIds: ['mootdx'],
          unmappedCanonicalCapabilities: ['order-book'],
        },
        {
          upstreamCallable: 'tdx_client.transaction',
          status: 'unsupported',
          providerId: null,
          operation: null,
          coverage: 'none',
          sourceIds: [],
        },
      ],
    })
    expect(byId.get('capability-001').reason).toMatch(/order-book.*transaction/u)

    expect(byId.get('capability-002')).toMatchObject({
      name: 'tencent_quote',
      status: 'deferred-policy',
      generated: false,
      canonicalMapping: null,
      runtimeMappings: [{
        upstreamCallable: 'tencent_quote',
        status: 'deferred-policy',
        providerId: null,
        operation: null,
        coverage: 'none',
        sourceIds: [],
      }],
    })
    expect(byId.get('capability-002').reason).toMatch(/East Money.*Tencent/u)
    expect(byId.get('capability-002').runtimeMappings[0].replacementRuntime).toEqual({
      providerId: 'a-stock-public',
      operation: 'quote',
      runtimeSourceIds: ['eastmoney-push2'],
    })

    for (const [id, name] of [
      ['capability-055', 'index_weights'],
      ['capability-056', 'index_valuation'],
    ] as const) {
      expect(byId.get(id)).toMatchObject({
        name,
        status: 'deferred-policy',
        generated: true,
        canonicalMapping: null,
        runtimeMappings: [{
          upstreamCallable: name,
          status: 'deferred-policy',
          providerId: null,
          operation: null,
          coverage: 'generated-only',
          sourceIds: [],
          generatedCallable: name,
        }],
      })
      expect(byId.get(id).reason).toMatch(/no curated provider operation invokes it/u)
    }

    for (const item of capability.capabilities.filter((entry: { status: string }) => entry.status === 'implemented-canonical')) {
      expect(item.canonicalMapping, item.id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/u)
      expect(item.runtimeMappings, item.id).not.toHaveLength(0)
      expect(item.runtimeMappings.every((mapping: { status: string; providerId: unknown; operation: unknown }) => (
        mapping.status === 'implemented-canonical'
        && typeof mapping.providerId === 'string'
        && typeof mapping.operation === 'string'
      )), item.id).toBe(true)
    }
    expect(capability.capabilities.filter((entry: { status: string }) => entry.status === 'implemented-canonical')
      .map((entry: { id: string }) => entry.id)).toEqual([
      'capability-029', 'capability-030', 'capability-034', 'capability-054', 'capability-057',
    ])
  })

  it('fails closed when the explicit runtime ledger drifts from upstream inventory', async () => {
    const [skillText, lock, sourceManifest, extractionSpec] = await Promise.all([
      readFile(SKILL_PATH, 'utf8'), json(LOCK_PATH), json(SOURCE_PATH), readExtractionSpec(),
    ])
    const extraction = extractPythonModule({ skillText, lock, spec: extractionSpec })

    const missing = structuredClone(extractionSpec)
    missing.capabilityRuntimeLedger.pop()
    expect(() => buildCapabilityManifest({ skillText, lock, sourceManifest, extraction, spec: missing }))
      .toThrow(/must inventory all 60 capabilities/u)

    const promoted = structuredClone(extractionSpec)
    promoted.capabilityRuntimeLedger[0].status = 'implemented-canonical'
    expect(() => buildCapabilityManifest({ skillText, lock, sourceManifest, extraction, spec: promoted }))
      .toThrow(/runtime ledger status differs from its callable mappings for capability-001/u)

    const stale = structuredClone(extractionSpec)
    stale.capabilityRuntimeLedger[1].upstreamCallables = ['renamed_quote']
    expect(() => buildCapabilityManifest({ skillText, lock, sourceManifest, extraction, spec: stale }))
      .toThrow(/runtime ledger callables differ for capability-002/u)
  })

  it('detects stale source-to-capability links during an offline check', async () => {
    const source = await json(SOURCE_PATH)
    const mutated = structuredClone(source)
    mutated.sources.find((item: { id: string }) => item.id === 'eastmoney-push2').capabilityIds.push('capability-004')
    const result = await checkVendor({ sourceManifest: mutated })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('source eastmoney-push2 has stale capability link capability-004')
  })

  it('rejects source snapshot identity drift and duplicate lock paths', async () => {
    const [lock, source] = await Promise.all([json(LOCK_PATH), json(SOURCE_PATH)])
    const duplicate = structuredClone(lock)
    duplicate.files.push(structuredClone(duplicate.files[0]))
    expect(() => validateLock(duplicate)).toThrow(/duplicate lock file path: CHANGELOG\.md/u)

    const cases = [
      ['upstream version', (value: typeof source) => { value.upstreamVersion = 'v9.9.9' }],
      ['peeled commit', (value: typeof source) => { value.peeledCommit = '0'.repeat(40) }],
      ['snapshot hash', (value: typeof source) => { value.snapshotFiles[0].sha256 = '0'.repeat(64) }],
    ] as const
    for (const [name, mutate] of cases) {
      const value = structuredClone(source)
      mutate(value)
      const result = await checkVendor({ sourceManifest: value })
      expect(result.status, name).toBe('blocked')
      expect(result.blockers.join('\n'), name).toMatch(/source manifest .*upstream lock/u)
    }
  })

  it('rejects files outside the closed upstream and generated inventories', async () => {
    const upstreamExtra = join(UPSTREAM, '.unexpected-vendor-test-file')
    const generatedExtra = join(GENERATED, '.unexpected-generated-test-file')
    await Promise.all([writeFile(upstreamExtra, 'unexpected\n'), writeFile(generatedExtra, 'unexpected\n')])
    try {
      const result = await checkVendor()
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('unexpected upstream file: .unexpected-vendor-test-file')
      expect(result.errors).toContain('unexpected generated file: .unexpected-generated-test-file')
    } finally {
      await Promise.all([rm(upstreamExtra, { force: true }), rm(generatedExtra, { force: true })])
    }
  })

  it('keeps check offline, write-free, and equal to a fresh in-memory build', async () => {
    const watched = [
      ...(await filesBelow(GENERATED)),
      LOCK_PATH, CAPABILITY_PATH, SOURCE_PATH,
      join(ROOT, 'THIRD_PARTY_NOTICES.md'),
    ]
    const before = await fingerprint(watched)
    const result = await checkVendor()
    const after = await fingerprint(watched)
    const first = await buildArtifacts()
    const second = await buildArtifacts()

    expect(result).toMatchObject({ status: 'clean', ok: true, changed: false, errors: [], blockers: [] })
    expect(after).toEqual(before)
    expect([...first.files]).toEqual([...second.files])

    const { stdout } = await execFile(process.execPath, ['scripts/sync-a-stock-data.mjs', '--check', '--json'], {
      cwd: ROOT,
      env: { ...process.env, PATH: '/path-disabled-for-offline-check' },
    })
    expect(JSON.parse(stdout)).toMatchObject({ status: 'clean', ok: true, changed: false })
  })

  it('ships Apache attribution and a syntactically valid import-safe runtime module', async () => {
    const [notice, license] = await Promise.all([
      readFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      readFile(join(UPSTREAM, 'LICENSE'), 'utf8'),
    ])
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0, January 2004')
    expect(notice).toContain('Simon Lin')
    expect(notice).toContain('9f995e66ee792255e492a15627f98615627041c6')
    expect(notice).toContain('2012ce7cd0e75d379c5e6cbd3115514f300f3bc8')
    expect(notice.toLowerCase()).toContain('modified')
    expect(notice).toContain('62 Python fences')

    await expect(execFile('python3', [
      '-c',
      'import ast,pathlib; ast.parse(pathlib.Path("packages/finance-provider-astock/python/generated/astock_upstream.py").read_text(encoding="utf-8"))',
    ], { cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).resolves.toMatchObject({ stderr: '' })
  })
})
