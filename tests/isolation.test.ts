import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROJECT_ROOT,
  RESERVED_PORTS,
  RUNTIME_HOME,
  assertPortAvailable,
  prepareRuntime,
} from '../src/runtime.js'

const originalEnvironment = {
  DSH_HOME: process.env.DSH_HOME,
  FINANCE2DSH_SKILLS_DIR: process.env.FINANCE2DSH_SKILLS_DIR,
  NGFI_LLM_PROVIDER: process.env.NGFI_LLM_PROVIDER,
  NGFI_LLM_MODEL: process.env.NGFI_LLM_MODEL,
  NGFI_LLM_BASE_URL: process.env.NGFI_LLM_BASE_URL,
  NGFI_API_KEY: process.env.NGFI_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('isolated runtime', () => {
  it('uses the project runtime and public DeepSeek defaults without storing credentials', async () => {
    process.env.DSH_HOME = '/tmp/must-not-be-used-by-finance2dsh'
    delete process.env.FINANCE2DSH_SKILLS_DIR
    delete process.env.NGFI_LLM_PROVIDER
    delete process.env.NGFI_LLM_MODEL
    const runtime = await prepareRuntime()
    expect(runtime.home).toBe(join(PROJECT_ROOT, '.runtime'))
    expect(runtime.environment.DSH_HOME).toBe(RUNTIME_HOME)
    expect(runtime.environment.DSH_TELEMETRY_MODE).toBe('DISABLED')
    expect(runtime.environment.FINANCE2DSH_SKILLS_DIR).toBe(join(PROJECT_ROOT, 'skills'))
    expect(runtime.provider).toBe(DEFAULT_PROVIDER)
    expect(runtime.model).toBe(DEFAULT_MODEL)

    const bundle = join(RUNTIME_HOME, 'profiles/finance-headless/node_modules/@finance2dsh/dsh-bundle')
    expect((await lstat(bundle)).isSymbolicLink()).toBe(true)
    const settings = await readFile(join(RUNTIME_HOME, 'settings.yaml'), 'utf8')
    expect(settings).toContain('provider: \"deepseek-official\"')
    expect(settings).toContain('apiKeyEnv: DEEPSEEK_API_KEY')
    expect(settings).not.toMatch(/access_token|api[_-]?key\s*:\s*(?!DEEPSEEK_API_KEY)/iu)
  })

  it('requires the selected credential only for real model calls', async () => {
    process.env.NGFI_LLM_PROVIDER = 'deepseek-official'
    delete process.env.DEEPSEEK_API_KEY
    await expect(prepareRuntime({ requireCredential: true })).rejects.toThrow(/DEEPSEEK_API_KEY/)
  })

  it('materializes a generic OpenAI-compatible provider without persisting its key', async () => {
    process.env.NGFI_LLM_PROVIDER = 'openai-compatible'
    process.env.NGFI_LLM_MODEL = 'example-model'
    process.env.NGFI_LLM_BASE_URL = 'https://gateway.example/v1'
    process.env.NGFI_API_KEY = 'test-only-placeholder'
    const runtime = await prepareRuntime({ requireCredential: true })
    expect(runtime.provider).toBe('openai-compatible')
    expect(runtime.credentialSource).toBe('process-environment')
    const settings = await readFile(join(RUNTIME_HOME, 'settings.yaml'), 'utf8')
    expect(settings).toContain('baseURL: \"https://gateway.example/v1\"')
    expect(settings).toContain('id: \"example-model\"')
    expect(settings).toContain('apiKeyEnv: NGFI_API_KEY')
    expect(settings).not.toContain('test-only-placeholder')
  })

  it('rejects an OpenAI-compatible provider without an absolute HTTP endpoint', async () => {
    process.env.NGFI_LLM_PROVIDER = 'openai-compatible'
    process.env.NGFI_LLM_MODEL = 'example-model'
    process.env.NGFI_LLM_BASE_URL = 'not-a-url'
    await expect(prepareRuntime()).rejects.toThrow(/absolute HTTP/)
  })

  it('allows an explicit isolated skill root for baseline comparisons', async () => {
    process.env.FINANCE2DSH_SKILLS_DIR = './skills/investment-behavior-diagnosis-workspace/skill-snapshot'
    const runtime = await prepareRuntime()
    expect(runtime.environment.FINANCE2DSH_SKILLS_DIR).toBe(
      join(PROJECT_ROOT, 'skills/investment-behavior-diagnosis-workspace/skill-snapshot'),
    )
  })

  it('rejects both native DSH default ports', async () => {
    expect([...RESERVED_PORTS]).toEqual([3080, 3090])
    await expect(assertPortAvailable(3080)).rejects.toThrow(/reserved/)
    await expect(assertPortAvailable(3090)).rejects.toThrow(/reserved/)
  })
})
