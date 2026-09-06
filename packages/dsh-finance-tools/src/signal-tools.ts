import { join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  InMemorySignalLedger,
  createCalibrationSnapshot,
  evaluateSignalOutcome,
  type SignalLedgerSnapshot,
} from '@finance2dsh/signal-evaluation'
import type { SignalObservation } from '@finance2dsh/strategy-core'
import {
  atomicJsonWrite, containedPath, ensurePlainDirectory, readJsonFile,
  requireRevision, requireRuntimeId, strictTool, withExclusiveLock,
} from './runtime-store.js'

export const SIGNAL_TOOL_NAMES = [
  'finance_signal_ledger',
  'finance_signal_outcome',
] as const

export interface SignalToolOptions { runtimeRoot: string }

interface SignalState {
  schemaVersion: 1
  revision: number
  ledger: SignalLedgerSnapshot
}

const EMPTY_STATE: SignalState = {
  schemaVersion: 1, revision: 0,
  ledger: { observations: [], lifecycleEvents: [], outcomeRevisions: [], feedback: [] },
}
const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function jsonSafe(value: unknown): never { return JSON.parse(JSON.stringify(value)) as never }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}
function location(options: SignalToolOptions, workspaceId: unknown) {
  const directory = containedPath(options.runtimeRoot, 'signals', requireRuntimeId(workspaceId, 'workspace_id'))
  ensurePlainDirectory(directory)
  return { directory, state: join(directory, 'state.json') }
}
function load(path: string): { state: SignalState; ledger: InMemorySignalLedger } {
  const state = readJsonFile(path, EMPTY_STATE)
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new TypeError('signal runtime state is corrupt')
  }
  return { state, ledger: new InMemorySignalLedger(state.ledger) }
}
function inspect(options: SignalToolOptions, workspaceId: unknown) {
  const target = location(options, workspaceId)
  const current = load(target.state)
  return { revision: current.state.revision, ledger: current.ledger.snapshot() }
}
function mutate<T>(
  options: SignalToolOptions, workspaceId: unknown, expected: unknown,
  operation: (ledger: InMemorySignalLedger) => { appended: boolean; record: T },
) {
  const target = location(options, workspaceId)
  return withExclusiveLock(target.directory, () => {
    const current = load(target.state)
    requireRevision(current.state.revision, expected)
    const result = operation(current.ledger)
    const revision = current.state.revision + (result.appended ? 1 : 0)
    if (result.appended) atomicJsonWrite(target.state, { schemaVersion: 1, revision, ledger: current.ledger.snapshot() })
    return { revision, ...result }
  })
}

export function createSignalTools(options: SignalToolOptions): ToolDefinition[] {
  return [
    defineTool({
      name: 'finance_signal_ledger',
      description: 'Inspect or append an immutable signal observation/lifecycle event in a bounded runtime ledger. Writes use exact revision CAS and domain idempotence; lifecycle transitions fail closed.',
      parameters: {
        action: { type: 'string', enum: ['inspect', 'append-observation', 'append-lifecycle', 'project-lifecycle'], required: true },
        workspace_id: { type: 'string', required: true },
        expected_revision: { type: 'integer' },
        observation: { type: 'object', additionalProperties: true },
        event: { type: 'object', additionalProperties: true },
        observation_id: { type: 'string' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        if (args.action === 'inspect') return jsonSafe(inspect(options, args.workspace_id))
        if (args.action === 'project-lifecycle') {
          const state = inspect(options, args.workspace_id)
          if (typeof args.observation_id !== 'string') throw new TypeError('observation_id is required')
          const projection = new InMemorySignalLedger(state.ledger).projectLifecycle(args.observation_id)
          if (projection === undefined) throw new Error(`observation not found: ${args.observation_id}`)
          return jsonSafe({ revision: state.revision, projection })
        }
        if (args.action === 'append-observation') {
          return jsonSafe(mutate(options, args.workspace_id, args.expected_revision, ledger =>
            ledger.appendObservation(object(args.observation, 'observation') as unknown as SignalObservation)))
        }
        return jsonSafe(mutate(options, args.workspace_id, args.expected_revision, ledger =>
          ledger.appendLifecycleEvent(object(args.event, 'event') as never)))
      },
    }),
    defineTool({
      name: 'finance_signal_outcome',
      description: 'Evaluate and append a new outcome revision for a ledger observation, or compute an evidence-only calibration snapshot. Unfillable/unable and insufficient outputs retain null values.',
      parameters: {
        action: { type: 'string', enum: ['evaluate-and-append', 'calibrate'], required: true },
        workspace_id: { type: 'string', required: true },
        expected_revision: { type: 'integer' },
        observation_id: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        options: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        if (args.action === 'calibrate') {
          const state = inspect(options, args.workspace_id)
          return jsonSafe({
            revision: state.revision,
            snapshot: createCalibrationSnapshot(state.ledger, object(args.options, 'options') as never),
          })
        }
        if (typeof args.observation_id !== 'string') throw new TypeError('observation_id is required')
        const observationId = args.observation_id
        const target = location(options, args.workspace_id)
        return jsonSafe(withExclusiveLock(target.directory, () => {
          const current = load(target.state)
          requireRevision(current.state.revision, args.expected_revision)
          const observation = current.ledger.getObservation(observationId)
          if (observation === undefined) throw new Error(`observation not found: ${observationId}`)
          const outcome = evaluateSignalOutcome({
            ...object(args.input, 'input'), observation,
          } as never)
          const result = current.ledger.appendOutcomeRevision(outcome)
          const revision = current.state.revision + (result.appended ? 1 : 0)
          if (result.appended) atomicJsonWrite(target.state, { schemaVersion: 1, revision, ledger: current.ledger.snapshot() })
          return { revision, ...result }
        }))
      },
    }),
  ].map(strictTool)
}
