import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { FINANCE_TOOL_ALLOWLIST } from '@finance2dsh/dsh-bundle/policy'
import { PROJECT_ROOT, findAvailablePort, prepareRuntime, resolveDshBin } from './runtime.js'

interface RpcEnvelope {
  result?: { ok?: boolean; value?: unknown; error?: unknown }
}

interface SessionEvent {
  type?: string
  data?: Record<string, unknown>
}

async function waitUntilReady(origin: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH Web exited before readiness with code ${child.exitCode}`)
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // Startup races are expected until the loopback listener is ready.
    }
    await delay(250)
  }
  throw new Error(`DSH Web did not become ready at ${origin}`)
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), delay(10_000).then(() => false)])
  if (!graceful && child.exitCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response`)
  }
  return value as Record<string, unknown>
}

async function main(): Promise<void> {
  const runtime = await prepareRuntime({ requireCredential: true })
  const bin = await resolveDshBin()
  const port = await findAvailablePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [
    bin, '--profile', 'finance-dev', '--host', '127.0.0.1', '--port', String(port), '--no-open',
  ], {
    cwd: PROJECT_ROOT,
    env: runtime.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-32_768) })
  child.stderr?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-32_768) })

  const rpc = async (method: string, payload: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json() as RpcEnvelope
    if (!response.ok || body.result?.ok !== true) {
      throw new Error(`${method} failed: ${JSON.stringify(body.result?.error)}`)
    }
    return body.result.value
  }

  try {
    await waitUntilReady(origin, child)
    const models = record(await rpc('llm.models', {}), 'llm.models')
    if (Array.isArray(models.failures) && models.failures.length > 0) {
      throw new Error(`llm.models reported failures: ${JSON.stringify(models.failures)}`)
    }
    const session = record(await rpc('session.create', {
      cwd: PROJECT_ROOT,
      agentPreset: 'finance-analyst',
    }), 'session.create')
    if (typeof session.sessionId !== 'string') throw new Error('session.create returned no sessionId')
    const routing = record(await rpc('session.models', { sessionId: session.sessionId }), 'session.models')
    const current = record(routing.current, 'session.models.current')
    if (routing.routable !== true || current.provider !== runtime.provider || current.model !== runtime.model) {
      throw new Error(`Web session route mismatch: ${JSON.stringify(routing)}`)
    }

    await rpc('session.prompt', {
      sessionId: session.sessionId,
      mode: 'queue',
      content: [{
        type: 'text',
        text: [
          '先调用 skill 工具加载 ticker-snapshot，再调用 finance_security_reference 和 finance_market_data 查询 AAPL。',
          '用中文给出公司名、ticker、当前价格、币种与观察时间；缺失值不要猜。',
        ].join(''),
      }],
    })

    let events: SessionEvent[] = []
    const deadline = Date.now() + 10 * 60_000
    for (;;) {
      const history = record(await rpc('session.history', { sessionId: session.sessionId, maxMessages: 1000 }), 'session.history')
      if (!Array.isArray(history.events)) throw new Error('session.history returned no events')
      if (history.hasMore === true) throw new Error('session.history was truncated')
      events = history.events.map(item => {
        const entry = record(item, 'session.history entry')
        return record(entry.event, 'session.history event') as SessionEvent
      })
      const end = events.findLast(event => event.type === 'turn/end')
      if (end !== undefined) {
        const reason = record(end.data?.reason, 'turn/end reason')
        if (reason.kind !== 'completed') throw new Error(`Web turn did not complete: ${JSON.stringify(reason)}`)
        break
      }
      if (Date.now() >= deadline) throw new Error('Web model turn did not complete within ten minutes')
      await delay(1_500)
    }

    const headers = events.filter(event => event.type === 'request/header')
    if (headers.length === 0) throw new Error('Web session produced no model request header')
    for (const header of headers) {
      const requestHeader = record(header.data?.header, 'request/header')
      const config = requestHeader.config
      const tools = requestHeader.tools
      const selected = record(config, 'request/header config')
      if (selected.provider !== runtime.provider || selected.model !== runtime.model) {
        throw new Error(`Model request route mismatch: ${JSON.stringify(selected)}`)
      }
      if (!Array.isArray(tools)) throw new Error('request/header contained no tool inventory')
      const actual = tools.map(tool => record(tool, 'request tool').name).filter(name => typeof name === 'string').sort()
      const expected = [...FINANCE_TOOL_ALLOWLIST].sort()
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`finance-analyst tool isolation mismatch: ${actual.join(',')}`)
      }
    }

    const calls = events
      .filter(event => event.type === 'tool/call')
      .map(event => event.data?.name)
      .filter((name): name is string => typeof name === 'string')
    for (const expected of ['skill', 'finance_security_reference', 'finance_market_data']) {
      if (!calls.includes(expected)) throw new Error(`Web session did not call ${expected}`)
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      scope: 'native-web-rpc; not browser UI acceptance',
      host: '127.0.0.1',
      port,
      provider: runtime.provider,
      model: runtime.model,
      preset: 'finance-analyst',
      toolCalls: calls,
      isolatedToolCount: FINANCE_TOOL_ALLOWLIST.length,
    }, null, 2)}\n`)
  } catch (error) {
    if (output.trim() !== '') process.stderr.write(output)
    throw error
  } finally {
    await stop(child)
    await runtime.cleanup()
  }
}

await main()
