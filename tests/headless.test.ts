import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { summarize } from '../packages/dsh-finance-bundle/src/headless.js'

function events(value: unknown[]): SessionEvent[] {
  return value as SessionEvent[]
}

describe('headless result observability', () => {
  it('captures tool arguments, results and aggregate provider-reported usage', () => {
    const outcome = summarize(events([
      { type: 'turn/start', seq: 10, time: 1000, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 11,
        time: 1001,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'test', model: 'test' } },
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, reasoningTokens: 7 },
        },
      },
      {
        type: 'tool/call',
        seq: 12,
        time: 1002,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'skill', arguments: '{"name":"example"}' },
      },
      {
        type: 'tool/result',
        seq: 13,
        time: 1003,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'user',
            source: { kind: 'tool', callId: 'call-1' },
            content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'loaded' }] }],
          },
        },
      },
      {
        type: 'assistant/message',
        seq: 14,
        time: 1004,
        data: {
          turn: 1,
          step: 2,
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'test', model: 'test' },
            content: [{ type: 'text', text: 'answer' }],
          },
          usage: { inputTokens: 120, outputTokens: 30, cacheWriteTokens: 10 },
        },
      },
      { type: 'turn/end', seq: 15, time: 1005, data: { turn: 1, reason: { kind: 'completed' } } },
    ]), 10)

    expect(outcome.text).toBe('answer')
    expect(outcome.toolCalls).toEqual(['skill'])
    expect(outcome.toolTrace).toEqual([{
      callId: 'call-1',
      name: 'skill',
      arguments: '{"name":"example"}',
      result: [{ type: 'text', text: 'loaded' }],
    }])
    expect(outcome.usage).toEqual({
      inputTokens: 220,
      outputTokens: 50,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 7,
      totalTokens: 330,
      modelCalls: 2,
      reported: true,
    })
  })

  it('ignores events before the requested turn boundary', () => {
    const outcome = summarize(events([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: 'old', name: 'old', arguments: '{}' } },
      { type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ]), 3)

    expect(outcome.toolCalls).toEqual([])
    expect(outcome.usage.reported).toBe(false)
  })
})
