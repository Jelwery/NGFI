import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { describe, expect, it } from 'vitest'

describe('agent preset source of truth', () => {
  it('keeps generated presets byte-identical to config sources', () => {
    expect(execFileSync(process.execPath, ['scripts/check-presets.mjs', '--check'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).toMatch(/preset drift check passed/)
  })

  it('discovers every generated preset as a valid DSH composition', async () => {
    const presets = await discoverPresets([{
      path: join(process.cwd(), 'generated/agent-presets'), trust: 'system',
    }])
    expect(presets.map(preset => preset.id)).toEqual([
      'finance-analyst', 'company-research', 'strategy-research', 'portfolio-risk',
    ])
    expect(presets.every(preset => preset.broken === undefined)).toBe(true)
  })
})
