import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DataCapability, ProviderHealth } from '@finance2dsh/core'
import { FinanceDataService } from '@finance2dsh/data-service'
import type { ProviderCatalogEntry, ProviderRegistration } from '@finance2dsh/data-service'
import {
  ASTOCK_CAPABILITIES,
  ASTOCK_PROVIDER_ID,
  createAStockProvider,
  type AStockProviderOptions,
} from '@finance2dsh/provider-astock'
import {
  CNE6_LOCAL_CAPABILITIES,
  createCne6LocalProvider,
  type Cne6LocalProviderOptions,
} from '@finance2dsh/provider-cne6'
import {
  createIfindOfficialProvider,
  IFIND_OFFICIAL_CAPABILITIES,
  IFIND_OFFICIAL_PROVIDER_ID,
} from '@finance2dsh/provider-ifind'
import {
  createTdxCommunityProvider,
  createTdxOfficialProvider,
  TDX_COMMUNITY_CAPABILITIES,
  TDX_COMMUNITY_PROVIDER_ID,
  TDX_OFFICIAL_CAPABILITIES,
  TDX_OFFICIAL_PROVIDER_ID,
} from '@finance2dsh/provider-tdx'
import {
  createTushareMcpProvider,
  resolveTushareEndpoint,
  TUSHARE_MCP_CAPABILITIES,
  type TushareMcpProvider,
} from '@finance2dsh/provider-tushare-mcp'

export const ASHARE_PROVIDER_IDS = [
  ASTOCK_PROVIDER_ID,
  'tushare-mcp',
  TDX_OFFICIAL_PROVIDER_ID,
  TDX_COMMUNITY_PROVIDER_ID,
  IFIND_OFFICIAL_PROVIDER_ID,
  'cne6-local',
] as const

export type AshareProviderId = typeof ASHARE_PROVIDER_IDS[number]

export interface AshareProviderCatalogEntry extends ProviderCatalogEntry {
  routable: boolean
}

export interface AshareDataComposition {
  readonly service: FinanceDataService
  readonly approvedProviderIds: readonly AshareProviderId[]
  catalog(): Promise<AshareProviderCatalogEntry[]>
  close(): Promise<void>
  readonly iwencaiConfigured: boolean
}

export interface AshareDataCompositionOptions {
  env?: NodeJS.ProcessEnv
  astock?: AStockProviderOptions
  cne6?: Cne6LocalProviderOptions
  projectRoot?: string
}

interface CatalogOnlyProvider {
  providerId: AshareProviderId
  capabilities: readonly DataCapability[]
  markets: readonly string[]
  qualityTier: ProviderRegistration['qualityTier']
  authMode: ProviderRegistration['authMode']
  priority: number
  health(signal?: AbortSignal): Promise<ProviderHealth>
}

function unavailableCatalogProvider(
  providerId: AshareProviderId,
  capabilities: readonly DataCapability[],
  qualityTier: ProviderRegistration['qualityTier'],
  authMode: ProviderRegistration['authMode'],
  priority: number,
  error: unknown,
): CatalogOnlyProvider {
  const message = error instanceof Error ? error.message : String(error)
  return {
    providerId, capabilities, markets: ['CN'], qualityTier, authMode, priority,
    health: async () => ({
      providerId,
      status: 'unavailable',
      checkedAt: new Date().toISOString(),
      message: `blocked: invalid local provider configuration (${message})`,
      capabilities: Object.fromEntries(capabilities.map(capability => [capability, 'unavailable'])),
    }),
  }
}

function configured(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key]?.trim()
  return value !== undefined && value !== ''
}

function registration(
  adapter: ProviderRegistration['adapter'] & { providerId: string },
  capabilities: readonly DataCapability[],
  options: Pick<ProviderRegistration, 'qualityTier' | 'authMode' | 'priority'>,
): ProviderRegistration {
  return {
    providerId: adapter.providerId,
    adapter,
    capabilities,
    markets: ['CN'],
    ...options,
  }
}

function catalogOnly(
  adapter: CatalogOnlyProvider,
  health: ProviderHealth,
): AshareProviderCatalogEntry {
  return {
    providerId: adapter.providerId,
    capabilities: adapter.capabilities,
    markets: adapter.markets,
    qualityTier: adapter.qualityTier,
    authMode: adapter.authMode,
    priority: adapter.priority,
    health,
    routable: false,
  }
}

