import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireBatch, acquisitionHash, readAcquisitionArtifact, validateAcquisitionPlan,
  type AcquisitionPlan,
} from '../packages/finance-data-service/src/providers/tushare-mcp/acquisition.js'
import { TushareMcpClient } from '../packages/finance-data-service/src/providers/tushare-mcp/client.js'

const roots: string[] = []
function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'ngfi-acquisition-'))
  roots.push(path)
  return path
}
function plan(): AcquisitionPlan {
  return { schemaVersion: 1, id: 'sample', decisionDate: '2026-09-09', contractHash: 'a'.repeat(64),
    baselineVersion: 'test-baseline', purpose: 'research-diagnostic',
    requests: [{ tool: 'daily', arguments: { ts_code: '600000.SH', start_date: '20260901', end_date: '20260909' } }] }
}
function cache(root: string, input = plan()) {
  mkdirSync(join(root, 'requests'), { recursive: true })
  const request = input.requests[0]!
  const raw = [{ ts_code: '600000.SH', trade_date: '20260909', close: 10 }]
  const content = { schemaVersion: 1, request, requestHash: acquisitionHash(request), contractHash: input.contractHash,
    fetchedAt: '2026-09-10T01:00:00Z', source: 'tushare-mcp', toolSchemaHash: 'b'.repeat(64), raw, rows: raw, rawHash: acquisitionHash(raw) }
  const artifact = { ...content, artifactHash: acquisitionHash(content) }
  const path = join(root, 'requests', `${content.requestHash}.json`)
  writeFileSync(path, JSON.stringify(artifact))
  return { path, artifact }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('equity acquisition contract', () => {
  it('accepts bounded read requests and hashes map order deterministically', () => {
    expect(() => validateAcquisitionPlan(plan())).not.toThrow()
    expect(acquisitionHash({ b: 2, a: [1, null] })).toBe(acquisitionHash({ a: [1, null], b: 2 }))
    expect(() => acquisitionHash({ nested: Infinity })).toThrow('nonfinite')
  })

  it.each(['write-tool', 'arbitrary-argument', 'over-budget', 'future', 'unbounded', 'duplicate', 'reversed-window'])('rejects %s plans', change => {
    const input = plan()
    if (change === 'write-tool') input.requests[0]!.tool = 'p_save'
    if (change === 'arbitrary-argument') input.requests[0]!.arguments.url = 'https://example.invalid'
    if (change === 'over-budget') input.requests = Array.from({ length: 31 }, () => input.requests[0]!)
    if (change === 'future') input.requests[0]!.arguments.end_date = '20260910'
    if (change === 'unbounded') input.requests[0]!.arguments = {}
    if (change === 'duplicate') input.requests.push(structuredClone(input.requests[0]!))
    if (change === 'reversed-window') input.requests[0]!.arguments.start_date = '20260909', input.requests[0]!.arguments.end_date = '20260901'
    expect(() => validateAcquisitionPlan(input)).toThrow()
  })

  it.each(['hash', 'request', 'symlink'])('rejects unsafe cached artifact: %s', change => {
    const root = temporary()
    const { path, artifact } = cache(root)
    if (change === 'hash') writeFileSync(path, JSON.stringify({ ...artifact, rawHash: 'c'.repeat(64) }))
    if (change === 'symlink') {
      const link = join(root, 'linked.json')
      symlinkSync(path, link)
      expect(() => readAcquisitionArtifact(link)).toThrow('invalid acquisition artifact')
      return
    }
    const request = structuredClone(plan().requests[0]!)
    if (change === 'request') request.arguments.ts_code = '000001.SZ'
    expect(() => readAcquisitionArtifact(path, request)).toThrow('integrity mismatch')
  })

  it('replays a complete cache without credentials or network requests', async () => {
    const root = temporary()
    const { path, artifact } = cache(root)
    vi.stubEnv('TUSHARE_TOKEN', '')
    vi.stubEnv('TUSHARE_MCP_URL', '')
    const discovery = vi.spyOn(TushareMcpClient.prototype, 'discoverTools').mockRejectedValue(new Error('network forbidden'))
    const report = await acquireBatch(plan(), root)
    expect(report.status).toBe('collected')
    expect(report.requestStarts).toBe(0)
    expect(discovery).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(artifact)
  })

  it('records a source error and stops without retrying later partitions', async () => {
    const root = temporary()
    vi.stubEnv('TUSHARE_TOKEN', 'fixture-secret-that-must-not-leak')
    const daily = { name: 'daily', inputSchema: { type: 'object' as const } }
    vi.spyOn(TushareMcpClient.prototype, 'discoverTools').mockResolvedValue({ tools: new Map([['daily', daily]]), toolNames: ['daily'], capabilities: ['market-bars'], unavailableCapabilities: {} })
    const call = vi.spyOn(TushareMcpClient.prototype, 'call').mockRejectedValue(new Error('429 rate limit'))
    const input = plan()
    input.requests.push({ tool: 'daily', arguments: { ts_code: '000001.SZ', trade_date: '20260909' } })
    const report = await acquireBatch(input, root)
    expect(report.status).toBe('blocked')
    expect(report.requestStarts).toBe(1)
    expect(report.skipped).toBe(1)
    expect(call).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(report)).not.toContain('fixture-secret-that-must-not-leak')
    expect(report.promotionAllowed).toBe(false)
  })
})
