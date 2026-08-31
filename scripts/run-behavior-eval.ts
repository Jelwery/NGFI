import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { PROJECT_ROOT, RUNTIME_HOME, prepareRuntime, resolveDshBin } from '../src/runtime.js'

interface EvalCase { id: number; name: string; prompt: string }
interface DshResult {
  text?: unknown
  reason?: unknown
  toolCalls?: unknown
  toolTrace?: unknown
  usage?: { totalTokens?: unknown; modelCalls?: unknown }
  startedAt?: unknown
  completedAt?: unknown
  durationMs?: unknown
}

const execFileAsync = promisify(execFile)

function within(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !path.startsWith(sep))
}

function parseResult(stdout: string): DshResult {
  const line = stdout.trim().split(/\r?\n/u).at(-1)
  if (line === undefined) throw new Error('DSH returned no JSON result')
  return JSON.parse(line) as DshResult
}

async function main(): Promise<void> {
  const caseId = Number(process.argv[2])
  const skillsRoot = resolve(process.argv[3] ?? '')
  const runDirectory = resolve(process.argv[4] ?? '')
  const workspace = join(PROJECT_ROOT, 'skills', 'investment-behavior-diagnosis-workspace')
  if (!Number.isInteger(caseId)) throw new Error('first argument must be an integer case id')
  if (!within(workspace, skillsRoot) || !within(workspace, runDirectory)) {
    throw new Error('skills root and run directory must stay inside the behavior evaluation workspace')
  }
  const cases = JSON.parse(await readFile(
    join(PROJECT_ROOT, 'evals', 'cases', 'investment-behavior-diagnosis.json'),
    'utf8',
  )) as EvalCase[]
  const item = cases.find(candidate => candidate.id === caseId)
  if (item === undefined) throw new Error(`unknown behavior evaluation case: ${caseId}`)

  const outputs = join(runDirectory, 'outputs')
  await mkdir(outputs, { recursive: true })
  const inheritedRuntime = process.env.FINANCE2DSH_RUNTIME_PREPARED === '1'
    && process.env.DSH_HOME === RUNTIME_HOME
  const runtime = inheritedRuntime ? undefined : await prepareRuntime({ requireCredential: true })
  const runtimeEnvironment = runtime?.environment ?? process.env
  const bin = await resolveDshBin()
  const startedAt = new Date()
  let stdout = ''
  let stderr = ''
  let commandError: unknown
  try {
    const execution = await execFileAsync(
      process.execPath,
      [bin, '--profile', 'finance-headless', item.prompt],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...runtimeEnvironment,
          DSH_HOME: RUNTIME_HOME,
          DSH_PERMISSION_MODE: 'read-only',
          DSH_TELEMETRY_MODE: 'DISABLED',
          FINANCE2DSH_SKILLS_DIR: skillsRoot,
          FINANCE2DSH_RESULT_FORMAT: 'json',
        },
        timeout: 10 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    )
    stdout = execution.stdout
    stderr = execution.stderr
  } catch (error) {
    commandError = error
    const failure = error as { stdout?: unknown; stderr?: unknown }
    stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
    stderr = typeof failure.stderr === 'string' ? failure.stderr : String(error)
  }
  const completedAt = new Date()
  let result: DshResult
  try {
    result = parseResult(stdout)
  } catch (parseError) {
    await writeFile(join(outputs, 'stdout.txt'), stdout)
    await writeFile(join(outputs, 'stderr.txt'), stderr)
    throw new Error('behavior evaluation did not produce a parseable DSH result', { cause: commandError ?? parseError })
  }

  const answer = typeof result.text === 'string' ? result.text : ''
  const toolCalls = Array.isArray(result.toolCalls)
    ? result.toolCalls.filter((value): value is string => typeof value === 'string')
    : []
  const durationMs = typeof result.durationMs === 'number'
    ? result.durationMs
    : completedAt.getTime() - startedAt.getTime()
  const totalTokens = typeof result.usage?.totalTokens === 'number' ? result.usage.totalTokens : 0
  const traceText = JSON.stringify(result.toolTrace ?? [], null, 2)
  await Promise.all([
    writeFile(join(outputs, 'answer.md'), answer),
    writeFile(join(outputs, 'result.json'), `${JSON.stringify(result, null, 2)}\n`),
    writeFile(join(outputs, 'tool-trace.json'), `${traceText}\n`),
    writeFile(join(outputs, 'metrics.json'), `${JSON.stringify({
      tool_calls: Object.fromEntries([...new Set(toolCalls)].map(name => [name, toolCalls.filter(itemName => itemName === name).length])),
      total_tool_calls: toolCalls.length,
      total_steps: (typeof result.usage?.modelCalls === 'number' ? result.usage.modelCalls : 0) + toolCalls.length,
      files_created: ['answer.md', 'result.json', 'tool-trace.json'],
      errors_encountered: commandError === undefined ? 0 : 1,
      output_chars: answer.length,
      transcript_chars: traceText.length,
    }, null, 2)}\n`),
    writeFile(join(runDirectory, 'timing.json'), `${JSON.stringify({
      total_tokens: totalTokens,
      duration_ms: durationMs,
      total_duration_seconds: durationMs / 1000,
      executor_start: typeof result.startedAt === 'string' ? result.startedAt : startedAt.toISOString(),
      executor_end: typeof result.completedAt === 'string' ? result.completedAt : completedAt.toISOString(),
      executor_duration_seconds: durationMs / 1000,
    }, null, 2)}\n`),
    writeFile(join(runDirectory, 'transcript.md'), [
      '## Eval Prompt',
      '',
      item.prompt,
      '',
      '## Tool Calls',
      '',
      toolCalls.length === 0 ? '(none)' : toolCalls.map(name => `- ${name}`).join('\n'),
      '',
      '## Final Answer',
      '',
      answer,
      '',
    ].join('\n')),
    ...(stderr.trim() === '' ? [] : [writeFile(join(outputs, 'stderr.txt'), stderr)]),
  ])
  if (commandError !== undefined) throw commandError
  process.stdout.write(`${JSON.stringify({ caseId, runDirectory, toolCalls, totalTokens, durationMs })}\n`)
  await runtime?.cleanup()
}

await main()
