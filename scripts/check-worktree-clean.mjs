#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const statePath = resolve(root, '.runtime', 'check-worktree.before')
const mode = process.argv[2]

function state() {
  return execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root })
}

if (mode === '--record') {
  writeFileSync(statePath, state())
} else if (mode === '--verify') {
  const before = readFileSync(statePath)
  const after = state()
  if (!before.equals(after)) {
    process.stderr.write('worktree drift detected during pnpm check\n')
    process.exitCode = 1
  } else {
    process.stdout.write('worktree drift check passed\n')
  }
} else {
  throw new Error('usage: node scripts/check-worktree-clean.mjs [--record|--verify]')
}
