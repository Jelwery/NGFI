import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT, prepareRuntime } from '../src/runtime.js'

const iterationNumber = Number(process.argv[2] ?? '1')
if (!Number.isInteger(iterationNumber) || iterationNumber < 1) throw new Error('iteration number must be a positive integer')
const pairs: Array<{ id: number; name: string }> = [
  { id: 1, name: 'winner-sale-regret' },
  { id: 2, name: 'loser-break-even-anchor' },
  { id: 3, name: 'recent-rally-extrapolation' },
  { id: 4, name: 'frequent-checking-anxiety' },
  { id: 5, name: 'winning-streak-risk-escalation' },
  { id: 6, name: 'loss-chasing' },
  { id: 7, name: 'bubble-state-assessment' },
  { id: 8, name: 'belief-updating-resistance' },
  { id: 9, name: 'multi-trade-audit' },
  { id: 10, name: 'insufficient-information-nonbias' },
  { id: 11, name: 'prospect-theory-concept' },
  { id: 12, name: 'adjacent-market-request' },
]
const workspace = join(PROJECT_ROOT, 'skills', 'investment-behavior-diagnosis-workspace', `iteration-${iterationNumber}`)
const requested = process.argv.slice(3)
const jobs = pairs.flatMap(item => ['new_skill', 'old_skill'].map(configuration => ({ item, configuration })))
  .filter(job => requested.length === 0 || requested.includes(`${job.item.id}:${job.configuration}`))

function run(
  item: { id: number; name: string },
  configuration: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const skillsRoot = join(workspace, 'skill-roots', configuration)
  const runDirectory = join(workspace, `eval-${item.id}-${item.name}`, configuration, 'run-1')
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      'scripts/run-behavior-eval.ts',
      String(item.id),
      skillsRoot,
      runDirectory,
    ], {
      cwd: PROJECT_ROOT,
      env: { ...environment, FINANCE2DSH_RUNTIME_PREPARED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', code => {
      if (code === 0) {
        process.stdout.write(stdout)
        resolveRun()
      } else {
        rejectRun(new Error(`eval ${item.id} ${configuration} exited ${String(code)}: ${stderr || stdout}`))
      }
    })
  })
}

const runtime = await prepareRuntime({ requireCredential: true })
try {
  const results = await Promise.allSettled(jobs.map(job => run(job.item, job.configuration, runtime.environment)))
  const failures = results.filter(result => result.status === 'rejected')
  for (const failure of failures) {
    if (failure.status === 'rejected') process.stderr.write(`${String(failure.reason)}\n`)
  }
  if (failures.length > 0) process.exitCode = 1
} finally {
  await runtime.cleanup()
}
