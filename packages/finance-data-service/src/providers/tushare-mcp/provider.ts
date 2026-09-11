import { FinanceDataError } from '@finance2dsh/core'
import type {
  CanonicalDataResult,
  CapabilityRequest,
  DataCapability,
  ProviderHealth,
  ProviderHealthStatus,
} from '@finance2dsh/core'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { TushareMcpClient } from './client.js'
import { resolveCapabilityTool, TUSHARE_MCP_CAPABILITIES } from './discovery.js'
import type { TushareMcpCapability, ValidatedToolInventory } from './discovery.js'
import { createMappedCall } from './mapping.js'
import { classifyTushareError, resolveTushareEndpoint, TushareMcpError } from './security.js'
import type { ResolvedTushareEndpoint } from './security.js'

const PROVIDER_ID = 'tushare-mcp' as const

export interface TushareMcpProviderOptions {
  url?: string
  token?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  toolsCacheTtlMs?: number
  fetch?: FetchLike
  now?: () => Date
  nowMs?: () => number
}

export interface TushareMcpInventory {
  server?: { name: string; version: string }
  toolNames: readonly string[]
  capabilities: readonly TushareMcpCapability[]
  unavailableCapabilities: Readonly<Partial<Record<TushareMcpCapability, string>>>
}

function isSupportedCapability(value: DataCapability): value is TushareMcpCapability {
  return TUSHARE_MCP_CAPABILITIES.includes(value as TushareMcpCapability)
}

function healthStatus(error: TushareMcpError): ProviderHealthStatus {
  if (error.kind === 'unauthorized') return 'unauthorized'
  return 'unavailable'
}

function capabilityHealth(
  inventory: ValidatedToolInventory,
): Partial<Record<DataCapability, ProviderHealthStatus>> {
  return Object.fromEntries(TUSHARE_MCP_CAPABILITIES.map(capability => [
    capability,
    inventory.capabilities.includes(capability) ? 'healthy' : 'unavailable',
  ]))
}

export class TushareMcpProvider {
  readonly providerId = PROVIDER_ID
  readonly name = PROVIDER_ID
  readonly capabilities = TUSHARE_MCP_CAPABILITIES
  private readonly endpoint?: ResolvedTushareEndpoint
  private readonly client?: TushareMcpClient
  private readonly now: () => Date
  private readonly configurationError?: TushareMcpError

  constructor(options: TushareMcpProviderOptions = {}) {
    this.now = options.now ?? (() => new Date())
    let endpoint: ResolvedTushareEndpoint | undefined
    try {
      endpoint = resolveTushareEndpoint({
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.env === undefined ? {} : { env: options.env }),
      })
    } catch (error) {
      this.configurationError = classifyTushareError(error)
      return
    }
    if (endpoint === undefined) return
    this.endpoint = endpoint
    this.client = new TushareMcpClient({
      endpoint,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.toolsCacheTtlMs === undefined ? {} : { toolsCacheTtlMs: options.toolsCacheTtlMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.nowMs === undefined ? {} : { now: options.nowMs }),
    })
  }

  async execute<T = unknown, P = Readonly<Record<string, unknown>>>(
    request: CapabilityRequest<P>,
  ): Promise<CanonicalDataResult<T>> {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new FinanceDataError('capability request must be an object', 'invalid-request', { provider: PROVIDER_ID })
    }
    if (!isSupportedCapability(request.capability)) {
      throw new FinanceDataError(
        'TuShare MCP does not support the requested capability',
        'unsupported',
        { provider: PROVIDER_ID, retryable: false },
      )
    }
    if (typeof request.market !== 'string' || request.market.toUpperCase() !== 'CN') {
      throw new FinanceDataError('TuShare MCP provider supports market CN only', 'unsupported', {
        provider: PROVIDER_ID,
        retryable: false,
      })
    }
    const client = this.requireClient()
    const deadline = client.createDeadline()
    try {
      const inventory = await client.discoverTools(request.signal, { deadline })
      const tool = resolveCapabilityTool(inventory, request.capability, request.instrument)
      const mapped = createMappedCall(request.capability, request as CapabilityRequest, tool, client.redactedEndpoint, this.now)
      const response = await client.call({ tool, arguments: mapped.arguments }, request.signal, { deadline })
      return mapped.map(response.value) as CanonicalDataResult<T>
    } catch (error) {
      throw classifyTushareError(error, this.endpoint?.secrets)
    }
  }

  async inventory(signal?: AbortSignal, options: { refresh?: boolean } = {}): Promise<TushareMcpInventory> {
    const client = this.requireClient()
    const inventory = await client.discoverTools(signal, options)
    return {
      ...(client.serverVersion === undefined ? {} : { server: structuredClone(client.serverVersion) }),
      toolNames: [...inventory.toolNames],
      capabilities: [...inventory.capabilities],
      unavailableCapabilities: structuredClone(inventory.unavailableCapabilities),
    }
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const checkedAt = this.now().toISOString()
    if (this.configurationError !== undefined) {
      return {
        providerId: PROVIDER_ID,
        status: 'dormant',
        checkedAt,
        message: `invalid TuShare MCP configuration: ${this.configurationError.message}`,
        capabilities: Object.fromEntries(this.capabilities.map(capability => [capability, 'dormant'])),
      }
    }
    if (this.client === undefined) {
      return {
        providerId: PROVIDER_ID,
        status: 'dormant',
        checkedAt,
        message: 'set TUSHARE_MCP_URL or TUSHARE_TOKEN to enable this optional provider',
        capabilities: Object.fromEntries(this.capabilities.map(capability => [capability, 'dormant'])),
      }
    }
    try {
      const inventory = await this.client.discoverTools(signal)
      const allAvailable = inventory.capabilities.length === this.capabilities.length
      return {
        providerId: PROVIDER_ID,
        status: allAvailable ? 'healthy' : 'degraded',
        checkedAt,
        message: allAvailable
          ? `connected to ${this.client.redactedEndpoint}; all curated capabilities are available`
          : `connected to ${this.client.redactedEndpoint}; ${inventory.capabilities.length}/${this.capabilities.length} curated capabilities are available`,
        capabilities: capabilityHealth(inventory),
      }
    } catch (error) {
      const classified = classifyTushareError(error, this.endpoint?.secrets)
      if (classified.kind === 'aborted') throw classified
      const status = healthStatus(classified)
      return {
        providerId: PROVIDER_ID,
        status,
        checkedAt,
        message: classified.message,
        capabilities: Object.fromEntries(this.capabilities.map(capability => [capability, status])),
      }
    }
  }

  close(): Promise<void> {
    return this.client?.close() ?? Promise.resolve()
  }

  private requireClient(): TushareMcpClient {
    if (this.configurationError !== undefined) throw this.configurationError
    if (this.client === undefined) {
      throw new TushareMcpError(
        'TuShare MCP is dormant; set TUSHARE_MCP_URL or TUSHARE_TOKEN',
        'unauthorized',
        'missing-configuration',
        { retryable: false },
      )
    }
    return this.client
  }
}

export function createTushareMcpProvider(options?: TushareMcpProviderOptions): TushareMcpProvider {
  return new TushareMcpProvider(options)
}
