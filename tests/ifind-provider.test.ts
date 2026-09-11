import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IFIND_OFFICIAL_CAPABILITIES,
  IFIND_OFFICIAL_PROVIDER_ID,
  IfindOfficialProvider,
  THS_PUBLIC_SOURCE_ID,
} from '../packages/finance-data-service/src/providers/ifind/index.js'

const NOW = Date.parse('2026-09-05T00:00:00Z')

describe('IfindOfficialProvider', () => {
  it.each([
    [{}, { endpointConfigured: false, credentialConfigured: false }],
    [{ IFIND_MCP_URL: 'https://mcp.51ifind.com/' }, { endpointConfigured: true, credentialConfigured: false }],
    [{ IFIND_MCP_CREDENTIAL: 'fixture-secret' }, { endpointConfigured: false, credentialConfigured: true }],
  ])('stays dormant when URL or credential is missing', async (environment, flags) => {
    const provider = new IfindOfficialProvider({ environment, now: () => NOW })
    await expect(provider.health()).resolves.toEqual({
      providerId: 'ifind-official',
      status: 'dormant',
      checkedAt: '2026-09-05T00:00:00.000Z',
      message: 'blocked: missing IFIND_MCP_URL or credential',
      capabilities: Object.fromEntries(IFIND_OFFICIAL_CAPABILITIES.map(value => [value, 'dormant'])),
      reason: 'missing-config',
      authMode: 'custom',
      details: {
        ...flags,
        requiredEnvironment: ['IFIND_MCP_URL', 'IFIND_MCP_CREDENTIAL'],
        transport: 'mcp',
        sourceKind: 'licensed',
        liveVerified: false,
        cookieAcquisition: 'disabled',
        publicWebAlias: false,
      },
    })
  })

  it.each([
    'not-an-absolute-url',
    'http://mcp.example.invalid/mcp',
    'https://user:password@mcp.example.invalid/mcp',
    'https://mcp.example.invalid/mcp#fragment',
  ])('reports an invalid endpoint before a missing credential: %s', async unsafe => {
    const health = await new IfindOfficialProvider({
      mcpUrl: unsafe,
      environment: {},
      now: () => NOW,
    }).health()

    expect(health).toMatchObject({
      providerId: IFIND_OFFICIAL_PROVIDER_ID,
      status: 'unavailable',
      reason: 'invalid-config',
      message: 'blocked: IFIND_MCP_URL must be an absolute HTTPS URL without embedded credentials',
      capabilities: Object.fromEntries(
        IFIND_OFFICIAL_CAPABILITIES.map(value => [value, 'unavailable']),
      ),
      details: {
        endpointConfigured: true,
        credentialConfigured: false,
        liveVerified: false,
      },
    })
    expect(JSON.stringify(health)).not.toContain(unsafe)
  })

  it('keeps iFind official distinct from ths-public and never exposes configured secrets', async () => {
    const secret = 'ifind-secret-that-must-not-leak'
    const provider = new IfindOfficialProvider({
      environment: {
        IFIND_MCP_URL: 'https://mcp.51ifind.com/mcp',
        IFIND_MCP_CREDENTIAL: secret,
        IFIND_COOKIE: 'must-not-be-read',
      },
      now: () => NOW,
    })
    const health = await provider.health()

    expect(provider.providerId).toBe(IFIND_OFFICIAL_PROVIDER_ID)
    expect(provider.providerId).not.toBe(THS_PUBLIC_SOURCE_ID)
    expect(health).toMatchObject({
      status: 'dormant',
      reason: 'not-live-verified',
      capabilities: {
        quote: 'dormant',
        'market-bars': 'dormant',
        fundamentals: 'dormant',
        'research-consensus': 'dormant',
      },
      details: {
        transport: 'mcp',
        sourceKind: 'licensed',
        cookieAcquisition: 'disabled',
        publicWebAlias: false,
      },
    })
    expect(JSON.stringify(health)).not.toContain(secret)
    expect(JSON.stringify(health)).not.toContain('must-not-be-read')
  })

  it('does not inspect cookie environment entries while resolving official MCP configuration', async () => {
    const reads: string[] = []
    const environment = new Proxy({
      IFIND_MCP_URL: 'https://mcp.51ifind.com/mcp',
      IFIND_MCP_CREDENTIAL: 'configured',
    } as NodeJS.ProcessEnv, {
      get(target, property, receiver) {
        reads.push(String(property))
        if (/cookie/i.test(String(property))) throw new Error('cookie access is forbidden')
        return Reflect.get(target, property, receiver)
      },
    })
    const provider = new IfindOfficialProvider({ environment, now: () => NOW })

    await expect(provider.health()).resolves.toMatchObject({ status: 'dormant' })
    expect(reads).toEqual(['IFIND_MCP_URL', 'IFIND_MCP_CREDENTIAL'])
  })

  it('rejects unsafe MCP URLs without echoing them', async () => {
    const unsafe = 'http://user:password@example.invalid/mcp#secret'
    const health = await new IfindOfficialProvider({
      mcpUrl: unsafe,
      credential: 'configured',
      now: () => NOW,
    }).health()

    expect(health).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-config',
      message: 'blocked: IFIND_MCP_URL must be an absolute HTTPS URL without embedded credentials',
      capabilities: Object.fromEntries(IFIND_OFFICIAL_CAPABILITIES.map(value => [value, 'unavailable'])),
    })
    expect(JSON.stringify(health)).not.toContain(unsafe)
    expect(JSON.stringify(health)).not.toContain('password')
  })

  it('fails closed on execute and supports an already-aborted health probe', async () => {
    const provider = new IfindOfficialProvider({ environment: {}, now: () => NOW })
    await expect(provider.execute({ capability: 'quote', market: 'CN' })).rejects.toMatchObject({
      kind: 'unauthorized',
      retryable: false,
      provider: 'ifind-official',
    })

    const controller = new AbortController()
    controller.abort()
    await expect(provider.health(controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
      retryable: false,
      provider: 'ifind-official',
    })
  })

  it('distinguishes a missing endpoint from a missing credential on execute', async () => {
    const missingEndpoint = new IfindOfficialProvider({
      environment: { IFIND_MCP_CREDENTIAL: 'configured' }, now: () => NOW,
    })
    await expect(missingEndpoint.execute({ capability: 'quote', market: 'CN' }))
      .rejects.toMatchObject({ kind: 'unsupported', details: { reason: 'missing-config' } })

    const missingCredential = new IfindOfficialProvider({
      environment: { IFIND_MCP_URL: 'https://mcp.51ifind.com/mcp' }, now: () => NOW,
    })
    await expect(missingCredential.execute({ capability: 'quote', market: 'CN' }))
      .rejects.toMatchObject({ kind: 'unauthorized', details: { reason: 'missing-config' } })
  })

  it('ships a provenance-only fixture that explicitly contains no live response or secrets', async () => {
    const fixture = JSON.parse(await readFile(
      join(process.cwd(), 'tests/fixtures/ifind/health.json'),
      'utf8',
    )) as Record<string, unknown>
    expect(fixture).toEqual(expect.objectContaining({
      fixtureVersion: '1',
      providerId: 'ifind-official',
      status: 'dormant',
      containsCredential: false,
      containsCookie: false,
    }))
    expect(JSON.stringify(fixture)).not.toMatch(/token|password|authorization/i)
  })
})
