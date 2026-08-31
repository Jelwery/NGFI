import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

export const name = 'finance-headless-runner'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'sessions']

export interface Config {
  task: string
  preset?: string
}

export const Config = z.object({
  task: z.string().required(),
  preset: z.string().default('finance-analyst'),
})

export interface ToolTrace {
  callId: string
  name: string
  arguments: string
  result?: ContentBlock[]
  error?: { name: string; code: string }
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  modelCalls: number
  reported: boolean
}

export interface Outcome {
  text: string
  reason: unknown
  toolCalls: string[]
  toolTrace: ToolTrace[]
  usage: UsageSummary
}

function emptyUsage(): UsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    reported: false,
  }
}

function addUsage(summary: UsageSummary, usage: TokenUsage): void {
  summary.inputTokens += usage.inputTokens
  summary.outputTokens += usage.outputTokens
  summary.cacheReadTokens += usage.cacheReadTokens ?? 0
  summary.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  summary.reasoningTokens += usage.reasoningTokens ?? 0
  summary.modelCalls += 1
  summary.reported = true
  // reasoningTokens is provider detail and may already be included in outputTokens.
  summary.totalTokens = summary.inputTokens + summary.outputTokens
    + summary.cacheReadTokens + summary.cacheWriteTokens
}

export function summarize(events: readonly SessionEvent[], firstSeq: number): Outcome {
  let started = false
  let text = ''
  let reason: unknown
  const toolCalls: string[] = []
  const toolTrace: ToolTrace[] = []
  const traceByCallId = new Map<string, ToolTrace>()
  const usage = emptyUsage()
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
      if (event.data.usage !== undefined) addUsage(usage, event.data.usage)
    } else if (event.type === 'tool/call') {
      toolCalls.push(event.data.name)
      const trace: ToolTrace = {
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
      }
      toolTrace.push(trace)
      traceByCallId.set(event.data.callId, trace)
    } else if (event.type === 'tool/result') {
      const trace = traceByCallId.get(event.data.message.source.callId)
      if (trace !== undefined) {
        const block = event.data.message.content[0]
        trace.result = block.content
        if (event.data.error !== undefined) trace.error = event.data.error
      }
    } else if (event.type === 'turn/end') {
      reason = event.data.reason
    }
  }
  return { text, reason, toolCalls, toolTrace, usage }
}

function isCompleted(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null
    && 'kind' in reason && reason.kind === 'completed'
}

function errorReason(reason: unknown): { code: string; message: string } | undefined {
  if (typeof reason !== 'object' || reason === null || !('kind' in reason) || reason.kind !== 'error') {
    return undefined
  }
  if (!('error' in reason) || typeof reason.error !== 'object' || reason.error === null) return undefined
  const error = reason.error as { code?: unknown; message?: unknown }
  return { code: String(error.code ?? 'UNKNOWN'), message: String(error.message ?? 'unknown error') }
}

async function run(ctx: Context, config: Config): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const presets = ctx.get('agentPresets')
  const sessions = ctx.get('sessions')
  const exit = ctx.get('appExit')
  if (agents === undefined || defaultModel === undefined || presets === undefined
    || sessions === undefined || exit === undefined) return

  const selection = defaultModel.currentSelection()
  const presetId = config.preset ?? 'finance-analyst'
  const { agent } = await agents.create({
    sessionId: SessionId(`finance-${randomUUID()}`),
    meta: { cwd: process.cwd(), agentPreset: presetId },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async agentCtx => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, presetId)
    },
  })

  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const startedAt = new Date()
  const startedMonotonic = performance.now()
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const completedAt = new Date()
  const durationMs = Math.round(performance.now() - startedMonotonic)
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)

  if (process.env.FINANCE2DSH_RESULT_FORMAT === 'json') {
    process.stdout.write(`${JSON.stringify({
      sessionId: agent.id,
      preset: presetId,
      selection,
      toolCalls: outcome.toolCalls,
      toolTrace: outcome.toolTrace,
      usage: outcome.usage,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      reason: outcome.reason,
      text: outcome.text,
    })}\n`)
  } else {
    process.stdout.write(`${outcome.text}\n`)
  }
  const failure = errorReason(outcome.reason)
  if (failure !== undefined) process.stderr.write(`dsh: ${failure.code}: ${failure.message}\n`)
  exit(isCompleted(outcome.reason) ? 0 : 1)
}

export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('finance-headless-runner requires the DSH launcher')
  run(ctx, config).catch(error => {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
