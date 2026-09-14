import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const RUNTIME_HOME = join(PROJECT_ROOT, '.runtime')
export const DEFAULT_WEB_PORT = 3180
export const RESERVED_PORTS = new Set([3080, 3090])
export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-v4-flash'

const PROFILE_NAMES = ['finance-headless', 'finance-dev'] as const
export const AGENT_PRESET_NAMES = [
  'finance-analyst', 'company-research', 'strategy-research', 'portfolio-risk',
] as const
const LOCAL_RUNTIME_PACKAGES = [
  '@finance2dsh/dsh-bundle',
  '@finance2dsh/dsh-tools',
] as const
const CREDENTIAL_ENV_BY_PROVIDER = {
  'deepseek-official': 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-compatible': 'NGFI_API_KEY',
  'model-hub': 'MODEL_HUB_API_KEY',
  'trae-official': null,
} as const
const PROVIDER_SCOPED_PROJECT_ENV = new Set([
  'NGFI_LLM_MODEL',
  'NGFI_LLM_BASE_URL',
  'NGFI_LLM_API',
  'NGFI_CONTEXT_WINDOW',
  'NGFI_MAX_TOKENS',
  'NGFI_REASONING_EFFORT',
  'DEEPSEEK_BASE_URL',
])

export const MODEL_HUB_BASE_URL = 'https://aidp-i18ntt-sg.tiktok-row.net/api/modelhub/online/unified/v1'
export const TRAE_BASE_URL = 'https://copilot-cn.bytedance.net'
export const TRAE_MODEL = {
  id: 'GPT-5.6-Sol',
  configName: 'gpt-5.6-sol',
  backendModel: 'gpt-5.6-sol__dev',
  name: 'GPT-5.6-Sol',
  contextWindow: 272000,
  maxTokens: 32000,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  defaultReasoningEffort: 'xhigh',
} as const

function traeAuthPath(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.TRAE_AUTH_PATH?.trim()
  const traeCliHome = environment.TRAECLI_HOME?.trim()
  const traeHome = environment.TRAE_HOME?.trim()
  for (const [name, value] of [
    ['TRAE_AUTH_PATH', explicit], ['TRAECLI_HOME', traeCliHome], ['TRAE_HOME', traeHome],
  ] as const) {
    if (value !== undefined && /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`${name} contains invalid characters`)
    }
  }
  return resolve(explicit
    || (traeCliHome ? join(traeCliHome, 'auth.json')
      : join(traeHome || join(homedir(), '.trae'), 'cli', 'auth.json')))
}

export const DATA_PROVIDER_SECRET_ENV = new Set([
  'TUSHARE_TOKEN',
  'TUSHARE_MCP_URL',
  'TDX_DATA_KEY',
  'TDX_COMMUNITY_SERVERS',
  'IFIND_MCP_URL',
  'IFIND_MCP_CREDENTIAL',
  'IWENCAI_API_KEY',
])
const DEFAULT_DATA_SECRETS_PATH = join(RUNTIME_HOME, 'secrets', 'a-share-data.env')
const DEFAULT_PROJECT_ENV_PATH = join(PROJECT_ROOT, '.env')
const MAX_DATA_SECRETS_BYTES = 64 * 1024

type SupportedProvider = keyof typeof CREDENTIAL_ENV_BY_PROVIDER

export interface PreparedRuntime {
  home: string
  environment: NodeJS.ProcessEnv
  provider: SupportedProvider
  model: string
  credentialSource: 'process-environment' | 'project-env' | 'trae-auth-file' | 'not-required'
  cleanup(): Promise<void>
}

