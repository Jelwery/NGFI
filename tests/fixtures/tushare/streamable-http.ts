type ToolFixture = {
  name: string
  description?: string
  execution?: { taskSupport?: 'forbidden' | 'optional' | 'required' }
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    additionalProperties?: boolean
  }
  outputSchema?: Record<string, unknown>
}

export interface FakeTushareMcpOptions {
  toolsPages?: readonly (readonly ToolFixture[])[]
  responders?: Readonly<Record<string, (args: Record<string, unknown>) => unknown>>
  isErrorTools?: Readonly<Record<string, string>>
  delayToolsMs?: Readonly<Record<string, number>>
  structuredTools?: readonly string[]
  repeatListCursor?: boolean
  notifyToolsChangedOnCall?: boolean
  delayInitializeMs?: number
  initializeGate?: Promise<void>
  onToolsList?: (pageIndex: number, requestIndex: number) => void | Promise<void>
  toolsByListRequest?: readonly (readonly ToolFixture[])[]
  onToolCall?: (name: string, args: Record<string, unknown>) => void | Promise<void>
}

export interface FakeTushareMcp {
  fetch: typeof fetch
  calls: Array<{ method: string; params?: Record<string, unknown> }>
  requests: Array<{ url: string; method: string }>
  initializeStarted: Promise<void>
}

export function createDeferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (reason?: unknown) => void
} {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function waitFor(promise: Promise<void>, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    const abort = () => {
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    void promise.then(
      () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      },
      error => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

export function createFakeTushareMcp(options: FakeTushareMcpOptions = {}): FakeTushareMcp {
  const pages = options.toolsPages ?? [[]]
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const requests: Array<{ url: string; method: string }> = []
  const initializeStarted = createDeferred()
  let toolsListRequestIndex = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' })
    if (init?.method === 'GET') return new Response(null, { status: 405 })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const request = JSON.parse(String(init?.body)) as {
      id?: string | number
      method: string
      params?: Record<string, unknown>
    }
    calls.push({ method: request.method, ...(request.params === undefined ? {} : { params: request.params }) })
    if (request.method === 'initialize') {
      initializeStarted.resolve()
      if (options.initializeGate !== undefined) await waitFor(options.initializeGate, init?.signal)
      if (options.delayInitializeMs !== undefined) await sleep(options.delayInitializeMs, init?.signal)
      return json({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake-tushare', version: '1.0.0' },
        },
      }, 200, { 'mcp-session-id': 'fixture-session' })
    }
    if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') {
      return new Response(null, { status: 202 })
    }
    if (request.method === 'tools/list') {
      const cursor = request.params?.cursor
      const index = cursor === undefined ? 0 : Number(String(cursor).replace('page-', ''))
      const requestIndex = toolsListRequestIndex++
      await options.onToolsList?.(index, requestIndex)
      const page = options.toolsByListRequest?.[requestIndex] ?? pages[index] ?? []
      const nextCursor = options.toolsByListRequest !== undefined
        ? undefined
        : options.repeatListCursor === true
        ? String(cursor ?? 'page-0')
        : index + 1 < pages.length ? `page-${index + 1}` : undefined
      return json({
        jsonrpc: '2.0',
        id: request.id,
        result: { tools: page, ...(nextCursor === undefined ? {} : { nextCursor }) },
      })
    }
    if (request.method === 'tools/call') {
      const name = String(request.params?.name)
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      await options.onToolCall?.(name, args)
      const delay = options.delayToolsMs?.[name]
      if (delay !== undefined) await sleep(delay, init?.signal)
      const failure = options.isErrorTools?.[name]
      if (failure !== undefined) {
        return json({
          jsonrpc: '2.0',
          id: request.id,
          result: { isError: true, content: [{ type: 'text', text: failure }] },
        })
      }
      const value = options.responders?.[name]?.(args) ?? []
      const structured = options.structuredTools?.includes(name) === true
      const response = {
        jsonrpc: '2.0',
        id: request.id,
        result: structured
          ? { structuredContent: value, content: [{ type: 'text', text: '{\"ignored\":true}' }] }
          : { content: [{ type: 'text', text: JSON.stringify(value) }] },
      }
      return json(options.notifyToolsChangedOnCall === true
        ? [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, response]
        : response)
    }
    return json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  }
  return { fetch, calls, requests, initializeStarted: initializeStarted.promise }
}

export const CORE_TOOLS = [
  {
    name: 'stock_basic',
    inputSchema: {
      type: 'object' as const,
      properties: { ts_code: { type: 'string' }, fields: { type: 'array' } },
      required: ['ts_code'],
    },
  },
  {
    name: 'trade_cal',
    inputSchema: {
      type: 'object' as const,
      properties: { exchange: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, is_open: { type: 'string' }, fields: { type: 'array' } },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'daily',
    inputSchema: {
      type: 'object' as const,
      properties: { ts_code: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, fields: { type: 'array' } },
      required: ['ts_code'],
    },
  },
  {
    name: 'fina_indicator',
    inputSchema: {
      type: 'object' as const,
      properties: { ts_code: { type: 'string' }, period: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'integer' }, fields: { type: 'array' } },
      required: ['ts_code'],
    },
  },
]
