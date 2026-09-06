import { spawnSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DATA_PROVIDER_SECRET_ENV,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROJECT_ROOT,
  RESERVED_PORTS,
  RUNTIME_HOME,
  assertPortAvailable,
  prepareRuntime,
} from '../src/runtime.js'
// @ts-expect-error The executable scanner is plain ESM and intentionally has no declaration output.
import { formatFinding, scanText } from '../scripts/security-scan.mjs'

const originalEnvironment = {
  DSH_HOME: process.env.DSH_HOME,
  FINANCE2DSH_SKILLS_DIR: process.env.FINANCE2DSH_SKILLS_DIR,
  NGFI_LLM_PROVIDER: process.env.NGFI_LLM_PROVIDER,
  NGFI_LLM_MODEL: process.env.NGFI_LLM_MODEL,
  NGFI_LLM_BASE_URL: process.env.NGFI_LLM_BASE_URL,
  NGFI_AGENT_PRESET: process.env.NGFI_AGENT_PRESET,
  NGFI_API_KEY: process.env.NGFI_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  ...Object.fromEntries([...DATA_PROVIDER_SECRET_ENV].map(name => [name, process.env[name]])),
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
    expect(runtime.environment.NGFI_AGENT_PRESET).toBe('finance-analyst')

    const bundle = join(RUNTIME_HOME, 'profiles/finance-headless/node_modules/@finance2dsh/dsh-bundle')
    expect((await lstat(bundle)).isSymbolicLink()).toBe(true)
    const settings = await readFile(join(RUNTIME_HOME, 'settings.yaml'), 'utf8')
    expect(settings).toContain('provider: \"deepseek-official\"')
    expect(settings).toContain('apiKeyEnv: DEEPSEEK_API_KEY')
    expect(settings).not.toMatch(/access_token|api[_-]?key\s*:\s*(?!DEEPSEEK_API_KEY)/iu)
  })

  it('accepts only the four governed Agent presets', async () => {
    process.env.NGFI_AGENT_PRESET = 'company-research'
    await expect(prepareRuntime()).resolves.toMatchObject({
      environment: expect.objectContaining({ NGFI_AGENT_PRESET: 'company-research' }),
    })
    process.env.NGFI_AGENT_PRESET = '../unsafe'
    await expect(prepareRuntime()).rejects.toThrow(/Unsupported NGFI_AGENT_PRESET/u)
  })

  it('requires the selected credential only for real model calls', async () => {
    process.env.NGFI_LLM_PROVIDER = 'deepseek-official'
    delete process.env.DEEPSEEK_API_KEY
    await expect(prepareRuntime({ requireCredential: true })).rejects.toThrow(/DEEPSEEK_API_KEY/)
  })

  it('loads only approved A-share secrets from a mode-0600 local file without persisting them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ngfi-data-secrets-'))
    const path = join(directory, 'providers.env')
    const testToken = ['unit', 'safe', 'tushare', 'value'].join('-')
    await writeFile(path, `TUSHARE_TOKEN=${testToken}\n`, { mode: 0o600 })
    await chmod(path, 0o600)
    delete process.env.TUSHARE_TOKEN

    const runtime = await prepareRuntime({ dataSecretsPath: path })
    expect(runtime.environment.TUSHARE_TOKEN).toBe(testToken)
    const settings = await readFile(join(RUNTIME_HOME, 'settings.yaml'), 'utf8')
    expect(settings).not.toContain(testToken)
  })

  it('rejects an A-share secrets file readable by other users', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'ngfi-data-secrets-mode-'))
    const path = join(directory, 'providers.env')
    await writeFile(path, 'TUSHARE_TOKEN=<safe-test-value>\n', { mode: 0o644 })
    await chmod(path, 0o644)
    await expect(prepareRuntime({ dataSecretsPath: path })).rejects.toThrow(/mode 0600/)
  })

  it('requires the dedicated secrets file to have exactly mode 0600', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'ngfi-data-secrets-mode-exact-'))
    const path = join(directory, 'providers.env')
    await writeFile(path, 'TUSHARE_TOKEN=<safe-test-value>\n', { mode: 0o400 })
    await chmod(path, 0o400)
    await expect(prepareRuntime({ dataSecretsPath: path })).rejects.toThrow(/mode 0600/)
  })

  it.each([...DATA_PROVIDER_SECRET_ENV])('rejects %s in the project .env even when process env has precedence', async key => {
    const directory = await mkdtemp(join(tmpdir(), 'ngfi-project-env-'))
    const projectEnvPath = join(directory, '.env')
    const missingSecretsPath = join(directory, 'missing-secrets.env')
    await writeFile(projectEnvPath, `${key}=<forbidden-project-env-value>\n`, { mode: 0o600 })
    process.env[key] = '<allowed-process-env-value>'

    await expect(prepareRuntime({ projectEnvPath, dataSecretsPath: missingSecretsPath }))
      .rejects.toThrow(new RegExp(`A-share data secret ${key} is not allowed`))
  })

  it('allows A-share secrets from process env and gives them precedence over the dedicated file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ngfi-process-data-secrets-'))
    const projectEnvPath = join(directory, 'missing-project.env')
    const dataSecretsPath = join(directory, 'providers.env')
    await writeFile(dataSecretsPath, 'TUSHARE_TOKEN=<safe-file-value>\n', { mode: 0o600 })
    await chmod(dataSecretsPath, 0o600)
    process.env.TUSHARE_TOKEN = '<YOUR_SAFE_PROCESS_VALUE>'

    const runtime = await prepareRuntime({ projectEnvPath, dataSecretsPath })
    expect(runtime.environment.TUSHARE_TOKEN).toBe('<YOUR_SAFE_PROCESS_VALUE>')
  })

  it('rejects symlinks and oversized A-share secret files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ngfi-data-secrets-invalid-'))
    const target = join(directory, 'target.env')
    const link = join(directory, 'link.env')
    await writeFile(target, 'TUSHARE_TOKEN=<safe-test-value>\n', { mode: 0o600 })
    await symlink(target, link)
    await expect(prepareRuntime({ dataSecretsPath: link })).rejects.toThrow(/regular file, not a symlink/)

    await rm(link)
    await writeFile(target, `#${'x'.repeat(64 * 1024)}\n`, { mode: 0o600 })
    await expect(prepareRuntime({ dataSecretsPath: target })).rejects.toThrow(/exceeds 64 KiB/)
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

