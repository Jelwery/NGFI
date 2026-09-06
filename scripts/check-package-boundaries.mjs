#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const failures = []
const packages = readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())
const manifests = new Map()

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
  let source = ''
  try {
    for (const file of readdirSync(sourceRoot, { recursive: true })) {
      if (typeof file === 'string' && file.endsWith('.ts')) source += readFileSync(resolve(sourceRoot, file), 'utf8')
    }
  } catch {}

  const role = manifest.directory
  if ((role === 'finance-core' || role === 'research-core' || role === 'research-workspace'
      || role === 'research-audit' || role === 'research-workflow' || role === 'strategy-core'
      || role === 'technical-analysis' || role === 'signal-evaluation' || role === 'portfolio-risk')
      && /@deepseek-ai\/(?:dsh|cordis)/u.test(source)) {
    failures.push(`${name}: domain/application package imports DSH or Cordis`)
  }
  if (role.startsWith('finance-provider-') && /@finance2dsh\/(?:dsh-tools|dsh-bundle)/u.test(source)) {
    failures.push(`${name}: provider depends on Agent adapter`)
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
