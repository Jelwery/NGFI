import { FinanceDataError, dataErrorKind } from '@finance2dsh/core'
import type { CanonicalDataResult } from '@finance2dsh/core'
import {
  assertReconciliationPlan,
  reconcileCrossSourceResults,
} from './reconciliation.js'
import type {
  CrossSourceReconciliationResult,
  ReconciliationContext,
  ReconciliationPolicy,
  ReconciliationSourceInput,
} from './reconciliation.js'
import { ProviderRegistry } from './registry.js'
import { ProviderRouter } from './router.js'
import type { ProviderRouterOptions } from './router.js'
import { assertCapabilityRequestBoundary } from './safety.js'
import type { ProviderRegistration, RouteOptions, ServiceCapabilityRequest } from './types.js'

export interface ServiceReconciliationOptions {
  /** Two or more explicit providers. Automatic provider selection is intentionally unsupported. */
  providers: readonly string[]
  policy: ReconciliationPolicy
  /** Forwarded to every isolated provider call; false forces fresh provider observations. */
  cache?: boolean
}

/** Small facade for applications that do not need to manage registry and router separately. */
export class FinanceDataService {
  readonly registry: ProviderRegistry
  readonly router: ProviderRouter

  constructor(options: ProviderRouterOptions = {}) {
    this.registry = new ProviderRegistry()
    this.router = new ProviderRouter(this.registry, options)
  }

  register(registration: ProviderRegistration): this {
    this.registry.register(registration)
    return this
  }

  execute<T>(
    request: ServiceCapabilityRequest,
    options: RouteOptions = {},
  ): Promise<CanonicalDataResult<T>> {
    return this.router.execute(request, options)
  }

  async reconcile(
    request: ServiceCapabilityRequest,
    options: ServiceReconciliationOptions,
  ): Promise<CrossSourceReconciliationResult> {
    request = assertCapabilityRequestBoundary(request)
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new FinanceDataError('reconciliation options must be an object', 'invalid-request', { retryable: false })
    }
    const optionKeys = Object.keys(options)
    if (optionKeys.some(key => key !== 'providers' && key !== 'policy' && key !== 'cache')) {
      throw new FinanceDataError('reconciliation options contain an unknown property', 'invalid-request', {
        retryable: false,
      })
    }
    if (options.cache !== undefined && typeof options.cache !== 'boolean') {
      throw new FinanceDataError('reconciliation cache option must be boolean', 'invalid-request', { retryable: false })
    }
    assertReconciliationPlan(request.capability, options.providers, options.policy)

    const providers = [...options.providers]
    const settled = await Promise.allSettled(providers.map(provider => (
      this.execute<unknown>(request, {
        provider,
        fallback: false,
        cache: options.cache ?? false,
      })
    )))
    const fatal = settled
      .map((outcome, index) => ({ outcome, provider: providers[index] as string }))
      .filter((entry): entry is { outcome: PromiseRejectedResult; provider: string } => (
        entry.outcome.status === 'rejected'
      ))
      .sort((left, right) => left.provider.localeCompare(right.provider))
      .find(({ outcome }) => {
        const kind = dataErrorKind(outcome.reason)
        return kind === 'invalid-request' || kind === 'schema-drift' || kind === 'aborted'
          || kind === 'ambiguous-instrument' || kind === 'conflicting-instrument'
      })
    if (fatal !== undefined) {
      if (fatal.outcome.reason instanceof Error) throw fatal.outcome.reason
      throw new FinanceDataError(
        `provider ${fatal.provider} failed reconciliation validation`,
        dataErrorKind(fatal.outcome.reason),
        { provider: fatal.provider, retryable: false },
      )
    }

    const sources: ReconciliationSourceInput[] = settled.map((outcome, index) => {
      const provider = providers[index] as string
      return outcome.status === 'fulfilled'
        ? { provider, result: outcome.value }
        : { provider, error: outcome.reason }
    })
    return reconcileCrossSourceResults({
      capability: request.capability,
      sources,
      policy: options.policy,
      context: reconciliationContext(request),
    })
  }
}

function reconciliationContext(request: ServiceCapabilityRequest): ReconciliationContext {
  const context: ReconciliationContext = {
    ...(request.instrument === undefined ? {} : { instrument: request.instrument }),
  }
  if (request.capability !== 'market-bars'
    || request.params === null
    || typeof request.params !== 'object'
    || Array.isArray(request.params)) return context
  const params = request.params as Record<string, unknown>
  return {
    ...context,
    ...(typeof params.interval === 'string' ? { interval: params.interval } : {}),
    ...(params.adjustment === 'none' || params.adjustment === 'qfq' || params.adjustment === 'hfq'
      ? { adjustment: params.adjustment }
      : {}),
  }
}
