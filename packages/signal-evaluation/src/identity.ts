import { deepFreeze, stableHash, type JsonObject } from '@finance2dsh/strategy-core'

import type {
  CalibrationBucketDimensions,
  CalibrationSnapshot,
  SignalFeedback,
  SignalFeedbackInput,
  SignalLifecycleEvent,
  SignalLifecycleEventInput,
  SignalOutcomeRevision,
  SignalOutcomeRevisionInput,
} from './contracts.js'

function frozen<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

export function lifecycleEventId(input: Omit<SignalLifecycleEvent, 'id'>): string {
  return stableHash(input)
}

export function createLifecycleEvent(input: SignalLifecycleEventInput): SignalLifecycleEvent {
  const { id, ...semantic } = input
  const expected = lifecycleEventId(semantic)
  if (id !== undefined && id !== expected) throw new TypeError(`lifecycle event id mismatch: expected ${expected}`)
  return frozen({ id: expected, ...semantic })
}

export function outcomeRevisionId(input: Omit<SignalOutcomeRevision, 'id'>): string {
  return stableHash(input)
}

export function createOutcomeRevision(
  input: SignalOutcomeRevisionInput,
  revision: number,
): SignalOutcomeRevision {
  const semantic = { ...input, revision }
  return frozen({ id: outcomeRevisionId(semantic), ...semantic })
}

export function feedbackId(input: Omit<SignalFeedback, 'id'>): string {
  return stableHash(input)
}

export function createSignalFeedback(input: SignalFeedbackInput): SignalFeedback {
  const { id, ...semantic } = input
  const expected = feedbackId(semantic)
  if (id !== undefined && id !== expected) throw new TypeError(`signal feedback id mismatch: expected ${expected}`)
  return frozen({ id: expected, ...semantic })
}

export function calibrationBucketId(dimensions: CalibrationBucketDimensions): string {
  return stableHash(dimensions)
}

export function calibrationSnapshotId(snapshot: Omit<CalibrationSnapshot, 'id'>): string {
  return stableHash(snapshot as unknown as JsonObject)
}
