import type {
  SignalLifecycleEvent,
  SignalLifecycleProjection,
  SignalLifecycleState,
} from './contracts.js'
import { SignalEvaluationError } from './validation.js'

const TRANSITIONS: Readonly<Record<SignalLifecycleState, readonly SignalLifecycleState[]>> = {
  observed: ['qualified', 'retired'],
  qualified: ['watching', 'tradeable', 'retired'],
  watching: ['tradeable', 'retired'],
  tradeable: ['watching', 'retired'],
  retired: [],
}

export function assertLifecycleTransition(from: SignalLifecycleState, to: SignalLifecycleState): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new SignalEvaluationError('transition', `invalid lifecycle transition: ${from} -> ${to}`)
  }
}

export function projectSignalLifecycle(
  observationId: string,
  observedAt: string,
  events: readonly SignalLifecycleEvent[],
): SignalLifecycleProjection {
  let state: SignalLifecycleState = 'observed'
  let updatedAt = observedAt
  let latestEventId: string | null = null
  let previousTime = Date.parse(observedAt)
  for (const event of events) {
    if (event.observationId !== observationId) {
      throw new SignalEvaluationError('invalid', 'lifecycle event belongs to another observation')
    }
    const eventTime = Date.parse(event.occurredAt)
    if (eventTime < previousTime) {
      throw new SignalEvaluationError('transition', 'lifecycle events must not move backwards in time')
    }
    assertLifecycleTransition(state, event.type)
    state = event.type
    updatedAt = event.occurredAt
    latestEventId = event.id
    previousTime = eventTime
  }
  return Object.freeze({ observationId, state, eventCount: events.length, latestEventId, updatedAt })
}
