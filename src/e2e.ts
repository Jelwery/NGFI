import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROJECT_ROOT, prepareRuntime, resolveDshBin } from './runtime.js'

interface E2eResult {
  selection?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  preset?: unknown
  toolCalls?: unknown
  reason?: { kind?: unknown }
  text?: unknown
}

const execFileAsync = promisify(execFile)
const task = [
  '先调用 skill 工具加载 ticker-snapshot，再调用所需的 finance 工具查询 AAPL。',
  '用中文给出公司名、ticker、当前价格、币种、观察时间与近一个月走势；缺失值不要猜。',
].join('')

function parseResult(stdout: string): E2eResult {
  const line = stdout.trim().split(/\r?\n/u).at(-1)
  if (line === undefined) throw new Error('DSH E2E returned no JSON result')
  try {
    return JSON.parse(line) as E2eResult
  } catch (cause) {
    throw new Error('DSH E2E did not end with a JSON result', { cause })
  }
}

async function main(): Promise<void> {
  const runtime = await prepareRuntime({ requireCredential: true })
  const bin = await resolveDshBin()
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [bin, '--profile', 'finance-headless', task],
      {
        cwd: PROJECT_ROOT,
        env: { ...runtime.environment, FINANCE2DSH_RESULT_FORMAT: 'json' },
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    const result = parseResult(stdout)
    const calls = Array.isArray(result.toolCalls) ? result.toolCalls : []
    const errors: string[] = []
    if (result.selection?.provider !== runtime.provider) errors.push(`provider was not ${runtime.provider}`)
    if (result.selection?.model !== runtime.model) errors.push(`model was not ${runtime.model}`)
    if (result.preset !== 'finance-analyst') errors.push('finance-analyst preset was not mounted')
    if (!calls.includes('skill')) errors.push('ticker-snapshot Skill was not loaded through the skill tool')
    if (!calls.includes('finance_security_reference')) errors.push('security reference tool was not called')
    if (!calls.includes('finance_market_data')) errors.push('market data tool was not called')
    if (result.reason?.kind !== 'completed') errors.push(`turn did not complete: ${JSON.stringify(result.reason)}`)
    if (typeof result.text !== 'string' || result.text.trim() === '') errors.push('assistant returned no text')
    if (errors.length > 0) {
      if (stderr.trim() !== '') process.stderr.write(stderr)
      throw new Error(`Finance2DSH E2E failed:\n- ${errors.join('\n- ')}`)
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      credentialSource: runtime.credentialSource,
      selection: result.selection,
      preset: result.preset,
      toolCalls: calls,
      answer: result.text,
    }, null, 2)}\n`)
  } finally {
    await runtime.cleanup()
  }
}

await main()
