import { describe, expect, it } from 'vitest'
import {
  assertJsonSafe,
  calculateDcf,
  calculateDcfSensitivity,
  calculateRelativeValuation,
  calculateWacc,
  observedNumber,
} from '@finance2dsh/core'

describe('finance-core normalization', () => {
  it('preserves missingness instead of replacing it with zero', () => {
    expect(observedNumber(Number.NaN)).toEqual({ status: 'missing', value: null })
    expect(observedNumber(0)).toEqual({ status: 'available', value: 0 })
  })

  it('rejects non-finite numbers anywhere in a contract', () => {
    expect(() => assertJsonSafe({ nested: [1, Number.POSITIVE_INFINITY] })).toThrow(/Non-finite/)
  })
})

describe('WACC', () => {
  it('calculates CAPM and debt-weighted WACC', () => {
    const result = calculateWacc({
      riskFreeRate: 0.04,
      equityRiskPremium: 0.055,
      beta: 1.2,
      costOfDebt: 0.05,
      taxRate: 0.21,
      debtToEquity: 0.25,
    })
    expect(result.costOfEquity).toBeCloseTo(0.106)
    expect(result.wacc).toBeCloseTo(0.0927)
    expect(result.components.equityWeight).toBeCloseTo(0.8)
  })

  it('requires all debt inputs together', () => {
    expect(() => calculateWacc({
      riskFreeRate: 0.04,
      equityRiskPremium: 0.05,
      beta: 1,
      costOfDebt: 0.05,
    })).toThrow(/supplied together/)
  })
})

describe('DCF', () => {
  const base = {
    freeCashFlows: [100, 110, 121],
    discountRate: 0.1,
    terminal: { method: 'gordon-growth' as const, terminalGrowthRate: 0.03 },
    netDebt: 50,
    sharesOutstanding: 10,
  }

  it('returns an auditable value bridge and terminal share', () => {
    const result = calculateDcf(base)
    expect(result.presentValueExplicitPeriod).toBeCloseTo(272.727273)
    expect(result.terminalValue).toBeCloseTo(1780.428571)
    expect(result.enterpriseValue).toBeCloseTo(1610.389182)
    expect(result.intrinsicValuePerShare).toBeCloseTo(156.038918)
    expect(result.terminalValueShareOfEnterpriseValue).toBeGreaterThan(0.8)
  })

  it('hard-fails when terminal growth is not below WACC', () => {
    expect(() => calculateDcf({
      ...base,
      discountRate: 0.03,
      terminal: { method: 'gordon-growth', terminalGrowthRate: 0.03 },
    })).toThrow(/lower than discountRate/)
  })

  it('does not silently turn missing net debt into zero equity adjustment', () => {
    const { netDebt, equityValue, intrinsicValuePerShare } = calculateDcf({
      freeCashFlows: [100, 110, 121],
      discountRate: 0.1,
      terminal: { method: 'gordon-growth', terminalGrowthRate: 0.03 },
      sharesOutstanding: 10,
    })
    expect(netDebt).toBeNull()
    expect(equityValue).toBeNull()
    expect(intrinsicValuePerShare).toBeNull()
  })

  it('marks invalid sensitivity cells null', () => {
    const result = calculateDcfSensitivity({
      freeCashFlows: base.freeCashFlows,
      discountRates: [0.02, 0.08, 0.1],
      terminal: { method: 'gordon-growth', terminalGrowthRates: [0.03, 0.04] },
      netDebt: base.netDebt,
      sharesOutstanding: base.sharesOutstanding,
    })
    expect(result.grid[0]).toEqual([null, null])
    expect(result.validCellCount).toBe(4)
  })

  it('returns enterprise-value sensitivity when the net-debt bridge is unavailable', () => {
    const result = calculateDcfSensitivity({
      freeCashFlows: [100, 110, 121],
      discountRates: [0.1],
      terminal: { method: 'gordon-growth', terminalGrowthRates: [0.03] },
    })
    expect(result.metric).toBe('enterprise-value')
    expect(result.grid[0]?.[0]).toBeCloseTo(1610.389182)
  })
})

describe('relative valuation', () => {
  it('uses peer medians and target fundamentals without averaging methods silently', () => {
    const result = calculateRelativeValuation({
      target: {
        currentPrice: 100,
        eps: 5,
        ebitda: 1_000,
        revenue: 5_000,
        sharesOutstanding: 100,
        netDebt: 200,
      },
      peerMultiples: {
        AAA: { pe: 20, evEbitda: 10, evRevenue: 2, priceSales: 2.2 },
        BBB: { pe: 24, evEbitda: 12, evRevenue: 2.4, priceSales: 2.6 },
        CCC: { pe: 22, evEbitda: 11, evRevenue: 2.2, priceSales: 2.4 },
      },
    })
    expect(result.peerMedians.pe).toBe(22)
    expect(result.impliedValuePerShare.pe).toBe(110)
    expect(result.impliedValuePerShare.evEbitda).toBe(108)
    expect(result.peerCount).toBe(3)
  })
})
