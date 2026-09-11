import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DATA_CAPABILITIES, type AshareFeatureScope, type DataCapability } from '@finance2dsh/core'

export const ASHARE_FEATURE_IMPLEMENTATIONS = [
  'implemented-canonical', 'implemented-experimental', 'implemented-optional-auth',
] as const
export type AshareFeatureImplementation = typeof ASHARE_FEATURE_IMPLEMENTATIONS[number]
export type AshareContractTier = 'canonical' | 'experimental-records-v1'
export type AshareFeatureAuth = 'none' | 'client' | 'session' | 'api-key'

export interface AshareFeatureVariant {
  id: string
  upstreamCallable: string
  runtime: { kind: 'generated-block' | 'generated-module'; block?: string; symbol: string }
  toolName: string
  dataCapability: DataCapability
  dataset: string
}

export interface AshareFeatureDefinition {
  featureId: string
  upstreamCapabilityId: string
  upstreamCallables: string[]
  variants: AshareFeatureVariant[]
  tools: string[]
  sources: string[]
  auth: AshareFeatureAuth
  implementation: AshareFeatureImplementation
  contractTier: AshareContractTier
  scope: AshareFeatureScope
  pitGrade: 'current' | 'partial' | 'date-bounded'
  allowedParams: string[]
  defaultLimit: number
  maxLimit: number
  fixture: string
  liveProbe: string
  fieldUnits: Record<string, string>
  limitations: string[]
}

export interface AshareFeatureRegistry {
  schemaVersion: 1
  registryVersion: string
  upstream: {
    repository: string
    version: string
    tagObject: string
    peeledCommit: string
  }
  features: AshareFeatureDefinition[]
}

