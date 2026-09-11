export interface LicenseEntry {
  ecosystem: string
  name: string
  version: string
  license: string
}

export function normalizeLegacyLicense(raw: string, classifiers: string[]): string
export function validateLicense(entry: LicenseEntry): string | undefined
