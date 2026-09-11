#!/usr/bin/env -S pnpm exec tsx
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ASHARE_FEATURES, AStockProvider, type AshareFeatureDefinition, type AshareFeatureVariant,
} from '../packages/finance-data-service/src/providers/astock/index.js'
import type { DataCapability, InstrumentId } from '@finance2dsh/core'

type LiveStatus = 'pass' | 'no-data' | 'blocked-auth' | 'unavailable-network' | 'rate-limited' | 'schema-drift' | 'upstream-error'
type ProbeResult = {
  featureId: string
  capabilityId: string
  auth: string
  status: LiveStatus
  attempted: boolean
  variants: Array<{ id: string; status: LiveStatus; attempted: boolean; elapsedMs: number }>
}

const root = process.cwd()
const argv = process.argv.slice(2)
const valueAfter = (name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}
const selectedFeature = valueAfter('--feature')
const selectedGroup = valueAfter('--group')
const runAll = argv.includes('--all')
if ([selectedFeature !== undefined, selectedGroup !== undefined, runAll].filter(Boolean).length !== 1) {
  throw new Error('choose exactly one of --feature ID, --group NAME, or --all --low-frequency')
}
if (runAll && !argv.includes('--low-frequency')) throw new Error('--all requires --low-frequency')

const groups: Record<string, (feature: AshareFeatureDefinition) => boolean> = {
  identity: feature => feature.tools.includes('finance_cn_instrument'),
  market: feature => feature.tools.includes('finance_cn_quote') || feature.tools.includes('finance_cn_bars'),
  research: feature => feature.tools.includes('finance_cn_fundamentals') || feature.tools.includes('finance_cn_disclosures'),
  activity: feature => feature.tools.includes('finance_cn_market_activity'),
  'macro-index': feature => feature.tools.includes('finance_cn_macro_index'),
}
let selected = ASHARE_FEATURES
if (selectedFeature !== undefined) selected = selected.filter(item => item.featureId === selectedFeature)
if (selectedGroup !== undefined) {
  const predicate = groups[selectedGroup]
  if (predicate === undefined) throw new Error(`unknown group ${selectedGroup}; expected ${Object.keys(groups).join(', ')}`)
  selected = selected.filter(predicate)
}
if (selected.length === 0) throw new Error('no A-share features matched the selection')

function recentWeekday(): string {
  const selected = new Date()
  selected.setUTCHours(0, 0, 0, 0)
  while (selected.getUTCDay() === 0 || selected.getUTCDay() === 6) selected.setUTCDate(selected.getUTCDate() - 1)
  return selected.toISOString().slice(0, 10)
}
const tradeDate = recentWeekday()
const oneYearAgo = `${Number(tradeDate.slice(0, 4)) - 1}${tradeDate.slice(4)}`

