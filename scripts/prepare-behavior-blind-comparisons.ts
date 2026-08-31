import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../src/runtime.js'

interface Metadata { eval_id: number; eval_name: string; prompt: string }

const iterationNumber = Number(process.argv[2] ?? '1')
if (!Number.isInteger(iterationNumber) || iterationNumber < 1) throw new Error('iteration number must be a positive integer')
const iteration = join(
  PROJECT_ROOT,
  'skills',
  'investment-behavior-diagnosis-workspace',
  `iteration-${iterationNumber}`,
)
const entries = (await import('node:fs/promises')).readdir(iteration, { withFileTypes: true })
const mappings: Array<{ eval_id: number; A: string; B: string }> = []

for (const entry of await entries) {
  if (!entry.isDirectory() || !entry.name.startsWith('eval-')) continue
  const evalDirectory = join(iteration, entry.name)
  const metadata = JSON.parse(await readFile(join(evalDirectory, 'eval_metadata.json'), 'utf8')) as Metadata
  const aConfiguration = metadata.eval_id % 2 === 1 ? 'new_skill' : 'old_skill'
  const bConfiguration = aConfiguration === 'new_skill' ? 'old_skill' : 'new_skill'
  const blindDirectory = join(iteration, 'blind-comparisons', `eval-${metadata.eval_id}-${metadata.eval_name}`)
  await mkdir(join(blindDirectory, 'A'), { recursive: true })
  await mkdir(join(blindDirectory, 'B'), { recursive: true })
  await copyFile(join(evalDirectory, aConfiguration, 'run-1', 'outputs', 'answer.md'), join(blindDirectory, 'A', 'answer.md'))
  await copyFile(join(evalDirectory, bConfiguration, 'run-1', 'outputs', 'answer.md'), join(blindDirectory, 'B', 'answer.md'))
  await writeFile(join(blindDirectory, 'prompt.md'), metadata.prompt)
  mappings.push({ eval_id: metadata.eval_id, A: aConfiguration, B: bConfiguration })
}

await writeFile(join(iteration, 'blind-mapping.json'), `${JSON.stringify(mappings.sort((a, b) => a.eval_id - b.eval_id), null, 2)}\n`)
