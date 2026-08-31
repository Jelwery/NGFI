export type RelativeMetric = 'pe' | 'evEbitda' | 'evRevenue' | 'priceSales'

export interface RelativeValuationTarget {
  currentPrice?: number
  eps?: number
  ebitda?: number
  revenue?: number
  sharesOutstanding?: number
  netDebt?: number
}

export interface RelativeValuationInput {
  target: RelativeValuationTarget
  peerMultiples: Record<string, Partial<Record<RelativeMetric, number>>>
}

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError('median requires at least one value')
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle] as number
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

export function calculateRelativeValuation(input: RelativeValuationInput) {
  const metrics: RelativeMetric[] = ['pe', 'evEbitda', 'evRevenue', 'priceSales']
  const peerMedians: Partial<Record<RelativeMetric, number>> = {}
  for (const metric of metrics) {
    const values = Object.values(input.peerMultiples)
      .map(peer => peer[metric])
      .filter(usable)
    if (values.length > 0) peerMedians[metric] = median(values)
  }

  const target = input.target
  const implied: Partial<Record<RelativeMetric, number>> = {}
  if (usable(peerMedians.pe) && usable(target.eps)) implied.pe = peerMedians.pe * target.eps
  if (
    usable(peerMedians.evEbitda) && usable(target.ebitda) && usable(target.sharesOutstanding)
    && typeof target.netDebt === 'number' && Number.isFinite(target.netDebt)
  ) {
    implied.evEbitda = (peerMedians.evEbitda * target.ebitda - target.netDebt) / target.sharesOutstanding
  }
  if (
    usable(peerMedians.evRevenue) && usable(target.revenue) && usable(target.sharesOutstanding)
    && typeof target.netDebt === 'number' && Number.isFinite(target.netDebt)
  ) {
    implied.evRevenue = (peerMedians.evRevenue * target.revenue - target.netDebt) / target.sharesOutstanding
  }
  if (usable(peerMedians.priceSales) && usable(target.revenue) && usable(target.sharesOutstanding)) {
    implied.priceSales = peerMedians.priceSales * target.revenue / target.sharesOutstanding
  }

  for (const metric of metrics) {
    const value = implied[metric]
    if (!usable(value)) delete implied[metric]
  }
  const values = Object.values(implied).filter(usable)
  const medianImplied = values.length === 0 ? null : median(values)
  return {
    peerMedians,
    impliedValuePerShare: implied,
    low: values.length === 0 ? null : Math.min(...values),
    high: values.length === 0 ? null : Math.max(...values),
    medianImplied,
    currentPrice: usable(target.currentPrice) ? target.currentPrice : null,
    medianUpside: medianImplied !== null && usable(target.currentPrice)
      ? medianImplied / target.currentPrice - 1
      : null,
    peerCount: Object.keys(input.peerMultiples).length,
  }
}
