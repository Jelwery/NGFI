import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

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
] as const

export function apply(ctx: Context): void {
  ctx.tools.restrict({ allow: FINANCE_TOOL_ALLOWLIST })
}
