import type { NumberLexicon } from './contracts.js'

const FINANCIAL_UNIT_SCALES: Readonly<Record<string, number>> = Object.freeze({
  '': 1,
  元: 1,
  千: 1e3,
  万: 1e4,
  万元: 1e4,
  亿: 1e8,
  亿元: 1e8,
  万亿: 1e12,
  万亿元: 1e12,
  倍: 1,
  x: 1,
  X: 1,
  '%': 1,
  百分点: 1,
})

/** Financial vocabulary is injected into the generic number-binding engine. */
export function createFinancialNumberLexicon(subjectCodes: readonly string[] = []): NumberLexicon {
  return {
    ignoredPatterns: [
      /\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/gu,
      /\bFY\s*(?:19|20)\d{2}\b/giu,
      /\b(?:19|20)\d{2}Q[1-4]\b/giu,
      /\b(?:19|20)\d{2}\b(?!\s*(?:万亿元|亿元|万元|百分点|万亿|亿|万|千|元|%|倍|[xX]))/gu,
      /https?:\/\/\S+/gu,
    ],
    unitScales: FINANCIAL_UNIT_SCALES,
    percentSuffixes: ['%', '百分点'],
    subjectCodes: [...subjectCodes],
  }
}
