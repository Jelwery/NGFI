import fs from 'node:fs'
import path from 'node:path'

import { canonicalJson, deepFreeze, type SignalObservation } from '@finance2dsh/strategy-core'

import type {
  AppendRecordResult,
  SignalFeedback,
  SignalFeedbackInput,
  SignalLedger,
  SignalLedgerSnapshot,
  SignalLifecycleEvent,
  SignalLifecycleEventInput,
  SignalLifecycleProjection,
  SignalOutcomeHorizon,
  SignalOutcomeRevision,
  SignalOutcomeRevisionInput,
} from './contracts.js'
import { createLifecycleEvent, createOutcomeRevision, createSignalFeedback } from './identity.js'
import { projectSignalLifecycle } from './lifecycle.js'
import {
  SignalEvaluationError,
  assertLifecycleEvent,
  assertObservation,
  assertOutcomeRevision,
  assertSignalFeedback,
} from './validation.js'

function immutable<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export class InMemorySignalLedger implements SignalLedger {
  readonly #observations = new Map<string, SignalObservation>()
  readonly #events: SignalLifecycleEvent[] = []
  readonly #outcomes: SignalOutcomeRevision[] = []
  readonly #feedback: SignalFeedback[] = []

  constructor(seed?: SignalLedgerSnapshot) {
    if (seed === undefined) return
    for (const observation of seed.observations) this.appendObservation(observation)
    for (const event of seed.lifecycleEvents) this.appendLifecycleEvent(event)
    for (const outcome of seed.outcomeRevisions) this.#restoreOutcome(outcome)
    for (const item of seed.feedback) this.appendFeedback(item)
  }

  appendObservation(observation: SignalObservation): AppendRecordResult<SignalObservation> {
    assertObservation(observation)
    const record = immutable(observation)
    const existing = this.#observations.get(record.id)
    if (existing !== undefined) {
      if (!same(existing, record)) throw new SignalEvaluationError('conflict', `observation id conflict: ${record.id}`)
      return { appended: false, record: existing }
    }
    this.#observations.set(record.id, record)
    return { appended: true, record }
  }

  appendLifecycleEvent(input: SignalLifecycleEventInput): AppendRecordResult<SignalLifecycleEvent> {
    const event = createLifecycleEvent(input)
    assertLifecycleEvent(event)
    const existing = this.#events.find(item => item.id === event.id)
    if (existing !== undefined) {
      if (!same(existing, event)) throw new SignalEvaluationError('conflict', `lifecycle event id conflict: ${event.id}`)
      return { appended: false, record: existing }
    }
    const observation = this.#requiredObservation(event.observationId)
    const events = this.#events.filter(item => item.observationId === event.observationId)
    projectSignalLifecycle(event.observationId, observation.availableAt, [...events, event])
    this.#events.push(event)
    return { appended: true, record: event }
  }

  appendOutcomeRevision(input: SignalOutcomeRevisionInput): AppendRecordResult<SignalOutcomeRevision> {
    this.#requiredObservation(input.observationId)
    const revisions = this.#outcomes.filter(item => item.observationId === input.observationId && item.horizon === input.horizon)
    const latest = revisions.at(-1)
    if (latest !== undefined) {
      const { id: _id, revision: _revision, ...latestInput } = latest
      if (same(latestInput, input)) return { appended: false, record: latest }
    }
    const record = createOutcomeRevision(input, revisions.length + 1)
    assertOutcomeRevision(record)
    this.#outcomes.push(record)
    return { appended: true, record }
  }

  #restoreOutcome(outcome: SignalOutcomeRevision): void {
    assertOutcomeRevision(outcome)
    this.#requiredObservation(outcome.observationId)
    const revisions = this.#outcomes.filter(item => item.observationId === outcome.observationId && item.horizon === outcome.horizon)
    const duplicate = this.#outcomes.find(item => item.id === outcome.id)
    if (duplicate !== undefined) {
      if (!same(duplicate, outcome)) throw new SignalEvaluationError('conflict', `outcome id conflict: ${outcome.id}`)
      return
    }
    if (outcome.revision !== revisions.length + 1) {
      throw new SignalEvaluationError('corrupt', `non-sequential outcome revision for ${outcome.observationId}/${outcome.horizon}`)
    }
    this.#outcomes.push(immutable(outcome))
  }

  appendFeedback(input: SignalFeedbackInput): AppendRecordResult<SignalFeedback> {
    const record = createSignalFeedback(input)
    assertSignalFeedback(record)
    this.#requiredObservation(record.observationId)
    const existing = this.#feedback.find(item => item.id === record.id)
    if (existing !== undefined) {
      if (!same(existing, record)) throw new SignalEvaluationError('conflict', `feedback id conflict: ${record.id}`)
      return { appended: false, record: existing }
    }
    this.#feedback.push(record)
    return { appended: true, record }
  }

  getObservation(observationId: string): SignalObservation | undefined {
    return this.#observations.get(observationId)
  }

  projectLifecycle(observationId: string): SignalLifecycleProjection | undefined {
    const observation = this.#observations.get(observationId)
    if (observation === undefined) return undefined
    return projectSignalLifecycle(
      observationId,
      observation.availableAt,
      this.#events.filter(event => event.observationId === observationId),
    )
  }

  outcomesFor(observationId: string, horizon?: SignalOutcomeHorizon): readonly SignalOutcomeRevision[] {
    return this.#outcomes.filter(item => item.observationId === observationId && (horizon === undefined || item.horizon === horizon))
  }

  latestOutcomes(): readonly SignalOutcomeRevision[] {
    const latest = new Map<string, SignalOutcomeRevision>()
    for (const outcome of this.#outcomes) latest.set(`${outcome.observationId}:${outcome.horizon}`, outcome)
    return [...latest.values()]
  }

  snapshot(): SignalLedgerSnapshot {
    return immutable({
      observations: [...this.#observations.values()],
      lifecycleEvents: this.#events,
      outcomeRevisions: this.#outcomes,
      feedback: this.#feedback,
    })
  }

  #requiredObservation(id: string): SignalObservation {
    const observation = this.#observations.get(id)
    if (observation === undefined) throw new SignalEvaluationError('not-found', `observation not found: ${id}`)
    return observation
  }
}

