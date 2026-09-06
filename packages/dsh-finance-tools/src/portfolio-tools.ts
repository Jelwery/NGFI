import { join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  Cne6PortfolioRiskFacade,
  InMemoryHoldingsStore,
  importHoldingsCsv,
  importHoldingsJson,
  type HoldingsImportContext,
  type HoldingsStore,
} from '@finance2dsh/portfolio-risk'
import { atomicJsonWrite, containedPath, ensurePlainDirectory, readJsonFile, requireRuntimeId, strictTool, withExclusiveLock } from './runtime-store.js'

export const PORTFOLIO_TOOL_NAMES = [
  'finance_holdings',
  'finance_portfolio_risk',
] as const

export interface PortfolioToolOptions { runtimeRoot: string }

type HoldingsEvent =
  | { action: 'stage'; format: 'json' | 'csv'; text: string; context: HoldingsImportContext }
  | { action: 'confirm'; expectedSnapshotHash: `sha256:${string}` }
  | { action: 'discard' }
interface HoldingsState { schemaVersion: 1; events: HoldingsEvent[] }

const EMPTY_STATE: HoldingsState = { schemaVersion: 1, events: [] }
const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function jsonSafe(value: unknown): never { return JSON.parse(JSON.stringify(value)) as never }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}
function target(options: PortfolioToolOptions, workspaceId: unknown, portfolioId: unknown) {
  const directory = containedPath(
    options.runtimeRoot, 'portfolios', requireRuntimeId(workspaceId, 'workspace_id'), requireRuntimeId(portfolioId, 'portfolio_id'),
  )
  ensurePlainDirectory(directory)
  return { directory, state: join(directory, 'state.json') }
}
function importEvent(event: Extract<HoldingsEvent, { action: 'stage' }>) {
  return event.format === 'json'
    ? importHoldingsJson(event.text, event.context)
    : importHoldingsCsv(event.text, event.context)
}
function load(path: string): { state: HoldingsState; store: HoldingsStore } {
  const state = readJsonFile(path, EMPTY_STATE)
  if (state.schemaVersion !== 1 || !Array.isArray(state.events)) throw new TypeError('holdings runtime state is corrupt')
  const store = new InMemoryHoldingsStore()
  for (const event of state.events) {
    const revision = store.snapshot().revision
    if (event.action === 'stage') {
      const imported = importEvent(event)
      if (imported.status !== 'ready') throw new TypeError('holdings runtime state contains an invalid import')
      const result = store.stage(imported, revision)
      if (!result.changed) throw new TypeError('holdings runtime state contains a redundant stage event')
    } else if (event.action === 'confirm') {
      store.confirm(revision, event.expectedSnapshotHash)
    } else if (event.action === 'discard') {
      const result = store.discard(revision)
      if (!result.changed) throw new TypeError('holdings runtime state contains a redundant discard event')
    } else {
      throw new TypeError('holdings runtime state contains an unknown event')
    }
  }
  return { state, store }
}

export function createPortfolioTools(options: PortfolioToolOptions): ToolDefinition[] {
  return [
    defineTool({
      name: 'finance_holdings',
      description: 'Import, stage, inspect, explicitly confirm, or discard holdings in a bounded runtime book. Invalid/empty imports are returned as invalid and never staged; writes require exact revision and confirmation hash.',
      parameters: {
        action: { type: 'string', enum: ['inspect', 'stage-json', 'stage-csv', 'confirm', 'discard'], required: true },
        workspace_id: { type: 'string', required: true },
        portfolio_id: { type: 'string', required: true },
        expected_revision: { type: 'integer' },
        as_of: { type: 'string' },
        base_currency: { type: 'string' },
        content: { type: 'string' },
        expected_snapshot_hash: { type: 'string' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const location = target(options, args.workspace_id, args.portfolio_id)
        if (args.action === 'inspect') return jsonSafe(load(location.state).store.snapshot())
        return jsonSafe(withExclusiveLock(location.directory, () => {
          const current = load(location.state)
          const expected = args.expected_revision
          let result
          let event: HoldingsEvent
          if (args.action === 'stage-json' || args.action === 'stage-csv') {
            const context: HoldingsImportContext = {
              portfolioId: requireRuntimeId(args.portfolio_id, 'portfolio_id'),
              asOf: requiredText(args.as_of, 'as_of'), baseCurrency: requiredText(args.base_currency, 'base_currency'),
            }
            event = {
              action: 'stage', format: args.action === 'stage-json' ? 'json' : 'csv',
              text: requiredText(args.content, 'content'), context,
            }
            const imported = importEvent(event)
            if (imported.status !== 'ready') return { revision: current.store.snapshot().revision, changed: false, import: imported }
            result = current.store.stage(imported, expected as number)
          } else if (args.action === 'confirm') {
            event = { action: 'confirm', expectedSnapshotHash: requiredText(args.expected_snapshot_hash, 'expected_snapshot_hash') as `sha256:${string}` }
            const book = current.store.snapshot()
            if (book.staged === null && book.confirmed?.snapshotHash === event.expectedSnapshotHash) {
              if (expected !== book.revision) throw new Error(`holdings revision conflict: expected ${String(expected)}, found ${book.revision}`)
              return { revision: book.revision, changed: false, snapshot: book.confirmed }
            }
            result = current.store.confirm(expected as number, event.expectedSnapshotHash)
          } else {
            event = { action: 'discard' }
            result = current.store.discard(expected as number)
          }
          if (result.changed) atomicJsonWrite(location.state, { schemaVersion: 1, events: [...current.state.events, event] })
          return result
        }))
      },
    }),
    defineTool({
      name: 'finance_portfolio_risk',
      description: 'Calculate CNE6 portfolio, marginal, or factor-scenario risk from explicitly supplied model data and the confirmed holdings snapshot. Staged, unmapped, currency-conflicted, low-coverage, or unreconciled inputs fail closed.',
      parameters: {
        action: { type: 'string', enum: ['snapshot', 'marginal', 'stress'], required: true },
        workspace_id: { type: 'string', required: true },
        portfolio_id: { type: 'string', required: true },
        model: { type: 'object', additionalProperties: true, required: true },
        options: { type: 'object', additionalProperties: true },
        proposal: { type: 'object', additionalProperties: true },
        scenario: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const book = load(target(options, args.workspace_id, args.portfolio_id).state).store.snapshot()
        const holdings = book.confirmed ?? book.staged
        if (holdings === null) throw new Error('holdings are unavailable; stage and confirm an import first')
        const facade = new Cne6PortfolioRiskFacade(
          object(args.model, 'model') as never, args.options === undefined ? {} : object(args.options, 'options'),
        )
        if (args.action === 'snapshot') return jsonSafe(facade.portfolioRisk(holdings))
        if (args.action === 'marginal') return jsonSafe(facade.marginalRisk(holdings, object(args.proposal, 'proposal') as never))
        return jsonSafe(facade.stress(holdings, object(args.scenario, 'scenario') as never))
      },
    }),
  ].map(strictTool)
}
