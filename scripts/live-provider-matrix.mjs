#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(command, [
  'exec', 'vitest', 'run', '--config', 'vitest.live.config.ts', 'tests/live-matrix.live.test.ts',
], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  env: {
    ...process.env,
    NGFI_LIVE_TDX: '1',
    NGFI_LIVE_IFIND: '1',
    NGFI_LIVE_CNE6: '1',
    NGFI_LIVE_REPORT_ONLY: '1',
  },
})

if (result.error !== undefined) {
  process.stderr.write('live provider report could not start the provider checks\n')
  process.exitCode = 1
} else {
  const prefix = '[live-provider-matrix] '
  const entries = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/u)
    .filter(line => line.includes(prefix))
    .map(line => JSON.parse(line.slice(line.indexOf(prefix) + prefix.length)))
  const expectedProviders = ['tdx-official', 'tdx-community', 'ifind-official', 'cne6-local']
  if (!expectedProviders.every(provider => entries.some(entry => entry.provider === provider))) {
    process.stderr.write('live provider report did not produce every expected provider record\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      testExitCode: result.status ?? 1,
      entries,
    }, null, 2)}\n`)
  }
}
