import {
  FinanceDataError,
  type CanonicalDataResult,
  type CapabilityRequest,
  type DataCapability,
  type ProviderHealth,
  type ProviderHealthStatus,
} from '@finance2dsh/core'

export const IFIND_OFFICIAL_PROVIDER_ID = 'ifind-official' as const
/** Reserved identity for public 10jqka/THS pages; it is never an iFinD alias. */
export const THS_PUBLIC_SOURCE_ID = 'ths-public' as const

export const IFIND_OFFICIAL_CAPABILITIES = [
  'quote',
  'market-bars',
  'fundamentals',
  'research-consensus',
] as const satisfies readonly DataCapability[]

export interface IfindProviderHealth extends ProviderHealth {
  reason: 'missing-config' | 'invalid-config' | 'not-live-verified'
  authMode: 'custom'
  details: Readonly<Record<string, unknown>>
}

export interface IfindOfficialProviderOptions {
  mcpUrl?: string
  credential?: string
  environment?: NodeJS.ProcessEnv
  now?: () => number
}

/**
 * Dormant configuration boundary for the licensed iFinD MCP. It deliberately
 * performs no browser login, cookie discovery, or network calls.
 */
export class IfindOfficialProvider {
  readonly providerId = IFIND_OFFICIAL_PROVIDER_ID
  readonly name = IFIND_OFFICIAL_PROVIDER_ID
  readonly capabilities = IFIND_OFFICIAL_CAPABILITIES
  readonly markets = ['CN'] as const
  readonly authMode = 'custom' as const
  private readonly endpointState: 'missing' | 'valid' | 'invalid'
  private readonly hasCredential: boolean
  private readonly now: () => number

  constructor(options: IfindOfficialProviderOptions = {}) {
    const environment = options.environment ?? process.env
    const rawUrl = options.mcpUrl ?? environment.IFIND_MCP_URL
    const credential = options.credential ?? environment.IFIND_MCP_CREDENTIAL
    this.endpointState = endpointState(rawUrl)
    this.hasCredential = typeof credential === 'string' && credential.trim() !== ''
    this.now = options.now ?? Date.now
  }

  async health(signal?: AbortSignal): Promise<IfindProviderHealth> {
    throwIfAborted(signal)
    if (this.endpointState === 'invalid') {
      return this.healthResult(
        'unavailable',
        'blocked: IFIND_MCP_URL must be an absolute HTTPS URL without embedded credentials',
        'invalid-config',
        { endpointConfigured: true, credentialConfigured: this.hasCredential },
      )
    }
    if (this.endpointState === 'missing' || !this.hasCredential) {
      return this.healthResult(
        'dormant',
        'blocked: missing IFIND_MCP_URL or credential',
        'missing-config',
        {
          endpointConfigured: this.endpointState !== 'missing',
          credentialConfigured: this.hasCredential,
        },
      )
    }
    return this.healthResult(
      'dormant',
      'blocked: iFind official MCP is configured but dormant until an authenticated live handshake is verified',
      'not-live-verified',
      { endpointConfigured: true, credentialConfigured: true },
    )
  }

  async execute<T = unknown, P = Readonly<Record<string, unknown>>>(
    request: CapabilityRequest<P>,
  ): Promise<CanonicalDataResult<T>> {
    throwIfAborted(request.signal)
    const health = await this.health(request.signal)
    const missingCredential = health.reason === 'missing-config' && !this.hasCredential
    throw new FinanceDataError(health.message ?? 'iFind official MCP is dormant',
      missingCredential ? 'unauthorized' : 'unsupported', {
        provider: this.providerId,
        retryable: false,
        details: { reason: health.reason },
      })
  }

  private healthResult(
    status: ProviderHealthStatus,
    message: string,
    reason: IfindProviderHealth['reason'],
    configuration: Readonly<Record<string, unknown>>,
  ): IfindProviderHealth {
    return {
      providerId: this.providerId,
      status,
      checkedAt: new Date(this.now()).toISOString(),
      message,
      capabilities: Object.fromEntries(
        IFIND_OFFICIAL_CAPABILITIES.map(capability => [capability, status]),
      ),
      reason,
      authMode: this.authMode,
      details: {
        ...configuration,
        requiredEnvironment: ['IFIND_MCP_URL', 'IFIND_MCP_CREDENTIAL'],
        transport: 'mcp',
        sourceKind: 'licensed',
        liveVerified: false,
        cookieAcquisition: 'disabled',
        publicWebAlias: false,
      },
    }
  }
}

export function createIfindOfficialProvider(
  options?: IfindOfficialProviderOptions,
): IfindOfficialProvider {
  return new IfindOfficialProvider(options)
}

function endpointState(value: string | undefined): 'missing' | 'valid' | 'invalid' {
  if (value === undefined || value.trim() === '') return 'missing'
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hash === ''
      ? 'valid'
      : 'invalid'
  } catch {
    return 'invalid'
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new FinanceDataError('ifind-official request was aborted', 'aborted', {
      provider: IFIND_OFFICIAL_PROVIDER_ID,
      retryable: false,
    })
  }
}