function instrumentFor(feature: AshareFeatureDefinition): InstrumentId | undefined {
  if (feature.upstreamCapabilityId === 'capability-059') {
    return { market: 'CN', exchange: 'BSE', symbol: '920021', assetType: 'equity' }
  }
  if (feature.scope === 'index') return { market: 'CN', exchange: 'SSE', symbol: '000300', assetType: 'index' }
  if (feature.scope === 'derivative') return { market: 'CN', exchange: 'SSE', symbol: '510050', assetType: 'etf' }
  if (feature.scope === 'instrument') return { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' }
  return undefined
}

function paramsFor(feature: AshareFeatureDefinition, variant: AshareFeatureVariant): Record<string, unknown> {
  const params: Record<string, unknown> = { featureId: feature.featureId, variant: variant.id, limit: 1 }
  const instrument = instrumentFor(feature)
  if (instrument !== undefined) params.instrument = instrument
  const id = feature.upstreamCapabilityId
  if (['capability-001', 'capability-003', 'capability-004', 'capability-031', 'capability-057'].includes(id)) {
    params.startDate = oneYearAgo
    params.endDate = tradeDate
  }
  if (id === 'capability-001') { params.interval = '1d'; params.adjustment = 'none'; params.tradeDate = tradeDate }
  if (id === 'capability-004') params.adjustment = 'qfq'
  if (id === 'capability-005' && variant.id === 'industry') params.industryCode = '*'
  if (id === 'capability-008') { params.searchText = '沪深300 研究'; params.channel = 'report'; params.page = 1 }
  if (['capability-009', 'capability-013', 'capability-014', 'capability-017', 'capability-036', 'capability-037', 'capability-038', 'capability-039', 'capability-040', 'capability-041', 'capability-058', 'capability-059', 'capability-060'].includes(id)) params.tradeDate = tradeDate
  if (id === 'capability-013') params.lookbackDays = 30
  if (id === 'capability-014') params.forwardDays = 90
  if (id === 'capability-016') { params.boardType = 'industry'; params.period = 'today' }
  if (['capability-027', 'capability-028', 'capability-035'].includes(id)) params.category = '最新提示'
  if (id === 'capability-030') params.statement = 'lrb'
  if (id === 'capability-033') params.asOf = tradeDate
  if (id === 'capability-045') { params.underlying = '510050'; params.optionType = 'call' }
  if (['capability-046', 'capability-047'].includes(id)) params.optionCode = '10009999'
  if (id === 'capability-048') params.page = 1
  if (id === 'capability-049') params.period = 'hour'
  if (id === 'capability-052') params.year = Number(tradeDate.slice(0, 4))
  if (['capability-054', 'capability-055'].includes(id)) params.officialProvider = 'csi'
  return params
}

function classify(error: unknown, feature: AshareFeatureDefinition): LiveStatus {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? String(error.kind) : ''
  if (kind === 'no-data') return 'no-data'
  if (kind === 'rate-limited') return 'rate-limited'
  if (kind === 'schema-drift') return 'schema-drift'
  if (kind === 'timeout' || kind === 'transport') return 'unavailable-network'
  if (kind === 'unauthorized' && feature.upstreamCapabilityId === 'capability-008') return 'blocked-auth'
  return 'upstream-error'
}

const provider = new AStockProvider({ source: 'public-web', projectRoot: root, timeoutMs: 15_000, networkTimeoutMs: 10_000, minRequestIntervalMs: 1_000 })
const results: ProbeResult[] = []
for (const feature of selected) {
  const variants: ProbeResult['variants'] = []
  for (const variant of feature.variants) {
    const start = Date.now()
    if (feature.auth === 'api-key' && !process.env.IWENCAI_API_KEY) {
      variants.push({ id: variant.id, status: 'blocked-auth', attempted: false, elapsedMs: Date.now() - start })
      continue
    }
    try {
      const data = await provider.execute({
        capability: variant.dataCapability as DataCapability, market: 'CN',
        ...(instrumentFor(feature) === undefined ? {} : { instrument: instrumentFor(feature) }),
        params: paramsFor(feature, variant),
      })
      variants.push({ id: variant.id, status: data.status === 'no-data' ? 'no-data' : 'pass', attempted: true, elapsedMs: Date.now() - start })
    } catch (error) {
      variants.push({ id: variant.id, status: classify(error, feature), attempted: true, elapsedMs: Date.now() - start })
    }
  }
  const statuses = variants.map(item => item.status)
  const status = statuses.every(item => item === 'pass') ? 'pass'
    : statuses.includes('rate-limited') ? 'rate-limited'
      : statuses.includes('schema-drift') ? 'schema-drift'
        : statuses.includes('unavailable-network') ? 'unavailable-network'
          : statuses.every(item => item === 'blocked-auth') ? 'blocked-auth'
            : statuses.every(item => item === 'no-data') ? 'no-data' : 'upstream-error'
  const result = { featureId: feature.featureId, capabilityId: feature.upstreamCapabilityId, auth: feature.auth, status, attempted: variants.some(item => item.attempted), variants } satisfies ProbeResult
  results.push(result)
  process.stderr.write(`${result.capabilityId} ${result.featureId}: ${result.status}\n`)
}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), lowFrequency: true, count: results.length, results }
const output = resolve(root, '.runtime/a-stock-live-matrix.json')
await mkdir(resolve(root, '.runtime'), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
