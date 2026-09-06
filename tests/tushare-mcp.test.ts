import { describe, expect, it, vi } from 'vitest'
import {
  TUSHARE_MCP_CAPABILITIES,
  TushareMcpClient,
  TushareMcpProvider,
  classifyTushareError,
  redactTushareText,
  redactTushareUrl,
  resolveTushareEndpoint,
} from '../packages/finance-provider-tushare-mcp/src/index.js'
import { CORE_TOOLS, createDeferred, createFakeTushareMcp } from './fixtures/tushare/streamable-http.js'

const endpoint = 'https://api.tushare.pro/mcp/?token=fixture-secret-that-must-not-leak'
const instrument = { market: 'CN', exchange: 'SSE', symbol: '600519', assetType: 'equity' } as const

function provider(
  fake: ReturnType<typeof createFakeTushareMcp>,
  options: { timeoutMs?: number; nowMs?: () => number } = {},
) {
  return new TushareMcpProvider({
    url: endpoint,
    fetch: fake.fetch,
    now: () => new Date('2026-09-05T10:00:00.000Z'),
    nowMs: options.nowMs ?? (() => 1_000),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
}

describe('TushareMcpProvider configuration and discovery', () => {
  it('stays dormant without credentials and never exposes a raw tool escape hatch', async () => {
    const dormant = new TushareMcpProvider({ env: {} })
    await expect(dormant.health()).resolves.toEqual(expect.objectContaining({
      providerId: 'tushare-mcp',
      status: 'dormant',
      capabilities: Object.fromEntries(TUSHARE_MCP_CAPABILITIES.map(capability => [capability, 'dormant'])),
    }))
    await expect(dormant.execute({ capability: 'quote', market: 'CN' })).rejects.toMatchObject({
      kind: 'unsupported',
      provider: 'tushare-mcp',
    })
    expect(Object.getOwnPropertyNames(TushareMcpProvider.prototype)).not.toContain('callTool')
  })

  it('rejects timeout values that exceed the Node timer range', () => {
    expect(() => provider(createFakeTushareMcp(), { timeoutMs: 2_147_483_648 }))
      .toThrow(RangeError)
  })

  it('uses the documented path form for token-only configuration and redacts both URL forms', () => {
    const secret = 'fixture-secret-that-must-not-leak'
    const resolved = resolveTushareEndpoint({ token: secret, env: {} })
    expect(resolved?.url.toString()).toBe(`https://api.tushare.pro/mcp/token=${secret}`)
    expect(resolved?.redactedUrl).toBe('https://api.tushare.pro/mcp/token=[REDACTED]')
    expect(redactTushareUrl('https://api.tushare.pro/mcp/' + 'token=' + secret)).not.toContain(secret)
    expect(redactTushareUrl('https://api.tushare.pro/mcp/?' + 'token=' + secret)).not.toContain(secret)
  })

  it('preserves and fully redacts an explicit token containing a slash', () => {
    const token = ['slash', 'token'].join('/')
    const resolved = resolveTushareEndpoint({
      url: 'https://api.tushare.pro/mcp/token=old', token, env: {},
    })
    expect(resolved?.url.searchParams.get('token')).toBe(token)
    expect(resolved?.redactedUrl).not.toContain('slash')
    expect(resolved?.redactedUrl).not.toContain('token=old')
    expect(resolved?.secrets).toContain(token)
  })

  it('paginates tools/list once, caches validated inventory, and reports all mapped capabilities', async () => {
    const fake = createFakeTushareMcp({ toolsPages: [CORE_TOOLS.slice(0, 2), CORE_TOOLS.slice(2)] })
    const subject = provider(fake)

    const first = await subject.inventory()
    const second = await subject.inventory()

    expect(first.server).toEqual({ name: 'fake-tushare', version: '1.0.0' })
    expect(first.capabilities).toEqual(TUSHARE_MCP_CAPABILITIES)
    expect(second).toEqual(first)
    expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(2)
    await expect(subject.health()).resolves.toMatchObject({ status: 'healthy' })
    expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(2)
    await subject.close()
  })

  it('refreshes the cached tools inventory when its TTL expires', async () => {
    let clock = 1_000
    const fake = createFakeTushareMcp({ toolsPages: [[CORE_TOOLS[0]!]] })
    const subject = new TushareMcpProvider({
      url: endpoint,
      fetch: fake.fetch,
      toolsCacheTtlMs: 50,
      nowMs: () => clock,
    })
    await subject.inventory()
    clock = 1_049
    await subject.inventory()
    expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(1)
    clock = 1_050
    await subject.inventory()
    expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(2)
    await subject.close()
  })

  it('invalidates its cache when the server sends tools/list_changed', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!]],
      responders: { stock_basic: () => [{ ts_code: '600519.SH', name: '贵州茅台' }] },
      notifyToolsChangedOnCall: true,
    })
    const subject = provider(fake)
    await subject.execute({ capability: 'instrument-reference', market: 'CN', instrument })
    await subject.inventory()
    expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(2)
    await subject.close()
  })

  it('serializes inventory refreshes so SDK tool metadata cannot roll backward', async () => {
    const olderGate = createDeferred()
    const newerGate = createDeferred()
    const olderStarted = createDeferred()
    const newerStarted = createDeferred()
    const fake = createFakeTushareMcp({
      toolsByListRequest: [[CORE_TOOLS[0]!], [CORE_TOOLS[0]!], [CORE_TOOLS[2]!]],
      onToolsList: async (_page, requestIndex) => {
        if (requestIndex === 1) {
          olderStarted.resolve()
          await olderGate.promise
        }
        if (requestIndex === 2) {
          newerStarted.resolve()
          await newerGate.promise
        }
      },
    })
    const subject = provider(fake)
    let older: Promise<unknown> | undefined
    let newer: Promise<unknown> | undefined
    try {
      await subject.inventory()
      older = subject.inventory(undefined, { refresh: true })
      await olderStarted.promise
      newer = subject.inventory(undefined, { refresh: true })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(2)

      olderGate.resolve()
      await expect(older).resolves.toMatchObject({ capabilities: ['instrument-reference'] })
      await newerStarted.promise
      newerGate.resolve()
      await expect(newer).resolves.toMatchObject({ capabilities: ['market-bars'] })

      await expect(subject.inventory()).resolves.toMatchObject({ capabilities: ['market-bars'] })
      expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(3)
    } finally {
      olderGate.resolve()
      newerGate.resolve()
      await Promise.allSettled([older, newer].filter((value): value is Promise<unknown> => value !== undefined))
      await subject.close()
    }
  })

  it('validates output schemas for tools advertised before the final inventory page', async () => {
    const dailyWithOutputSchema = {
      ...CORE_TOOLS[2]!,
      outputSchema: {
        type: 'object',
        properties: { data: { type: 'array' } },
        required: ['data'],
        additionalProperties: false,
      },
    }
    const fake = createFakeTushareMcp({
      toolsPages: [[dailyWithOutputSchema], [CORE_TOOLS[1]!]],
      structuredTools: ['daily'],
      responders: { daily: () => ({ unexpected: true }) },
    })
    const resolvedEndpoint = resolveTushareEndpoint({ url: endpoint, env: {} })
    expect(resolvedEndpoint).toBeDefined()
    const client = new TushareMcpClient({ endpoint: resolvedEndpoint!, fetch: fake.fetch })
    try {
      const inventory = await client.discoverTools()
      const tool = inventory.tools.get('daily')
      expect(tool).toBeDefined()

      await expect(client.call({ tool: tool!, arguments: { ts_code: '600519.SH' } }))
        .rejects.toMatchObject({ kind: 'schema-drift' })
    } finally {
      await client.close()
    }
  })

  it('uses the selected tool snapshot when a later refresh changes SDK task metadata', async () => {
    const requiredTaskDaily = {
      ...CORE_TOOLS[2]!,
      execution: { taskSupport: 'required' as const },
    }
    const fake = createFakeTushareMcp({
      toolsByListRequest: [[CORE_TOOLS[2]!], [requiredTaskDaily]],
      responders: { daily: () => [] },
    })
    const resolvedEndpoint = resolveTushareEndpoint({ url: endpoint, env: {} })
    expect(resolvedEndpoint).toBeDefined()
    const client = new TushareMcpClient({ endpoint: resolvedEndpoint!, fetch: fake.fetch })
    try {
      const selected = (await client.discoverTools()).tools.get('daily')
      expect(selected).toBeDefined()
      await client.discoverTools(undefined, { refresh: true })

      await expect(client.call({ tool: selected!, arguments: { ts_code: '600519.SH' } }))
        .resolves.toMatchObject({ value: [] })
      expect(fake.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  it('rejects advertised tools whose schema cannot accept curated arguments', async () => {
    const malformedDaily = {
      name: 'daily',
      inputSchema: {
        type: 'object' as const,
        properties: { symbol: { type: 'string' } },
        additionalProperties: false,
      },
    }
    const fake = createFakeTushareMcp({ toolsPages: [[malformedDaily]] })
    const subject = provider(fake)
    await expect(subject.execute({
      capability: 'market-bars', market: 'CN', instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-05' },
    })).rejects.toMatchObject({
      kind: 'schema-drift',
    })
    await subject.close()
  })

  it('does not advertise a required-task tool through the non-task call path', async () => {
    const requiredTaskDaily = {
      ...CORE_TOOLS[2]!,
      execution: { taskSupport: 'required' as const },
    }
    const fake = createFakeTushareMcp({ toolsPages: [[requiredTaskDaily]] })
    const subject = provider(fake)
    try {
      await expect(subject.inventory()).resolves.toMatchObject({
        capabilities: expect.not.arrayContaining(['market-bars']),
        unavailableCapabilities: { 'market-bars': expect.stringMatching(/task/i) },
      })
    } finally {
      await subject.close()
    }
  })

  it('rejects a tools/list pagination cursor loop', async () => {
    const fake = createFakeTushareMcp({ toolsPages: [[CORE_TOOLS[0]!]], repeatListCursor: true })
    const subject = provider(fake)
    await expect(subject.inventory()).rejects.toMatchObject({ kind: 'schema-drift' })
    await subject.close()
  })

  it('cancels an in-progress handshake when closed', async () => {
    const fake = createFakeTushareMcp({ toolsPages: [[CORE_TOOLS[0]!]], delayInitializeMs: 100 })
    const subject = provider(fake, { timeoutMs: 1_000 })
    const pending = subject.inventory()
    await Promise.resolve()
    await subject.close()
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
    expect(fake.requests.some(request => request.method === 'DELETE')).toBe(false)
  })

  it('isolates an initiating caller cancellation from another caller sharing the handshake', async () => {
    const handshake = createDeferred()
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!]],
      initializeGate: handshake.promise,
    })
    const subject = provider(fake, { timeoutMs: 1_000 })
    const initiatingController = new AbortController()
    const initiating = subject.inventory(initiatingController.signal).then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )

    await fake.initializeStarted
    const joining = subject.inventory().then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )
    initiatingController.abort()
    handshake.resolve()

    await expect(initiating).resolves.toMatchObject({
      status: 'rejected',
      error: { kind: 'aborted', retryable: false },
    })
    await expect(joining).resolves.toMatchObject({
      status: 'fulfilled',
      value: { toolNames: ['stock_basic'] },
    })
    expect(fake.calls.filter(call => call.method === 'initialize')).toHaveLength(1)
    await subject.close()
  })

  it('lets a joining caller cancel without aborting the caller that started the shared handshake', async () => {
    const handshake = createDeferred()
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!]],
      initializeGate: handshake.promise,
    })
    const subject = provider(fake, { timeoutMs: 1_000 })
    const initiating = subject.inventory().then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )

    await fake.initializeStarted
    const joiningController = new AbortController()
    const joining = subject.inventory(joiningController.signal).then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )
    joiningController.abort()
    handshake.resolve()

    await expect(initiating).resolves.toMatchObject({
      status: 'fulfilled',
      value: { toolNames: ['stock_basic'] },
    })
    await expect(joining).resolves.toMatchObject({
      status: 'rejected',
      error: { kind: 'aborted', retryable: false },
    })
    expect(fake.calls.filter(call => call.method === 'initialize')).toHaveLength(1)
    await subject.close()
  })

  it('gives a late caller its full timeout budget while both callers share one handshake', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    const handshake = createDeferred()
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!]],
      initializeGate: handshake.promise,
    })
    const subject = provider(fake, { timeoutMs: 100, nowMs: () => Date.now() })
    try {
      const first = subject.inventory().then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      )
      await fake.initializeStarted
      await vi.advanceTimersByTimeAsync(75)

      let secondSettled = false
      const second = subject.inventory().then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ).finally(() => { secondSettled = true })
      await vi.advanceTimersByTimeAsync(30)

      await expect(first).resolves.toMatchObject({
        status: 'rejected',
        error: { kind: 'timeout', retryable: true },
      })
      expect(secondSettled).toBe(false)
      handshake.resolve()
      await expect(second).resolves.toMatchObject({
        status: 'fulfilled',
        value: { toolNames: ['stock_basic'] },
      })
      expect(fake.calls.filter(call => call.method === 'initialize')).toHaveLength(1)
    } finally {
      await subject.close()
      vi.useRealTimers()
    }
  })

  it('abandons a shared handshake once every waiting caller has cancelled', async () => {
    const firstGate = createDeferred()
    const secondGate = createDeferred()
    let initializeCount = 0
    const firstFake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!]],
      initializeGate: firstGate.promise,
    })
    const secondFake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!]],
      initializeGate: secondGate.promise,
    })
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string }
      if (request.method === 'initialize') initializeCount += 1
      return (initializeCount <= 1 ? firstFake.fetch : secondFake.fetch)(input, init)
    }
    const subject = new TushareMcpProvider({
      url: endpoint, fetch, timeoutMs: 1_000,
      now: () => new Date('2026-09-05T10:00:00.000Z'),
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = subject.inventory(firstController.signal).catch(error => error)
    await firstFake.initializeStarted
    const second = subject.inventory(secondController.signal).catch(error => error)
    firstController.abort()
    secondController.abort()
    await expect(first).resolves.toMatchObject({ kind: 'aborted' })
    await expect(second).resolves.toMatchObject({ kind: 'aborted' })
    await Promise.resolve()

    const third = subject.inventory()
    await secondFake.initializeStarted
    secondGate.resolve()
    await expect(third).resolves.toMatchObject({ toolNames: ['stock_basic'] })
    expect(initializeCount).toBe(2)
    firstGate.resolve()
    await subject.close()
  })

  it('uses one timeout budget across discovery and the mapped tool call', async () => {
    let clock = 1_000
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[2]!]],
      onToolsList: () => { clock += 60 },
      onToolCall: () => { clock += 60 },
    })
    const subject = provider(fake, { timeoutMs: 100, nowMs: () => clock })
    try {
      await expect(subject.execute({
        capability: 'market-bars', market: 'CN', instrument,
        params: { startDate: '2026-09-01', endDate: '2026-09-05' },
      })).rejects.toMatchObject({ kind: 'timeout', retryable: true })
      expect(fake.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
    } finally {
      await subject.close()
    }
  })

  it('uses one timeout budget for the complete paginated tools discovery', async () => {
    let clock = 1_000
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!], [CORE_TOOLS[1]!], [CORE_TOOLS[2]!]],
      onToolsList: () => { clock += 60 },
    })
    const subject = provider(fake, { timeoutMs: 100, nowMs: () => clock })

    await expect(subject.inventory()).rejects.toMatchObject({ kind: 'timeout', retryable: true })
    expect(fake.calls.filter(call => call.method === 'tools/list')).toHaveLength(2)
    await subject.close()
  })

  it('treats omitted additionalProperties as permissive according to JSON Schema', async () => {
    const implicitAdditionalProperties = {
      name: 'stock_basic',
      inputSchema: { type: 'object' as const, required: ['ts_code'] },
    }
    const fake = createFakeTushareMcp({ toolsPages: [[implicitAdditionalProperties]] })
    const subject = provider(fake)

    await expect(subject.inventory()).resolves.toMatchObject({
      capabilities: expect.arrayContaining(['instrument-reference']),
      unavailableCapabilities: expect.not.objectContaining({ 'instrument-reference': expect.anything() }),
    })
    await expect(subject.health()).resolves.toMatchObject({
      status: 'degraded',
      capabilities: { 'instrument-reference': 'healthy' },
    })
    await expect(subject.execute({
      capability: 'instrument-reference', market: 'CN', instrument,
    })).resolves.toMatchObject({ status: 'no-data' })
    expect(fake.calls.find(call => call.method === 'tools/call')?.params?.arguments).toEqual({
      ts_code: '600519.SH',
      fields: 'ts_code,symbol,name,fullname,market,exchange,curr_type,list_status,list_date,delist_date,industry,area',
    })
    await subject.close()
  })

  it.each([
    {
      name: 'instrument array fields',
      capability: 'instrument-reference' as const,
      tool: {
        ...CORE_TOOLS[0]!,
        inputSchema: {
          ...CORE_TOOLS[0]!.inputSchema,
          properties: {
            ...CORE_TOOLS[0]!.inputSchema.properties,
            fields: {
              type: 'array',
              const: [
                'ts_code', 'symbol', 'name', 'fullname', 'market', 'exchange', 'curr_type',
                'list_status', 'list_date', 'delist_date', 'industry', 'area',
              ],
            },
          },
        },
      },
      request: { capability: 'instrument-reference' as const, market: 'CN', instrument },
      expectedFields: [
        'ts_code', 'symbol', 'name', 'fullname', 'market', 'exchange', 'curr_type',
        'list_status', 'list_date', 'delist_date', 'industry', 'area',
      ],
    },
    {
      name: 'market-bars string fields',
      capability: 'market-bars' as const,
      tool: {
        ...CORE_TOOLS[2]!,
        inputSchema: {
          ...CORE_TOOLS[2]!.inputSchema,
          properties: {
            ...CORE_TOOLS[2]!.inputSchema.properties,
            fields: {
              type: 'string',
              const: 'ts_code,trade_date,open,high,low,close,pre_close,vol,amount',
            },
          },
        },
      },
      request: {
        capability: 'market-bars' as const, market: 'CN', instrument,
        params: { startDate: '2026-09-01', endDate: '2026-09-05' },
      },
      expectedFields: 'ts_code,trade_date,open,high,low,close,pre_close,vol,amount',
    },
  ])('validates and dispatches the exact mapped fields for $name', async ({
    capability, tool, request, expectedFields,
  }) => {
    const fake = createFakeTushareMcp({ toolsPages: [[tool]] })
    const subject = provider(fake)
    try {
      await expect(subject.inventory()).resolves.toMatchObject({
        capabilities: expect.arrayContaining([capability]),
      })
      await subject.execute(request)
      expect(fake.calls.find(call => call.method === 'tools/call')?.params?.arguments).toEqual(
        expect.objectContaining({ fields: expectedFields }),
      )
    } finally {
      await subject.close()
    }
  })

  it.each([
    {
      name: 'old abbreviated instrument fields',
      capability: 'instrument-reference' as const,
      tool: {
        ...CORE_TOOLS[0]!,
        inputSchema: {
          ...CORE_TOOLS[0]!.inputSchema,
          properties: {
            ...CORE_TOOLS[0]!.inputSchema.properties,
            fields: { type: 'array', const: ['ts_code', 'symbol', 'name'] },
          },
        },
      },
    },
    {
      name: 'old abbreviated market-bars fields',
      capability: 'market-bars' as const,
      tool: {
        ...CORE_TOOLS[2]!,
        inputSchema: {
          ...CORE_TOOLS[2]!.inputSchema,
          properties: {
            ...CORE_TOOLS[2]!.inputSchema.properties,
            fields: { type: 'string', const: 'ts_code,trade_date,close' },
          },
        },
      },
    },
  ])('rejects $name that cannot accept the real mapped call', async ({ capability, tool }) => {
    const fake = createFakeTushareMcp({ toolsPages: [[tool]] })
    const subject = provider(fake)
    try {
      await expect(subject.inventory()).resolves.toMatchObject({
        capabilities: expect.not.arrayContaining([capability]),
        unavailableCapabilities: expect.objectContaining({ [capability]: expect.any(String) }),
      })
      expect(fake.calls.filter(call => call.method === 'tools/call')).toHaveLength(0)
    } finally {
      await subject.close()
    }
  })

  it.each([
    ['a mapped argument with the wrong type', {
      ...CORE_TOOLS[2]!,
      inputSchema: {
        ...CORE_TOOLS[2]!.inputSchema,
        properties: { ...CORE_TOOLS[2]!.inputSchema.properties, ts_code: { type: 'integer' } },
        additionalProperties: false,
      },
    }],
    ['a required argument that the mapping does not supply', {
      ...CORE_TOOLS[2]!,
      inputSchema: {
        ...CORE_TOOLS[2]!.inputSchema,
        properties: { ...CORE_TOOLS[2]!.inputSchema.properties, account_id: { type: 'string' } },
        required: ['ts_code', 'account_id'],
        additionalProperties: false,
      },
    }],
  ])('rejects %s before dispatching tools/call', async (_scenario, advertisedTool) => {
    const fake = createFakeTushareMcp({ toolsPages: [[advertisedTool]] })
    const subject = provider(fake)

    try {
      const inventory = await subject.inventory()
      expect(inventory.capabilities).not.toContain('market-bars')
      expect(inventory.unavailableCapabilities).toEqual(expect.objectContaining({
        'market-bars': expect.any(String),
      }))
      await expect(subject.health()).resolves.toMatchObject({
        status: 'degraded',
        capabilities: { 'market-bars': 'unavailable' },
      })
      await expect(subject.execute({
        capability: 'market-bars', market: 'CN', instrument,
        params: { startDate: '2026-09-01', endDate: '2026-09-05' },
      })).rejects.toMatchObject({ kind: 'schema-drift' })
      expect(fake.calls.filter(call => call.method === 'tools/call')).toHaveLength(0)
    } finally {
      await subject.close()
    }
  })
})

