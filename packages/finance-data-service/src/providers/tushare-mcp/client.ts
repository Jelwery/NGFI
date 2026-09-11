import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { validateToolArguments, validateToolInventory, validateToolResult } from './discovery.js'
import type { ValidatedToolInventory } from './discovery.js'
import { classifyTushareError, TushareMcpError } from './security.js'
import type { ResolvedTushareEndpoint } from './security.js'

const CLIENT_INFO = { name: 'finance2dsh-tushare-mcp', version: '0.1.0' } as const
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface TushareMcpClientOptions {
  endpoint: ResolvedTushareEndpoint
  timeoutMs?: number
  toolsCacheTtlMs?: number
  fetch?: FetchLike
  now?: () => number
}

export interface TushareToolCall {
  tool: Tool
  arguments: Readonly<Record<string, unknown>>
}

export interface ParsedToolResult {
  value: unknown
  source: 'structuredContent' | 'text'
}

interface OpeningAttempt {
  readonly generation: number
  readonly controller: AbortController
  readonly waiters: Map<symbol, number>
  promise: Promise<Client>
  transport?: StreamableHTTPClientTransport
  deadlineTimer?: ReturnType<typeof setTimeout>
  closePromise?: Promise<void>
  state: 'opening' | 'connected' | 'failed' | 'abandoned' | 'closed'
}

export interface TushareMcpDeadlineOptions {
  readonly deadline?: number
}

export interface DiscoverToolsOptions extends TushareMcpDeadlineOptions {
  readonly refresh?: boolean
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  if (name === 'timeoutMs' && value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

function abortedError(): DOMException {
  return new DOMException('TuShare MCP operation was aborted', 'AbortError')
}

function timeoutError(): TushareMcpError {
  return new TushareMcpError('TuShare MCP operation timed out', 'timeout', 'timeout', { retryable: true })
}

function errorText(result: CallToolResult): string {
  const text = result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: 'text' }> => item.type === 'text')
    .map(item => item.text.trim())
    .filter(Boolean)
    .join('\n')
  if (text !== '') return text
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return 'TuShare MCP tool returned isError without diagnostic text'
}

function parseTextResult(result: CallToolResult): unknown {
  const blocks = result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: 'text' }> => item.type === 'text')
    .map(item => item.text.trim())
    .filter(Boolean)
  if (blocks.length === 0) {
    throw new TushareMcpError('TuShare MCP tool returned no structured or text data', 'schema-drift', 'schema-drift')
  }
  const parsed: unknown[] = []
  for (const block of blocks) {
    try {
      parsed.push(JSON.parse(block) as unknown)
    } catch {
      throw new TushareMcpError(
        'TuShare MCP tool returned non-JSON text content',
        'schema-drift',
        'schema-drift',
      )
    }
  }
  if (parsed.length === 1) return parsed[0]
  if (parsed.every(Array.isArray)) return parsed.flat()
  return parsed
}

export function parseToolResult(result: CallToolResult, secrets: readonly string[] = []): ParsedToolResult {
  if (result.isError === true) throw classifyTushareError(new Error(errorText(result)), secrets)
  if (result.structuredContent !== undefined) {
    return { value: structuredClone(result.structuredContent), source: 'structuredContent' }
  }
  return { value: parseTextResult(result), source: 'text' }
}

export class TushareMcpClient {
  private readonly endpoint: ResolvedTushareEndpoint
  private readonly timeoutMs: number
  private readonly toolsCacheTtlMs: number
  private readonly fetch: FetchLike | undefined
  private readonly now: () => number
  private client: Client | undefined
  private transport: StreamableHTTPClientTransport | undefined
  private opening: OpeningAttempt | undefined
  private inventory: { value: ValidatedToolInventory; expiresAt: number } | undefined
  private inventoryRefreshTail: Promise<void> = Promise.resolve()
  private inventoryGeneration = 0
  private connectionGeneration = 0

