import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  ASHARE_TOOL_NAMES,
  PORTFOLIO_TOOL_NAMES,
  RESEARCH_TOOL_NAMES,
  SIGNAL_TOOL_NAMES,
  STRATEGY_TOOL_NAMES,
  createAshareFinanceTools,
  createFinanceTools,
  createGovernedFinanceTools,
} from '@finance2dsh/dsh-tools'
import type { FinanceDataProvider } from '@finance2dsh/core'
import {
  COMPANY_RESEARCH_TOOL_ALLOWLIST, FINANCE_TOOL_ALLOWLIST, PORTFOLIO_RISK_TOOL_ALLOWLIST,
  PRESET_TOOL_ALLOWLISTS, STRATEGY_RESEARCH_TOOL_ALLOWLIST,
} from '../packages/dsh-finance-bundle/src/policy.js'
import { PROJECT_ROOT, RUNTIME_HOME, prepareRuntime, resolveDshBin } from '../src/runtime.js'

const execFileAsync = promisify(execFile)
const EXPECTED_FINANCE_TOOLS = [
  'finance_behavior_reference',
  'finance_behavior_market_evidence',
  'finance_behavior_trade_audit',
  'finance_security_reference',
  'finance_fundamentals',
  'finance_market_data',
  'finance_estimates',
  'finance_comparables',
  'finance_wacc',
  'finance_dcf',
  'finance_dcf_sensitivity',
  'finance_relative_valuation',
]

const unusedProvider: FinanceDataProvider = {
  securityReference: async () => { throw new Error('not used') },
  fundamentals: async () => { throw new Error('not used') },
  marketData: async () => { throw new Error('not used') },
  estimates: async () => { throw new Error('not used') },
  comparables: async () => { throw new Error('not used') },
}