describe('TushareMcpProvider canonical mappings', () => {
  const identityMappings = [
    {
      name: 'instrument',
      tool: CORE_TOOLS[0]!,
      toolName: 'stock_basic',
      request: { capability: 'instrument-reference', market: 'CN', instrument } as const,
      restOfRow: { name: '贵州茅台' },
    },
    {
      name: 'bar',
      tool: CORE_TOOLS[2]!,
      toolName: 'daily',
      request: {
        capability: 'market-bars', market: 'CN', instrument,
        params: { startDate: '2026-09-01', endDate: '2026-09-05' },
      } as const,
      restOfRow: { trade_date: '20260904', close: 1 },
    },
    {
      name: 'fundamentals',
      tool: CORE_TOOLS[3]!,
      toolName: 'fina_indicator',
      request: { capability: 'fundamentals', market: 'CN', instrument } as const,
      restOfRow: { end_date: '20260630', ann_date: '20260831', roe: 1 },
    },
  ] as const

  it.each(identityMappings.flatMap(mapping => [
    { ...mapping, identity: 'missing', tsCode: undefined },
    { ...mapping, identity: 'empty', tsCode: '' },
    { ...mapping, identity: 'conflicting', tsCode: '000001.SZ' },
  ]))('rejects a nonempty $name result with $identity ts_code', async ({ tool, toolName, request, restOfRow, tsCode }) => {
    const row = tsCode === undefined ? { ...restOfRow } : { ts_code: tsCode, ...restOfRow }
    const fake = createFakeTushareMcp({
      toolsPages: [[tool]],
      responders: { [toolName]: () => [row] },
    })
    const subject = provider(fake)

    try {
      await expect(subject.execute(request)).rejects.toMatchObject({
        kind: 'schema-drift',
        message: expect.stringMatching(/ts_code/),
      })
    } finally {
      await subject.close()
    }
  })

  it.each(identityMappings)('keeps an empty $name result as no-data', async ({ tool, toolName, request }) => {
    const fake = createFakeTushareMcp({ toolsPages: [[tool]], responders: { [toolName]: () => [] } })
    const subject = provider(fake)

    try {
      await expect(subject.execute(request)).resolves.toMatchObject({ status: 'no-data', data: null })
    } finally {
      await subject.close()
    }
  })

  it('maps structured instrument data and keeps the source URL redacted', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[0]!]],
      structuredTools: ['stock_basic'],
      responders: {
        stock_basic: args => ({ data: [{ ts_code: args.ts_code, name: '贵州茅台', currency: 'CNY' }] }),
      },
    })
    const subject = provider(fake)
    const response = await subject.execute({ capability: 'instrument-reference', market: 'CN', instrument })

    expect(response).toEqual(expect.objectContaining({
      status: 'available',
      data: expect.objectContaining({
        canonical: 'CN:SSE:600519:EQUITY',
        id: instrument,
        name: { status: 'available', value: '贵州茅台' },
        providerSymbols: { tushare: '600519.SH' },
      }),
      provenance: expect.objectContaining({
        actualProvider: 'tushare-mcp',
        upstreamSource: 'tushare',
        sourceKind: 'licensed',
        sourceUrl: 'https://api.tushare.pro/mcp/?token=[REDACTED]',
      }),
    }))
    const toolCall = fake.calls.find(call => call.method === 'tools/call')
    expect(toolCall?.params?.arguments).toEqual(expect.objectContaining({ ts_code: '600519.SH' }))
    await subject.close()
  })

  it('maps and sorts unadjusted daily bars without fabricating missing values', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[2]!]],
      responders: {
        daily: () => [
          { ts_code: '600519.SH', trade_date: '20260904', open: 1401, high: 1420, low: 1390, close: 1410, pre_close: 1400, vol: 10, amount: null },
          { ts_code: '600519.SH', trade_date: '20260903', open: 1390, high: 1410, low: 1380, close: 1400, pre_close: 1395, vol: 20, amount: 200 },
        ],
      },
    })
    const subject = provider(fake)
    const response = await subject.execute<{ bars: Array<Record<string, unknown>> }>({
      capability: 'market-bars',
      market: 'CN',
      instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-04', interval: '1d', adjustment: 'none' },
    })

    expect(response.status).toBe('available')
    expect(response.provenance).toMatchObject({ adjustment: 'none', observedAt: '2026-09-04' })
    expect(response.data?.bars).toEqual([
      expect.objectContaining({ observedAt: '2026-09-03', close: 1400 }),
      expect.objectContaining({ observedAt: '2026-09-04', close: 1410, amount: null }),
    ])
    const toolCall = fake.calls.find(call => call.method === 'tools/call')
    expect(toolCall?.params?.arguments).toEqual(expect.objectContaining({
      ts_code: '600519.SH',
      start_date: '20260901',
      end_date: '20260904',
    }))
    await subject.close()
  })

  it('normalizes native TuShare fields/items tabular responses', async () => {
    const stringFieldsTool = {
      ...CORE_TOOLS[2]!,
      inputSchema: {
        ...CORE_TOOLS[2]!.inputSchema,
        properties: { ...CORE_TOOLS[2]!.inputSchema.properties, fields: { type: 'string' } },
      },
    }
    const fake = createFakeTushareMcp({
      toolsPages: [[stringFieldsTool]],
      responders: {
        daily: () => ({
          data: {
            fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'],
            items: [['600519.SH', '20260904', 1, 2, 0.5, 1.5, 1.2, 10, 20]],
          },
        }),
      },
    })
    const subject = provider(fake)
    const response = await subject.execute<{ bars: Array<Record<string, unknown>> }>({
      capability: 'market-bars', market: 'CN', instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-05' },
    })
    expect(response.data?.bars[0]).toEqual(expect.objectContaining({ observedAt: '2026-09-04', close: 1.5 }))
    const toolCall = fake.calls.find(call => call.method === 'tools/call')
    expect(toolCall?.params?.arguments).toEqual(expect.objectContaining({
      fields: 'ts_code,trade_date,open,high,low,close,pre_close,vol,amount',
    }))
    await subject.close()
  })

  it('enforces adjustment and as-of boundaries on market bars', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[2]!]],
      responders: {
        daily: () => [{ ts_code: '600519.SH', trade_date: '20260906', close: 1 }],
      },
    })
    const subject = provider(fake)
    await expect(subject.execute({
      capability: 'market-bars', market: 'CN', instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-05', adjustment: 'qfq' },
    })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(subject.execute({
      capability: 'market-bars', market: 'CN', instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-05', interval: '1wk', adjustment: 'none' },
    })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(subject.execute({
      capability: 'market-bars', market: 'CN', instrument, asOf: '2026-09-05',
      params: { startDate: '2026-09-01' },
    })).rejects.toMatchObject({ kind: 'schema-drift' })
    await subject.close()
  })

  it('maps trading calendar dates and open state', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[1]!]],
      responders: {
        trade_cal: () => [
          { exchange: 'SSE', cal_date: '20260905', is_open: 0, pretrade_date: '20260904' },
          { exchange: 'SSE', cal_date: '20260904', is_open: 1, pretrade_date: '20260903' },
        ],
      },
    })
    const subject = provider(fake)
    const response = await subject.execute<{ days: Array<Record<string, unknown>> }>({
      capability: 'trading-calendar',
      market: 'CN',
      params: { exchange: 'SSE', startDate: '2026-09-04', endDate: '2026-09-05' },
    })

    expect(response.data?.days).toEqual([
      { exchange: 'SSE', calendarDate: '2026-09-04', isOpen: true, previousOpenDate: '2026-09-03' },
      { exchange: 'SSE', calendarDate: '2026-09-05', isOpen: false, previousOpenDate: '2026-09-04' },
    ])
    await subject.close()
  })

  it('maps financial periods and warns when PIT availability is incomplete', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[3]!]],
      responders: {
        fina_indicator: () => [{
          ts_code: '600519.SH', end_date: '20260630', ann_date: null, roe: 18.2, grossprofit_margin: null,
        }],
      },
    })
    const subject = provider(fake)
    const response = await subject.execute<{ pointInTimeSafe: boolean; periods: Array<Record<string, unknown>> }>({
      capability: 'fundamentals',
      market: 'CN',
      instrument,
      params: { period: '2026-06-30' },
    })

    expect(response.data?.pointInTimeSafe).toBe(false)
    expect(response.data?.periods[0]).toEqual(expect.objectContaining({
      fiscalPeriod: '2026-06-30',
      availableAt: null,
      fields: expect.objectContaining({
        roe: { status: 'available', value: 18.2 },
        grossprofit_margin: { status: 'missing', value: null },
      }),
    }))
    expect(response.warnings).toEqual([expect.stringMatching(/PIT safety/)])
    await subject.close()
  })

  it('filters fundamentals by availability before applying the requested limit', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[3]!]],
      responders: {
        fina_indicator: () => [
          { ts_code: '600519.SH', end_date: '20260630', ann_date: '20260831', roe: 20 },
          { ts_code: '600519.SH', end_date: '20260331', ann_date: '20260430', roe: 18 },
        ],
      },
    })
    const subject = provider(fake)
    const response = await subject.execute<{ periods: Array<{ fiscalPeriod: string }> }>({
      capability: 'fundamentals',
      market: 'CN',
      instrument,
      asOf: '2026-06-01',
      params: { limit: 1 },
    })
    expect(response.data?.periods).toEqual([expect.objectContaining({ fiscalPeriod: '2026-03-31' })])
    const toolCall = fake.calls.find(call => call.method === 'tools/call')
    expect(toolCall?.params?.arguments).not.toHaveProperty('limit')
    await subject.close()
  })

  it('falls back to ann_date when f_ann_date is an empty provider value', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[3]!]],
      responders: { fina_indicator: () => [{
        ts_code: '600519.SH', end_date: '20260630',
        f_ann_date: '', ann_date: '20260831', roe: 20,
      }] },
    })
    const subject = provider(fake)
    try {
      await expect(subject.execute({
        capability: 'fundamentals', market: 'CN', instrument,
        asOf: '2026-09-01', params: { limit: 1 },
      })).resolves.toMatchObject({
        status: 'available', data: { periods: [{ availableAt: '2026-08-31' }] },
      })
    } finally {
      await subject.close()
    }
  })
})

