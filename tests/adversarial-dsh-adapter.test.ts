import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createDshSessionChatExecutor } from '@finance2dsh/dsh-tools'
import type { AdversarialChatRequest } from '@finance2dsh/research-workflow'

const request = {
  reviewId: 'review-dsh',
  sessionId: 'dsh-bull',
  stage: { id: 'bull', label: 'Bull case', sees: [], prompt: 'Review.' },
  dossier: {} as AdversarialChatRequest['dossier'],
  visibleStages: [],
  message: 'Review the frozen dossier.',
} as AdversarialChatRequest

describe('adversarial DSH session adapter', () => {
  it('creates, flushes and disposes a fresh session while denying every tool', async () => {
    const calls: string[] = []
    const events: unknown[] = []
    const agents = {
      create: async (options: { sessionId: string; setup?: (context: unknown) => Promise<unknown> | unknown }) => {
        calls.push(`create:${options.sessionId}`)
        const tools = {
          presentAs: (mode: string) => calls.push(`present:${mode}`),
          restrict: (filter: { allow?: readonly string[] }) => calls.push(`allow:${JSON.stringify(filter.allow)}`),
          guard: (guard: () => string | undefined) => calls.push(`guard:${guard()}`),
        }
        await options.setup?.({ tools, on: () => () => undefined })
        return {
          agent: {
            session: { id: options.sessionId, seq: 0, events },
            whenIdle: async () => undefined,
            followup: () => events.push(
              { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'Grounded review.' }] } } },
              { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } },
            ),
          },
          dispose: async () => { calls.push(`dispose:${options.sessionId}`) },
        }
      },
    } as unknown as Pick<AgentRegistry, 'create'>
    const sessions = ({
      flush: async (session: { id: string }) => { calls.push(`flush:${session.id}`) },
    } as unknown as Pick<SessionStore, 'flush'>)

    const executor = createDshSessionChatExecutor({
      agents, sessions, selection: { provider: 'mock-provider', model: 'mock-model' },
    })

    await expect(executor(request)).resolves.toBe('Grounded review.')
    expect(calls).toEqual([
      'create:dsh-bull', 'present:native', 'allow:[]',
      'guard:Adversarial review roles cannot call tools; use the frozen dossier',
      'flush:dsh-bull', 'dispose:dsh-bull',
    ])
  })

  it('disposes the session and preserves the domain error when a turn is incomplete', async () => {
    let disposed = false
    const agents = {
      create: async (options: { setup?: (context: unknown) => Promise<unknown> | unknown }) => {
        await options.setup?.({
          on: () => () => undefined,
          tools: { presentAs: () => undefined, restrict: () => undefined, guard: () => undefined },
        })
        return {
          agent: {
            session: { seq: 0, events: [{ type: 'turn/end', seq: 1, time: 1, data: { reason: { kind: 'blocked' } } }] },
            whenIdle: async () => undefined,
            followup: () => undefined,
          },
          dispose: async () => { disposed = true },
        }
      },
    } as unknown as Pick<AgentRegistry, 'create'>
    const executor = createDshSessionChatExecutor({
      agents,
      sessions: { flush: async () => undefined } as unknown as Pick<SessionStore, 'flush'>,
      selection: { provider: 'mock-provider', model: 'mock-model' },
    })

    await expect(executor(request)).rejects.toMatchObject({ code: 'invalid-session' })
    expect(disposed).toBe(true)
  })
})
