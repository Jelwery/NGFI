import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { TushareMcpClient } from './client.js'
import { classifyTushareError, resolveTushareEndpoint } from './security.js'

const READ_TOOLS: Record<string, { limit: number; keys: readonly string[] }> = {
  stock_basic: { limit: 6000, keys: ['ts_code', 'exchange', 'list_status', 'fields'] },
  trade_cal: { limit: 6000, keys: ['exchange', 'start_date', 'end_date', 'fields'] },
  daily: { limit: 6000, keys: ['ts_code', 'trade_date', 'start_date', 'end_date', 'fields'] },
  daily_basic: { limit: 6000, keys: ['ts_code', 'trade_date', 'start_date', 'end_date', 'fields'] },
  adj_factor: { limit: 6000, keys: ['ts_code', 'trade_date', 'start_date', 'end_date', 'fields'] },
  namechange: { limit: 1000, keys: ['ts_code', 'start_date', 'end_date', 'fields'] },
  suspend_d: { limit: 5000, keys: ['ts_code', 'trade_date', 'start_date', 'end_date', 'fields'] },
  stk_limit: { limit: 5800, keys: ['ts_code', 'trade_date', 'start_date', 'end_date', 'fields'] },
  index_weight: { limit: 5000, keys: ['index_code', 'trade_date', 'start_date', 'end_date', 'fields'] },
  index_daily: { limit: 6000, keys: ['ts_code', 'trade_date', 'start_date', 'end_date', 'fields'] },
  index_member_all: { limit: 2000, keys: ['ts_code', 'is_new', 'src', 'fields'] },
  income: { limit: 1000, keys: ['ts_code', 'period', 'start_date', 'end_date', 'report_type', 'fields'] },
  balancesheet: { limit: 100, keys: ['ts_code', 'period', 'start_date', 'end_date', 'report_type', 'fields'] },
  cashflow: { limit: 1000, keys: ['ts_code', 'period', 'start_date', 'end_date', 'report_type', 'fields'] },
  dividend: { limit: 2000, keys: ['ts_code', 'end_date', 'ex_date', 'fields'] },
  bse_mapping: { limit: 2000, keys: ['fields'] },
  anns_d: { limit: 2000, keys: ['ts_code', 'start_date', 'end_date', 'limit', 'fields'] },
}

export interface AcquisitionRequest {
  tool: string
  arguments: Record<string, string | string[] | number>
}

export interface AcquisitionPlan {
  schemaVersion: 1
  id: string
  decisionDate: string
  contractHash: string
  baselineVersion: string
  purpose: 'research-diagnostic'
  requests: AcquisitionRequest[]
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]))
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('nonfinite source value')
  return value
}

export function acquisitionHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

