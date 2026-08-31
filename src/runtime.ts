import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const RUNTIME_HOME = join(PROJECT_ROOT, '.runtime')
export const DEFAULT_WEB_PORT = 3180
export const RESERVED_PORTS = new Set([3080, 3090])
export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-v4-flash'

const PROFILE_NAMES = ['finance-headless', 'finance-dev'] as const
const LOCAL_RUNTIME_PACKAGES = [
  '@finance2dsh/dsh-bundle',
  '@finance2dsh/dsh-tools',
] as const
const CREDENTIAL_ENV_BY_PROVIDER = {
  'deepseek-official': 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-compatible': 'NGFI_API_KEY',
} as const

type SupportedProvider = keyof typeof CREDENTIAL_ENV_BY_PROVIDER

export interface PreparedRuntime {
  home: string
  environment: NodeJS.ProcessEnv
  provider: SupportedProvider
  model: string
  credentialSource: 'process-environment' | 'project-env' | 'not-required'
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

async function projectEnvironment(): Promise<{ environment: NodeJS.ProcessEnv; fromFile: Set<string> }> {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  const fromFile = new Set<string>()
  try {
    const values = parseDotEnv(await readFile(join(PROJECT_ROOT, '.env'), 'utf8'))
    for (const [key, value] of values) {
      if (environment[key] === undefined) {
        environment[key] = value
        fromFile.add(key)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { environment, fromFile }
}

function requiredText(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = environment[name]?.trim() || fallback
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} contains invalid characters`)
  return value
}

function resolveProvider(environment: NodeJS.ProcessEnv): SupportedProvider {
  const provider = requiredText(environment, 'NGFI_LLM_PROVIDER', DEFAULT_PROVIDER)
  if (!(provider in CREDENTIAL_ENV_BY_PROVIDER)) {
    throw new Error(`Unsupported NGFI_LLM_PROVIDER: ${provider}. Use deepseek-official, openai, anthropic, or openai-compatible.`)
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

function defaultModelFor(provider: SupportedProvider): string {
  if (provider === 'deepseek-official') return DEFAULT_MODEL
  if (provider === 'openai') return 'gpt-5'
  if (provider === 'anthropic') return 'claude-sonnet-4-5'
  return ''
}

function runtimeSettings(environment: NodeJS.ProcessEnv, provider: SupportedProvider, model: string): string[] {
  const reasoningEffort = environment.NGFI_REASONING_EFFORT?.trim()
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

export async function prepareRuntime(options: { requireCredential?: boolean } = {}): Promise<PreparedRuntime> {
  const loaded = await projectEnvironment()
  const provider = resolveProvider(loaded.environment)
  const model = requiredText(loaded.environment, 'NGFI_LLM_MODEL', defaultModelFor(provider))
  if (model === '') throw new Error('NGFI_LLM_MODEL is required for the openai-compatible provider')
  validateBaseUrl(loaded.environment, provider)

  const credentialName = CREDENTIAL_ENV_BY_PROVIDER[provider]
  const credential = loaded.environment[credentialName]?.trim()
  if ((options.requireCredential ?? false) && !credential) {
    throw new Error(`Missing ${credentialName}. Copy .env.example to .env and configure the selected provider.`)
  }

  await mkdir(RUNTIME_HOME, { recursive: true, mode: 0o700 })
  await chmod(RUNTIME_HOME, 0o700)
  await Promise.all(PROFILE_NAMES.map(materializeProfile))

  const presets = join(RUNTIME_HOME, '.agent-presets')
  await rm(presets, { recursive: true, force: true })
  await cp(join(PROJECT_ROOT, 'generated', 'agent-presets'), presets, { recursive: true })

  const settings = runtimeSettings(loaded.environment, provider, model)
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
  }
  const credentialSource = credential
    ? (loaded.fromFile.has(credentialName) ? 'project-env' : 'process-environment')
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
