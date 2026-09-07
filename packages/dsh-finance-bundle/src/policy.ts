import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  PORTFOLIO_TOOL_NAMES, RESEARCH_TOOL_NAMES, SIGNAL_TOOL_NAMES, STRATEGY_TOOL_NAMES,
} from '@finance2dsh/dsh-tools'

export const name = 'finance-agent-policy'
export const inject = ['financeTools', 'tools']

export const FINANCE_TOOL_ALLOWLIST = [
  'skill',
  'finance_behavior_reference',
  'finance_behavior_market_evidence',
  'finance_behavior_trade_audit',
  'finance_security_reference',
  'finance_fundamentals',
  'finance_market_data',
  'finance_estimates',
  'finance_comparables',
  'finance_wacc',
  'finance_dcf',
  'finance_dcf_sensitivity',
  'finance_relative_valuation',
  'finance_data_catalog',
  'finance_cn_instrument',
  'finance_cn_quote',
  'finance_cn_bars',
  'finance_cn_fundamentals',
  'finance_cn_disclosures',
  'finance_cn_market_activity',
  'finance_cn_macro_index',
] as const

export const COMPANY_RESEARCH_TOOL_ALLOWLIST = [
  ...FINANCE_TOOL_ALLOWLIST,
  ...RESEARCH_TOOL_NAMES,
] as const

export const STRATEGY_RESEARCH_TOOL_ALLOWLIST = [
  ...FINANCE_TOOL_ALLOWLIST,
  ...STRATEGY_TOOL_NAMES,
  ...SIGNAL_TOOL_NAMES,
] as const

export const PORTFOLIO_RISK_TOOL_ALLOWLIST = [
  ...FINANCE_TOOL_ALLOWLIST,
  ...PORTFOLIO_TOOL_NAMES,
] as const

export const PRESET_TOOL_ALLOWLISTS = {
  'finance-analyst': FINANCE_TOOL_ALLOWLIST,
  'company-research': COMPANY_RESEARCH_TOOL_ALLOWLIST,
  'strategy-research': STRATEGY_RESEARCH_TOOL_ALLOWLIST,
  'portfolio-risk': PORTFOLIO_RISK_TOOL_ALLOWLIST,
} as const

export interface Config { preset?: keyof typeof PRESET_TOOL_ALLOWLISTS }

export function apply(ctx: Context, config: Config = {}): void {
  const preset = config.preset ?? 'finance-analyst'
  const allow = PRESET_TOOL_ALLOWLISTS[preset]
  if (allow === undefined) throw new TypeError(`unknown finance policy preset: ${String(preset)}`)
  ctx.tools.restrict({ allow })
}
