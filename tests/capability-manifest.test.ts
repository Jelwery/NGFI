import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const validator = 'scripts/validate-capability-manifest.mjs'

function validate(path = 'docs/capabilities/manifest.json'): string {
  return execFileSync(process.execPath, [validator, path], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function changedManifest(mutator: (manifest: Record<string, any>) => void): Promise<string> {
  const manifest = JSON.parse(await readFile('docs/capabilities/manifest.json', 'utf8')) as Record<string, any>
  mutator(manifest)
  const path = join(tmpdir(), `ngfi-capabilities-${process.pid}-${Math.random()}.json`)
  await writeFile(path, JSON.stringify(manifest), 'utf8')
  return path
}

describe('capability manifest', () => {
  it('matches every current tool, Skill, preset, export, test, and fixture', () => {
    expect(validate()).toMatch(/capability manifest passed/)
  })

  it('fails closed when a contract test is removed from the declared surface', async () => {
    const path = await changedManifest(manifest => { manifest.capabilities[0].contractTests = ['tests/does-not-exist.test.ts'] })
    expect(() => validate(path)).toThrow(/missing contractTests/)
  })

  it('fails closed when an Agent tool disappears from the declaration', async () => {
    const path = await changedManifest(manifest => {
      const capability = manifest.capabilities.find((item: { tools?: string[] }) => (item.tools?.length ?? 0) > 0)
      capability.tools = capability.tools.slice(1)
    })
    expect(() => validate(path)).toThrow(/tool inventory mismatch/)
  })
})
