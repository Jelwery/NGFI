#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const snapshot = resolve(root, 'packages/finance-provider-astock/upstream/upstream.lock.json')

if (!existsSync(snapshot)) {
  process.stdout.write('upstream integrity: no vendored a-stock snapshot in this phase\n')
} else {
  execFileSync(process.execPath, ['scripts/sync-a-stock-data.mjs', '--check'], { cwd: root, stdio: 'inherit' })
}