describe('TushareMcpProvider errors and cancellation', () => {
  it('classifies isError permission failures separately from empty data', async () => {
    const fake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[2]!]],
      isErrorTools: { daily: 'tushare API 错误 [40203]: 抱歉，您没有接口(daily)访问权限' },
    })
    const subject = provider(fake)
    await expect(subject.execute({
      capability: 'market-bars', market: 'CN', instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-05' },
    })).rejects.toMatchObject({
      kind: 'insufficient-permission',
      reason: 'insufficient-permission',
      retryable: false,
    })
    await subject.close()
  })

  it('returns no-data only for a successful empty result', async () => {
    const fake = createFakeTushareMcp({ toolsPages: [[CORE_TOOLS[2]!]], responders: { daily: () => [] } })
    const subject = provider(fake)
    await expect(subject.execute({
      capability: 'market-bars', market: 'CN', instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-05' },
    })).resolves.toMatchObject({
      status: 'no-data',
      data: null,
    })
    await subject.close()
  })

  it('distinguishes insufficient points from an invalid token', () => {
    expect(classifyTushareError(new Error('积分不足，无法调用该接口'))).toMatchObject({
      kind: 'insufficient-permission', reason: 'insufficient-points',
    })
    expect(classifyTushareError(new Error('invalid token'))).toMatchObject({
      kind: 'unauthorized', reason: 'invalid-token',
    })
  })

  it('propagates timeout and abort through official SDK request options', async () => {
    const timeoutFake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[2]!]],
      delayToolsMs: { daily: 100 },
    })
    const timeoutSubject = provider(timeoutFake, { timeoutMs: 10 })
    await expect(timeoutSubject.execute({
      capability: 'market-bars', market: 'CN', instrument,
      params: { startDate: '2026-09-01', endDate: '2026-09-05' },
    })).rejects.toMatchObject({
      kind: 'timeout',
    })
    await timeoutSubject.close()

    const abortFake = createFakeTushareMcp({
      toolsPages: [[CORE_TOOLS[2]!]],
      delayToolsMs: { daily: 100 },
    })
    const abortSubject = provider(abortFake, { timeoutMs: 1_000 })
    const controller = new AbortController()
    const pending = abortSubject.execute({
      capability: 'market-bars', market: 'CN', instrument, signal: controller.signal,
      params: { startDate: '2026-09-01', endDate: '2026-09-05' },
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false })
    await abortSubject.close()
  })

  it('redacts URLs, explicit secrets, headers, and classified diagnostics', () => {
    const secret = 'fixture-secret-that-must-not-leak'
    const raw = `failed at https://api.tushare.pro/mcp/?token=${secret} with Bearer ${secret}`
    expect(redactTushareUrl(endpoint)).toBe('https://api.tushare.pro/mcp/?token=[REDACTED]')
    expect(redactTushareText(raw, [secret])).not.toContain(secret)
    const classified = classifyTushareError(new Error(raw), [secret])
    expect(classified.message).not.toContain(secret)
    expect(classified.stack).not.toContain(secret)
    expect(classified.cause).toBeUndefined()
    expect(JSON.stringify(classified)).not.toContain(secret)
  })

  it.each([['auth', 'Token'], ['bearer', 'Token'], ['client', 'Secret']] as const)(
    'redacts camelCase %s%s query credentials',
    (prefix, suffix) => {
      const key = `${prefix}${suffix}`
      const secret = ['short', 'fixture', 'value'].join('-')
      const url = `https://api.tushare.pro/mcp/?${key}=${secret}`
      const resolved = resolveTushareEndpoint({ url, env: {} })

      expect(resolved?.redactedUrl).not.toContain(secret)
      expect(resolved?.secrets).toContain(secret)
      expect(redactTushareText(`${key}=${secret}`)).not.toContain(secret)
    },
  )

  it.each(['accessToken', 'credential', 'sig'])(
    'redacts sensitive free-form key %s using the same key policy as URLs',
    key => {
      const marker = ['short', 'fixture', 'value'].join('-')
      expect(redactTushareText(`${key}=${marker}`)).not.toContain(marker)
    },
  )
})
