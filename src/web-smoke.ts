import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { PROJECT_ROOT, RESERVED_PORTS, findAvailablePort, prepareRuntime, resolveDshBin } from './runtime.js'

async function waitUntilReady(url: string, child: ReturnType<typeof spawn>): Promise<number> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH Web exited before readiness with code ${child.exitCode}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return response.status
    } catch {
      // Startup races are expected until the loopback listener is ready.
    }
    await delay(250)
  }
  throw new Error(`DSH Web did not become ready at ${url}`)
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

async function main(): Promise<void> {
  const port = await findAvailablePort()
  if (RESERVED_PORTS.has(port)) throw new Error(`Dynamic allocator returned reserved port ${port}`)
  const runtime = await prepareRuntime({ requireCredential: false })
  const bin = await resolveDshBin()
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
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  child.stderr?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  try {
    const status = await waitUntilReady(`http://127.0.0.1:${port}/`, child)
    process.stdout.write(`${JSON.stringify({ ok: true, host: '127.0.0.1', port, status })}\n`)
  } catch (error) {
    if (output.trim() !== '') process.stderr.write(output)
    throw error
  } finally {
    await stop(child)
    await runtime.cleanup()
  }
}

await main()
