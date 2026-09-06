import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { canonicalJson, compareThesisSnapshots, researchCaseId, validateEvidence, type ThesisSnapshot } from '@finance2dsh/research-core'
import { auditResearchReport, type ResearchAuditInput } from '@finance2dsh/research-audit'
import {
  ResearchWorkspace,
  ResearchWorkspaceError,
  createSnapshot,
  seedFrozenReplay,
  verifyFrozenReplay,
  verifySnapshot,
} from '@finance2dsh/research-workspace'
import {
  COMPANY_RESEARCH_V1,
  loadFrozenEvidenceDossier,
  runWorkflow,
  startAdversarialReview,
  type AdversarialChatExecutor,
  type StageResult,
  type WorkflowRunState,
} from '@finance2dsh/research-workflow'
import {
  atomicJsonWrite, containedPath, ensurePlainDirectory, readJsonFile, requireRuntimeId, strictTool,
} from './runtime-store.js'

export const RESEARCH_TOOL_NAMES = [
  'finance_research_case',
  'finance_research_ledger',
  'finance_research_snapshot',
  'finance_research_workflow',
  'finance_research_audit',
  'finance_thesis_drift',
  'finance_adversarial_review',
] as const

export interface ResearchToolOptions {
  runtimeRoot: string
  adversarialExecutor?: AdversarialChatExecutor
}

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function jsonSafe(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never
}

function workspace(options: ResearchToolOptions, id: unknown): ResearchWorkspace {
  const root = containedPath(options.runtimeRoot, 'research', requireRuntimeId(id, 'workspace_id'))
  ensurePlainDirectory(root)
  return new ResearchWorkspace({ root })
}

