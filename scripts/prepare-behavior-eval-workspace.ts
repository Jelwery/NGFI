import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/runtime.js'

interface EvalCase {
  id: number
  name: string
  prompt: string
  requiredTools: string[]
  forbiddenTools: string[]
  expectations: string[]
}

const workspace = join(PROJECT_ROOT, 'skills', 'investment-behavior-diagnosis-workspace')
const iterationNumber = Number(process.argv[2] ?? '1')
if (!Number.isInteger(iterationNumber) || iterationNumber < 1) {
  throw new Error('iteration number must be a positive integer')
}
const iteration = join(workspace, `iteration-${iterationNumber}`)
const skillRoots = join(iteration, 'skill-roots')

async function linkSkillRoot(root: string, behaviorSource: string): Promise<void> {
  await mkdir(root, { recursive: true })
  const entries = await readdir(join(PROJECT_ROOT, 'skills'), { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith('-workspace')) continue
    const source = entry.name === 'investment-behavior-diagnosis'
      ? behaviorSource
      : join(PROJECT_ROOT, 'skills', entry.name)
    await symlink(source, join(root, entry.name), 'dir')
  }
}

async function main(): Promise<void> {
  try {
    await readFile(iteration)
    throw new Error(`iteration-${iterationNumber} already exists; refusing to overwrite evaluation results`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EISDIR'
      && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') {
      throw new Error(`iteration-${iterationNumber} already exists; refusing to overwrite evaluation results`)
    }
  }

  const cases = JSON.parse(await readFile(
    join(PROJECT_ROOT, 'evals', 'cases', 'investment-behavior-diagnosis.json'),
    'utf8',
  )) as EvalCase[]
  const skillEvalDirectory = join(PROJECT_ROOT, 'skills', 'investment-behavior-diagnosis', 'evals')
  await mkdir(skillEvalDirectory, { recursive: true })
  await writeFile(join(skillEvalDirectory, 'evals.json'), `${JSON.stringify({
    skill_name: 'investment-behavior-diagnosis',
    evals: cases.map(item => ({
      id: item.id,
      prompt: item.prompt,
      expected_output: item.expectations.join(' '),
      files: [],
      expectations: item.expectations,
    })),
  }, null, 2)}\n`)
  await mkdir(skillRoots, { recursive: true })
  await linkSkillRoot(
    join(skillRoots, 'new_skill'),
    join(PROJECT_ROOT, 'skills', 'investment-behavior-diagnosis'),
  )
  await linkSkillRoot(
    join(skillRoots, 'old_skill'),
    join(workspace, 'skill-snapshot', 'investment-behavior-diagnosis'),
  )

  for (const item of cases) {
    const evalDirectory = join(iteration, `eval-${item.id}-${item.name}`)
    await mkdir(evalDirectory, { recursive: true })
    const assertions = [
      ...item.expectations,
      ...(item.requiredTools.length === 0
        ? []
        : [`工具轨迹包含要求的工具：${item.requiredTools.join(', ')}。`]),
      ...(item.forbiddenTools.length === 0
        ? []
        : [`工具轨迹不包含禁止的工具：${item.forbiddenTools.join(', ')}。`]),
    ]
    await writeFile(join(evalDirectory, 'eval_metadata.json'), `${JSON.stringify({
      eval_id: item.id,
      eval_name: item.name,
      prompt: item.prompt,
      assertions,
      required_tools: item.requiredTools,
      forbidden_tools: item.forbiddenTools,
    }, null, 2)}\n`)
  }
  process.stdout.write(`${resolve(iteration)}\n`)
}

await main()