  constructor(options: TushareMcpClientOptions) {
    this.endpoint = options.endpoint
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, 'timeoutMs')
    this.toolsCacheTtlMs = positiveInteger(options.toolsCacheTtlMs ?? 5 * 60_000, 'toolsCacheTtlMs')
    this.fetch = options.fetch
    this.now = options.now ?? Date.now
  }

  get redactedEndpoint(): string {
    return this.endpoint.redactedUrl
  }

  get serverVersion(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion()
  }

  createDeadline(): number {
    return this.now() + this.timeoutMs
  }

  invalidateTools(): void {
    this.inventoryGeneration += 1
    this.inventory = undefined
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const deadline = this.createDeadline()
    try {
      await this.connected(signal, deadline)
      this.remainingTimeout(deadline)
    } catch (error) {
      throw classifyTushareError(error, this.endpoint.secrets)
    }
  }

  async discoverTools(signal?: AbortSignal, options: DiscoverToolsOptions = {}): Promise<ValidatedToolInventory> {
    const deadline = options.deadline ?? this.createDeadline()
    try {
      signal?.throwIfAborted()
      this.remainingTimeout(deadline)
      if (options.refresh !== true && this.inventory !== undefined && this.inventory.expiresAt > this.now()) {
        return this.inventory.value
      }
      const client = await this.connected(signal, deadline)
      this.remainingTimeout(deadline)
      const predecessor = this.inventoryRefreshTail
      let releaseTurn!: () => void
      this.inventoryRefreshTail = new Promise<void>(resolve => { releaseTurn = resolve })
      try {
        await this.waitForInventoryTurn(predecessor, signal, deadline)
        if (options.refresh !== true && this.inventory !== undefined && this.inventory.expiresAt > this.now()) {
          return this.inventory.value
        }
        const inventoryGeneration = ++this.inventoryGeneration
        const tools: Tool[] = []
        const seenCursors = new Set<string>()
        let cursor: string | undefined
        for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
          const requestedCursor = cursor
          const remainingTimeout = this.remainingTimeout(deadline)
          const result = await client.listTools(
            requestedCursor === undefined ? undefined : { cursor: requestedCursor },
            {
              ...(signal === undefined ? {} : { signal }),
              timeout: remainingTimeout,
              maxTotalTimeout: remainingTimeout,
            },
          )
          this.remainingTimeout(deadline)
          tools.push(...result.tools)
          if (result.nextCursor === undefined || result.nextCursor === '') {
            const inventory = validateToolInventory(tools)
            if (inventoryGeneration === this.inventoryGeneration) {
              this.inventory = { value: inventory, expiresAt: this.now() + this.toolsCacheTtlMs }
            }
            return inventory
          }
          if (result.nextCursor === requestedCursor || seenCursors.has(result.nextCursor)) {
            throw new TushareMcpError('tools/list pagination returned a repeated cursor', 'schema-drift', 'schema-drift')
          }
          if (requestedCursor !== undefined) seenCursors.add(requestedCursor)
          seenCursors.add(result.nextCursor)
          cursor = result.nextCursor
        }
        throw new TushareMcpError('tools/list pagination exceeded 100 pages', 'schema-drift', 'schema-drift')
      } finally {
        releaseTurn()
      }
    } catch (error) {
      throw classifyTushareError(error, this.endpoint.secrets)
    }
  }

  async call(
    call: TushareToolCall,
    signal?: AbortSignal,
    options: TushareMcpDeadlineOptions = {},
  ): Promise<ParsedToolResult> {
    const deadline = options.deadline ?? this.createDeadline()
    try {
      signal?.throwIfAborted()
      const argumentsCopy = structuredClone(call.arguments)
      validateToolArguments(call.tool, argumentsCopy)
      const client = await this.connected(signal, deadline)
      const remainingTimeout = this.remainingTimeout(deadline)
      const result = await client.request(
        { method: 'tools/call', params: { name: call.tool.name, arguments: argumentsCopy } },
        CallToolResultSchema,
        {
          ...(signal === undefined ? {} : { signal }),
          timeout: remainingTimeout,
          maxTotalTimeout: remainingTimeout,
        },
      )
      this.remainingTimeout(deadline)
      validateToolResult(call.tool, result)
      return parseToolResult(result, this.endpoint.secrets)
    } catch (error) {
      throw classifyTushareError(error, this.endpoint.secrets)
    }
  }

  async close(): Promise<void> {
    this.connectionGeneration += 1
    const client = this.client
    const opening = this.opening
    this.client = undefined
    this.transport = undefined
    this.opening = undefined
    this.invalidateTools()
    if (opening !== undefined) this.terminateOpening(opening, 'closed', abortedError())
    await Promise.all([
      client?.close(),
      opening?.closePromise,
      opening?.promise.catch(() => {}),
    ])
  }

  private connected(signal: AbortSignal | undefined, deadline: number): Promise<Client> {
    signal?.throwIfAborted()
    this.remainingTimeout(deadline)
    if (this.client?.transport !== undefined) {
      return Promise.resolve(this.client)
    }
    const attempt = this.opening ?? this.createOpeningAttempt()
    return this.waitForOpening(attempt, signal, deadline)
  }

  private createOpeningAttempt(): OpeningAttempt {
    const attempt: OpeningAttempt = {
      generation: this.connectionGeneration,
      controller: new AbortController(),
      waiters: new Map(),
      promise: undefined as unknown as Promise<Client>,
      state: 'opening',
    }
    this.opening = attempt
    attempt.promise = this.open(attempt)
    void attempt.promise.catch(() => {})
    return attempt
  }

  private waitForOpening(attempt: OpeningAttempt, signal: AbortSignal | undefined, deadline: number): Promise<Client> {
    signal?.throwIfAborted()
    const remaining = this.remainingTimeout(deadline)
    const waiter = Symbol('tushare-mcp-handshake-waiter')
    attempt.waiters.set(waiter, deadline)
    this.scheduleOpeningDeadline(attempt)

    return new Promise<Client>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        this.removeOpeningWaiter(attempt, waiter)
      }
      const settle = <T>(callback: (value: T) => void, value: T) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const aborted = () => settle(reject, abortedError())
      const timer = setTimeout(() => settle(reject, timeoutError()), remaining)
      signal?.addEventListener('abort', aborted, { once: true })
      void attempt.promise.then(
        client => settle(resolve, client),
        error => settle(reject, error),
      )
    })
  }

  private removeOpeningWaiter(attempt: OpeningAttempt, waiter: symbol): void {
    if (!attempt.waiters.delete(waiter) || attempt.state !== 'opening') return
    if (attempt.waiters.size === 0) {
      if (this.opening === attempt) this.opening = undefined
      this.terminateOpening(attempt, 'abandoned', abortedError())
      return
    }
    this.scheduleOpeningDeadline(attempt)
  }

  private async open(attempt: OpeningAttempt): Promise<Client> {
    const signal = attempt.controller.signal
    signal.throwIfAborted()
    const client = new Client(CLIENT_INFO, {
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: () => this.invalidateTools(),
        },
      },
    })
    const transport = new StreamableHTTPClientTransport(
      new URL(this.endpoint.url.toString()),
      {
        ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
        reconnectionOptions: {
          initialReconnectionDelay: 250,
          maxReconnectionDelay: 2_000,
          reconnectionDelayGrowFactor: 2,
          maxRetries: 1,
        },
      },
    )
    attempt.transport = transport
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined
        this.transport = undefined
        this.invalidateTools()
      }
    }
    client.onerror = () => {
      // The operation receiving the error reports a redacted failure. Avoid raw SDK diagnostics here.
    }
    try {
      // SDK 1.30's concrete streamable transport exposes `sessionId` as a getter
      // returning `string | undefined`, while its base Transport declaration uses an
      // exact optional property. Runtime behavior conforms to Transport. The SDK's
      // initialize timeout cannot be extended, so the shared, extendable attempt
      // deadline is enforced by `signal`; these values are only a timer-safe ceiling.
      await client.connect(transport as Transport, {
        signal,
        timeout: MAX_TIMER_DELAY_MS,
        maxTotalTimeout: MAX_TIMER_DELAY_MS,
      })
      if (attempt.generation !== this.connectionGeneration || this.opening !== attempt
        || attempt.state !== 'opening' || signal.aborted) {
        await this.closeOpeningTransport(attempt)
        throw new DOMException('TuShare MCP connection was aborted', 'AbortError')
      }
      attempt.state = 'connected'
      this.clearOpeningDeadline(attempt)
      this.opening = undefined
      this.client = client
      this.transport = transport
      this.invalidateTools()
      return client
    } catch (error) {
      if (attempt.state === 'opening') attempt.state = 'failed'
      if (this.opening === attempt) this.opening = undefined
      this.clearOpeningDeadline(attempt)
      await this.closeOpeningTransport(attempt)
      if (signal.reason instanceof TushareMcpError && signal.reason.kind === 'timeout') {
        throw signal.reason
      }
      if (attempt.generation !== this.connectionGeneration || attempt.state === 'closed' || attempt.state === 'abandoned') {
        throw new TushareMcpError('TuShare MCP connection was aborted', 'aborted', 'aborted', { retryable: false })
      }
      throw classifyTushareError(error, this.endpoint.secrets)
    }
  }

  private terminateOpening(
    attempt: OpeningAttempt,
    state: 'abandoned' | 'closed',
    reason: Error,
  ): void {
    if (attempt.state !== 'opening') return
    attempt.state = state
    this.clearOpeningDeadline(attempt)
    attempt.controller.abort(reason)
    void this.closeOpeningTransport(attempt)
  }

  private scheduleOpeningDeadline(attempt: OpeningAttempt): void {
    this.clearOpeningDeadline(attempt)
    if (attempt.state !== 'opening' || attempt.waiters.size === 0) return
    const deadline = Math.max(...attempt.waiters.values())
    const remaining = Math.ceil(deadline - this.now())
    if (!Number.isFinite(remaining) || remaining <= 0) {
      if (this.opening === attempt) this.opening = undefined
      this.terminateOpening(attempt, 'abandoned', timeoutError())
      return
    }
    attempt.deadlineTimer = setTimeout(() => {
      if (this.opening !== attempt || attempt.state !== 'opening') return
      this.opening = undefined
      this.terminateOpening(attempt, 'abandoned', timeoutError())
    }, remaining)
  }

  private clearOpeningDeadline(attempt: OpeningAttempt): void {
    if (attempt.deadlineTimer !== undefined) clearTimeout(attempt.deadlineTimer)
    delete attempt.deadlineTimer
  }

  private closeOpeningTransport(attempt: OpeningAttempt): Promise<void> {
    if (attempt.closePromise !== undefined) return attempt.closePromise
    attempt.closePromise = attempt.transport?.close().catch(() => {}) ?? Promise.resolve()
    return attempt.closePromise
  }

  private waitForInventoryTurn(
    predecessor: Promise<void>,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<void> {
    signal?.throwIfAborted()
    const remaining = this.remainingTimeout(deadline)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
      }
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const aborted = () => settle(() => reject(abortedError()))
      const timer = setTimeout(() => settle(() => reject(timeoutError())), remaining)
      signal?.addEventListener('abort', aborted, { once: true })
      void predecessor.then(() => settle(resolve))
    })
  }

  private remainingTimeout(deadline: number): number {
    const remaining = Math.ceil(deadline - this.now())
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw timeoutError()
    }
    return Math.min(remaining, this.timeoutMs)
  }
}