function caseId(value: unknown): string {
  if (typeof value !== 'string' || !/^case-[0-9a-f]{64}$/u.test(value)) throw new TypeError('case_id must be a canonical research case id')
  return value
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('expected_revision must be a non-negative integer')
  return value as number
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

function researchPaths(options: ResearchToolOptions, workspaceId: unknown, snapshotId: unknown) {
  const workspaceName = requireRuntimeId(workspaceId, 'workspace_id')
  const snapshotName = requireRuntimeId(snapshotId, 'snapshot_id')
  return {
    workspace: workspace(options, workspaceName),
    snapshot: containedPath(options.runtimeRoot, 'research-snapshots', workspaceName, snapshotName),
    replay: containedPath(options.runtimeRoot, 'research-replays', workspaceName, snapshotName),
  }
}

function isWorkspaceError(error: unknown, code: string): error is ResearchWorkspaceError {
  return error instanceof ResearchWorkspaceError && error.code === code
}

export function createResearchTools(options: ResearchToolOptions): ToolDefinition[] {
  return [
    defineTool({
      name: 'finance_research_case',
      description: 'Create, open, update, or archive one case inside an explicitly named NGFI runtime research workspace. Updates require the exact current revision.',
      parameters: {
        action: { type: 'string', enum: ['create', 'open', 'update', 'archive'], required: true },
        workspace_id: { type: 'string', required: true },
        case_id: { type: 'string' },
        expected_revision: { type: 'integer' },
        subject: { type: 'object', additionalProperties: true },
        mandate: { type: 'string' },
        as_of: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'active', 'completed'] },
        created_at: { type: 'string', description: 'Required for create; optional seeded_at override for replay seeding.' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const store = workspace(options, args.workspace_id)
        if (args.action === 'create') {
          const createdAt = new Date(text(args.created_at, 'created_at')).toISOString()
          const input = {
            subject: record(args.subject, 'subject') as never, mandate: text(args.mandate, 'mandate'),
            asOf: text(args.as_of, 'as_of'), status: args.status ?? 'draft', createdAt,
          }
          try { return jsonSafe(store.create(input)) } catch (error) {
            if (!isWorkspaceError(error, 'already-exists')) throw error
            const id = researchCaseId(input)
            return jsonSafe(store.open(id))
          }
        }
        const id = caseId(args.case_id)
        if (args.action === 'open') return jsonSafe(store.open(id))
        const expected = revision(args.expected_revision)
        if (args.action === 'archive') return jsonSafe(store.archive(id, expected))
        if (args.status === undefined) throw new TypeError('status is required for update')
        return jsonSafe(store.update(id, expected, { status: args.status }))
      },
    }),
    defineTool({
      name: 'finance_research_ledger',
      description: 'Append or save validated research evidence, assumptions, claims, model runs, decisions, memo text, immutable run artifacts, or terminal run manifests. Every mutation is bound to workspace_id, case_id, and expected_revision.',
      parameters: {
        action: {
          type: 'string',
          enum: [
            'append-evidence', 'append-decision', 'save-assumptions', 'save-claims',
            'save-model-run', 'save-memo', 'write-artifact', 'save-run-manifest',
          ],
          required: true,
        },
        workspace_id: { type: 'string', required: true },
        case_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
        payload: { type: 'object', additionalProperties: true },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        memo: { type: 'string' },
        artifact_path: { type: 'string' },
        artifact_content: { type: 'string' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const store = workspace(options, args.workspace_id)
        const id = caseId(args.case_id)
        const expected = revision(args.expected_revision)
        if (args.action === 'append-evidence') {
          const items = array(args.items, 'items')
          try { return jsonSafe(store.appendEvidence(id, expected, items as never)) } catch (error) {
            if (!isWorkspaceError(error, 'duplicate-entry')) throw error
            const current = store.open(id)
            const existing = new Map(current.evidence.map(item => [item.id, item]))
            const replay = items.map(validateEvidence)
            if (!replay.every(item => canonicalJson(existing.get(item.id)) === canonicalJson(item))) throw error
            return jsonSafe({ revision: current.revision, changed: false, appendedIds: [] })
          }
        }
        if (args.action === 'append-decision') {
          try { return jsonSafe(store.appendDecision(id, expected, record(args.payload, 'payload') as never)) } catch (error) {
            if (!isWorkspaceError(error, 'duplicate-entry')) throw error
            return jsonSafe({ revision: store.open(id).revision, changed: false, appendedIds: [] })
          }
        }
        if (args.action === 'save-assumptions') return jsonSafe(store.saveAssumptions(id, expected, array(args.items, 'items') as never))
        if (args.action === 'save-claims') return jsonSafe(store.saveClaims(id, expected, array(args.items, 'items') as never))
        if (args.action === 'save-model-run') return jsonSafe(store.saveModelRun(id, expected, record(args.payload, 'payload') as never))
        if (args.action === 'save-memo') return jsonSafe(store.saveMemo(id, expected, text(args.memo, 'memo')))
        if (args.action === 'write-artifact') {
          return jsonSafe(store.writeArtifact(
            id, expected, text(args.artifact_path, 'artifact_path'), text(args.artifact_content, 'artifact_content'),
          ))
        }
        return jsonSafe(store.saveRunManifest(id, expected, record(args.payload, 'payload') as never))
      },
    }),
    defineTool({
      name: 'finance_research_snapshot',
      description: 'Create, verify, seed, or verify a frozen replay using bounded runtime identifiers. Snapshot manifests and every file hash are verified before use.',
      parameters: {
        action: { type: 'string', enum: ['create', 'verify', 'seed', 'verify-seeded'], required: true },
        workspace_id: { type: 'string', required: true },
        snapshot_id: { type: 'string', required: true },
        case_id: { type: 'string' },
        run_id: { type: 'string' },
        created_at: { type: 'string' },
        receipt: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const paths = researchPaths(options, args.workspace_id, args.snapshot_id)
        if (args.action === 'create') {
          const requestedCase = caseId(args.case_id)
          const requestedRun = text(args.run_id, 'run_id')
          if (existsSync(paths.snapshot)) {
            const existing = verifySnapshot(paths.snapshot)
            if (existing.caseId !== requestedCase || existing.sourceRunId !== requestedRun) {
              throw new Error('snapshot_id already identifies a different case or run')
            }
            return jsonSafe(existing)
          }
          return jsonSafe(createSnapshot({
            workspace: paths.workspace, caseId: requestedCase, runId: requestedRun,
            destination: paths.snapshot, ...(args.created_at === undefined ? {} : { createdAt: args.created_at }),
          }))
        }
        if (args.action === 'verify') return jsonSafe(verifySnapshot(paths.snapshot))
        if (args.action === 'seed') {
          const receiptPath = join(paths.replay, '_seed-receipt.json')
          if (existsSync(receiptPath)) {
            const receipt = readJsonFile(receiptPath, null)
            const snapshot = verifySnapshot(paths.snapshot)
            if (record(receipt, 'stored receipt').sourceTreeHash !== snapshot.treeHash) {
              throw new Error('stored replay receipt does not match the frozen snapshot')
            }
            verifyFrozenReplay(paths.replay, receipt as never)
            return jsonSafe(receipt)
          }
          const receipt = seedFrozenReplay(paths.snapshot, paths.replay, args.created_at)
          atomicJsonWrite(receiptPath, receipt)
          return jsonSafe(receipt)
        }
        return jsonSafe(verifyFrozenReplay(paths.replay, record(args.receipt, 'receipt') as never))
      },
    }),
    defineTool({
      name: 'finance_research_workflow',
      description: 'Run or resume the deterministic company-research-v1 state machine from an explicit case state and stage-result map. Completion is impossible unless the report audit passes.',
      parameters: {
        action: { type: 'string', enum: ['run', 'resume'], required: true },
        workspace_id: { type: 'string', required: true },
        case_id: { type: 'string', required: true },
        stage_results: { type: 'object', additionalProperties: true, required: true },
        resume: { type: 'object', additionalProperties: true },
        audit: { type: 'object', additionalProperties: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const supplied = record(args.stage_results, 'stage_results')
        const caseState = workspace(options, args.workspace_id).open(caseId(args.case_id))
        const state = await runWorkflow({
          definition: COMPANY_RESEARCH_V1,
          caseState,
          ...(args.action === 'resume' ? { resume: record(args.resume, 'resume') as unknown as WorkflowRunState } : {}),
          ...(args.audit === undefined ? {} : { audit: record(args.audit, 'audit') as never }),
          executor: ({ stage }) => {
            const result = supplied[stage.id]
            if (result === undefined) throw new Error(`missing supplied result for stage ${stage.id}`)
            return result as unknown as StageResult
          },
        })
        return jsonSafe(state)
      },
    }),
    defineTool({
      name: 'finance_research_audit',
      description: 'Run the deterministic report gate for citations, number fidelity, calculation closure, source conflicts, sections, gaps, and terminal status.',
      parameters: { input: { type: 'object', additionalProperties: true, required: true } },
      output: JSON_OUTPUT,
      async execute(args) { return jsonSafe(auditResearchReport(record(args.input, 'input') as unknown as ResearchAuditInput)) },
    }),
    defineTool({
      name: 'finance_thesis_drift',
      description: 'Compare validated structured thesis snapshots. Business claims cannot drift from price-only or wording-only changes.',
      parameters: {
        baseline: { type: 'object', additionalProperties: true },
        current: { type: 'object', additionalProperties: true, required: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return jsonSafe(compareThesisSnapshots(
          args.baseline === undefined ? undefined : record(args.baseline, 'baseline') as unknown as ThesisSnapshot,
          record(args.current, 'current') as unknown as ThesisSnapshot,
        ))
      },
    }),
    defineTool({
      name: 'finance_adversarial_review',
      description: 'Run isolated bull, bear, rebuttal, and neutral adjudication sessions over one verified frozen replay. Every role sees only its declared inputs and has no tools.',
      parameters: {
        workspace_id: { type: 'string', required: true },
        snapshot_id: { type: 'string', required: true },
        review_id: { type: 'string', required: true },
        max_characters: { type: 'integer' },
      },
      output: JSON_OUTPUT,
      timeoutMs: 10 * 60_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        if (options.adversarialExecutor === undefined) throw new Error('adversarial DSH executor is unavailable')
        const paths = researchPaths(options, args.workspace_id, args.snapshot_id)
        const dossier = loadFrozenEvidenceDossier({
          snapshotDirectory: paths.snapshot,
          ...(args.max_characters === undefined ? {} : { maxCharacters: args.max_characters }),
        })
        const result = await startAdversarialReview({
          id: requireRuntimeId(args.review_id, 'review_id'), dossier, executor: options.adversarialExecutor,
        }).runToCompletion()
        return jsonSafe(result)
      },
    }),
  ].map(strictTool)
}
