#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const inventoryPath = resolve(root, 'docs', 'dependency-licenses.json')
function pythonProject(path) {
  const text = readFileSync(resolve(root, path, 'pyproject.toml'), 'utf8')
  const project = /^name\s*=\s*["']([^"']+)["']/mu.exec(text)?.[1]
  if (project === undefined) throw new Error(`${path}/pyproject.toml does not declare project.name`)
  return { path, project }
}

const pythonProjects = [
  pythonProject('.'),
  ...readdirSync(resolve(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(root, 'packages', entry.name, 'pyproject.toml')))
    .map(entry => pythonProject(`packages/${entry.name}`)),
]

const allowedLicenses = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0',
  'ISC', 'MIT', 'MIT-0', 'MPL-2.0', 'PSF-2.0', 'Python-2.0', 'Zlib',
])
const strongCopyleft = /(?:^|[-.( ])(?:AGPL|GPL)(?:[-.)+ ]|$)/iu

// These normalize legacy PyPI metadata or packages whose wheel only carries a
// license file. Keep overrides version-specific so upgrades require review.
const pythonLicenseOverrides = new Map(Object.entries({
  'akracer@0.0.14': { license: 'MIT', reason: 'Platform-conditional wheel license reviewed manually; package is not installed on this host.' },
  'colorama@0.4.6': { license: 'BSD-3-Clause', reason: 'Platform-conditional wheel license reviewed manually; package is not installed on this host.' },
  'numpy@2.4.6': { license: 'BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0', reason: 'Python-version-conditional release uses the same reviewed NumPy license family as the installed release.' },
  'pandas@2.3.3': { license: 'BSD-3-Clause', reason: 'Primary package license verified in the wheel LICENSE; retain its bundled third-party notices. The legacy metadata concatenates those notices and must not be classified as PSF-only.' },
  'peewee@4.4.0': { license: 'MIT', reason: 'The installed wheel LICENSE contains the standard MIT grant.' },
  'py-mini-racer@0.6.0': { license: 'ISC', reason: 'Platform-conditional package license reviewed manually; package is not installed on this host.' },
  'pytdx@1.72': { license: 'LicenseRef-pytdx-usage-notice', reason: 'Wheel and upstream repository omit an OSI license; the upstream usage notice was manually reviewed and must be re-reviewed on upgrade.' },
  'python-dateutil@2.9.0.post0': { license: 'BSD-3-Clause OR Apache-2.0', reason: 'Legacy metadata declares the two OSI-approved alternatives as classifiers.' },
  'scipy@1.17.1': { license: 'BSD-3-Clause', reason: 'Python-version-conditional release uses the reviewed SciPy BSD license.' },
  'tzdata@2026.3': { license: 'Apache-2.0', reason: 'Platform-conditional PyPI tzdata package license reviewed manually.' },
}))

// Optional sharp runtime artifacts are platform-specific and excluded from the
// deterministic core inventory. Record the sole copyleft runtime exception.
const reviewedExceptions = [{
  ecosystem: 'npm',
  package: '@img/sharp-libvips-*',
  license: 'LGPL-3.0-or-later',
  scope: 'optional platform runtime for sharp',
  reason: 'Dynamically linked libvips runtime distributed separately by sharp; retain notices and re-review on sharp/libvips upgrades.',
}, {
  ecosystem: 'pypi',
  package: 'pytdx',
  license: 'LicenseRef-pytdx-usage-notice',
  scope: 'isolated optional TDX-compatible provider',
  reason: 'pytdx 1.72 publishes a usage notice but no standard license; use is isolated and requires manual legal review before redistribution.',
}]

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

function normalizeName(value) {
  return value.toLowerCase().replace(/[_.]+/gu, '-')
}

function packageKey(name, version) {
  return `${normalizeName(name)}@${version}`
}

export function normalizeLegacyLicense(raw, classifiers) {
  const text = raw.trim()
  const joined = `${text} ${classifiers.join(' ')}`
  if (strongCopyleft.test(joined)) return joined.trim()
  if (/Mozilla Public License 2\.0|MPL-2\.0/iu.test(joined)) return 'MPL-2.0'
  if (/Python Software Foundation/iu.test(joined)) return 'PSF-2.0'
  if (/Apache/iu.test(joined)) return 'Apache-2.0'
  if (/BSD 3-Clause|3-Clause BSD/iu.test(joined)) return 'BSD-3-Clause'
  if (/BSD-2-Clause/iu.test(joined)) return 'BSD-2-Clause'
  if (/BSD/iu.test(joined)) return 'BSD-3-Clause'
  if (/MIT/iu.test(joined)) return 'MIT'
  if (/ISC/iu.test(joined)) return 'ISC'
  return text || 'UNKNOWN'
}

