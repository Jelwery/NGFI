import { describe, expect, it } from 'vitest'
import { normalizeLegacyLicense, validateLicense } from '../scripts/dependency-audit.mjs'

describe('dependency license audit', () => {
  it('does not hide strong copyleft behind an allowed token', () => {
    const license = normalizeLegacyLicense('MIT AND GPL-3.0-only', [])
    expect(validateLicense({ ecosystem: 'pypi', name: 'mixed', version: '1', license })).toMatch(/denied strong-copyleft/u)
    expect(validateLicense({ ecosystem: 'pypi', name: 'allowed', version: '1', license: 'MIT' })).toBeUndefined()
  })
})
