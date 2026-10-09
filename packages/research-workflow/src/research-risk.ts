import { Cne6PortfolioRiskFacade, type Cne6ModelSnapshot } from '@finance2dsh/portfolio-risk'
import { sha256, type JsonObject } from '@finance2dsh/research-core'

/** Research-only NAV weights; never creates a confirmed holdings snapshot. */
export function researchRiskAttribution(dataset: JsonObject, backtest: JsonObject): JsonObject {
  const models = (dataset.cne6Models ?? []) as JsonObject[]
  const sessions = new Map((dataset.calendar as JsonObject[]).map(row => [String(row.date), row]))
  const prices = new Map((dataset.bars as JsonObject[]).map(row => {
    const instrument = row.instrument as JsonObject
    return [`${row.date}/${instrument.market}:${instrument.exchange}:${instrument.symbol}:${instrument.assetType}`.toUpperCase(), Number(row.close)] as const
  }))
  const returns = (dataset.returnAttribution ?? []) as JsonObject[]
  const rows = (backtest.equity as JsonObject[]).map(point => {
    const date = String(point.date)
    const cutoff = Date.parse(String(sessions.get(date)?.decisionAt))
    const close = Date.parse(String(sessions.get(date)?.closeAt))
    const visible = models.filter(row => row.asOf === date &&
      Date.parse(String(row.availableAt)) >= close && Date.parse(String(row.availableAt)) <= cutoff)
      .sort((a, b) => Date.parse(String(b.availableAt)) - Date.parse(String(a.availableAt)))
    const snapshot = visible[0]
    if (!snapshot) return { date, status: 'blocked', reason: 'No same-date CNE6 risk snapshot published between session close and decision' }
    try {
      const nav = Number(point.nav)
      const weights = Object.fromEntries(Object.entries(point.positions as JsonObject).map(([key, quantity]) => [
        key.toUpperCase(), Number(quantity) * prices.get(`${date}/${key}`.toUpperCase())! / nav,
      ]))
      const cashWeight = (Number(point.cash) + Number(point.receivableDividends)) / nav
      const facade = new Cne6PortfolioRiskFacade(snapshot as unknown as Cne6ModelSnapshot)
      const account = { asOf: date, weights, cashWeight, nav }
      const benchmark = returns.find(row => row.previousDate === date && Date.parse(String(row.weightsAvailableAt)) <= cutoff)
      const absolute = facade.researchRisk(account)
      const active = benchmark
        ? facade.researchRisk(account, Object.fromEntries(Object.entries(benchmark.benchmarkWeights as JsonObject).map(([key, value]) => [key.toUpperCase(), Number(value)])))
        : { status: 'blocked', reason: 'No PIT benchmark weights for the same beginning date' }
      return { date, snapshotHash: sha256(snapshot), status: absolute.status === 'available' && active.status === 'available' ? 'available' : 'partial',
        absolute, active }
    } catch (error) {
      return { date, status: 'blocked', reason: error instanceof Error ? error.message : 'Invalid risk snapshot' }
    }
  })
  return JSON.parse(JSON.stringify({ schemaVersion: '3', kind: 'portfolio-risk', promotionEligible: false,
    unit: 'daily-return-variance', status: rows.length && rows.every(row => row.status === 'available') ? 'complete' : 'partial', rows })) as JsonObject
}