function licenseAtoms(expression) {
  return expression
    .replace(/\bWITH\s+[A-Za-z0-9.-]+/gu, '')
    .split(/\s+(?:AND|OR)\s+|[()]/gu)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function validateLicense(entry) {
  const expression = entry.license
  if (!expression || /^(?:UNKNOWN|UNLICENSED)$/iu.test(expression)) {
    return `${entry.ecosystem}:${entry.name}@${entry.version} has ${expression || 'UNKNOWN'} license`
  }
  if (strongCopyleft.test(expression)) {
    return `${entry.ecosystem}:${entry.name}@${entry.version} uses denied strong-copyleft license ${expression}`
  }
  const unknown = licenseAtoms(expression).filter((license) => {
    if (allowedLicenses.has(license)) return false
    return !inventoryExceptionMatches(entry, license)
  })
  if (unknown.length > 0) {
    return `${entry.ecosystem}:${entry.name}@${entry.version} has unreviewed license ${expression}`
  }
  return undefined
}

function inventoryExceptionMatches(entry, license) {
  return reviewedExceptions.some((exception) => {
    if (exception.ecosystem !== entry.ecosystem || exception.license !== license) return false
    const escaped = exception.package.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')
    return new RegExp(`^${escaped}$`, 'u').test(entry.name)
  })
}

function nodeInventory() {
  const raw = run('pnpm', ['licenses', 'list', '--prod', '--no-optional', '--json', '--filter', 'ngfi'])
  const grouped = JSON.parse(raw)
  const entries = []
  for (const [license, packages] of Object.entries(grouped)) {
    for (const pkg of packages) {
      for (const version of pkg.versions) entries.push({ ecosystem: 'npm', name: pkg.name, version, license })
    }
  }
  return entries.sort(compareEntry)
}

function checkOptionalNodeLicenses() {
  const raw = run('pnpm', ['licenses', 'list', '--prod', '--json', '--filter', 'ngfi'])
  const grouped = JSON.parse(raw)
  const issues = []
  for (const [license, packages] of Object.entries(grouped)) {
    for (const pkg of packages) {
      for (const version of pkg.versions) {
        const issue = validateLicense({ ecosystem: 'npm', name: pkg.name, version, license })
        if (issue) issues.push(issue)
      }
    }
  }
  return issues
}

function exportedPythonPackages(projectPath) {
  const output = run('uv', [
    '--directory', projectPath, 'export', '--offline', '--locked', '--no-dev',
    '--no-emit-project', '--no-hashes', '--no-header', '--no-annotate',
  ])
  const packages = []
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)==([^ ;]+)(?:\s*;\s*(.+))?$/u)
    if (match) packages.push({ name: normalizeName(match[1]), version: match[2], marker: match[3] })
  }
  const seen = new Set()
  return packages.filter((pkg) => {
    const key = `${pkg.name}\0${pkg.version}\0${pkg.marker ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pythonMetadata(projectPath) {
  const python = resolve(root, projectPath, '.venv', 'bin', 'python')
  if (!existsSync(python)) throw new Error(`${projectPath}/.venv is missing; run uv sync --directory ${projectPath}`)
  const code = [
    'import importlib.metadata as m, json',
    'out = []',
    'for d in m.distributions():',
    '  name = d.metadata.get("Name")',
    '  if name:',
    '    out.append({"name": name, "version": d.version, "expression": d.metadata.get("License-Expression"), "license": d.metadata.get("License") or "", "classifiers": [x for x in (d.metadata.get_all("Classifier") or []) if x.startswith("License ::")]})',
    'print(json.dumps(out))',
  ].join('\n')
  const metadata = JSON.parse(run(python, ['-c', code]))
  return new Map(metadata.map((item) => [packageKey(item.name, item.version), item]))
}

function pythonInventoryFromMetadata() {
  const entries = []
  for (const config of pythonProjects) {
    const installed = pythonMetadata(config.path)
    for (const pkg of exportedPythonPackages(config.path)) {
      const key = packageKey(pkg.name, pkg.version)
      const metadata = installed.get(key)
      const override = pythonLicenseOverrides.get(key)
      if (!metadata && !override) {
        entries.push({ ecosystem: 'pypi', name: pkg.name, version: pkg.version, license: 'UNKNOWN', project: config.project, ...(pkg.marker ? { marker: pkg.marker } : {}) })
        continue
      }
      const license = override?.license || metadata.expression || normalizeLegacyLicense(metadata.license, metadata.classifiers)
      entries.push({
        ecosystem: 'pypi', name: pkg.name, version: pkg.version, license, project: config.project,
        ...(pkg.marker ? { marker: pkg.marker } : {}),
        ...(override ? { review: override.reason } : {}),
      })
    }
  }
  return entries.sort(compareEntry)
}

function inventoryForCheck(committed) {
  const committedPython = new Map(
    committed.dependencies
      .filter((entry) => entry.ecosystem === 'pypi')
      .map((entry) => [[entry.project, entry.name, entry.version, entry.marker ?? ''].join('\0'), entry]),
  )
  const python = []
  for (const config of pythonProjects) {
    for (const pkg of exportedPythonPackages(config.path)) {
      const key = [config.project, pkg.name, pkg.version, pkg.marker ?? ''].join('\0')
      const reviewed = committedPython.get(key)
      python.push(reviewed ?? {
        ecosystem: 'pypi', name: pkg.name, version: pkg.version, license: 'UNKNOWN',
        project: config.project, ...(pkg.marker ? { marker: pkg.marker } : {}),
      })
    }
  }
  return { ...committed, dependencies: [...nodeInventory(), ...python].sort(compareEntry) }
}

function compareEntry(left, right) {
  return [left.ecosystem, left.name, left.version, left.project ?? '', left.marker ?? ''].join('\0')
    .localeCompare([right.ecosystem, right.name, right.version, right.project ?? '', right.marker ?? ''].join('\0'), 'en')
}

function buildInventoryWithMetadata() {
  return {
    schemaVersion: 1,
    scope: {
      npm: 'root pnpm production dependency closure, excluding optional dependencies',
      pypi: pythonProjects.map(({ path, project }) => ({ path, project, dependencies: 'production (--no-dev)' })),
    },
    policy: {
      failClosed: ['UNKNOWN', 'UNLICENSED', 'unreviewed license identifiers', 'AGPL-*', 'GPL-*'],
      reviewedExceptions,
    },
    dependencies: [...nodeInventory(), ...pythonInventoryFromMetadata()].sort(compareEntry),
  }
}

function serialized(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`
}

function checkInventory() {
  if (!existsSync(inventoryPath)) {
    process.stderr.write('dependency license gate: docs/dependency-licenses.json is missing; run pnpm dependency:licenses:update\n')
    process.exitCode = 1
    return
  }
  const committedText = readFileSync(inventoryPath, 'utf8')
  let committed
  try {
    committed = JSON.parse(committedText)
  } catch (error) {
    throw new Error(`docs/dependency-licenses.json is not valid JSON: ${error.message}`)
  }
  const inventory = inventoryForCheck(committed)
  const issues = [
    ...inventory.dependencies.map(validateLicense).filter(Boolean),
    ...checkOptionalNodeLicenses(),
  ]
  if (committedText !== serialized(inventory)) {
    issues.push('docs/dependency-licenses.json is stale; review changes and run pnpm dependency:licenses:update')
  }
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`dependency license gate: ${issue}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`dependency license gate passed (${inventory.dependencies.length} production entries)\n`)
  }
}

function updateInventory(inventory) {
  const issues = [
    ...inventory.dependencies.map(validateLicense).filter(Boolean),
    ...checkOptionalNodeLicenses(),
  ]
  if (issues.length > 0) throw new Error(`refusing to write failing inventory:\n${issues.join('\n')}`)
  writeFileSync(inventoryPath, serialized(inventory))
  process.stdout.write(`wrote ${inventoryPath.slice(root.length + 1)} (${inventory.dependencies.length} production entries)\n`)
}

function main() {
  const mode = process.argv[2]
  if (!['--check', '--update'].includes(mode)) {
    throw new Error('usage: node scripts/dependency-audit.mjs [--check|--update]')
  }
  if (mode === '--update') updateInventory(buildInventoryWithMetadata())
  else checkInventory()
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`dependency audit failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
