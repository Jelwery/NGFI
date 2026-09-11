#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
let workspace = 'default'
if (args[0] === '--workspace') {
  workspace = args[1]
  args.splice(0, 2)
}
if (typeof workspace !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(workspace)) {
  throw new Error('workspace must be a safe NGFI workspace ID')
}
const localUv = resolve(root, '.runtime/python-tools/bin/uv')
const uv = process.env.NGFI_UV_EXECUTABLE || (existsSync(localUv) ? localUv : 'uv')
const store = resolve(process.env.NGFI_RUNTIME_DATA_ROOT || resolve(root, '.runtime/finance-data'), 'quant-research', workspace)
const child = spawn(uv, [
  'run', '--project', resolve(root, 'packages/quant-research'), '--frozen', '--offline',
  'ngfi-quant', '--store', store, ...(args.length ? args : ['--help']),
], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, UV_CACHE_DIR: resolve(root, '.uv-cache'),
    OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
})
const interrupt = () => child.kill('SIGTERM')
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
