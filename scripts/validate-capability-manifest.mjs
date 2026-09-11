#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VALID_STATUS = new Set(['kernel-tested', 'agent-exposed', 'live-verified'])

function read(relative, root = repositoryRoot) {
  return readFileSync(resolve(root, relative), 'utf8')
}

function trackedPaths(root) {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })
  return output.toString('utf8').split('\0').filter(Boolean)
}

function existingFile(relative, root) {
  const path = resolve(root, relative)
  return path.startsWith(`${resolve(root)}/`) && existsSync(path)
}

function frontmatterName(path) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(readFileSync(path, 'utf8'))
  if (match === null) return undefined
  const data = parse(match[1])
  return typeof data?.name === 'string' ? data.name : undefined
}

function sourceCorpus(directory) {
  if (!existsSync(directory)) return ''
  let corpus = ''
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !['node_modules', '.venv', '.uv-cache', 'lib', '__pycache__', 'upstream'].includes(entry.name)) corpus += sourceCorpus(path)
    else if (/\.(?:ts|py)$/u.test(entry.name)) corpus += readFileSync(path, 'utf8')
  }
  return corpus
}

function actualSkills(root) {
  return trackedPaths(root)
    .filter(path => /^skills\/[^/]+\/SKILL\.md$/u.test(path) && existsSync(resolve(root, path)))
    .map(path => frontmatterName(resolve(root, path)))
    .filter(Boolean)
    .sort()
}

function actualTools(root) {
  const sourceRoot = resolve(root, 'packages/dsh-finance-tools/src')
  const names = []
  for (const path of trackedPaths(root).filter(path => /^packages\/dsh-finance-tools\/src\/.*\.ts$/u.test(path))) {
    const source = readFileSync(resolve(root, path), 'utf8')
    for (const match of source.matchAll(/(?:name:\s*|optimizationTool\(options,\s*)['"](finance_[a-z0-9_]+)['"]/gu)) names.push(match[1])
  }
  return [...new Set(names)].sort()
}

function actualPresets(root) {
  const visible = new Set(trackedPaths(root))
  const presetRoot = resolve(root, 'generated/agent-presets')
  return readdirSync(presetRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory()
      && visible.has(`generated/agent-presets/${entry.name}/preset.yml`)
      && visible.has(`generated/agent-presets/${entry.name}/agent.cordis.yml`))
    .map(entry => entry.name)
    .sort()
}

function declared(manifest, field) {
  return [...new Set(manifest.capabilities.flatMap(capability => capability[field] ?? []))].sort()
}

function sameMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

export function validateCapabilityManifest(manifest, root = repositoryRoot) {
  const errors = []
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.capabilities)) {
    return ['manifest must use schemaVersion 1 and contain capabilities[]']
  }
  const ids = new Set()
  for (const capability of manifest.capabilities) {
    const label = typeof capability.id === 'string' ? capability.id : '<missing-id>'
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(label)) errors.push(`${label}: invalid capability id`)
    if (ids.has(label)) errors.push(`${label}: duplicate capability id`)
    ids.add(label)
    if (typeof capability.category !== 'string' || capability.category === '') errors.push(`${label}: missing category`)
    if (!VALID_STATUS.has(capability.status)) errors.push(`${label}: invalid status`)
    if (typeof capability.ownerPackage !== 'string'
      || (!existingFile(`${capability.ownerPackage}/package.json`, root)
        && !existingFile(`${capability.ownerPackage}/pyproject.toml`, root))) {
      errors.push(`${label}: owner package does not exist`)
    }
    if (!Array.isArray(capability.publicExports) || capability.publicExports.length === 0) {
      errors.push(`${label}: publicExports must be non-empty`)
    } else {
      const sources = sourceCorpus(resolve(root, capability.ownerPackage))
      for (const exported of capability.publicExports) {
        if (!sources.includes(exported)) errors.push(`${label}: public export not found: ${exported}`)
      }
    }
    for (const field of ['contractTests', 'goldenFixtures']) {
      if (!Array.isArray(capability[field]) || capability[field].length === 0) errors.push(`${label}: ${field} must be non-empty`)
      else for (const path of capability[field]) if (!existingFile(path, root)) errors.push(`${label}: missing ${field}: ${path}`)
    }
    if (!Array.isArray(capability.upstream) || capability.upstream.length === 0) errors.push(`${label}: upstream must be non-empty`)
    else for (const source of capability.upstream) {
      for (const field of ['project', 'commit', 'path']) {
        if (typeof source[field] !== 'string' || source[field] === '') errors.push(`${label}: upstream ${field} missing`)
      }
    }
    for (const field of ['safetyBoundaries', 'knownLimitations']) {
      if (!Array.isArray(capability[field]) || capability[field].length === 0) errors.push(`${label}: ${field} must be non-empty`)
    }
    if (capability.status !== 'kernel-tested'
      && !(capability.tools?.length || capability.skills?.length || capability.presets?.length)) {
      errors.push(`${label}: exposed status has no Agent surface`)
    }
  }
  const tools = actualTools(root)
  const skills = actualSkills(root)
  const presets = actualPresets(root)
  if (!sameMembers(declared(manifest, 'tools'), tools)) errors.push(`tool inventory mismatch: declared=${declared(manifest, 'tools')} actual=${tools}`)
  if (!sameMembers(declared(manifest, 'skills'), skills)) errors.push(`skill inventory mismatch: declared=${declared(manifest, 'skills')} actual=${skills}`)
  if (!sameMembers(declared(manifest, 'presets'), presets)) errors.push(`preset inventory mismatch: declared=${declared(manifest, 'presets')} actual=${presets}`)
  return errors
}

export function runCapabilityValidation(path = resolve(repositoryRoot, 'docs/capabilities/manifest.json')) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const errors = validateCapabilityManifest(manifest, repositoryRoot)
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`capability manifest: ${error}\n`)
    return 1
  }
  const counts = Object.fromEntries([...VALID_STATUS].map(status => [
    status, manifest.capabilities.filter(capability => capability.status === status).length,
  ]))
  process.stdout.write(`capability manifest passed (${manifest.capabilities.length} capabilities; ${JSON.stringify(counts)})\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCapabilityValidation(process.argv[2] && resolve(process.argv[2]))
}