const FILES = {
  observations: 'observations.jsonl', lifecycleEvents: 'lifecycle-events.jsonl',
  outcomeRevisions: 'outcome-revisions.jsonl', feedback: 'feedback.jsonl',
} as const

function safeRoot(directory: string): string {
  const root = path.resolve(directory)
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
    throw new SignalEvaluationError('invalid', `ledger root must not be a symlink: ${root}`)
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

function readJsonLines(root: string, filename: string): unknown[] {
  const target = path.join(root, filename)
  if (!fs.existsSync(target)) return []
  if (fs.lstatSync(target).isSymbolicLink()) throw new SignalEvaluationError('corrupt', `ledger file is a symlink: ${filename}`)
  const text = fs.readFileSync(target, 'utf8')
  if (text.length === 0) return []
  if (!text.endsWith('\n')) throw new SignalEvaluationError('corrupt', `${filename} has a partial final line`)
  return text.slice(0, -1).split('\n').map((line, index) => {
    try { return JSON.parse(line) as unknown } catch (error) {
      throw new SignalEvaluationError('corrupt', `${filename}:${index + 1} is invalid JSON`, { cause: error })
    }
  })
}

function appendJsonLine(root: string, filename: string, record: unknown): void {
  const target = path.join(root, filename)
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new SignalEvaluationError('corrupt', `ledger file is a symlink: ${filename}`)
  }
  fs.appendFileSync(target, `${canonicalJson(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
}

export class FileSignalLedger implements SignalLedger {
  readonly #root: string

  constructor(directory: string) {
    this.#root = safeRoot(directory)
    this.#load()
  }

  appendObservation(observation: SignalObservation): AppendRecordResult<SignalObservation> {
    return this.#mutate(FILES.observations, ledger => ledger.appendObservation(observation))
  }

  appendLifecycleEvent(input: SignalLifecycleEventInput): AppendRecordResult<SignalLifecycleEvent> {
    return this.#mutate(FILES.lifecycleEvents, ledger => ledger.appendLifecycleEvent(input))
  }

  appendOutcomeRevision(input: SignalOutcomeRevisionInput): AppendRecordResult<SignalOutcomeRevision> {
    return this.#mutate(FILES.outcomeRevisions, ledger => ledger.appendOutcomeRevision(input))
  }

  appendFeedback(input: SignalFeedbackInput): AppendRecordResult<SignalFeedback> {
    return this.#mutate(FILES.feedback, ledger => ledger.appendFeedback(input))
  }

  getObservation(observationId: string): SignalObservation | undefined { return this.#load().getObservation(observationId) }
  projectLifecycle(observationId: string): SignalLifecycleProjection | undefined { return this.#load().projectLifecycle(observationId) }
  outcomesFor(observationId: string, horizon?: SignalOutcomeHorizon): readonly SignalOutcomeRevision[] {
    return this.#load().outcomesFor(observationId, horizon)
  }
  latestOutcomes(): readonly SignalOutcomeRevision[] { return this.#load().latestOutcomes() }
  snapshot(): SignalLedgerSnapshot { return this.#load().snapshot() }

  #load(): InMemorySignalLedger {
    const observations = readJsonLines(this.#root, FILES.observations)
    const lifecycleEvents = readJsonLines(this.#root, FILES.lifecycleEvents)
    const outcomeRevisions = readJsonLines(this.#root, FILES.outcomeRevisions)
    const feedback = readJsonLines(this.#root, FILES.feedback)
    return new InMemorySignalLedger({
      observations: observations as SignalObservation[],
      lifecycleEvents: lifecycleEvents as SignalLifecycleEvent[],
      outcomeRevisions: outcomeRevisions as SignalOutcomeRevision[],
      feedback: feedback as SignalFeedback[],
    })
  }

  #mutate<T>(
    filename: string,
    operation: (ledger: InMemorySignalLedger) => AppendRecordResult<T>,
  ): AppendRecordResult<T> {
    const lockPath = path.join(this.#root, '.ledger.lock')
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      throw new SignalEvaluationError('locked', 'signal ledger is locked by another writer', { cause: error })
    }
    try {
      const ledger = this.#load()
      const result = operation(ledger)
      if (result.appended) appendJsonLine(this.#root, filename, result.record)
      return result
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
    }
  }
}
