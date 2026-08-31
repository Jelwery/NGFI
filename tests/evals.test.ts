import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { FINANCE_TOOL_ALLOWLIST } from '../packages/dsh-finance-bundle/src/policy.js'

interface EvalCase { id: string; category: string; requiredTools: string[] }
interface BehaviorEvalCase extends EvalCase {
  name: string
  dataMode: string
  prompt: string
  forbiddenTools: string[]
  expectations: string[]
}

describe('finance evaluation assets', () => {
  it('defines a weighted six-dimension rubric with hard failures', async () => {
    const rubric = parse(await readFile('evals/rubric/finance-analysis.yml', 'utf8')) as {
      dimensions: Array<{ id: string; weight: number }>
      hardFailures: string[]
      pass: { minimumTotal: number; requireNoHardFailures: boolean }
    }
    expect(rubric.dimensions).toHaveLength(6)
    expect(rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0)).toBe(100)
    expect(new Set(rubric.dimensions.map(dimension => dimension.id)).size).toBe(6)
    expect(rubric.hardFailures.length).toBeGreaterThanOrEqual(8)
    expect(rubric.pass).toEqual(expect.objectContaining({
      minimumTotal: 75,
      requireNoHardFailures: true,
    }))
  })

  it('ships 25 unique cases whose required tools are in the finance allowlist', async () => {
    const cases = JSON.parse(await readFile('evals/cases/v1.json', 'utf8')) as EvalCase[]
    expect(cases).toHaveLength(25)
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    const allowed = new Set<string>(FINANCE_TOOL_ALLOWLIST)
    for (const item of cases) {
      expect(item.id).toMatch(/^[a-z0-9-]+$/u)
      expect(item.requiredTools.length).toBeGreaterThan(0)
      expect(item.requiredTools.every(tool => allowed.has(tool))).toBe(true)
    }
  })

  it('ships twelve behavior cases spanning diagnosis, theory, data and routing boundaries', async () => {
    const cases = JSON.parse(
      await readFile('evals/cases/investment-behavior-diagnosis.json', 'utf8'),
    ) as BehaviorEvalCase[]
    expect(cases).toHaveLength(12)
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    expect(new Set(cases.map(item => item.name)).size).toBe(cases.length)
    const categories = new Set(cases.map(item => item.category))
    for (const category of ['decision', 'belief', 'market', 'longitudinal', 'theory', 'routing-negative']) {
      expect(categories.has(category)).toBe(true)
    }
    for (const item of cases) {
      expect(item.name).toMatch(/^[a-z0-9-]+$/u)
      expect(item.prompt.length).toBeGreaterThan(20)
      expect(item.expectations.length).toBeGreaterThanOrEqual(3)
      expect(new Set(item.requiredTools).size).toBe(item.requiredTools.length)
      expect(item.requiredTools.some(tool => item.forbiddenTools.includes(tool))).toBe(false)
    }
    expect(cases.some(item => item.dataMode === 'trade-records')).toBe(true)
    expect(cases.some(item => item.dataMode === 'reference-only')).toBe(true)
  })

  it('defines a 100-point behavior rubric with explicit hard failures', async () => {
    const rubric = parse(
      await readFile('evals/rubric/investment-behavior-diagnosis.yml', 'utf8'),
    ) as {
      dimensions: Array<{ id: string; weight: number }>
      hardFailures: string[]
      pass: { minimumTotal: number; requireNoHardFailures: boolean }
    }
    expect(rubric.dimensions).toHaveLength(7)
    expect(rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0)).toBe(100)
    expect(new Set(rubric.dimensions.map(dimension => dimension.id)).size).toBe(7)
    expect(rubric.hardFailures.length).toBeGreaterThanOrEqual(12)
    expect(rubric.pass).toEqual(expect.objectContaining({ minimumTotal: 80, requireNoHardFailures: true }))
  })

  it('keeps unavailable web tools out of the public finance policy', () => {
    expect(FINANCE_TOOL_ALLOWLIST).not.toContain('web_search')
    expect(FINANCE_TOOL_ALLOWLIST).not.toContain('web_fetch')
  })
})