/** Build the production A-share router and a catalog that also exposes dormant providers. */
export function createDefaultAshareDataComposition(
  options: AshareDataCompositionOptions = {},
): AshareDataComposition {
  const env = options.env ?? process.env
  const projectRoot = resolve(options.projectRoot ?? process.cwd())
  const service = new FinanceDataService()
  const catalogProviders: CatalogOnlyProvider[] = []
  const closers: Array<() => Promise<void>> = []

  const astock = createAStockProvider({ environment: env, ...options.astock })
  service.register({
    ...registration(astock, ASTOCK_CAPABILITIES, {
    qualityTier: 'fallback', authMode: 'none', priority: 10,
    }),
    rateLimit: { concurrency: 1, minIntervalMs: options.astock?.minRequestIntervalMs ?? 1_000 },
    retry: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 5_000, jitterRatio: 0.2 },
    circuitBreaker: { failureThreshold: 3, openDurationMs: 60_000, halfOpenMaxRequests: 1 },
  })

  let tushare: TushareMcpProvider
  try {
    const endpoint = resolveTushareEndpoint({ env })
    tushare = createTushareMcpProvider({ env })
    if (endpoint !== undefined) {
      service.register({
        ...registration(tushare, TUSHARE_MCP_CAPABILITIES, {
          qualityTier: 'standard', authMode: 'api-key', priority: 40,
        }),
        rateLimit: { concurrency: 2, minIntervalMs: 200 },
        retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 3_000, jitterRatio: 0.2 },
        circuitBreaker: { failureThreshold: 3, openDurationMs: 60_000, halfOpenMaxRequests: 1 },
      })
      closers.push(() => tushare.close())
    } else {
      catalogProviders.push({
        providerId: 'tushare-mcp', capabilities: TUSHARE_MCP_CAPABILITIES, markets: ['CN'],
        qualityTier: 'standard', authMode: 'api-key', priority: 40,
        health: signal => tushare.health(signal),
      })
    }
  } catch (error) {
    catalogProviders.push({
      ...unavailableCatalogProvider(
        'tushare-mcp', TUSHARE_MCP_CAPABILITIES, 'standard', 'api-key', 40, error,
      ),
    })
  }

  const tdxOfficial = createTdxOfficialProvider({ environment: env })
  catalogProviders.push({
    providerId: TDX_OFFICIAL_PROVIDER_ID, capabilities: TDX_OFFICIAL_CAPABILITIES, markets: ['CN'],
    qualityTier: 'authoritative', authMode: 'api-key', priority: 60,
    health: signal => tdxOfficial.health(signal),
  })

  try {
    const tdxCommunity = createTdxCommunityProvider({ environment: env })
    if (configured(env, 'TDX_COMMUNITY_SERVERS')) {
      service.register({
        ...registration(tdxCommunity, TDX_COMMUNITY_CAPABILITIES, {
          qualityTier: 'fallback', authMode: 'none', priority: 30,
        }),
        rateLimit: { concurrency: 1, minIntervalMs: 200 },
        retry: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: 0.2 },
        circuitBreaker: { failureThreshold: 3, openDurationMs: 60_000, halfOpenMaxRequests: 1 },
      })
      closers.push(() => tdxCommunity.close())
    } else {
      catalogProviders.push({
        providerId: TDX_COMMUNITY_PROVIDER_ID, capabilities: TDX_COMMUNITY_CAPABILITIES, markets: ['CN'],
        qualityTier: 'fallback', authMode: 'none', priority: 30,
        health: signal => tdxCommunity.health(signal),
      })
    }
  } catch (error) {
    catalogProviders.push({
      ...unavailableCatalogProvider(
        TDX_COMMUNITY_PROVIDER_ID, TDX_COMMUNITY_CAPABILITIES, 'fallback', 'none', 30, error,
      ),
    })
  }

  const ifind = createIfindOfficialProvider({ environment: env })
  catalogProviders.push({
    providerId: IFIND_OFFICIAL_PROVIDER_ID, capabilities: IFIND_OFFICIAL_CAPABILITIES, markets: ['CN'],
    qualityTier: 'authoritative', authMode: 'custom', priority: 50,
    health: signal => ifind.health(signal),
  })

  const configuredCne6Root = env.CNE6_DATA_ROOT?.trim()
  const cne6Root = configuredCne6Root
    ? resolve(configuredCne6Root)
    : resolve(projectRoot, 'packages/combinatorial-optimization/data')
  try {
    const cne6 = createCne6LocalProvider({ ...options.cne6, dataRoot: cne6Root })
    if (existsSync(resolve(cne6Root, 'CURRENT'))
      || existsSync(resolve(cne6Root, 'quality-report.json'))) {
      service.register(registration(cne6, CNE6_LOCAL_CAPABILITIES, {
        qualityTier: 'standard', authMode: 'local', priority: 35,
      }))
    } else {
      catalogProviders.push({
        providerId: 'cne6-local', capabilities: CNE6_LOCAL_CAPABILITIES, markets: ['CN'],
        qualityTier: 'standard', authMode: 'local', priority: 35,
        health: signal => cne6.health(signal),
      })
    }
  } catch (error) {
    catalogProviders.push({
      ...unavailableCatalogProvider(
        'cne6-local', CNE6_LOCAL_CAPABILITIES, 'standard', 'local', 35, error,
      ),
    })
  }

  return {
    service,
    approvedProviderIds: ASHARE_PROVIDER_IDS,
    iwencaiConfigured: configured(env, 'IWENCAI_API_KEY'),
    async catalog() {
      const routed = (await service.registry.catalog()).map(entry => ({
        ...entry,
        routable: healthAllowsRouting(entry.health, entry.capabilities),
      }))
      const dormant = await Promise.all(catalogProviders.map(async provider => (
        catalogOnly(provider, await provider.health())
      )))
      const byId = new Map([...routed, ...dormant].map(entry => [entry.providerId, entry]))
      return ASHARE_PROVIDER_IDS.map(id => byId.get(id)).filter(
        (entry): entry is AshareProviderCatalogEntry => entry !== undefined,
      )
    },
    async close() {
      await Promise.allSettled(closers.map(close => close()))
    },
  }
}

function healthAllowsRouting(
  health: ProviderHealth,
  capabilities: readonly DataCapability[],
): boolean {
  const allowed = (status: ProviderHealth['status']): boolean => status === 'healthy' || status === 'degraded'
  return allowed(health.status)
    && capabilities.some(capability => {
      const status = health.capabilities?.[capability]
      return status === undefined || allowed(status)
    })
}
