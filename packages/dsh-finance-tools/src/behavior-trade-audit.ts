import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { calculateBehaviorTradeAudit } from '@finance2dsh/core'

const TRADE_PROPERTIES = {
  id: { type: 'string' as const, required: true as const },
  ticker: { type: 'string' as const, required: true as const },
  opened_at: { type: 'string' as const, required: true as const, description: 'ISO date or timestamp.' },
  closed_at: { type: 'string' as const, required: true as const, description: 'ISO date or timestamp.' },
  entry_price: { type: 'number' as const, required: true as const },
  exit_price: { type: 'number' as const, required: true as const },
  side: { type: 'string' as const, enum: ['long', 'short'] as const },
  quantity: { type: 'number' as const },
  fees: { type: 'number' as const },
  rationale: { type: 'string' as const },
  planned_horizon_days: { type: 'number' as const },
  confidence: { type: 'number' as const, description: 'Ex-ante confidence from 0 to 1.' },
  rule_followed: { type: 'boolean' as const },
}

const OPPORTUNITY_PROPERTIES = {
  id: { type: 'string' as const, required: true as const },
  observed_at: { type: 'string' as const, required: true as const, description: 'Sale date as an ISO date or timestamp.' },
  realized_gains: { type: 'integer' as const, required: true as const },
  realized_losses: { type: 'integer' as const, required: true as const },
  paper_gains: { type: 'integer' as const, required: true as const },
  paper_losses: { type: 'integer' as const, required: true as const },
}

export function createBehaviorTradeAuditTool(): ToolDefinition {
  return defineTool({
    name: 'finance_behavior_trade_audit',
    description: 'Audit normalized completed trades using descriptive return, holding-period, completeness, fee, rule-adherence and uncertainty statistics. For behavioral interpretation, first load investment-behavior-diagnosis with the skill tool. Report the sample start/end dates and completeness as well as group statistics. This pure tool performs no account access or storage. PGR/PLR are calculated only when complete sale-date opportunity counts and an explicit lot-matching assumption are supplied; output does not diagnose a psychological cause.',
    parameters: {
      records: {
        type: 'array',
        required: true,
        items: { type: 'object', properties: TRADE_PROPERTIES, additionalProperties: false },
        description: 'Normalized completed trades. Each record must have a unique id.',
      },
      opportunity_sets: {
        type: 'array',
        items: { type: 'object', properties: OPPORTUNITY_PROPERTIES, additionalProperties: false },
        description: 'Optional complete realized and paper gain/loss opportunity counts for each included sale date.',
      },
      lot_matching_assumption: { type: 'string', description: 'Required for PGR/PLR, for example FIFO, LIFO, or specific-lot.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return calculateBehaviorTradeAudit({
        records: args.records.map(record => ({
          id: record.id,
          ticker: record.ticker,
          openedAt: record.opened_at,
          closedAt: record.closed_at,
          entryPrice: record.entry_price,
          exitPrice: record.exit_price,
          ...(record.side === undefined ? {} : { side: record.side }),
          ...(record.quantity === undefined ? {} : { quantity: record.quantity }),
          ...(record.fees === undefined ? {} : { fees: record.fees }),
          ...(record.rationale === undefined ? {} : { rationale: record.rationale }),
          ...(record.planned_horizon_days === undefined ? {} : { plannedHorizonDays: record.planned_horizon_days }),
          ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
          ...(record.rule_followed === undefined ? {} : { ruleFollowed: record.rule_followed }),
        })),
        ...(args.opportunity_sets === undefined ? {} : {
          opportunitySets: args.opportunity_sets.map(item => ({
            id: item.id,
            observedAt: item.observed_at,
            realizedGains: item.realized_gains,
            realizedLosses: item.realized_losses,
            paperGains: item.paper_gains,
            paperLosses: item.paper_losses,
          })),
        }),
        ...(args.lot_matching_assumption === undefined ? {} : { lotMatchingAssumption: args.lot_matching_assumption }),
      }) as never
    },
  })
}
