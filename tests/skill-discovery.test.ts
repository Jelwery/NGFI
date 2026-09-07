import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../src/runtime.js'

const require = createRequire(import.meta.url)
const dshRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const providerUrl = pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-skill-filesystem')).href

describe('canonical skill filesystem', () => {
  it('is actually discovered by the DSH filesystem provider from one root', async () => {
    const { FileSystemSkillProvider } = await import(providerUrl)
    const provider = new FileSystemSkillProvider(
      { get: () => undefined, logger: { warn: () => undefined } } as never,
      { signal: new AbortController().signal, invalidate: () => undefined },
      {
        providerName: 'ngfi-contract',
        includeDefaultRoots: false,
        customSkillDirs: [join(PROJECT_ROOT, 'skills')],
        watch: false,
      },
    )
    const observation = await provider.list({ cwd: PROJECT_ROOT })
    const candidates = Array.isArray(observation) ? observation : observation.candidates
    const names = candidates.map((candidate: { name: string }) => candidate.name)
    expect(names).toContain('company-financial-analysis')
    expect(names).toContain('macro-cycle-policy-analysis')
    expect(names.filter((name: string) => name === 'investment-behavior-diagnosis')).toHaveLength(1)
    expect(names).toEqual(expect.arrayContaining([
      'company-research', 'strategy-research', 'portfolio-risk', 'thesis-review', 'adversarial-research',
    ]))
    await provider.dispose()
  })
})
