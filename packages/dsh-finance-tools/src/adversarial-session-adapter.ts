import {
  installModelSelection,
  type AgentRegistry,
  type AgentSetup,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionStore } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { canonicalJson } from '@finance2dsh/research-core'
import {
  AdversarialReviewError,
  type AdversarialChatExecutor,
} from '@finance2dsh/research-workflow'

export interface DshSessionChatExecutorOptions {
  agents: Pick<AgentRegistry, 'create'>
  sessions: Pick<SessionStore, 'flush'>
  selection: ModelSelection
  setup?: AgentSetup
  agentPreset?: string
  cwd?: string
  maxTokens?: number
}

function stageResponse(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  let reason: unknown
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const next = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (next !== '') text = next
    } else if (event.type === 'turn/end') {
      reason = event.data.reason
    }
  }
  if (typeof reason !== 'object' || reason === null || !('kind' in reason) || reason.kind !== 'completed') {
    const detail = typeof reason === 'object' && reason !== null && 'error' in reason
      ? canonicalJson(reason.error)
      : String((reason as { kind?: unknown } | undefined)?.kind ?? 'missing-turn-end')
    throw new AdversarialReviewError('invalid-session', 'DSH session did not complete: ' + detail)
  }
  if (text.trim() === '') {
    throw new AdversarialReviewError('invalid-session', 'DSH session completed without a text response')
  }
  return text
}

/**
 * Adapt DSH Agent/Session services to the domain-owned chat executor contract.
 * Each call receives a fresh session and a monotonic empty tool allowlist.
 */
export function createDshSessionChatExecutor(
  options: DshSessionChatExecutorOptions,
): AdversarialChatExecutor {
  return async request => {
    const handle = await options.agents.create({
      sessionId: SessionId(request.sessionId),
      meta: {
        cwd: options.cwd ?? process.cwd(),
        ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      },
      agentOptions: {
        provider: options.selection.provider,
        model: options.selection.model,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      },
      setup: async agentCtx => {
        installModelSelection(agentCtx, { current: options.selection, assembled: undefined })
        const commit = await options.setup?.(agentCtx)
        agentCtx.tools.presentAs('native')
        agentCtx.tools.restrict({ allow: [] })
        agentCtx.tools.guard(() => 'Adversarial review roles cannot call tools; use the frozen dossier')
        return commit
      },
    })
    try {
      await handle.agent.whenIdle()
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: request.message }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      await options.sessions.flush(handle.agent.session)
      return stageResponse(handle.agent.session.events, firstSeq)
    } finally {
      await handle.dispose()
    }
  }
}
