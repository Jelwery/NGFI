import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { YFinanceProvider } from '@finance2dsh/provider-yfinance'

describe('YFinanceProvider process contract', () => {
  it('ships the private Python runner in the package', async () => {
    const providerRoot = join(process.cwd(), 'packages/finance-provider-yfinance')
    await expect(access(join(providerRoot, 'python/runner.py'))).resolves.toBeUndefined()
  })

  it('classifies malformed runner output as a protocol error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'finance2dsh-provider-'))
    const runner = join(directory, 'bad.py')
    await writeFile(runner, 'print("not-json")\n', 'utf8')
    const provider = new YFinanceProvider({ projectRoot: process.cwd(), pythonRunner: runner })
    await expect(provider.securityReference('AAPL')).rejects.toMatchObject({ kind: 'protocol-error' })
  })

  it('rejects invalid tickers before starting the provider', async () => {
    const provider = new YFinanceProvider()
    expect(() => provider.securityReference('AAPL; rm -rf /')).toThrow(/ticker/)
  })

  it('maps a recorded runner response through the versioned canonical contract', async () => {
    const provider = new YFinanceProvider({
      projectRoot: process.cwd(),
      pythonRunner: join(process.cwd(), 'tests/fixtures/yfinance/runner.py'),
    })
    const reference = await provider.securityReference('test')
    expect(reference).toEqual(expect.objectContaining({
      ticker: 'TEST',
      observation: expect.objectContaining({ provider: 'yfinance', periodType: 'spot' }),
      fields: expect.objectContaining({
        currentPrice: { status: 'available', value: 123.45 },
        sector: { status: 'missing', value: null },
      }),
    }))
  })
})