async function dump(profile: string): Promise<string> {
  const runtime = await prepareRuntime()
  const bin = await resolveDshBin()
  const { stdout } = await execFileAsync(process.execPath, [bin, '--profile', profile, '--dump-config'], {
    cwd: PROJECT_ROOT,
    env: runtime.environment,
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout
}

describe('DSH finance composition', () => {
  it('registers exactly the public V1 finance tool names', () => {
    expect(createFinanceTools(unusedProvider).map(tool => tool.name)).toEqual(EXPECTED_FINANCE_TOOLS)
    const ashareTools = createAshareFinanceTools({
      service: { execute: async () => { throw new Error('not used') } },
      approvedProviderIds: [],
      catalog: async () => [],
    })
    expect(ashareTools.map(tool => tool.name)).toEqual(ASHARE_TOOL_NAMES)
    expect(FINANCE_TOOL_ALLOWLIST).toEqual([
      'skill',
      ...EXPECTED_FINANCE_TOOLS,
      ...ASHARE_TOOL_NAMES,
    ])
    expect(COMPANY_RESEARCH_TOOL_ALLOWLIST).toEqual([...FINANCE_TOOL_ALLOWLIST, ...RESEARCH_TOOL_NAMES])
    expect(STRATEGY_RESEARCH_TOOL_ALLOWLIST).toEqual([
      ...FINANCE_TOOL_ALLOWLIST, ...STRATEGY_TOOL_NAMES, ...SIGNAL_TOOL_NAMES,
    ])
    expect(PORTFOLIO_RISK_TOOL_ALLOWLIST).toEqual([...FINANCE_TOOL_ALLOWLIST, ...PORTFOLIO_TOOL_NAMES])
    expect(PRESET_TOOL_ALLOWLISTS['finance-analyst']).toHaveLength(21)
  })

  it('registers the exact fifteen governed tool names without changing the legacy factory', () => {
    const governed = createGovernedFinanceTools({
      runtimeRoot: join(PROJECT_ROOT, '.runtime', 'test-finance-data'),
      quantProjectRoot: join(PROJECT_ROOT, 'packages', 'quant-research'),
    }).map(tool => tool.name)
    expect(governed).toEqual([
      ...RESEARCH_TOOL_NAMES, ...STRATEGY_TOOL_NAMES, ...SIGNAL_TOOL_NAMES, ...PORTFOLIO_TOOL_NAMES,
    ])
    expect(governed).toHaveLength(15)
    expect(new Set(governed).size).toBe(15)
    expect(createFinanceTools(unusedProvider).map(tool => tool.name)).toEqual(EXPECTED_FINANCE_TOOLS)
  })

  it('keeps the three governed presets isolated from unrelated tools', () => {
    expect(COMPANY_RESEARCH_TOOL_ALLOWLIST).not.toEqual(expect.arrayContaining([...STRATEGY_TOOL_NAMES, ...SIGNAL_TOOL_NAMES, ...PORTFOLIO_TOOL_NAMES]))
    expect(STRATEGY_RESEARCH_TOOL_ALLOWLIST).not.toEqual(expect.arrayContaining([...RESEARCH_TOOL_NAMES, ...PORTFOLIO_TOOL_NAMES]))
    expect(PORTFOLIO_RISK_TOOL_ALLOWLIST).not.toEqual(expect.arrayContaining([...RESEARCH_TOOL_NAMES, ...STRATEGY_TOOL_NAMES, ...SIGNAL_TOOL_NAMES]))
    for (const allowlist of Object.values(PRESET_TOOL_ALLOWLISTS)) {
      for (const forbidden of ['shell', 'bash', 'web_search', 'web_fetch', 'raw_provider', 'raw_mcp', 'place_order']) {
        expect(allowlist).not.toContain(forbidden)
      }
    }
  })

  it.each([
    ['finance_security_reference', { ticker: '600519.SS' }],
    ['finance_fundamentals', { ticker: '000001.SZ' }],
    ['finance_market_data', { ticker: '600519.SS' }],
    ['finance_estimates', { ticker: '000001.SZ' }],
    ['finance_comparables', { ticker: '600519.SS', peers: ['AAPL'] }],
  ])('forces A-share ticker input away from generic tool %s', async (name, args) => {
    const tool = createFinanceTools(unusedProvider).find(candidate => candidate.name === name)
    await expect(tool?.execute(args as never, { signal: new AbortController().signal } as never))
      .rejects.toThrow(/finance_cn_/i)
  })

  it('composes the headless profile with the public DeepSeek provider and project runner', async () => {
    const output = await dump('finance-headless')
    expect(output).toContain("provider: !!js process.env.NGFI_LLM_PROVIDER || 'deepseek-official'")
    expect(output).toContain("model: !!js process.env.NGFI_LLM_MODEL || 'deepseek-v4-flash'")
    const settings = await readFile(join(RUNTIME_HOME, 'settings.yaml'), 'utf8')
    expect(settings).toContain('provider: \"deepseek-official\"')
    expect(settings).toContain('model: \"deepseek-v4-flash\"')
    expect(output).toContain("name: '@deepseek-ai/dsh-llm-deepseek'")
    expect(output).toContain("name: '@finance2dsh/dsh-tools'")
    expect(output).toContain("name: '@deepseek-ai/dsh-agent-presets'")
    expect(output).toContain("name: '@finance2dsh/dsh-bundle/headless'")
    expect(output).toMatch(/id: headless-runner[\s\S]*?disabled: true/u)
    expect(output).toMatch(/id: tool-web[\s\S]*?fetch: false/u)
    expect(output).toContain("preset: !!js process.env.NGFI_AGENT_PRESET || 'finance-analyst'")
    expect(FINANCE_TOOL_ALLOWLIST).not.toContain('web_search')
    expect(FINANCE_TOOL_ALLOWLIST).not.toContain('web_fetch')
  }, 30_000)

  it('composes the Web profile without a finance-specific server or MCP', async () => {
    const output = await dump('finance-dev')
    expect(output).toContain("name: '@deepseek-ai/dsh-web-app")
    expect(output).toContain("name: '@finance2dsh/dsh-tools'")
    expect(output).toContain("default: !!js process.env.NGFI_AGENT_PRESET || 'finance-analyst'")
    expect(output).not.toContain('@deepseek-ai/dsh-mcp-client')
    expect(output).toMatch(/id: tool-web[\s\S]*?disabled: true/u)
    expect(FINANCE_TOOL_ALLOWLIST).not.toContain('web_search')
    expect(FINANCE_TOOL_ALLOWLIST).not.toContain('web_fetch')
  }, 30_000)

  it('materializes all governed presets through the DSH roster', async () => {
    const output = await dump('finance-dev')
    expect(output).toContain("default: !!js process.env.NGFI_AGENT_PRESET || 'finance-analyst'")
    const runtime = await prepareRuntime()
    for (const preset of ['company-research', 'strategy-research', 'portfolio-risk']) {
      const policy = await readFile(join(runtime.home, '.agent-presets', preset, 'agent.cordis.yml'), 'utf8')
      expect(policy).toContain(`preset: ${preset}`)
    }
  }, 30_000)
})
