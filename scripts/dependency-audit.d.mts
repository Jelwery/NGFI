export interface LicenseEntry { ecosystem: string; name: string; version: string; license: string }
export declare function normalizeLegacyLicense(raw: string, classifiers: string[]): string
export declare function validateLicense(entry: LicenseEntry): string | undefined
