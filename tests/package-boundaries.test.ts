import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('package architecture boundaries', () => {
  it('keeps the workspace graph acyclic and every direct import declared', () => {
    expect(execFileSync(process.execPath, ['scripts/check-package-boundaries.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).toMatch(/acyclic/)
  })
})
