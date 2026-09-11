import { describe, expect, it } from 'vitest'

import { normalizeLegacyLicense, validateLicense } from '../scripts/dependency-audit.mjs'

describe('dependency license audit', () => {
  it('does not hide a denied license behind an allowed legacy license token', () => {
    const license = normalizeLegacyLicense('MIT AND GPL-3.0-only', [])
    expect(validateLicense({
      ecosystem: 'pypi',
      name: 'mixed-license',
      version: '1.0.0',
      license,
    })).toMatch(/denied strong-copyleft license/u)
  })
})