function parseDotEnv(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    let value = match[2] ?? ''
    if ((value.startsWith('\"') && value.endsWith('\"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/u, '').trim()
    }
    if (key !== undefined) values.set(key, value)
  }
  return values
}

export async function loadDataProviderSecrets(
  environment: NodeJS.ProcessEnv,
  path = DEFAULT_DATA_SECRETS_PATH,
): Promise<Set<string>> {
  const loaded = new Set<string>()
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return loaded
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('A-share data secrets path must be a regular file, not a symlink')
  }
  if (metadata.size > MAX_DATA_SECRETS_BYTES) {
    throw new Error('A-share data secrets file exceeds 64 KiB')
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new Error('A-share data secrets file must have mode 0600')
  }
  const values = parseDotEnv(await readFile(path, 'utf8'))
  for (const [key, value] of values) {
    if (!DATA_PROVIDER_SECRET_ENV.has(key)) {
      throw new Error(`Unsupported key in A-share data secrets file: ${key}`)
    }
    if (environment[key] === undefined) {
      environment[key] = value
      loaded.add(key)
    }
  }
  return loaded
}

async function projectEnvironment(
  dataSecretsPath = DEFAULT_DATA_SECRETS_PATH,
  projectEnvPath = DEFAULT_PROJECT_ENV_PATH,
): Promise<{ environment: NodeJS.ProcessEnv; fromFile: Set<string> }> {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  const fromFile = new Set<string>()
  try {
    const values = parseDotEnv(await readFile(projectEnvPath, 'utf8'))
    const processProvider = process.env.NGFI_LLM_PROVIDER?.trim()
    const projectProvider = values.get('NGFI_LLM_PROVIDER')?.trim()
    for (const [key, value] of values) {
      if (DATA_PROVIDER_SECRET_ENV.has(key)) {
        throw new Error(
          `A-share data secret ${key} is not allowed in the project .env; `
          + 'use the process environment or .runtime/secrets/a-share-data.env (mode 0600)',
        )
      }
      if (processProvider && projectProvider && processProvider !== projectProvider
        && PROVIDER_SCOPED_PROJECT_ENV.has(key)) {
        continue
      }
      if (environment[key] === undefined) {
        environment[key] = value
        fromFile.add(key)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const key of await loadDataProviderSecrets(environment, dataSecretsPath)) fromFile.add(key)
  return { environment, fromFile }
}

function requiredText(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = environment[name]?.trim() || fallback
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} contains invalid characters`)
  return value
}

function resolveProvider(environment: NodeJS.ProcessEnv): SupportedProvider {
  const provider = requiredText(environment, 'NGFI_LLM_PROVIDER', DEFAULT_PROVIDER)
  if (!Object.hasOwn(CREDENTIAL_ENV_BY_PROVIDER, provider)) {
    throw new Error(`Unsupported NGFI_LLM_PROVIDER: ${provider}. Use ${Object.keys(CREDENTIAL_ENV_BY_PROVIDER).join(', ')}.`)
  }
  return provider as SupportedProvider
}

function validateBaseUrl(environment: NodeJS.ProcessEnv, provider: SupportedProvider): void {
  if (provider !== 'openai-compatible') return
  const value = environment.NGFI_LLM_BASE_URL?.trim()
  if (!value) throw new Error('NGFI_LLM_BASE_URL is required for the openai-compatible provider')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('NGFI_LLM_BASE_URL must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('NGFI_LLM_BASE_URL must use HTTP or HTTPS')
  }
}

function rejectFixedProviderOverrides(environment: NodeJS.ProcessEnv, provider: SupportedProvider): void {
  const forbidden = provider === 'model-hub'
    ? ['NGFI_LLM_BASE_URL', 'NGFI_LLM_API']
    : provider === 'trae-official'
      ? ['NGFI_LLM_BASE_URL', 'NGFI_LLM_API', 'DEEPSEEK_BASE_URL']
      : []
  for (const name of forbidden) {
    if (environment[name]?.trim()) throw new Error(`${name} is not supported for ${provider}; the endpoint is statically pinned`)
  }
}

function defaultModelFor(provider: SupportedProvider): string {
  if (provider === 'deepseek-official') return DEFAULT_MODEL
  if (provider === 'openai') return 'gpt-5'
  if (provider === 'anthropic') return 'claude-sonnet-4-5'
  if (provider === 'trae-official') return TRAE_MODEL.id
  if (provider === 'model-hub') return 'gpt-5.6-terra'
  return ''
}

function runtimeSettings(environment: NodeJS.ProcessEnv, provider: SupportedProvider, model: string): string[] {
  const reasoningEffort = requiredText(environment, 'NGFI_REASONING_EFFORT',
    provider === 'trae-official' ? TRAE_MODEL.defaultReasoningEffort : '')
  if (provider === 'trae-official') {
    if (model !== TRAE_MODEL.id) throw new Error(`Unsupported Trae model: use ${TRAE_MODEL.id}; routes are statically pinned`)
    if (!(TRAE_MODEL.reasoningEfforts as readonly string[]).includes(reasoningEffort)) {
      throw new Error(`Unsupported NGFI_REASONING_EFFORT for Trae: use ${TRAE_MODEL.reasoningEfforts.join(', ')}`)
    }
  }
  if (provider === 'model-hub' && reasoningEffort) {
    throw new Error('NGFI_REASONING_EFFORT must be unset for model-hub; reasoning support is not declared')
  }
  const lines = [
    'agent-default-model:',
    `  provider: ${JSON.stringify(provider)}`,
    `  model: ${JSON.stringify(model)}`,
    ...(reasoningEffort ? [`  reasoningEffort: ${JSON.stringify(reasoningEffort)}`] : []),
  ]
  if (provider === 'deepseek-official') {
    lines.push(
      'llm-deepseek:',
      '  apiKeyEnv: DEEPSEEK_API_KEY',
      ...(environment.DEEPSEEK_BASE_URL?.trim()
        ? [`  baseURL: ${JSON.stringify(environment.DEEPSEEK_BASE_URL.trim())}`]
        : []),
    )
  } else if (provider === 'trae-official') {
    lines.push(
      'llm-trae:',
      `  baseURL: ${JSON.stringify(TRAE_BASE_URL)}`,
      `  authPath: ${JSON.stringify(traeAuthPath(environment))}`,
      '  streamIdleTimeoutMs: 300000',
      `  maxTokens: ${TRAE_MODEL.maxTokens}`,
      `  models: ${JSON.stringify([TRAE_MODEL])}`,
    )
  } else if (provider === 'model-hub') {
    lines.push(
      'llm-pi-ai:',
      '  streamIdleTimeoutMs: 300000',
      '  providers:',
      '    model-hub:',
      '      displayName: Model Hub',
      '      apiKeyEnv: MODEL_HUB_API_KEY',
      '      api: openai-completions',
      `      baseURL: ${JSON.stringify(MODEL_HUB_BASE_URL)}`,
      '      models:',
      `        - id: ${JSON.stringify(model)}`,
      `          name: ${JSON.stringify(model)}`,
      `          contextWindow: ${requiredPositiveInteger(environment, 'NGFI_CONTEXT_WINDOW', 262144)}`,
      `          maxTokens: ${requiredPositiveInteger(environment, 'NGFI_MAX_TOKENS', 32768)}`,
      '          reasoningEfforts: false',
    )
  } else if (provider === 'openai' || provider === 'anthropic') {
    lines.push(
      'llm-pi-ai:',
      '  providers:',
      `    ${provider}:`,
      `      apiKeyEnv: ${CREDENTIAL_ENV_BY_PROVIDER[provider]}`,
    )
  } else {
    lines.push(
      'llm-pi-ai:',
      '  providers:',
      '    openai-compatible:',
      '      displayName: OpenAI-compatible',
      '      apiKeyEnv: NGFI_API_KEY',
      `      api: ${JSON.stringify(environment.NGFI_LLM_API?.trim() || 'openai-completions')}`,
      `      baseURL: ${JSON.stringify(environment.NGFI_LLM_BASE_URL?.trim())}`,
      '      models:',
      `        - id: ${JSON.stringify(model)}`,
      `          name: ${JSON.stringify(model)}`,
      `          contextWindow: ${requiredPositiveInteger(environment, 'NGFI_CONTEXT_WINDOW', 131072)}`,
      `          maxTokens: ${requiredPositiveInteger(environment, 'NGFI_MAX_TOKENS', 8192)}`,
    )
  }
  return [...lines, '']
}

function requiredPositiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

async function removeIfSymlink(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (!stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink runtime package path: ${path}`)
    }
    await rm(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function linkPackage(profileDirectory: string, packageName: string, source: string): Promise<void> {
  const destination = join(profileDirectory, 'node_modules', ...packageName.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await removeIfSymlink(destination)
  await symlink(source, destination, 'dir')
}

async function resolveInstalledPackage(packageName: string): Promise<string> {
  if (packageName === '@finance2dsh/dsh-bundle') return join(PROJECT_ROOT, 'packages', 'dsh-finance-bundle')
  if (packageName === '@finance2dsh/dsh-tools') return join(PROJECT_ROOT, 'packages', 'dsh-finance-tools')
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve(`${packageName}/package.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
  let directory = dirname(require.resolve(packageName))
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === packageName) return directory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  throw new Error(`Unable to locate installed package root for ${packageName}`)
}

async function materializeProfile(name: typeof PROFILE_NAMES[number]): Promise<void> {
  const source = join(PROJECT_ROOT, 'profiles', name)
  const destination = join(RUNTIME_HOME, 'profiles', name)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await cp(source, destination, { recursive: true, force: true })

  for (const packageName of LOCAL_RUNTIME_PACKAGES) {
    await linkPackage(destination, packageName, await resolveInstalledPackage(packageName))
  }
}

export async function prepareRuntime(
  options: { requireCredential?: boolean; dataSecretsPath?: string; projectEnvPath?: string } = {},
): Promise<PreparedRuntime> {
  const loaded = await projectEnvironment(
    options.dataSecretsPath ?? DEFAULT_DATA_SECRETS_PATH,
    options.projectEnvPath ?? DEFAULT_PROJECT_ENV_PATH,
  )
  const provider = resolveProvider(loaded.environment)
  const model = requiredText(loaded.environment, 'NGFI_LLM_MODEL', defaultModelFor(provider))
  const preset = requiredText(loaded.environment, 'NGFI_AGENT_PRESET', 'finance-analyst')
  if (!AGENT_PRESET_NAMES.includes(preset as typeof AGENT_PRESET_NAMES[number])) {
    throw new Error(`Unsupported NGFI_AGENT_PRESET: ${preset}. Use ${AGENT_PRESET_NAMES.join(', ')}.`)
  }
  if (model === '') throw new Error('NGFI_LLM_MODEL is required for the openai-compatible provider')
  validateBaseUrl(loaded.environment, provider)
  rejectFixedProviderOverrides(loaded.environment, provider)
  const settings = runtimeSettings(loaded.environment, provider, model)

  const credentialName = CREDENTIAL_ENV_BY_PROVIDER[provider]
  const credential = credentialName === null ? undefined : loaded.environment[credentialName]?.trim()
  if (options.requireCredential ?? false) {
    if (provider === 'trae-official') {
      const { readTraeAuthHeader } = await import('@finance2dsh/dsh-bundle/trae')
      await readTraeAuthHeader(traeAuthPath(loaded.environment))
    } else if (!credential) {
      throw new Error(`Missing ${credentialName}. Copy .env.example to .env and configure the selected provider.`)
    }
  }

  await mkdir(RUNTIME_HOME, { recursive: true, mode: 0o700 })
  await chmod(RUNTIME_HOME, 0o700)
  await Promise.all(PROFILE_NAMES.map(materializeProfile))

  const presets = join(RUNTIME_HOME, '.agent-presets')
  await rm(presets, { recursive: true, force: true })
  await cp(join(PROJECT_ROOT, 'generated', 'agent-presets'), presets, { recursive: true })

  await writeFile(join(RUNTIME_HOME, 'settings.yaml'), settings.join('\n'), { encoding: 'utf8', mode: 0o600 })
  await chmod(join(RUNTIME_HOME, 'settings.yaml'), 0o600)

  const environment: NodeJS.ProcessEnv = {
    ...loaded.environment,
    DSH_HOME: RUNTIME_HOME,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_MODE: 'DISABLED',
    FINANCE2DSH_SKILLS_DIR: resolve(loaded.environment.FINANCE2DSH_SKILLS_DIR ?? join(PROJECT_ROOT, 'skills')),
    NGFI_LLM_PROVIDER: provider,
    NGFI_LLM_MODEL: model,
    NGFI_AGENT_PRESET: preset,
  }
  const credentialSource = provider === 'trae-official'
    ? ((options.requireCredential ?? false) ? 'trae-auth-file' : 'not-required')
    : credential
      ? (credentialName !== null && loaded.fromFile.has(credentialName) ? 'project-env' : 'process-environment')
      : 'not-required'
  return {
    home: RUNTIME_HOME,
    environment,
    provider,
    model,
    credentialSource,
    cleanup: async () => {},
  }
}

export async function resolveDshBin(): Promise<string> {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { bin?: { dsh?: unknown } }
  if (typeof manifest.bin?.dsh !== 'string') throw new Error('@deepseek-ai/dsh does not publish the expected dsh binary')
  return resolve(dirname(manifestPath), manifest.bin.dsh)
}

export async function runDsh(
  args: string[],
  options: { stdio?: 'inherit' | 'pipe'; requireCredential?: boolean } = {},
): Promise<number> {
  const runtime = await prepareRuntime({ requireCredential: options.requireCredential ?? true })
  const bin = await resolveDshBin()
  try {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: PROJECT_ROOT,
      env: runtime.environment,
      stdio: options.stdio ?? 'inherit',
    })
    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal)
    }
    process.once('SIGINT', forward)
    process.once('SIGTERM', forward)
    try {
      return await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', (status, signal) => {
          if (signal !== null) resolveExit(signal === 'SIGINT' ? 130 : 1)
          else resolveExit(status ?? 1)
        })
      })
    } finally {
      process.removeListener('SIGINT', forward)
      process.removeListener('SIGTERM', forward)
    }
  } finally {
    await runtime.cleanup()
  }
}

export async function assertPortAvailable(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`Invalid TCP port: ${port}`)
  if (RESERVED_PORTS.has(port)) throw new Error(`Port ${port} is reserved and may not be used by Finance2DSH`)
  await new Promise<void>((resolveReady, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(error => error === undefined ? resolveReady() : reject(error)))
  })
}

export async function findAvailablePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a loopback test port')))
        return
      }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2)
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  if (command === 'prepare') {
    const unknownArgs = args.filter(argument => argument !== '--require-credential')
    if (unknownArgs.length > 0) throw new Error(`Unknown prepare option: ${unknownArgs[0]}`)
    const runtime = await prepareRuntime({ requireCredential: args.includes('--require-credential') })
    process.stdout.write(`Prepared isolated DSH runtime at ${runtime.home} (${runtime.provider}/${runtime.model}; credential: ${runtime.credentialSource})\n`)
    return
  }
  if (command === 'dump') {
    const profile = args[0]
    if (!PROFILE_NAMES.includes(profile as typeof PROFILE_NAMES[number])) {
      throw new Error(`Unknown Finance2DSH profile: ${String(profile)}`)
    }
    process.exitCode = await runDsh(['--profile', profile as string, '--dump-config'], { requireCredential: false })
    return
  }
  if (command === 'headless') {
    if (args.length === 0 || args.join(' ').trim() === '') throw new Error('headless requires a task')
    process.exitCode = await runDsh(['--profile', 'finance-headless', args.join(' ')])
    return
  }
  if (command === 'web') {
    if (args.some(argument => argument === '--port' || argument.startsWith('--port='))) {
      throw new Error('Set FINANCE2DSH_PORT instead of passing --port so reserved-port checks cannot be bypassed')
    }
    const { environment } = await projectEnvironment()
    const rawPort = environment.FINANCE2DSH_PORT?.trim() || String(DEFAULT_WEB_PORT)
    const port = Number(rawPort)
    await assertPortAvailable(port)
    process.exitCode = await runDsh([
      '--profile', 'finance-dev', '--host', '127.0.0.1', '--port', String(port), ...args,
    ])
    return
  }
  throw new Error('Usage: tsx src/runtime.ts prepare [--require-credential]|dump <profile>|headless <task>|web [args...]')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
