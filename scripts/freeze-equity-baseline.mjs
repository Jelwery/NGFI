import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { resolve } from 'node:path'

const root = process.cwd()
const args = process.argv.slice(2)
const label = args[0]
if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(label ?? '') || args.slice(1).some(arg => arg !== '--check')) {
  throw new Error('usage: node scripts/freeze-equity-baseline.mjs LABEL [--check]')
}
const sha = data => createHash('sha256').update(data).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })
const inventory = () => [...new Set(git('ls-files', '-c', '-o', '--exclude-standard', '-z').toString().split('\0').filter(Boolean))]
  .sort().filter(path => existsSync(path)).map(path => {
    if (path.startsWith('-') || /[\r\n]/.test(path) || path.split('/').includes('..')) throw new Error('unsafe source path')
    if (/(^|\/)(\.env($|\.(?!example$))|credentials[^/]*|secrets[^/]*)/i.test(path)) throw new Error('private file in source inventory')
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new Error(`source inventory requires regular files: ${path}`)
    return { path, bytes: stat.size, executable: Boolean(stat.mode & 0o111), sha256: sha(readFileSync(path)) }
  })
const startedAt = new Date().toISOString()
const files = inventory()
const treeHash = sha(JSON.stringify(files))
const directory = resolve(root, '.runtime', 'equity-baselines', `${label}-${treeHash.slice(0, 16)}`)
if (existsSync(directory)) throw new Error('baseline already exists; never overwrite a frozen version')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const before = git('diff', '--no-ext-diff', '--binary', 'HEAD')
let checks = { status: 'not-run', command: 'pnpm check' }
if (args.includes('--check')) {
  const logPath = resolve(directory, 'pnpm-check.log')
  const fd = openSync(logPath, 'wx', 0o600)
  process.stdout.write(`Running pnpm check; log=${logPath}\n`)
  let result
  try {
    result = spawnSync(resolve(root, 'node_modules/.bin/pnpm'), ['check'], {
      cwd: root, env: { ...process.env, PATH: `${resolve(root, 'node_modules/.bin')}:${process.env.PATH}` },
      stdio: ['ignore', fd, fd], timeout: 30 * 60_000,
    })
  } finally {
    closeSync(fd)
  }
  checks = { status: result.status === 0 ? 'pass' : 'failed', command: 'pnpm check', exitCode: result.status,
    logSha256: sha(readFileSync(logPath)), logFile: 'pnpm-check.log' }
  if (checks.status !== 'pass') {
    writeFileSync(resolve(directory, 'failed-check.json'), JSON.stringify(checks, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    throw new Error(`checks failed; no accepted baseline created: ${logPath}`)
  }
}
if (sha(JSON.stringify(inventory())) !== treeHash || !before.equals(git('diff', '--no-ext-diff', '--binary', 'HEAD'))) {
  throw new Error('source changed during acceptance; freeze refused')
}
writeFileSync(resolve(directory, 'source-files.nul'), files.map(file => file.path).join('\0') + '\0', { flag: 'wx', mode: 0o600 })
writeFileSync(resolve(directory, 'worktree.patch'), before, { flag: 'wx', mode: 0o600 })
execFileSync('tar', ['-cf', resolve(directory, 'source.tar'), '--null', '-T', resolve(directory, 'source-files.nul')], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } })
if (sha(JSON.stringify(inventory())) !== treeHash) throw new Error('source changed during archive creation')
const python = execFileSync(resolve(root, 'packages/combinatorial-optimization/.venv/bin/python'), ['-c',
  'import json,platform,importlib.metadata as m; print(json.dumps({"python":platform.python_version(),**{p:m.version(p) for p in ("cvxpy","osqp","numpy","scipy","polars")}}))'], { cwd: root }).toString()
const manifest = {
  schemaVersion: 1, version: `${label}-${treeHash.slice(0, 16)}`, startedAt, frozenAt: new Date().toISOString(),
  gitHead: git('rev-parse', 'HEAD').toString().trim(), branch: git('branch', '--show-current').toString().trim(),
  dirty: git('status', '--porcelain').length > 0, treeHash, patchSha256: sha(before),
  archive: { file: 'source.tar', sha256: sha(readFileSync(resolve(directory, 'source.tar'))) },
  runtime: { node: process.version, pnpm: execFileSync(resolve(root, 'node_modules/.bin/pnpm'), ['--version']).toString().trim(),
    uv: execFileSync('uv', ['--version']).toString().trim(), ...JSON.parse(python),
    platform: platform(), osRelease: release(), architecture: process.arch, cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, physicalMemoryBytes: totalmem() },
  locks: files.filter(file => /(^|\/)(pnpm-lock\.yaml|uv\.lock)$/.test(file.path)), checks, files,
  scope: 'Source and offline engineering acceptance only; not real-market data or strategy acceptance.',
}
writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
process.stdout.write(JSON.stringify({ version: manifest.version, treeHash, files: files.length, checks, directory }) + '\n')