describe('security scanner', () => {
  const secretValue = (...parts: string[]): string => parts.join('-')
  const joinedSecret = (...parts: string[]): string => parts.join('')

  it.each([
    'TDX_DATA_KEY',
    'IFIND_MCP_CREDENTIAL',
    'db_password',
    'clientCredential',
  ])('detects a literal assignment to %s', key => {
    const value = secretValue('live', 'value', '9Qv3pL7x2K')
    expect(scanText('src/config.ts', `const ${key} = "${value}"`)).toEqual([
      { file: 'src/config.ts', line: 1, rule: 'credential-assignment' },
    ])
  })

  it('permits explicit placeholders and environment references', () => {
    expect(scanText('.env.example', [
      'TDX_DATA_KEY=replace-with-your-tdx-data-key',
      'IFIND_MCP_CREDENTIAL=<YOUR_IFIND_CREDENTIAL>',
      'db_password=${DB_PASSWORD}',
      'clientCredential=process.env.CLIENT_CREDENTIAL',
    ].join('\n'))).toEqual([])
  })

  it('does not exempt a realistic value because its file or value contains test or fixture', () => {
    const value = secretValue('production', 'fixture', '9Qv3pL7x2K')
    expect(scanText('tests/fixtures/provider.env', `TDX_DATA_KEY=${value}`)).toEqual([
      { file: 'tests/fixtures/provider.env', line: 1, rule: 'credential-assignment' },
    ])
  })

  it('normalizes quoted and trailing-comment dotenv secrets before detecting copied values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ngfi-security-scan-dotenv-'))
    const scanner = join(directory, 'scripts/security-scan.mjs')
    const quoted = secretValue('quoted', 'local', '9Qv3pL7x2K')
    const commented = secretValue('commented', 'local', '8Rw4qM6y3J')

    try {
      await mkdir(join(directory, 'scripts'), { recursive: true })
      await mkdir(join(directory, '.runtime/secrets'), { recursive: true })
      await mkdir(join(directory, 'src'), { recursive: true })
      await copyFile(join(process.cwd(), 'scripts/security-scan.mjs'), scanner)
      await writeFile(join(directory, '.runtime/secrets/a-share-data.env'), [
        `TDX_DATA_KEY="${quoted}"`,
        `IFIND_MCP_CREDENTIAL=${commented} # rotated credential`,
      ].join('\n'), { mode: 0o600 })
      await writeFile(join(directory, 'src/public.txt'), [
        `display_name=${quoted}`,
        `provider_label=${commented}`,
      ].join('\n'), 'utf8')
      const initialized = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' })
      expect(initialized.status).toBe(0)

      const result = spawnSync(process.execPath, [scanner, '--worktree'], {
        cwd: directory,
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('src/public.txt:1: local-secret-value')
      expect(result.stderr).toContain('src/public.txt:2: local-secret-value')
      expect(result.stderr).not.toContain(quoted)
      expect(result.stderr).not.toContain(commented)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    'api_key',
    'apikey',
    'access_token',
    'auth',
    'auth_token',
    'authorization',
    'cookie',
    'credential',
    'data_key',
    'password',
    'secret',
    'signature',
    'token',
  ])('detects credentials in the %s query parameter', key => {
    const value = secretValue('live', 'query', '9Qv3pL7x2K')
    const expected = [{ file: 'src/request.txt', line: 1, rule: 'credential-url' }]

    expect(scanText(
      'src/request.txt',
      `https://api.example.invalid/v1?${key}=${value}`,
    )).toEqual(expected)
    expect(scanText(
      'src/request.txt',
      `https://api.example.invalid/v1?mode=full&${key}=${value}`,
    )).toEqual(expected)
  })

  it('detects an HTTP Basic authorization value', () => {
    const value = joinedSecret('dXNlcjpw', 'YXNzd29yZA', '==')
    expect(scanText('src/request.txt', `Authorization: ${'Basic'} ${value}`)).toEqual([
      { file: 'src/request.txt', line: 1, rule: 'basic-auth' },
    ])
  })

  it.each([
    ['classic personal access', joinedSecret('ghp_', 'A'.repeat(36))],
    ['OAuth', joinedSecret('gho_', 'A'.repeat(36))],
    ['user-to-server', joinedSecret('ghu_', 'A'.repeat(36))],
    ['server-to-server', joinedSecret('ghs_', 'A'.repeat(36))],
    ['refresh', joinedSecret('ghr_', 'A'.repeat(36))],
    ['fine-grained personal access', joinedSecret('github_', 'pat_', 'A'.repeat(82))],
  ])('detects a %s GitHub token', (_kind, value) => {
    expect(scanText('src/config.txt', `value: ${value}`)).toEqual([
      { file: 'src/config.txt', line: 1, rule: 'github-token' },
    ])
  })

  it.each([
    '<live-value-9Qv3pL7x2K>',
    'replace-with-live-value-9Qv3pL7x2K',
    'your-live-value-9Qv3pL7x2K',
    'safe-placeholder-live-value-9Qv3pL7x2K',
  ])('does not exempt an arbitrary placeholder-shaped credential: %s', value => {
    expect(scanText('src/config.env', `IFIND_MCP_CREDENTIAL=${value}`)).toEqual([
      { file: 'src/config.env', line: 1, rule: 'credential-assignment' },
    ])
  })

  it('does not let a leading slash bypass credential assignment scanning', () => {
    const value = joinedSecret('/', 'live', '/value/', '9Qv3pL7x2K')
    expect(scanText('src/config.env', `password=${value}`)).toEqual([
      { file: 'src/config.env', line: 1, rule: 'credential-assignment' },
    ])
  })

  it('does not let a leading slash bypass query credential scanning', () => {
    const value = joinedSecret('/', 'live', '/value/', '9Qv3pL7x2K')
    expect(scanText(
      'src/request.txt',
      `https://api.example.invalid/v1?token=${value}`,
    )).toEqual([
      { file: 'src/request.txt', line: 1, rule: 'credential-url' },
    ])
  })

  it('scans credentials beyond the old two-mebibyte boundary', () => {
    const prefix = `${'x'.repeat(2 * 1024 * 1024)}\n`
    const value = secretValue('live', 'value', '9Qv3pL7x2K')
    expect(scanText('large.txt', `${prefix}password=${value}\n`)).toContainEqual({
      file: 'large.txt',
      line: 2,
      rule: 'credential-assignment',
    })
  })

  it('formats findings without revealing the matched secret', () => {
    const value = secretValue('live', 'value', '9Qv3pL7x2K')
    const finding = scanText('src/config.ts', `credential=${value}`)[0]
    expect(finding).toBeDefined()
    expect(formatFinding(finding!)).toBe('src/config.ts:1: credential-assignment')
    expect(formatFinding(finding!)).not.toContain(value)
  })

  it.each([
    [
      'credential-url',
      'https://api.example.invalid/v1?api_key=',
      secretValue('live', 'query', '9Qv3pL7x2K'),
    ],
    [
      'basic-auth',
      'Authorization: Basic ',
      joinedSecret('dXNlcjpw', 'YXNzd29yZA', '=='),
    ],
    [
      'github-token',
      'value: ',
      joinedSecret('ghp_', 'A'.repeat(36)),
    ],
  ])('formats %s findings without revealing the credential', (rule, prefix, value) => {
    const findings = scanText('src/security.txt', `${prefix}${value}`)
    expect(findings).toEqual([
      { file: 'src/security.txt', line: 1, rule },
    ])

    const formatted = formatFinding(findings[0]!)
    expect(formatted).toBe(`src/security.txt:1: ${rule}`)
    expect(formatted).not.toContain(value)
  })
})
