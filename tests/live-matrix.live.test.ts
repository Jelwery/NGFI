import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TdxCommunityProvider, TdxOfficialProvider } from '../packages/finance-provider-tdx/src/index.js'
import { IfindOfficialProvider } from '../packages/finance-provider-ifind/src/index.js'
import { Cne6LocalProvider } from '../packages/finance-provider-cne6/src/index.js'

type LiveOutcome =
  | 'pass'
  | 'fail'
  | 'blocked-auth'
  | 'blocked-configuration'
  | 'blocked-transport'
  | 'unavailable-network'
  | 'not-requested'

interface MatrixEntry {
  provider: string
  outcome: LiveOutcome
  reason: string
}

function emit(entry: MatrixEntry): void {
  // These records intentionally contain no endpoint, credential, response body, or stack trace.
  process.stdout.write(`[live-provider-matrix] ${JSON.stringify(entry)}\n`)
}

function emitRequested(entry: MatrixEntry): void {
  emit(entry)
  if (process.env.NGFI_LIVE_REPORT_ONLY !== '1') expect(entry.outcome).toBe('pass')
}

describe('opt-in live provider matrix', () => {
  it('reports TDX official access without presenting a blocked check as provider success', async () => {
    if (process.env.NGFI_LIVE_TDX !== '1') {
      emit({ provider: 'tdx-official', outcome: 'not-requested', reason: 'set NGFI_LIVE_TDX=1' })
      return
    }
    const health = await new TdxOfficialProvider().health()
    const entry: MatrixEntry = health.status === 'healthy'
      ? { provider: 'tdx-official', outcome: 'pass', reason: 'official health probe succeeded' }
      : health.reason === 'missing-credential'
        ? { provider: 'tdx-official', outcome: 'blocked-auth', reason: 'missing TDX_DATA_KEY with data-service entitlement' }
        : { provider: 'tdx-official', outcome: 'blocked-transport', reason: health.reason }
    emitRequested(entry)
  })

  it('reports TDX community network/configuration status separately from the official service', async () => {
    if (process.env.NGFI_LIVE_TDX !== '1') {
      emit({ provider: 'tdx-community', outcome: 'not-requested', reason: 'set NGFI_LIVE_TDX=1' })
      return
    }
    const provider = new TdxCommunityProvider()
    let entry: MatrixEntry
    try {
      const health = await provider.health()
      entry = health.status === 'healthy'
        ? { provider: 'tdx-community', outcome: 'pass', reason: 'configured community server probe succeeded' }
        : health.reason === 'missing-server-config'
          ? { provider: 'tdx-community', outcome: 'blocked-configuration', reason: 'missing approved TDX_COMMUNITY_SERVERS' }
          : { provider: 'tdx-community', outcome: 'unavailable-network', reason: health.reason }
    } catch {
      entry = { provider: 'tdx-community', outcome: 'fail', reason: 'community provider probe failed' }
    } finally {
      try {
        await provider.close()
      } catch {
        entry = { provider: 'tdx-community', outcome: 'fail', reason: 'community provider cleanup failed' }
      }
    }
    emitRequested(entry)
  })

  it('reports iFinD official access without presenting a blocked check as provider success', async () => {
    if (process.env.NGFI_LIVE_IFIND !== '1') {
      emit({ provider: 'ifind-official', outcome: 'not-requested', reason: 'set NGFI_LIVE_IFIND=1' })
      return
    }
    const health = await new IfindOfficialProvider().health()
    const entry: MatrixEntry = health.status === 'healthy'
      ? { provider: 'ifind-official', outcome: 'pass', reason: 'official MCP health probe succeeded' }
      : health.reason === 'missing-config'
        ? { provider: 'ifind-official', outcome: 'blocked-auth', reason: 'missing IFIND_MCP_URL or IFIND_MCP_CREDENTIAL' }
        : health.reason === 'not-live-verified'
          ? { provider: 'ifind-official', outcome: 'blocked-transport', reason: 'official MCP transport is not implemented' }
          : { provider: 'ifind-official', outcome: 'blocked-configuration', reason: health.reason }
    emitRequested(entry)
  })

  it('reports whether a published CNE6 snapshot is available', async () => {
    if (process.env.NGFI_LIVE_CNE6 !== '1') {
      emit({ provider: 'cne6-local', outcome: 'not-requested', reason: 'set NGFI_LIVE_CNE6=1' })
      return
    }
    const dataRoot = resolve(process.env.CNE6_DATA_ROOT ?? 'packages/combinatorial-optimization/data')
    if (!existsSync(resolve(dataRoot, 'CURRENT'))
      && !existsSync(resolve(dataRoot, 'quality-report.json'))) {
      const entry: MatrixEntry = {
        provider: 'cne6-local',
        outcome: 'fail',
        reason: 'no CURRENT snapshot or legacy quality-report.json; run the controlled rebuild CLI',
      }
      emitRequested(entry)
      return
    }
    let entry: MatrixEntry
    try {
      const health = await new Cne6LocalProvider({ dataRoot }).health()
      entry = health.status === 'healthy' || health.status === 'degraded'
        ? { provider: 'cne6-local', outcome: 'pass', reason: health.status }
        : { provider: 'cne6-local', outcome: 'fail', reason: health.status }
    } catch {
      entry = { provider: 'cne6-local', outcome: 'fail', reason: 'published snapshot validation failed' }
    }
    emitRequested(entry)
  })
})
