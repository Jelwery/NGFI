import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const skillRoot = join(process.cwd(), 'skills/investment-behavior-diagnosis')
const topics = [
  'preference-and-choice',
  'belief-and-learning',
  'market-aggregation',
  'diagnosis-and-evidence',
  'interventions-and-boundaries',
]

describe('investment behavior diagnosis skill', () => {
  it('has valid discoverable frontmatter and a compact entrypoint', async () => {
    const content = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(content)
    expect(match).not.toBeNull()
    const frontmatter = parse(match?.[1] ?? '') as { name: string; description: string }
    expect(frontmatter.name).toBe('investment-behavior-diagnosis')
    expect(frontmatter.description.length).toBeGreaterThan(80)
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024)
    expect(content.split(/\r?\n/u).length).toBeLessThan(500)
    expect(content).not.toMatch(/yfinance|CNE6/iu)
  })

  it('ships exactly five referenced progressive-disclosure topics', async () => {
    const content = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    for (const topic of topics) {
      expect(content).toContain(topic)
      await expect(access(join(skillRoot, 'references', topic + '.md'))).resolves.toBeUndefined()
    }
    expect(content).toContain('finance_behavior_reference')
    expect(content).toContain('finance_behavior_market_evidence')
    expect(content).toContain('finance_behavior_trade_audit')
  })

  it('preserves core theory while making diagnostic boundaries explicit', async () => {
    const references = await Promise.all(topics.map(
      topic => readFile(join(skillRoot, 'references', topic + '.md'), 'utf8'),
    ))
    const corpus = references.join('\n')
    for (const concept of [
      '前景理论', '概率加权', '心理账户', '处置效应', '短视损失厌恶',
      '贝叶斯', '代表性', '过度自信', '有限套利', '卖空约束', '泡沫',
      'PGR', 'PLR', '竞争解释', '验证指标',
    ]) {
      expect(corpus).toContain(concept)
    }
    expect(corpus).toContain('不能计算该定义下的 PGR/PLR')
    expect(corpus).toContain('不能据此声称某位用户“损失痛苦正好是 2.25 倍”')
  })
})
