import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { acquireBatch, acquisitionHash, readAcquisitionArtifact, type AcquisitionPlan, type AcquisitionRequest } from '../packages/finance-data-service/src/providers/tushare-mcp/acquisition.js'

const repo = process.cwd()
const root = resolve(repo, '.runtime/equity-data/a2')
const contractBytes = readFileSync(resolve(repo, 'config/equity-data-acceptance.json'))
const contract = JSON.parse(contractBytes.toString())
const contractHash = createHash('sha256').update(contractBytes).digest('hex')
const day = contract.decisionDate.replaceAll('-', '')
const baselineVersion = 'equity-a0-a1-1bb79e9c8e44b525'
const [mode, group] = process.argv.slice(2)
const masterFields = ['ts_code', 'symbol', 'name', 'market', 'exchange', 'curr_type', 'list_status', 'list_date', 'delist_date', 'industry']
const req = (tool: string, args: AcquisitionRequest['arguments']): AcquisitionRequest => ({ tool, arguments: args })

function bootstrap(): AcquisitionRequest[] {
  const jobs: AcquisitionRequest[] = []
  for (const exchange of ['SSE', 'SZSE', 'BSE']) {
    for (const list_status of ['L', 'D', 'P']) jobs.push(req('stock_basic', { exchange, list_status, fields: masterFields }))
  }
  jobs.push(req('bse_mapping', {}))
  for (const exchange of ['SSE', 'SZSE']) {
    for (const [start_date, end_date] of [['20090101', '20131231'], ['20140101', '20181231'], ['20190101', '20231231'], ['20240101', day]]) {
      jobs.push(req('trade_cal', { exchange, start_date: start_date!, end_date: end_date! }))
    }
  }
  jobs.push(req('daily', { trade_date: day }), req('daily_basic', { trade_date: day }),
    req('suspend_d', { trade_date: day }), req('suspend_d', { trade_date: '20240205' }),
    req('index_weight', { index_code: '000300.SH', start_date: '20260801', end_date: '20260831' }),
    req('index_weight', { index_code: '000906.SH', start_date: '20260801', end_date: '20260831' }))
  return jobs
}

function read(request: AcquisitionRequest) {
  return readAcquisitionArtifact(join(root, 'requests', `${acquisitionHash(request)}.json`), request)
}