export function validateAcquisitionPlan(plan: AcquisitionPlan): void {
  if (plan.schemaVersion !== 1 || plan.purpose !== 'research-diagnostic'
    || Object.keys(plan).sort().join(',') !== 'baselineVersion,contractHash,decisionDate,id,purpose,requests,schemaVersion'
    || !/^[a-z0-9-]{1,80}$/.test(plan.id) || !/^\d{4}-\d{2}-\d{2}$/.test(plan.decisionDate)
    || Number.isNaN(Date.parse(plan.decisionDate)) || new Date(plan.decisionDate).toISOString().slice(0, 10) !== plan.decisionDate
    || !/^[a-f0-9]{64}$/.test(plan.contractHash) || !plan.baselineVersion
    || !Array.isArray(plan.requests) || plan.requests.length < 1 || plan.requests.length > 30) {
    throw new TypeError('invalid frozen acquisition plan')
  }
  const hashes = new Set<string>()
  for (const request of plan.requests) {
    const rule = READ_TOOLS[request.tool]
    if (!rule || Object.keys(request).sort().join(',') !== 'arguments,tool') throw new TypeError('only fixed read-only acquisition tools are allowed')
    if (request.arguments === null || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) throw new TypeError('arguments must be an object')
    for (const [key, value] of Object.entries(request.arguments)) {
      if (!rule.keys.includes(key)) throw new TypeError(`unsupported acquisition parameter: ${key}`)
      if (key === 'fields') {
        if (!Array.isArray(value) || value.length > 200 || value.some(field => typeof field !== 'string' || !/^[a-z][a-z0-9_]{0,60}$/.test(field))) throw new TypeError('invalid selected fields')
      } else if (key === 'limit') {
        if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2000) throw new TypeError('invalid result limit')
      } else {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(value)) throw new TypeError(`invalid acquisition value: ${key}`)
        if (key.endsWith('_date') || key === 'period') {
          const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
          if (!/^\d{8}$/.test(value) || value > plan.decisionDate.replaceAll('-', '') || Number.isNaN(Date.parse(iso))
            || new Date(iso).toISOString().slice(0, 10) !== iso) throw new TypeError('request date is invalid or exceeds frozen D')
        }
      }
    }
    if (typeof request.arguments.start_date === 'string' && typeof request.arguments.end_date === 'string'
      && request.arguments.start_date > request.arguments.end_date) throw new TypeError('reversed acquisition date window')
    if (request.tool === 'stock_basic' && !request.arguments.ts_code && (!request.arguments.exchange || !request.arguments.list_status)) throw new TypeError('partition stock master by exchange and status')
    if (request.tool === 'trade_cal' && (!request.arguments.exchange || !request.arguments.start_date || !request.arguments.end_date)) throw new TypeError('calendar requires exchange and bounded dates')
    if (['daily', 'daily_basic', 'adj_factor', 'suspend_d', 'stk_limit', 'index_daily'].includes(request.tool)
      && !request.arguments.trade_date && (!request.arguments.ts_code || !request.arguments.start_date || !request.arguments.end_date)) throw new TypeError('market data requires a day partition or one bounded security')
    if (['income', 'balancesheet', 'cashflow', 'dividend', 'index_member_all', 'namechange', 'anns_d'].includes(request.tool) && !request.arguments.ts_code) throw new TypeError('security partition required')
    if (request.tool === 'index_weight' && (!request.arguments.index_code || !request.arguments.start_date || !request.arguments.end_date)) throw new TypeError('index weights require bounded dates')
    const hash = acquisitionHash(request)
    if (hashes.has(hash)) throw new TypeError('duplicate request in batch')
    hashes.add(hash)
  }
}

function plainDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('acquisition directory must be plain')
}

export interface AcquisitionArtifact {
  schemaVersion: 1
  request: AcquisitionRequest
  requestHash: string
  contractHash: string
  fetchedAt: string
  source: 'tushare-mcp'
  toolSchemaHash: string
  rawHash: string
  raw: unknown
  rows: Record<string, unknown>[]
  artifactHash: string
}

export function readAcquisitionArtifact(path: string, request?: AcquisitionRequest): AcquisitionArtifact {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('invalid acquisition artifact')
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as AcquisitionArtifact
  const { artifactHash, ...content } = artifact
  if (acquisitionHash(content) !== artifactHash || acquisitionHash(artifact.raw) !== artifact.rawHash
    || acquisitionHash(artifact.request) !== artifact.requestHash || acquisitionHash(artifact.rows) !== artifact.rawHash
    || (request && acquisitionHash(request) !== artifact.requestHash)) throw new Error('acquisition artifact integrity mismatch')
  return artifact
}

