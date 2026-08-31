import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  calculateBehaviorMarketEvidence,
  type BehaviorMarketEvidenceResult,
  type BehaviorProviderError,
  type BehaviorWindow,
  type FinanceDataProvider,
  type MarketData,
} from '@finance2dsh/core'

const CAVEAT = 'Market statistics describe a price path. A provider failure supplies no evidence, and market data cannot by itself establish a psychological bias, herding, FOMO, or a bubble.'

const WINDOW_PERIOD: Record<BehaviorWindow, string> = {
  20: '3mo',
  60: '6mo',
  120: '1y',
  252: '2y',
}

interface FetchRequest {
  request: 'target' | 'benchmark'
  ticker: string
}

function providerError(request: FetchRequest, error: unknown): BehaviorProviderError {
  const candidate = typeof error === 'object' && error !== null
    ? error as { kind?: unknown; message?: unknown; retryable?: unknown }
    : {}
  return {
    request: request.request,
    ticker: request.ticker,
    kind: typeof candidate.kind === 'string' ? candidate.kind : null,
    message: typeof candidate.message === 'string' && candidate.message.trim() !== ''
      ? candidate.message
      : 'market data provider failed without a usable error message',
    retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : null,
  }
}

async function fetchMarketEvidence(
  provider: FinanceDataProvider,
  ticker: string,
  benchmark: string | undefined,
  window: BehaviorWindow,
  signal: AbortSignal,
): Promise<BehaviorMarketEvidenceResult> {
  const requests: FetchRequest[] = [
    { request: 'target', ticker },
    ...(benchmark === undefined ? [] : [{ request: 'benchmark' as const, ticker: benchmark }]),
  ]
  const settled = await Promise.allSettled(requests.map(async request => ({
    request,
    data: await provider.marketData(request.ticker, {
      period: WINDOW_PERIOD[window],
      interval: '1d',
      signal,
    }),
  })))
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('market evidence request was aborted')

  const data = new Map<FetchRequest['request'], MarketData>()
  const errors: BehaviorProviderError[] = []
  settled.forEach((result, index) => {
    const request = requests[index] as FetchRequest
    if (result.status === 'fulfilled') data.set(request.request, result.value.data)
    else errors.push(providerError(request, result.reason))
  })
  if (errors.length > 0) {
    return {
      status: 'provider-error',
      ticker,
      benchmark: benchmark ?? null,
      window,
      observation: {
        target: data.get('target')?.observation ?? null,
        benchmark: data.get('benchmark')?.observation ?? null,
      },
      providerErrors: errors,
      diagnosticCaveat: CAVEAT,
      limitations: ['One or more requested market histories were unavailable. No missing market values or derived metrics were fabricated.'],
    }
  }
  const target = data.get('target')
  if (target === undefined) throw new Error('market evidence adapter invariant failed: target result is absent')
  const benchmarkData = data.get('benchmark')
  return calculateBehaviorMarketEvidence({
    target,
    ...(benchmarkData === undefined ? {} : { benchmark: benchmarkData }),
    window,
  })
}

export function createBehaviorMarketEvidenceTool(provider: FinanceDataProvider): ToolDefinition {
  return defineTool({
    name: 'finance_behavior_market_evidence',
    description: 'Fetch and calculate neutral price-path evidence for a ticker over exactly 20, 60, 120, or 252 valid daily closes, optionally aligned to a benchmark. For behavioral interpretation, first load investment-behavior-diagnosis with the skill tool; a user asking only for neutral statistics may use this tool directly. Report provenance, status, coverage, material missing fields and limitations alongside returns, drawdown, volatility, momentum and volume change. It does not diagnose a bias or prove FOMO, herding, or a bubble.',
    parameters: {
      ticker: { type: 'string', required: true, description: 'Public-market ticker.' },
      benchmark: { type: 'string', description: 'Optional benchmark ticker for date-aligned relative return.' },
      window: { type: 'integer', enum: [20, 60, 120, 252], required: true, description: 'Number of latest valid daily closes to analyze.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await fetchMarketEvidence(provider, args.ticker, args.benchmark, args.window, exec.signal) as never
    },
  })
}
