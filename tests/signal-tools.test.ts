import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSignalObservation, stableHash } from '@finance2dsh/strategy-core'
import { createSignalTools } from '@finance2dsh/dsh-tools'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-signal-tools-'))
  roots.push(runtimeRoot)
  const tools = createSignalTools({ runtimeRoot })
  return (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!
    .execute(args as never, { signal: new AbortController().signal } as never) as Promise<any>
}

function observation() {
  return createSignalObservation({
    strategyId: 'fixture.strategy', strategyHash: stableHash({ strategy: 1 }), inputHash: stableHash({ bars: 1 }),
    snapshotId: 'snapshot:1', instrument: { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' },
    signalAt: '2026-01-02T07:00:00.000Z', availableAt: '2026-01-02T07:00:01.000Z',
    configHash: stableHash({}), action: 'entry', direction: 'long', confirmationPrice: 10,
    executionDefinitionId: 'next-tradable-bar-open@1', payload: {}, explanation: 'fixture',
    quality: { level: 'high', inputStatus: 'complete', limitations: [] },
  })
}

describe('signal DSH tools', () => {
  it('persists observations and lifecycle events with CAS and legal transitions', async () => {
    const execute = fixture()
    const item = observation()
    await expect(execute('finance_signal_ledger', {
      action: 'append-observation', workspace_id: 'signals', expected_revision: 0, observation: item,
    })).resolves.toMatchObject({ revision: 1, appended: true })
    await expect(execute('finance_signal_ledger', {
      action: 'append-observation', workspace_id: 'signals', expected_revision: 1, observation: item,
    })).resolves.toMatchObject({ revision: 1, appended: false })
    await expect(execute('finance_signal_ledger', {
      action: 'append-lifecycle', workspace_id: 'signals', expected_revision: 1, event: {
        observationId: item.id, type: 'tradeable', actor: 'agent',
        occurredAt: '2026-01-03T00:00:00.000Z', payload: {},
      },
    })).rejects.toThrow(/invalid lifecycle transition/u)
    await expect(execute('finance_signal_ledger', {
      action: 'append-lifecycle', workspace_id: 'signals', expected_revision: 1, event: {
        observationId: item.id, type: 'qualified', actor: 'agent',
        occurredAt: '2026-01-03T00:00:00.000Z', payload: {},
      },
    })).resolves.toMatchObject({ revision: 2, appended: true })
  })

  it('appends outcome revisions and preserves unable and insufficient as null, not zero', async () => {
    const execute = fixture()
    const item = observation()
    await execute('finance_signal_ledger', {
      action: 'append-observation', workspace_id: 'signals', expected_revision: 0, observation: item,
    })
    const first = await execute('finance_signal_outcome', {
      action: 'evaluate-and-append', workspace_id: 'signals', expected_revision: 1, observation_id: item.id,
      input: { horizon: 5, calculationAt: '2026-02-01T00:00:00.000Z',
        entry: { status: 'filled', at: '2026-01-03T00:00:00.000Z', price: 10 }, bars: [], regime: 'bull' },
    })
    expect(first).toMatchObject({ revision: 2, record: { revision: 1, status: 'unable', instrumentReturn: null } })
    const calibration = await execute('finance_signal_outcome', {
      action: 'calibrate', workspace_id: 'signals',
      options: { createdAt: '2026-03-01T00:00:00.000Z', defaultMinimumSamples: 2 },
    })
    expect(calibration.snapshot).toMatchObject({ evidenceOnly: true })
    expect(calibration.snapshot.buckets[0].directionHitRate).toMatchObject({ status: 'insufficient', value: null })
  })
})