function selection() {
  const file = join(root, 'selection-v2.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const jobs = bootstrap()
  const master = jobs.filter(job => job.tool === 'stock_basic').flatMap(job => read(job).rows)
  const market = new Map(read(req('daily', { trade_date: day })).rows.map(row => [row.ts_code, row]))
  const suspended = new Set(read(req('suspend_d', { trade_date: '20240205' })).rows.filter(row => row.suspend_type === 'S').map(row => row.ts_code))
  const selected: Array<{ security: Record<string, unknown>; selectionReasons: string[] }> = []
  const eligible = master.filter(row => row.curr_type === 'CNY' && row.market !== 'CDR' && typeof row.list_date === 'string' && row.list_date <= day
    && (row.delist_date === null || String(row.delist_date) >= '20160101'))
  for (const exchange of ['SSE', 'SZSE', 'BSE']) {
    const rows = eligible.filter(row => row.exchange === exchange).sort((a, b) => String(a.ts_code).localeCompare(String(b.ts_code)))
    const picked = new Map<unknown, { security: Record<string, unknown>; selectionReasons: string[] }>()
    const pick = (row: Record<string, unknown> | undefined, reason: string) => {
      if (!row) return
      const current = picked.get(row.ts_code)
      if (current) current.selectionReasons.push(reason)
      else if (picked.size < 8) picked.set(row.ts_code, { security: row, selectionReasons: [reason] })
    }
    pick(rows.find(row => row.list_status === 'D'), 'historical-delisting')
    pick(rows.find(row => /ST/.test(String(row.name)) && row.list_status === 'L'), 'current-ST-name-needs-history-verification')
    pick(rows.find(row => suspended.has(row.ts_code)), 'suspension-on-2024-02-05-duration-unverified')
    pick(rows.find(row => ['银行', '证券', '保险', '多元金融'].includes(String(row.industry)) && row.list_status === 'L'), 'financial-source-classification-unverified')
    pick([...rows].filter(row => row.list_status === 'L').sort((a, b) => String(b.list_date).localeCompare(String(a.list_date)) || String(a.ts_code).localeCompare(String(b.ts_code)))[0], 'recent-IPO')
    pick([...rows].filter(row => row.list_status === 'L' && Number(market.get(row.ts_code)?.amount) > 0).sort((a, b) => Number(market.get(a.ts_code)?.amount) - Number(market.get(b.ts_code)?.amount) || String(a.ts_code).localeCompare(String(b.ts_code)))[0], 'low-D-turnover-needs-ADV-verification')
    for (const row of rows.filter(row => row.list_status === 'L')) pick(row, 'deterministic-exchange-fill')
    if (picked.size !== 8) throw new Error(`insufficient ${exchange} sample universe`)
    selected.push(...picked.values())
  }
  const result = { schemaVersion: 1, selectionVersion: 2, replaces: 'selection.json', selectionPolicy: 'Historical evaluation overlap; low-D-turnover instead of market-cap proxy; revised before sample history was fetched.', selectedAt: new Date().toISOString(), decisionDate: contract.decisionDate, contractHash, baselineVersion,
    inputHashes: jobs.filter(job => ['stock_basic', 'daily', 'suspend_d'].includes(job.tool)).map(job => read(job).artifactHash),
    selected, requiredStrata: contract.a2Sample.requiredStrata,
    pendingStratumVerification: ['historical-ST', 'long-suspension-duration', 'cash-dividend', 'bonus-or-split', 'low-liquidity'],
    qualityFlag: 'unverified', selectionStatus: 'candidate', promotionAllowed: false }
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return result
}

function sampleRequests(name: string): AcquisitionRequest[] {
  const sample = selection()
  return sample.selected.map(({ security }: { security: Record<string, unknown> }) => {
    const ts_code = String(security.ts_code)
    const start_date = '20090101'
    const end_date = day
    if (['daily', 'daily_basic', 'adj_factor', 'suspend_d', 'stk_limit'].includes(name)) return req(name, { ts_code, start_date, end_date })
    if (['namechange', 'index_member_all', 'dividend'].includes(name)) return req(name, { ts_code })
    if (['income', 'balancesheet', 'cashflow'].includes(name)) return req(name, { ts_code, start_date, end_date })
    throw new Error('unknown sample group')
  })
}

if (mode === 'observe') {
  const startedAt = new Date().toISOString()
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(new Date())
  const tradeDate = local.slice(0, 10)
  if (Number(local.slice(-2)) < 17 || (group !== undefined && group !== tradeDate)) throw new Error('observe only supports the actual Shanghai date after 17:00; no historical backfill')
  const observationRoot = join(root, 'observations', tradeDate)
  const output = join(observationRoot, 'observation.json')
  if (existsSync(observationRoot)) throw new Error('this session observation was already attempted; do not overwrite or count repeats')
  const trade_date = tradeDate.replaceAll('-', '')
  const plan: AcquisitionPlan = { schemaVersion: 1, id: `a2-observe-${tradeDate}`, decisionDate: tradeDate, contractHash, baselineVersion,
    purpose: 'research-diagnostic', requests: [req('trade_cal', { exchange: 'SSE', start_date: trade_date, end_date: trade_date }),
      req('daily', { trade_date }), req('daily_basic', { trade_date }), req('suspend_d', { trade_date })] }
  const report = await acquireBatch(plan, observationRoot)
  let sourceStatus = 'blocked'
  let rowCounts: Record<string, number> = {}
  if (report.status === 'collected') {
    const artifacts = plan.requests.map(request => readAcquisitionArtifact(join(observationRoot, 'requests', `${acquisitionHash(request)}.json`), request))
    rowCounts = Object.fromEntries(artifacts.map(artifact => [artifact.request.tool, artifact.rows.length]))
    const calendar = artifacts[0]!.rows
    const prices = artifacts[1]!.rows
    const capital = artifacts[2]!.rows
    const priceCodes = new Set(prices.map(row => row.ts_code))
    const capitalCodes = new Set(capital.map(row => row.ts_code))
    const identitiesValid = artifacts.every(artifact => artifact.rows.every(row => (row.trade_date ?? row.cal_date) === trade_date))
    if (calendar.length === 1 && calendar[0]!.is_open === 1 && identitiesValid && prices.length > 0
      && priceCodes.size === prices.length && capitalCodes.size === capital.length
      && priceCodes.size === capitalCodes.size && [...priceCodes].every(code => capitalCodes.has(code))) sourceStatus = 'pass'
  }
  const observation = { schemaVersion: 1, mode: 'live', tradeDate, contractHash, startedAt, finishedAt: new Date().toISOString(),
    sourceStatus, rowCounts, acquisitionReportFile: String(report.reportPath).split('/').at(-1),
    acquisitionReportHash: createHash('sha256').update(readFileSync(String(report.reportPath))).digest('hex'),
    publicationStatus: 'blocked', promotionAllowed: false,
    reason: 'Actual same-day source observation only; no accepted full-market risk publication exists and no CURRENT pointer is changed.' }
  writeFileSync(output, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(observation))
  if (sourceStatus !== 'pass') process.exitCode = 2
} else if (mode === 'bootstrap' || mode === 'sample' || mode === 'repair') {
  let requests = mode === 'bootstrap' ? bootstrap() : mode === 'sample' ? sampleRequests(group ?? '') : []
  let id = mode === 'bootstrap' ? 'a2-bootstrap-v1' : `a2-sample-${group?.replaceAll('_', '-')}-v1`
  if (mode === 'repair') {
    if (group === 'benchmarks') {
      requests = ['000300.SH', '000906.SH', 'H00300.CSI', 'H00906.CSI'].map(ts_code => req('index_daily', { ts_code, start_date: '20090101', end_date: day }))
    } else if (group === 'industry-history') {
      requests = sampleRequests('index_member_all').map(request => ({ ...request, arguments: { ...request.arguments, is_new: 'N' } }))
    } else if (group === 'index-weights-csi300' || group === 'index-weights-csi800') {
      // Full 2016..D monthly constituent/weight history. index_weight returns
      // month-end rows; partition by span so no call reaches the row cap:
      // CSI300 (300/mo) uses yearly windows, CSI800 (800/mo) uses half-year windows.
      const index_code = group === 'index-weights-csi300' ? '000300.SH' : '000906.SH'
      const spans: Array<[string, string]> = []
      const startYear = 2016
      const endYmd = day
      if (group === 'index-weights-csi300') {
        for (let y = startYear; y <= Number(endYmd.slice(0, 4)); y++) {
          const s = `${y}0101`
          const e = y === Number(endYmd.slice(0, 4)) ? endYmd : `${y}1231`
          spans.push([s, e])
        }
      } else {
        for (let y = startYear; y <= Number(endYmd.slice(0, 4)); y++) {
          for (const [ms, me] of [['0101', '0630'], ['0701', '1231']] as const) {
            const s = `${y}${ms}`
            let e = `${y}${me}`
            if (s > endYmd) continue
            if (e > endYmd) e = endYmd
            spans.push([s, e])
          }
        }
      }
      requests = spans.map(([start_date, end_date]) => req('index_weight', { index_code, start_date, end_date }))
    } else if (/^(income|balancesheet|cashflow)-type-[45]$/.test(group ?? '')) {
      const [tool, , reportType] = group!.split('-')
      requests = sampleRequests(tool!).map(request => ({ ...request, arguments: { ...request.arguments, report_type: reportType! } }))
    } else if (group === 'balance-early' || group === 'balance-late') {
      requests = sampleRequests('balancesheet').filter(request => read(request).rows.length >= 100).map(request => ({ ...request,
        arguments: { ...request.arguments, start_date: group === 'balance-early' ? '20090101' : '20180101', end_date: group === 'balance-early' ? '20171231' : day } }))
    } else throw new Error('unknown repair partition')
    id = `a2-repair-${group}-v1`
  }
  const plan: AcquisitionPlan = { schemaVersion: 1, id,
    decisionDate: contract.decisionDate, contractHash, baselineVersion, purpose: 'research-diagnostic', requests }
  const plans = join(root, 'plans')
  mkdirSync(plans, { recursive: true, mode: 0o700 })
  const path = join(plans, `${plan.id}.json`)
  if (existsSync(path)) {
    if (acquisitionHash(JSON.parse(readFileSync(path, 'utf8'))) !== acquisitionHash(plan)) throw new Error('frozen plan changed')
  } else writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const report = await acquireBatch(plan, root)
  console.log(JSON.stringify({ status: report.status, requestStarts: report.requestStarts, skipped: report.skipped, reportPath: report.reportPath }))
  if (report.status === 'blocked') process.exitCode = 1
} else if (mode === 'select') {
  const result = selection()
  console.log(JSON.stringify({ sampleSize: result.selected.length, qualityFlag: result.qualityFlag, selected: result.selected.map((row: { security: Record<string, unknown>; selectionReasons: string[] }) => ({ code: row.security.ts_code, name: row.security.name, reasons: row.selectionReasons })), pendingStratumVerification: result.pendingStratumVerification }, null, 2))
} else throw new Error('usage: acquire-equity-sample.ts bootstrap | select | sample daily|daily_basic|adj_factor|suspend_d|stk_limit|namechange|index_member_all|dividend|income|balancesheet|cashflow')
