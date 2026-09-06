import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { InstrumentId } from '@finance2dsh/core'
import { createSignalObservation, stableHash, type SignalObservation } from '@finance2dsh/strategy-core'
import {
  FileSignalLedger,
  InMemorySignalLedger,
  SignalEvaluationError,
} from '@finance2dsh/signal-evaluation'

const directories: string[] = []
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

const instrument: InstrumentId = { market: 'CN', exchange: 'SSE', symbol: '600000', assetType: 'equity' }

function observation(strategyHash = stableHash({ strategy: 'v1' }), action: 'entry' | 'exit' = 'entry'): SignalObservation {
  return createSignalObservation({
    strategyId: 'fixture.strategy', strategyHash, inputHash: stableHash({ bars: 1 }), snapshotId: 'snapshot:ledger',
    instrument, signalAt: '2026-01-02T07:00:00.000Z', availableAt: '2026-01-02T07:00:01.000Z',
    configHash: stableHash({}), action, direction: action === 'entry' ? 'long' : 'flat', confirmationPrice: 10,
    executionDefinitionId: 'next-tradable-bar-open@1', payload: { fixture: true }, explanation: 'fixture',
    quality: { level: 'high', inputStatus: 'complete', limitations: [] },
  })
}

describe('SignalObservation append-only ledger and lifecycle projection', () => {
  it('appends an immutable observation idempotently and rejects content tampering', () => {
    const ledger = new InMemorySignalLedger()
    const item = observation()
    expect(ledger.appendObservation(item)).toMatchObject({ appended: true, record: item })
    expect(ledger.appendObservation(structuredClone(item))).toMatchObject({ appended: false, record: item })
    expect(() => ledger.appendObservation({ ...item, explanation: 'rewritten' })).toThrow(SignalEvaluationError)
    expect(ledger.snapshot().observations).toEqual([item])
    expect(Object.isFrozen(ledger.getObservation(item.id))).toBe(true)
  })

  it('projects legal events, rejects invalid order and backward time, and never mutates the observation', () => {
    const ledger = new InMemorySignalLedger()
    const item = observation()
    ledger.appendObservation(item)
    const qualified = ledger.appendLifecycleEvent({
      observationId: item.id, type: 'qualified', actor: 'researcher', occurredAt: '2026-01-02T08:00:00.000Z', payload: {},
    })
    expect(ledger.appendLifecycleEvent(qualified.record).appended).toBe(false)
    ledger.appendLifecycleEvent({
      observationId: item.id, type: 'tradeable', actor: 'system', occurredAt: '2026-01-02T09:00:00.000Z', payload: {},
    })
    expect(ledger.projectLifecycle(item.id)).toMatchObject({ state: 'tradeable', eventCount: 2 })
    expect(ledger.getObservation(item.id)).toEqual(item)
    expect(() => ledger.appendLifecycleEvent({
      observationId: item.id, type: 'qualified', actor: 'system', occurredAt: '2026-01-02T10:00:00.000Z', payload: {},
    })).toThrow(/invalid lifecycle transition/)

    const second = observation(stableHash({ strategy: 'v2' }))
    ledger.appendObservation(second)
    expect(() => ledger.appendLifecycleEvent({
      observationId: second.id, type: 'qualified', actor: 'system', occurredAt: '2026-01-02T06:00:00.000Z', payload: {},
    })).toThrow(/backwards in time/)
  })

  it('keeps contrary observations from distinct strategy versions independent', () => {
    const ledger = new InMemorySignalLedger()
    const v1 = observation(stableHash({ strategy: 'v1' }), 'entry')
    const v2 = observation(stableHash({ strategy: 'v2' }), 'exit')
    ledger.appendObservation(v1)
    ledger.appendObservation(v2)
    ledger.appendLifecycleEvent({
      observationId: v1.id, type: 'retired', actor: 'system', occurredAt: '2026-01-03T00:00:00.000Z', payload: {},
    })
    expect(ledger.projectLifecycle(v1.id)?.state).toBe('retired')
    expect(ledger.projectLifecycle(v2.id)?.state).toBe('observed')
  })

  it('persists append-only JSONL, replays identically, and fails closed on corruption', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ngfi-signal-ledger-'))
    directories.push(directory)
    const ledger = new FileSignalLedger(directory)
    const item = observation()
    ledger.appendObservation(item)
    ledger.appendLifecycleEvent({
      observationId: item.id, type: 'qualified', actor: 'researcher', occurredAt: '2026-01-02T08:00:00.000Z', payload: {},
    })
    const before = ledger.snapshot()
    expect(new FileSignalLedger(directory).snapshot()).toEqual(before)
    expect(readFileSync(path.join(directory, 'observations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)

    writeFileSync(path.join(directory, 'lifecycle-events.jsonl'), '{broken', 'utf8')
    expect(() => new FileSignalLedger(directory)).toThrow(/partial final line/)
    expect(readFileSync(path.join(directory, 'lifecycle-events.jsonl'), 'utf8')).toBe('{broken')
  })
})
