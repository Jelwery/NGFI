function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`)
  return value
}

function rate(value: number, name: string, options: { min?: number; max?: number } = {}): number {
  finite(value, name)
  const min = options.min ?? 0
  const max = options.max ?? 1
  if (value < min || value >= max) {
    throw new RangeError(`${name} must be >= ${min} and < ${max}`)
  }
  return value
}

export interface WaccInput {
  riskFreeRate: number
  equityRiskPremium: number
  beta: number
  costOfDebt?: number
  taxRate?: number
  debtToEquity?: number
}

export interface WaccResult {
  method: 'capm' | 'capm+wacc'
  costOfEquity: number
  wacc: number
  impliedEquityRiskPremium: number
  waccPremiumOverRiskFree: number
  components: {
    riskFreeRate: number
    equityRiskPremium: number
    beta: number
    costOfDebt?: number
    taxRate?: number
    debtToEquity?: number
    equityWeight?: number
    debtWeight?: number
    afterTaxCostOfDebt?: number
  }
}

export function calculateWacc(input: WaccInput): WaccResult {
  const riskFreeRate = rate(input.riskFreeRate, 'riskFreeRate')
  const equityRiskPremium = rate(input.equityRiskPremium, 'equityRiskPremium')
  const beta = finite(input.beta, 'beta')
  if (beta < -2 || beta > 5) throw new RangeError('beta must be between -2 and 5')

  const debtInputs = [input.costOfDebt, input.taxRate, input.debtToEquity]
  const supplied = debtInputs.filter(value => value !== undefined).length
  if (supplied !== 0 && supplied !== 3) {
    throw new TypeError('costOfDebt, taxRate and debtToEquity must be supplied together')
  }

  const costOfEquity = riskFreeRate + beta * equityRiskPremium
  const components: WaccResult['components'] = { riskFreeRate, equityRiskPremium, beta }
  let wacc = costOfEquity
  let method: WaccResult['method'] = 'capm'

  if (supplied === 3) {
    const costOfDebt = rate(input.costOfDebt as number, 'costOfDebt')
    const taxRate = rate(input.taxRate as number, 'taxRate', { max: 1.0000000001 })
    if (taxRate > 1) throw new RangeError('taxRate must be <= 1')
    const debtToEquity = finite(input.debtToEquity as number, 'debtToEquity')
    if (debtToEquity < 0) throw new RangeError('debtToEquity must be >= 0')
    const equityWeight = 1 / (1 + debtToEquity)
    const debtWeight = debtToEquity / (1 + debtToEquity)
    const afterTaxCostOfDebt = costOfDebt * (1 - taxRate)
    wacc = equityWeight * costOfEquity + debtWeight * afterTaxCostOfDebt
    method = 'capm+wacc'
    Object.assign(components, {
      costOfDebt,
      taxRate,
      debtToEquity,
      equityWeight,
      debtWeight,
      afterTaxCostOfDebt,
    })
  }

  return {
    method,
    costOfEquity,
    wacc,
    impliedEquityRiskPremium: costOfEquity - riskFreeRate,
    waccPremiumOverRiskFree: wacc - riskFreeRate,
    components,
  }
}

export type DcfTerminal =
  | { method: 'gordon-growth'; terminalGrowthRate: number }
  | { method: 'exit-multiple'; terminalEbitda: number; terminalEbitdaMultiple: number }

export interface DcfInput {
  freeCashFlows: number[]
  discountRate: number
  terminal: DcfTerminal
  netDebt?: number
  sharesOutstanding?: number
}

export interface DcfResult {
  years: number[]
  freeCashFlows: number[]
  discountFactors: number[]
  presentValueFreeCashFlows: number[]
  presentValueExplicitPeriod: number
  terminal: DcfTerminal & { nextPeriodFreeCashFlow?: number }
  terminalValue: number
  presentValueTerminal: number
  enterpriseValue: number
  netDebt: number | null
  equityValue: number | null
  sharesOutstanding: number | null
  intrinsicValuePerShare: number | null
  terminalValueShareOfEnterpriseValue: number | null
  discountRate: number
}

export function calculateDcf(input: DcfInput): DcfResult {
  if (!Array.isArray(input.freeCashFlows) || input.freeCashFlows.length < 1 || input.freeCashFlows.length > 30) {
    throw new RangeError('freeCashFlows must contain 1-30 annual values')
  }
  const freeCashFlows = input.freeCashFlows.map((value, index) => finite(value, `freeCashFlows[${index}]`))
  const discountRate = rate(input.discountRate, 'discountRate', { min: Number.MIN_VALUE })
  const netDebt = input.netDebt === undefined ? null : finite(input.netDebt, 'netDebt')
  const sharesOutstanding = input.sharesOutstanding === undefined
    ? null
    : finite(input.sharesOutstanding, 'sharesOutstanding')
  if (sharesOutstanding !== null && sharesOutstanding <= 0) {
    throw new RangeError('sharesOutstanding must be > 0')
  }

  const years = freeCashFlows.map((_, index) => index + 1)
  const discountFactors = years.map(year => (1 + discountRate) ** year)
  const presentValueFreeCashFlows = freeCashFlows.map((cashFlow, index) => cashFlow / (discountFactors[index] as number))
  const presentValueExplicitPeriod = presentValueFreeCashFlows.reduce((sum, value) => sum + value, 0)

  let terminal: DcfResult['terminal']
  let terminalValue: number
  if (input.terminal.method === 'gordon-growth') {
    const terminalGrowthRate = rate(input.terminal.terminalGrowthRate, 'terminalGrowthRate', { min: -0.1 })
    if (terminalGrowthRate >= discountRate) {
      throw new RangeError('terminalGrowthRate must be lower than discountRate')
    }
    const nextPeriodFreeCashFlow = (freeCashFlows.at(-1) as number) * (1 + terminalGrowthRate)
    terminalValue = nextPeriodFreeCashFlow / (discountRate - terminalGrowthRate)
    terminal = { method: 'gordon-growth', terminalGrowthRate, nextPeriodFreeCashFlow }
  } else {
    const terminalEbitda = finite(input.terminal.terminalEbitda, 'terminalEbitda')
    const terminalEbitdaMultiple = finite(input.terminal.terminalEbitdaMultiple, 'terminalEbitdaMultiple')
    if (terminalEbitda < 0 || terminalEbitdaMultiple <= 0) {
      throw new RangeError('terminalEbitda must be >= 0 and terminalEbitdaMultiple must be > 0')
    }
    terminalValue = terminalEbitda * terminalEbitdaMultiple
    terminal = { method: 'exit-multiple', terminalEbitda, terminalEbitdaMultiple }
  }

  const presentValueTerminal = terminalValue / (discountFactors.at(-1) as number)
  const enterpriseValue = presentValueExplicitPeriod + presentValueTerminal
  const equityValue = netDebt === null ? null : enterpriseValue - netDebt
  return {
    years,
    freeCashFlows,
    discountFactors,
    presentValueFreeCashFlows,
    presentValueExplicitPeriod,
    terminal,
    terminalValue,
    presentValueTerminal,
    enterpriseValue,
    netDebt,
    equityValue,
    sharesOutstanding,
    intrinsicValuePerShare: sharesOutstanding === null || equityValue === null
      ? null
      : equityValue / sharesOutstanding,
    terminalValueShareOfEnterpriseValue: enterpriseValue === 0 ? null : presentValueTerminal / enterpriseValue,
    discountRate,
  }
}

export interface DcfSensitivityInput extends Omit<DcfInput, 'discountRate' | 'terminal'> {
  discountRates: number[]
  terminal:
    | { method: 'gordon-growth'; terminalGrowthRates: number[] }
    | { method: 'exit-multiple'; terminalEbitda: number; terminalEbitdaMultiples: number[] }
}

export interface DcfSensitivityResult {
  metric: 'intrinsic-value-per-share' | 'equity-value' | 'enterprise-value'
  terminalMethod: DcfTerminal['method']
  discountRates: number[]
  terminalAxis: number[]
  terminalAxisLabel: 'terminal-growth-rate' | 'terminal-ebitda-multiple'
  grid: Array<Array<number | null>>
  low: number | null
  high: number | null
  validCellCount: number
}

export function calculateDcfSensitivity(input: DcfSensitivityInput): DcfSensitivityResult {
  if (input.discountRates.length < 1 || input.discountRates.length > 12) {
    throw new RangeError('discountRates must contain 1-12 values')
  }
  const terminalAxis = input.terminal.method === 'gordon-growth'
    ? input.terminal.terminalGrowthRates
    : input.terminal.terminalEbitdaMultiples
  if (terminalAxis.length < 1 || terminalAxis.length > 12) {
    throw new RangeError('terminal axis must contain 1-12 values')
  }

  const grid = input.discountRates.map(discountRate => terminalAxis.map(driver => {
    try {
      const terminal: DcfTerminal = input.terminal.method === 'gordon-growth'
        ? { method: 'gordon-growth', terminalGrowthRate: driver }
        : {
            method: 'exit-multiple',
            terminalEbitda: input.terminal.terminalEbitda,
            terminalEbitdaMultiple: driver,
          }
      const result = calculateDcf({
        freeCashFlows: input.freeCashFlows,
        discountRate,
        terminal,
        ...(input.netDebt === undefined ? {} : { netDebt: input.netDebt }),
        ...(input.sharesOutstanding === undefined ? {} : { sharesOutstanding: input.sharesOutstanding }),
      })
      if (input.netDebt === undefined) return result.enterpriseValue
      return input.sharesOutstanding === undefined ? result.equityValue : result.intrinsicValuePerShare
    } catch {
      return null
    }
  }))
  const valid = grid.flat().filter((value): value is number => value !== null)
  return {
    metric: input.netDebt === undefined
      ? 'enterprise-value'
      : input.sharesOutstanding === undefined
        ? 'equity-value'
        : 'intrinsic-value-per-share',
    terminalMethod: input.terminal.method,
    discountRates: [...input.discountRates],
    terminalAxis: [...terminalAxis],
    terminalAxisLabel: input.terminal.method === 'gordon-growth'
      ? 'terminal-growth-rate'
      : 'terminal-ebitda-multiple',
    grid,
    low: valid.length === 0 ? null : Math.min(...valid),
    high: valid.length === 0 ? null : Math.max(...valid),
    validCellCount: valid.length,
  }
}
