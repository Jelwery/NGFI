import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('agent preset source of truth', () => {
  it('keeps generated presets byte-identical to config sources', () => {
    expect(execFileSync(process.execPath, ['scripts/check-presets.mjs', '--check'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).toMatch(/preset drift check passed/)
  })
})
