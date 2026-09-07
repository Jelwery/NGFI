#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const failures = []
const packages = readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())
const manifests = new Map()
const DOMAIN_PACKAGES = new Set([
  'finance-core', 'research-core', 'research-workspace', 'research-audit',
  'research-workflow', 'strategy-core', 'technical-analysis',
  'strategy-accumulation-breakout', 'signal-evaluation', 'portfolio-risk',
])

for (const entry of packages) {
  const path = `packages/${entry.name}/package.json`
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
    manifests.set(manifest.name, { ...manifest, path, directory: entry.name })
  } catch {
    continue
  }
}

const edges = new Map([...manifests].map(([name]) => [name, []]))
for (const [name, manifest] of manifests) {
  const dependencies = Object.keys(manifest.dependencies ?? {})
  for (const dependency of dependencies) if (manifests.has(dependency)) edges.get(name).push(dependency)

  const sourceRoot = resolve(root, 'packages', manifest.directory, 'src')
  const imported = new Set()
  if (existsSync(sourceRoot)) for (const file of readdirSync(sourceRoot, { recursive: true })) {
    if (typeof file !== 'string' || !file.endsWith('.ts')) continue
    const source = readFileSync(resolve(sourceRoot, file), 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\()(['"])(@[^/'"]+\/[^/'"]+)\1/gu)) {
      if (match[2] !== name) imported.add(match[2])
    }
    if (DOMAIN_PACKAGES.has(manifest.directory)
        && /(?:@deepseek-ai\/(?:dsh|cordis)|(?:from\s+|import\()['"](?:node:)?(?:http|https|net|tls|dns))/u.test(source)) {
      failures.push(`${name}: domain/application package imports DSH or network/UI infrastructure`)
    }
    if (manifest.directory.startsWith('finance-provider-')
        && /@finance2dsh\/(?:dsh-tools|dsh-bundle)/u.test(source)) {
      failures.push(`${name}: provider depends on Agent adapter`)
    }
    if (manifest.directory === 'dsh-finance-bundle'
        && /@finance2dsh\/(?!dsh-tools(?:['"]|\/))/u.test(source)) {
      failures.push(`${name}: bundle imports business logic outside dsh-tools`)
    }
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  for (const dependency of imported) {
    if (!declared.has(dependency)) failures.push(`${name}: undeclared direct dependency ${dependency}`)
  }

  const role = manifest.directory
  if (DOMAIN_PACKAGES.has(role)) for (const dependency of dependencies) {
    if (dependency.startsWith('@deepseek-ai/')) failures.push(`${name}: domain/application manifest depends on DSH`)
    if (dependency.startsWith('@finance2dsh/provider-')) failures.push(`${name}: domain/application manifest depends on provider`)
  }
}

const visiting = new Set()
const visited = new Set()
function visit(name, path = []) {
  if (visiting.has(name)) {
    failures.push(`workspace dependency cycle: ${[...path, name].join(' -> ')}`)
    return
  }
  if (visited.has(name)) return
  visiting.add(name)
  for (const dependency of edges.get(name) ?? []) visit(dependency, [...path, name])
  visiting.delete(name)
  visited.add(name)
}
for (const name of edges.keys()) visit(name)

if (failures.length > 0) {
  for (const failure of [...new Set(failures)]) process.stderr.write(`package boundary: ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`package boundaries passed (${manifests.size} packages; acyclic)\n`)
}
