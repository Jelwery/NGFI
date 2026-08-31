import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  calculateDcf,
  calculateDcfSensitivity,
  calculateRelativeValuation,
  calculateWacc,
  type ComparableCompany,
  type FinanceDataProvider,
  type RelativeMetric,
} from '@finance2dsh/core'
import { createYFinanceProvider } from '@finance2dsh/provider-yfinance'
import { createBehaviorReferenceTool } from './behavior-reference.js'
import { createBehaviorMarketEvidenceTool } from './behavior-market-evidence.js'
import { createBehaviorTradeAuditTool } from './behavior-trade-audit.js'

export {
  BEHAVIOR_REFERENCE_TOPICS,
  createBehaviorReferenceTool,
  type BehaviorReferenceOptions,
  type BehaviorReferenceTopic,
} from './behavior-reference.js'
export { createBehaviorMarketEvidenceTool } from './behavior-market-evidence.js'
export { createBehaviorTradeAuditTool } from './behavior-trade-audit.js'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function numberValue(company: ComparableCompany, key: string): number | undefined {
  const value = company.fields[key]?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function createFinanceTools(provider: FinanceDataProvider): ToolDefinition[] {
  return [
    createBehaviorReferenceTool(),
    createBehaviorMarketEvidenceTool(provider),
    createBehaviorTradeAuditTool(),
    defineTool({
      name: 'finance_security_reference',
      description: 'Fetch canonical company identity and a timestamped spot-market snapshot. Use this before analysis to disambiguate the ticker, currency and listing.',
      parameters: {
        ticker: { type: 'string', required: true, description: 'Public-market ticker, for example AAPL.' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return jsonSafe(await provider.securityReference(args.ticker, exec.signal)) as never
      },
    }),
    defineTool({
      name: 'finance_fundamentals',
      description: 'Fetch normalized TTM, annual and quarterly financial statements with explicit period, currency, source and missing-field status. Use returned values rather than inventing financial figures.',
      parameters: {
        ticker: { type: 'string', required: true, description: 'Public-market ticker.' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return jsonSafe(await provider.fundamentals(args.ticker, exec.signal)) as never
      },
    }),
    defineTool({
      name: 'finance_market_data',
      description: 'Fetch timestamped OHLCV history and basic derived returns/SMA. Current market observations must not be presented as historical filing-period facts.',
      parameters: {
        ticker: { type: 'string', required: true },
        period: { type: 'string', description: 'yfinance history period such as 1mo, 6mo, 1y; default 6mo.' },
        interval: { type: 'string', description: 'yfinance interval such as 1d or 1wk; default 1d.' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return jsonSafe(await provider.marketData(args.ticker, {
          ...(args.period === undefined ? {} : { period: args.period }),
          ...(args.interval === undefined ? {} : { interval: args.interval }),
          signal: exec.signal,
        })) as never
      },
    }),
    defineTool({
      name: 'finance_estimates',
      description: 'Fetch best-effort yfinance consensus and price-target fields. These are estimates, may be missing, and must never be described as historical facts.',
      parameters: {
        ticker: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return jsonSafe(await provider.estimates(args.ticker, exec.signal)) as never
      },
    }),
    defineTool({
      name: 'finance_comparables',
      description: 'Fetch normalized target and peer fundamentals/multiples. The caller must choose peers explicitly and explain why they are comparable.',
      parameters: {
        ticker: { type: 'string', required: true, description: 'Target ticker.' },
        peers: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'One to ten explicit peer tickers.',
        },
      },
      output: JSON_OUTPUT,
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args.peers.length < 1 || args.peers.length > 10) throw new RangeError('peers must contain 1-10 tickers')
        const companies = await provider.comparables([args.ticker, ...args.peers], exec.signal)
        const target = companies[0]
        if (target === undefined) throw new Error('target data is unavailable')
        const peerMultiples: Record<string, Partial<Record<RelativeMetric, number>>> = {}
        for (const peer of companies.slice(1)) {
          const multiples: Partial<Record<RelativeMetric, number>> = {}
          const pe = numberValue(peer, 'pe')
          const evEbitda = numberValue(peer, 'evEbitda')
          const evRevenue = numberValue(peer, 'evRevenue')
          const priceSales = numberValue(peer, 'priceSales')
          if (pe !== undefined) multiples.pe = pe
          if (evEbitda !== undefined) multiples.evEbitda = evEbitda
          if (evRevenue !== undefined) multiples.evRevenue = evRevenue
          if (priceSales !== undefined) multiples.priceSales = priceSales
          peerMultiples[peer.ticker] = multiples
        }
        const debt = numberValue(target, 'debt')
        const cash = numberValue(target, 'cash')
        const targetMetrics: Parameters<typeof calculateRelativeValuation>[0]['target'] = {}
        const currentPrice = numberValue(target, 'currentPrice')
        const eps = numberValue(target, 'eps')
        const ebitda = numberValue(target, 'ebitda')
        const revenue = numberValue(target, 'revenue')
        const sharesOutstanding = numberValue(target, 'sharesOutstanding')
        if (currentPrice !== undefined) targetMetrics.currentPrice = currentPrice
        if (eps !== undefined) targetMetrics.eps = eps
        if (ebitda !== undefined) targetMetrics.ebitda = ebitda
        if (revenue !== undefined) targetMetrics.revenue = revenue
        if (sharesOutstanding !== undefined) targetMetrics.sharesOutstanding = sharesOutstanding
        if (debt !== undefined && cash !== undefined) targetMetrics.netDebt = debt - cash
        const valuation = calculateRelativeValuation({
          target: targetMetrics,
          peerMultiples,
        })
        return jsonSafe({ target: target.ticker, peers: companies.slice(1).map(peer => peer.ticker), companies, valuation }) as never
      },
    }),
    defineTool({
      name: 'finance_wacc',
      description: 'Deterministically compute CAPM cost of equity and optional debt-weighted WACC. All rates are decimals (0.04 means 4%).',
      parameters: {
        risk_free_rate: { type: 'number', required: true },
        equity_risk_premium: { type: 'number', required: true },
        beta: { type: 'number', required: true },
        cost_of_debt: { type: 'number' },
        tax_rate: { type: 'number' },
        debt_to_equity: { type: 'number' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return jsonSafe(calculateWacc({
          riskFreeRate: args.risk_free_rate,
          equityRiskPremium: args.equity_risk_premium,
          beta: args.beta,
          ...(args.cost_of_debt === undefined ? {} : { costOfDebt: args.cost_of_debt }),
          ...(args.tax_rate === undefined ? {} : { taxRate: args.tax_rate }),
          ...(args.debt_to_equity === undefined ? {} : { debtToEquity: args.debt_to_equity }),
        })) as never
      },
    }),
    defineTool({
      name: 'finance_dcf',
      description: 'Deterministic DCF from an explicit annual FCF schedule. Returns enterprise value; the equity bridge is only returned when net debt is supplied, and per-share value additionally requires shares. Rates are decimals and units must be consistent.',
      parameters: {
        free_cash_flows: { type: 'array', items: { type: 'number' }, required: true },
        discount_rate: { type: 'number', required: true },
        terminal_method: { type: 'string', enum: ['gordon-growth', 'exit-multiple'], required: true },
        terminal_growth_rate: { type: 'number' },
        terminal_ebitda: { type: 'number' },
        terminal_ebitda_multiple: { type: 'number' },
        net_debt: { type: 'number' },
        shares_outstanding: { type: 'number' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const terminal = args.terminal_method === 'gordon-growth'
          ? { method: 'gordon-growth' as const, terminalGrowthRate: args.terminal_growth_rate as number }
          : {
              method: 'exit-multiple' as const,
              terminalEbitda: args.terminal_ebitda as number,
              terminalEbitdaMultiple: args.terminal_ebitda_multiple as number,
            }
        return jsonSafe(calculateDcf({
          freeCashFlows: args.free_cash_flows,
          discountRate: args.discount_rate,
          terminal,
          ...(args.net_debt === undefined ? {} : { netDebt: args.net_debt }),
          ...(args.shares_outstanding === undefined ? {} : { sharesOutstanding: args.shares_outstanding }),
        })) as never
      },
    }),
    defineTool({
      name: 'finance_dcf_sensitivity',
      description: 'Compute a two-dimensional DCF sensitivity grid. Invalid Gordon-growth cells where growth is at or above WACC return null.',
      parameters: {
        free_cash_flows: { type: 'array', items: { type: 'number' }, required: true },
        discount_rates: { type: 'array', items: { type: 'number' }, required: true },
        terminal_method: { type: 'string', enum: ['gordon-growth', 'exit-multiple'], required: true },
        terminal_growth_rates: { type: 'array', items: { type: 'number' } },
        terminal_ebitda: { type: 'number' },
        terminal_ebitda_multiples: { type: 'array', items: { type: 'number' } },
        net_debt: { type: 'number' },
        shares_outstanding: { type: 'number' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const terminal = args.terminal_method === 'gordon-growth'
          ? { method: 'gordon-growth' as const, terminalGrowthRates: args.terminal_growth_rates as number[] }
          : {
              method: 'exit-multiple' as const,
              terminalEbitda: args.terminal_ebitda as number,
              terminalEbitdaMultiples: args.terminal_ebitda_multiples as number[],
            }
        return jsonSafe(calculateDcfSensitivity({
          freeCashFlows: args.free_cash_flows,
          discountRates: args.discount_rates,
          terminal,
          ...(args.net_debt === undefined ? {} : { netDebt: args.net_debt }),
          ...(args.shares_outstanding === undefined ? {} : { sharesOutstanding: args.shares_outstanding }),
        })) as never
      },
    }),
    defineTool({
      name: 'finance_relative_valuation',
      description: 'Pure relative-valuation calculation using caller-supplied target fundamentals and explicit peer multiples. Returns per-method implied values without pretending peer selection is valid.',
      parameters: {
        target: { type: 'object', additionalProperties: true, required: true },
        peer_multiples: { type: 'object', additionalProperties: true, required: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return jsonSafe(calculateRelativeValuation({
          target: args.target as never,
          peerMultiples: args.peer_multiples as never,
        })) as never
      },
    }),
  ]
}

export const name = 'finance-tools'
export const inject = ['tools']

declare module '@deepseek-ai/cordis' {
  interface Context {
    financeTools: true
  }
}

export function apply(ctx: Context): void {
  const provider = createYFinanceProvider()
  for (const tool of createFinanceTools(provider)) ctx.tools.register(tool)
  ctx.provide('financeTools', true)
}
