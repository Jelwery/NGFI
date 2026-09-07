#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PRESET_TOOL_ALLOWLISTS } from '@finance2dsh/dsh-bundle/policy'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const dshManifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const dshManifest = JSON.parse(require('node:fs').readFileSync(dshManifestPath, 'utf8'))
const dshBin = resolve(dirname(dshManifestPath), dshManifest.bin.dsh)
const requests = []

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    try { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch {}
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-ngfi-offline', object: 'chat.completion.chunk', created: 1, model: 'ngfi-offline',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-ngfi-offline', object: 'chat.completion.chunk', created: 1, model: 'ngfi-offline',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
})

function listen() {
  return new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveReady())
  })
}

await listen()
try {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('offline model server did not bind a TCP port')
  const inherited = { ...process.env }
  for (const secret of [
    'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TUSHARE_TOKEN', 'TUSHARE_MCP_URL',
    'TDX_DATA_KEY', 'TDX_COMMUNITY_SERVERS', 'IFIND_MCP_URL', 'IFIND_MCP_CREDENTIAL', 'IWENCAI_API_KEY',
  ]) delete inherited[secret]
  const baseEnvironment = {
    ...inherited, NGFI_LLM_PROVIDER: 'openai-compatible', NGFI_LLM_MODEL: 'ngfi-offline',
    NGFI_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    NGFI_API_KEY: ['test', 'only', 'placeholder'].join('-'), FINANCE2DSH_RESULT_FORMAT: 'json',
    DSH_HOME: resolve(root, '.runtime'), DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_MODE: 'DISABLED',
    FINANCE2DSH_SKILLS_DIR: resolve(root, 'skills'),
  }
  for (const [preset, expected] of Object.entries(PRESET_TOOL_ALLOWLISTS)) {
    const env = { ...baseEnvironment, NGFI_AGENT_PRESET: preset }
    await execFileAsync('pnpm', ['--silent', 'prepare'], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 })
    const before = requests.length
    const { stdout } = await execFileAsync(process.execPath, [dshBin, '--profile', 'finance-headless', 'Reply exactly OK without calling tools.'], {
      cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    })
    const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1))
    if (result.preset !== preset || result.reason?.kind !== 'completed' || result.text !== 'OK') {
      throw new Error(`${preset}: offline DSH turn did not complete under the selected preset`)
    }
    const request = requests.slice(before).findLast(item => Array.isArray(item.tools) && item.tools.length > 0)
    if (request === undefined) throw new Error(`${preset}: no model request with tools was captured`)
    const actual = request.tools.map(tool => tool.function?.name).filter(Boolean).sort()
    const wanted = [...expected].sort()
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`${preset}: tool surface mismatch\nexpected=${wanted.join(',')}\nactual=${actual.join(',')}`)
    }
  }
  process.stdout.write(`agent preset materialization passed (${Object.keys(PRESET_TOOL_ALLOWLISTS).length} presets)\n`)
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
}