const TOOL_NAMES = new Set([
  'finance_data_catalog', 'finance_cn_instrument', 'finance_cn_quote', 'finance_cn_bars',
  'finance_cn_fundamentals', 'finance_cn_disclosures', 'finance_cn_market_activity',
  'finance_cn_macro_index',
])
const SCOPES = new Set(['instrument', 'market', 'industry', 'macro', 'index', 'derivative'])
const AUTH = new Set(['none', 'client', 'session', 'api-key'])
const TIERS = new Set(['canonical', 'experimental-records-v1'])
const IMPLEMENTATIONS = new Set(ASHARE_FEATURE_IMPLEMENTATIONS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${label} must be a non-empty string array`)
  }
  return [...value]
}

function parseVariant(value: unknown, label: string): AshareFeatureVariant {
  if (!isRecord(value) || !isRecord(value.runtime)) throw new TypeError(`${label} is invalid`)
  const kind = nonEmpty(value.runtime.kind, `${label}.runtime.kind`)
  if (kind !== 'generated-block' && kind !== 'generated-module') throw new TypeError(`${label}.runtime.kind is invalid`)
  const dataCapability = nonEmpty(value.dataCapability, `${label}.dataCapability`)
  if (!(DATA_CAPABILITIES as readonly string[]).includes(dataCapability)) throw new TypeError(`${label}.dataCapability is invalid`)
  const block = value.runtime.block
  if (kind === 'generated-block' && (typeof block !== 'string' || !/^block-\d{3}\.py$/u.test(block))) {
    throw new TypeError(`${label}.runtime.block is invalid`)
  }
  return {
    id: nonEmpty(value.id, `${label}.id`),
    upstreamCallable: nonEmpty(value.upstreamCallable, `${label}.upstreamCallable`),
    runtime: {
      kind,
      ...(kind === 'generated-block' ? { block: block as string } : {}),
      symbol: nonEmpty(value.runtime.symbol, `${label}.runtime.symbol`),
    },
    toolName: nonEmpty(value.toolName, `${label}.toolName`),
    dataCapability: dataCapability as DataCapability,
    dataset: nonEmpty(value.dataset, `${label}.dataset`),
  }
}

function parseFeature(value: unknown, index: number): AshareFeatureDefinition {
  const label = `features[${index}]`
  if (!isRecord(value)) throw new TypeError(`${label} is invalid`)
  const variants = Array.isArray(value.variants)
    ? value.variants.map((item, variantIndex) => parseVariant(item, `${label}.variants[${variantIndex}]`))
    : []
  if (variants.length === 0) throw new TypeError(`${label}.variants must not be empty`)
  const upstreamCallables = stringArray(value.upstreamCallables, `${label}.upstreamCallables`)
  if (JSON.stringify([...new Set(variants.map(item => item.upstreamCallable))].sort())
      !== JSON.stringify([...new Set(upstreamCallables)].sort())) {
    throw new TypeError(`${label} does not map every upstream callable`)
  }
  const tools = stringArray(value.tools, `${label}.tools`)
  if (tools.some(item => !TOOL_NAMES.has(item)) || variants.some(item => !tools.includes(item.toolName))) {
    throw new TypeError(`${label}.tools are invalid`)
  }
  const auth = nonEmpty(value.auth, `${label}.auth`)
  const implementation = nonEmpty(value.implementation, `${label}.implementation`)
  const contractTier = nonEmpty(value.contractTier, `${label}.contractTier`)
  const scope = nonEmpty(value.scope, `${label}.scope`)
  if (!AUTH.has(auth) || !IMPLEMENTATIONS.has(implementation as AshareFeatureImplementation)
      || !TIERS.has(contractTier) || !SCOPES.has(scope)) throw new TypeError(`${label} policy is invalid`)
  const defaultLimit = value.defaultLimit
  const maxLimit = value.maxLimit
  if (!Number.isInteger(defaultLimit) || !Number.isInteger(maxLimit)
      || (defaultLimit as number) < 1 || (maxLimit as number) < (defaultLimit as number)) {
    throw new TypeError(`${label} limits are invalid`)
  }
  return {
    featureId: nonEmpty(value.featureId, `${label}.featureId`),
    upstreamCapabilityId: nonEmpty(value.upstreamCapabilityId, `${label}.upstreamCapabilityId`),
    upstreamCallables, variants, tools,
    sources: stringArray(value.sources, `${label}.sources`),
    auth: auth as AshareFeatureAuth,
    implementation: implementation as AshareFeatureImplementation,
    contractTier: contractTier as AshareContractTier,
    scope: scope as AshareFeatureScope,
    pitGrade: nonEmpty(value.pitGrade, `${label}.pitGrade`) as AshareFeatureDefinition['pitGrade'],
    allowedParams: stringArray(value.allowedParams, `${label}.allowedParams`),
    defaultLimit: defaultLimit as number, maxLimit: maxLimit as number,
    fixture: nonEmpty(value.fixture, `${label}.fixture`),
    liveProbe: nonEmpty(value.liveProbe, `${label}.liveProbe`),
    fieldUnits: isRecord(value.fieldUnits) ? value.fieldUnits as Record<string, string> : {},
    limitations: stringArray(value.limitations, `${label}.limitations`),
  }
}

export function parseAshareFeatureRegistry(value: unknown): AshareFeatureRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.upstream) || !Array.isArray(value.features)) {
    throw new TypeError('A-share feature registry envelope is invalid')
  }
  const features = value.features.map(parseFeature)
  if (features.length !== 60) throw new TypeError('A-share feature registry must contain exactly 60 capabilities')
  const unique = (items: string[]): boolean => new Set(items).size === items.length
  if (!unique(features.map(item => item.featureId)) || !unique(features.map(item => item.upstreamCapabilityId))) {
    throw new TypeError('A-share feature and capability IDs must be unique')
  }
  const optional = features.filter(item => item.auth === 'api-key')
  if (optional.length !== 1 || optional[0]?.upstreamCapabilityId !== 'capability-008'
      || optional[0].implementation !== 'implemented-optional-auth') {
    throw new TypeError('iWenCai capability-008 must be the only optional-auth feature')
  }
  return {
    schemaVersion: 1,
    registryVersion: nonEmpty(value.registryVersion, 'registryVersion'),
    upstream: {
      repository: nonEmpty(value.upstream.repository, 'upstream.repository'),
      version: nonEmpty(value.upstream.version, 'upstream.version'),
      tagObject: nonEmpty(value.upstream.tagObject, 'upstream.tagObject'),
      peeledCommit: nonEmpty(value.upstream.peeledCommit, 'upstream.peeledCommit'),
    },
    features,
  }
}

export const ASHARE_FEATURE_REGISTRY = parseAshareFeatureRegistry(JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../providers/astock/feature-registry.json', import.meta.url)), 'utf8',
)))
export const ASHARE_FEATURES = ASHARE_FEATURE_REGISTRY.features
export const ASHARE_FEATURE_IDS = ASHARE_FEATURES.map(item => item.featureId)
export const ASHARE_DATASETS = [...new Set(ASHARE_FEATURES.flatMap(item => item.variants.map(variant => variant.dataset)))]

const BY_ID = new Map(ASHARE_FEATURES.map(item => [item.featureId, item]))
export function getAshareFeature(featureId: string): AshareFeatureDefinition {
  const feature = BY_ID.get(featureId)
  if (feature === undefined) throw new TypeError(`unsupported A-share feature: ${featureId}`)
  return feature
}
