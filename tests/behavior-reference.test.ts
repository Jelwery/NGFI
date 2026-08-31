import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BEHAVIOR_REFERENCE_TOPICS, createBehaviorReferenceTool } from '@finance2dsh/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const exec = { signal: new AbortController().signal } as ToolRunContext

async function fixture(): Promise<{ root: string; references: string }> {
  const root = await mkdtemp(join(tmpdir(), 'finance2dsh-behavior-reference-'))
  temporaryDirectories.push(root)
  const references = join(root, 'investment-behavior-diagnosis', 'references')
  await mkdir(references, { recursive: true })
  for (const topic of BEHAVIOR_REFERENCE_TOPICS) {
    await writeFile(join(references, topic + '.md'), '# ' + topic, 'utf8')
  }
  return { root, references }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('behavior reference tool', () => {
  it('reads each approved topic from the configured skill root', async () => {
    const { root } = await fixture()
    const tool = createBehaviorReferenceTool({ skillsRoot: root })
    for (const topic of BEHAVIOR_REFERENCE_TOPICS) {
      await expect(tool.execute({ topic }, exec)).resolves.toEqual({
        topic,
        content: '# ' + topic,
      })
    }
  })

  it('rejects arbitrary paths and unknown topics', async () => {
    const { root } = await fixture()
    const tool = createBehaviorReferenceTool({ skillsRoot: root })
    await expect(tool.execute({ topic: '../secret' }, exec)).rejects.toThrow(/must be one of|unsupported/)
    await expect(tool.execute({ topic: '/etc/passwd' }, exec)).rejects.toThrow(/must be one of|unsupported/)
  })

  it('rejects a symlink even when its name is allowlisted', async () => {
    const { root, references } = await fixture()
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'secret', 'utf8')
    const target = join(references, 'belief-and-learning.md')
    await rm(target)
    await symlink(outside, target)
    const tool = createBehaviorReferenceTool({ skillsRoot: root })
    await expect(tool.execute({ topic: 'belief-and-learning' }, exec)).rejects.toThrow(/symbolic links/)
  })

  it('enforces a bounded reference size', async () => {
    const { root } = await fixture()
    const tool = createBehaviorReferenceTool({ skillsRoot: root, maxBytes: 4 })
    await expect(tool.execute({ topic: 'market-aggregation' }, exec)).rejects.toThrow(/exceeds/)
  })
})