export async function acquireBatch(plan: AcquisitionPlan, root: string): Promise<Record<string, unknown>> {
  validateAcquisitionPlan(plan)
  plainDirectory(root)
  const requestsRoot = join(root, 'requests')
  const runsRoot = join(root, 'runs')
  plainDirectory(requestsRoot)
  plainDirectory(runsRoot)
  const planHash = acquisitionHash(plan)
  const startedAt = new Date().toISOString()
  const reportPath = join(runsRoot, `${plan.id}-${randomUUID()}.json`)
  let endpoint: ReturnType<typeof resolveTushareEndpoint>
  let client: TushareMcpClient | undefined
  let inventory: Awaited<ReturnType<TushareMcpClient['discoverTools']>> | undefined
  const results: Record<string, unknown>[] = []
  let stopReason: string | null = null
  let requestStarts = 0
  let previousStart = 0
  const started = Date.now()
  try {
    for (const request of plan.requests) {
      if (Date.now() - started >= 600_000) { stopReason = 'batch-deadline'; break }
      const requestHash = acquisitionHash(request)
      const artifactPath = join(requestsRoot, `${requestHash}.json`)
      if (existsSync(artifactPath)) {
        const cached = readAcquisitionArtifact(artifactPath, request)
        if (cached.contractHash !== plan.contractHash) throw new Error('cached contract hash mismatch')
        if (cached.rows.length >= READ_TOOLS[request.tool]!.limit) throw new Error('cached response may be truncated; partition it')
        results.push({ requestHash, tool: request.tool, status: 'cached', rows: cached.rows.length, artifactHash: cached.artifactHash })
        process.stdout.write(`${plan.id} ${results.length}/${plan.requests.length} ${request.tool}: cached ${cached.rows.length}\n`)
        continue
      }
      if (!client) {
        endpoint = resolveTushareEndpoint()
        if (!endpoint || endpoint.secrets.length === 0) throw new Error('TUSHARE_TOKEN must be configured')
        client = new TushareMcpClient({ endpoint, timeoutMs: 20_000 })
        inventory = await client.discoverTools()
      }
      const tool = inventory!.tools.get(request.tool)
      if (!tool) { stopReason = 'tool-not-advertised'; break }
      const delay = previousStart + 1_250 - Date.now()
      if (delay > 0) await pause(delay)
      previousStart = Date.now()
      requestStarts += 1
      try {
        const response = await client.call({ tool, arguments: request.arguments })
        const raw = response.value
        if (!Array.isArray(raw) || raw.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('source response is not a record array')
        const rows = raw as Record<string, unknown>[]
        if (rows.length >= READ_TOOLS[request.tool]!.limit) throw new Error('row cap reached; repartition rather than assume completeness')
        const content = { schemaVersion: 1 as const, request, requestHash, contractHash: plan.contractHash,
          fetchedAt: new Date().toISOString(), source: 'tushare-mcp' as const,
          toolSchemaHash: acquisitionHash(tool), rawHash: acquisitionHash(raw), raw, rows }
        const artifact = { ...content, artifactHash: acquisitionHash(content) }
        const serialized = JSON.stringify(artifact)
        if (serialized.length > 32 * 1024 * 1024 || endpoint?.secrets.some(secret => serialized.includes(secret))) throw new Error('unsafe acquisition artifact')
        writeFileSync(artifactPath, serialized + '\n', { flag: 'wx', mode: 0o600 })
        results.push({ requestHash, tool: request.tool, status: rows.length ? 'fetched' : 'empty', rows: rows.length, artifactHash: artifact.artifactHash })
        process.stdout.write(`${plan.id} ${results.length}/${plan.requests.length} ${request.tool}: ${rows.length} rows\n`)
      } catch (error) {
        const classified = classifyTushareError(error, endpoint?.secrets)
        results.push({ requestHash, tool: request.tool, status: 'failed', kind: classified.kind, reason: classified.reason })
        stopReason = classified.reason
        process.stdout.write(`${plan.id} ${request.tool}: stopped (${classified.kind})\n`)
        break
      }
    }
  } catch (error) {
    stopReason = classifyTushareError(error, endpoint?.secrets).reason
  } finally {
    await client?.close()
  }
  const report = { schemaVersion: 1, plan, planHash, startedAt, finishedAt: new Date().toISOString(),
    requestStarts, stopReason, status: stopReason ? 'blocked' : 'collected', results,
    skipped: plan.requests.length - results.length, dataAcceptanceStatus: 'not-evaluated', promotionAllowed: false }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { ...report, reportPath }
}
