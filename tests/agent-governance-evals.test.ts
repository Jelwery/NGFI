import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('offline Agent governance trajectories', () => {
  it('ships versioned trajectory fixtures for all three governed presets', () => {
    const fixture = JSON.parse(read('evals/agent-governance/trajectories.json')) as {
      schemaVersion: number
      cases: Array<{ id: string; preset: string; requiredTools: string[]; forbiddenTools: string[]; assertions: string[] }>
    }
    expect(fixture.schemaVersion).toBe(1)
    expect(new Set(fixture.cases.map(item => item.id)).size).toBe(fixture.cases.length)
    expect(new Set(fixture.cases.map(item => item.preset))).toEqual(new Set([
      'company-research', 'strategy-research', 'portfolio-risk',
    ]))
    for (const item of fixture.cases) {
      expect(item.requiredTools.length).toBeGreaterThan(0)
      expect(item.forbiddenTools.length).toBeGreaterThan(0)
      expect(item.assertions.length).toBeGreaterThan(0)
    }
  })

  it('keeps company research on frozen evidence and audit-gated completion', () => {
    const skill = read('skills/company-research/SKILL.md')
    expect(skill).toContain('finance_research_snapshot')
    expect(skill).toMatch(/Completion requires `finance_research_audit`[\s\S]*?gates to pass/u)
    expect(skill).toContain('workspace_id')
    expect(skill).toContain('expected_revision')
  })

  it('forbids smoke promotion and keeps outcome insufficiency explicit', () => {
    const skill = read('skills/strategy-research/SKILL.md')
    expect(skill).toContain('promotionEligible=false')
    expect(skill).toContain('never call it research-grade')
    expect(skill).toContain('insufficient')
    expect(skill).toContain('null')
  })

  it('requires staged-confirmed holdings and fail-closed reconciliation', () => {
    const skill = read('skills/portfolio-risk/SKILL.md')
    expect(skill).toMatch(/staged snapshot/u)
    expect(skill).toContain('Never confirm implicitly')
    expect(skill).toContain('reconciliation')
    expect(skill).toContain('rejected')
  })

  it('keeps every preset free of shell, web, raw provider/MCP, order and live-trading grants', () => {
    for (const preset of ['company-research', 'strategy-research', 'portfolio-risk']) {
      const text = read(`config/agent-presets/${preset}/agent.cordis.yml`)
      expect(text).not.toMatch(/name:\s*['"]?(?:@deepseek-ai\/dsh-(?:terminal|tool-web|mcp)|.*order.*tool)/iu)
      expect(text).toMatch(/禁止[^\n]{0,20}shell/u)
      expect(text).toContain('raw provider/MCP')
    }
  })
})
