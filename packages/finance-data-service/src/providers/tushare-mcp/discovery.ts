import type { DataCapability, InstrumentId } from '@finance2dsh/core'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { TushareMcpError } from './security.js'

export const TUSHARE_MCP_CAPABILITIES = [
  'instrument-reference',
  'trading-calendar',
  'market-bars',
  'fundamentals',
] as const satisfies readonly DataCapability[]

export type TushareMcpCapability = typeof TUSHARE_MCP_CAPABILITIES[number]

type CapabilityWithMappedOutputFields = Exclude<TushareMcpCapability, 'fundamentals'>

export const MAPPED_OUTPUT_FIELDS = {
  'instrument-reference': [
    'ts_code', 'symbol', 'name', 'fullname', 'market', 'exchange', 'curr_type',
    'list_status', 'list_date', 'delist_date', 'industry', 'area',
  ],
  'market-bars': [
    'ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount',
  ],
  'trading-calendar': ['exchange', 'cal_date', 'is_open', 'pretrade_date'],
} as const satisfies Readonly<Record<CapabilityWithMappedOutputFields, readonly string[]>>

interface ToolCandidate {
  readonly name: string
  readonly requiredInputs: readonly string[]
}

const TOOL_CANDIDATES: Readonly<Record<TushareMcpCapability, Readonly<Record<string, readonly ToolCandidate[]>>>> = {
  'instrument-reference': {
    equity: [{ name: 'stock_basic', requiredInputs: ['ts_code'] }],
    index: [{ name: 'index_basic', requiredInputs: ['ts_code'] }],
    etf: [
      { name: 'etf_basic', requiredInputs: ['ts_code'] },
      { name: 'fund_basic', requiredInputs: ['ts_code'] },
    ],
    fund: [
      { name: 'fund_basic', requiredInputs: ['ts_code'] },
      { name: 'etf_basic', requiredInputs: ['ts_code'] },
    ],
  },
  'market-bars': {
    equity: [{ name: 'daily', requiredInputs: ['ts_code'] }],
    index: [{ name: 'index_daily', requiredInputs: ['ts_code'] }],
    etf: [{ name: 'fund_daily', requiredInputs: ['ts_code'] }],
    fund: [{ name: 'fund_daily', requiredInputs: ['ts_code'] }],
  },
  fundamentals: {
    equity: [
      { name: 'fina_indicator', requiredInputs: ['ts_code'] },
      { name: 'fina_indicator_vip', requiredInputs: ['ts_code'] },
    ],
  },
  'trading-calendar': {
    '*': [{ name: 'trade_cal', requiredInputs: ['start_date', 'end_date'] }],
  },
}

export interface ValidatedToolInventory {
  readonly tools: ReadonlyMap<string, Tool>
  readonly toolNames: readonly string[]
  readonly capabilities: readonly TushareMcpCapability[]
  readonly unavailableCapabilities: Readonly<Partial<Record<TushareMcpCapability, string>>>
}

const toolArgumentValidator = new AjvJsonSchemaValidator()

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fieldSchemaAccepts(tool: Tool, schema: Record<string, unknown>, value: unknown): boolean {
  const inputSchema = tool.inputSchema as unknown as Record<string, unknown>
  const standaloneSchema = {
    ...('$schema' in inputSchema ? { $schema: inputSchema.$schema } : {}),
    ...('$defs' in inputSchema ? { $defs: inputSchema.$defs } : {}),
    ...('definitions' in inputSchema ? { definitions: inputSchema.definitions } : {}),
    ...schema,
  }
  try {
    return toolArgumentValidator
      .getValidator<unknown>(standaloneSchema as unknown as JsonSchemaType)(value)
      .valid
  } catch {
    throw new TushareMcpError(`tool ${tool.name} has an invalid fields input schema`, 'schema-drift', 'schema-drift')
  }
}

export function outputFields(tool: Tool, names: readonly string[]): Record<string, unknown> {
  if (!toolAcceptsInput(tool, 'fields')) return {}
  const schema = tool.inputSchema.properties?.fields
  const csv = names.join(',')
  if (!isSchemaObject(schema)) return { fields: csv }

  const array = [...names]
  if (fieldSchemaAccepts(tool, schema, array)) return { fields: array }
  if (fieldSchemaAccepts(tool, schema, csv)) return { fields: csv }
  throw new TushareMcpError(
    `tool ${tool.name} fields input cannot accept the mapped output fields`,
    'schema-drift',
    'schema-drift',
  )
}

function toolAllowsInputs(tool: Tool, requiredInputs: readonly string[]): boolean {
  const properties = tool.inputSchema.properties ?? {}
  const required = new Set(tool.inputSchema.required ?? [])
  const permitsAdditional = tool.inputSchema.additionalProperties !== false
  return requiredInputs.every(input => input in properties || required.has(input) || permitsAdditional)
}

function representativeArguments(capability: TushareMcpCapability, tool: Tool): Record<string, unknown> {
  switch (capability) {
    case 'instrument-reference':
      return {
        ts_code: '600519.SH',
        ...outputFields(tool, MAPPED_OUTPUT_FIELDS['instrument-reference']),
      }
    case 'market-bars':
      return {
        ts_code: '600519.SH', start_date: '20260101', end_date: '20260102',
        ...outputFields(tool, MAPPED_OUTPUT_FIELDS['market-bars']),
      }
    case 'fundamentals':
      return { ts_code: '600519.SH' }
    case 'trading-calendar':
      return {
        exchange: '', start_date: '20260101', end_date: '20260102',
        ...outputFields(tool, MAPPED_OUTPUT_FIELDS['trading-calendar']),
      }
  }
}

function toolProblem(
  tool: Tool,
  candidate: ToolCandidate,
  capability: TushareMcpCapability,
): string | undefined {
  if (tool.annotations?.destructiveHint === true) return `${tool.name} is marked destructive`
  if (tool.execution?.taskSupport === 'required') {
    return `${tool.name} requires the unsupported MCP task execution path`
  }
  if (!toolAllowsInputs(tool, candidate.requiredInputs)) {
    return `${tool.name} does not declare inputs: ${candidate.requiredInputs.join(', ')}`
  }
  try {
    validateToolArguments(tool, representativeArguments(capability, tool))
  } catch {
    return `${tool.name} input schema is incompatible with the curated ${capability} mapping`
  }
  return undefined
}

function candidatesFor(capability: TushareMcpCapability, assetType?: string): readonly ToolCandidate[] {
  const byAssetType = TOOL_CANDIDATES[capability]
  if (capability === 'trading-calendar') return byAssetType['*'] ?? []
  if (assetType !== undefined) return byAssetType[assetType] ?? []
  return Object.values(byAssetType).flat()
}

function capabilityAvailability(
  capability: TushareMcpCapability,
  tools: ReadonlyMap<string, Tool>,
): { available: boolean; reason?: string } {
  const candidates = candidatesFor(capability)
  const schemaProblems: string[] = []
  for (const candidate of candidates) {
    const tool = tools.get(candidate.name)
    if (tool === undefined) continue
    const problem = toolProblem(tool, candidate, capability)
    if (problem === undefined) return { available: true }
    schemaProblems.push(problem)
  }
  if (schemaProblems.length > 0) return { available: false, reason: schemaProblems.join('; ') }
  return { available: false, reason: `none of the approved tools are advertised: ${[...new Set(candidates.map(item => item.name))].join(', ')}` }
}

export function validateToolInventory(tools: readonly Tool[]): ValidatedToolInventory {
  const byName = new Map<string, Tool>()
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name)) {
      throw new TushareMcpError('tools/list returned an invalid tool name', 'schema-drift', 'schema-drift')
    }
    if (tool.inputSchema.type !== 'object') {
      throw new TushareMcpError(`tool ${tool.name} has a non-object input schema`, 'schema-drift', 'schema-drift')
    }
    if (byName.has(tool.name)) {
      throw new TushareMcpError(`tools/list returned duplicate tool ${tool.name}`, 'schema-drift', 'schema-drift')
    }
    byName.set(tool.name, structuredClone(tool))
  }

  const capabilities: TushareMcpCapability[] = []
  const unavailableCapabilities: Partial<Record<TushareMcpCapability, string>> = {}
  for (const capability of TUSHARE_MCP_CAPABILITIES) {
    const availability = capabilityAvailability(capability, byName)
    if (availability.available) capabilities.push(capability)
    else unavailableCapabilities[capability] = availability.reason ?? 'not advertised'
  }

  return {
    tools: byName,
    toolNames: [...byName.keys()].sort(),
    capabilities,
    unavailableCapabilities,
  }
}

export function resolveCapabilityTool(
  inventory: ValidatedToolInventory,
  capability: TushareMcpCapability,
  instrument?: InstrumentId,
): Tool {
  const assetType = capability === 'trading-calendar' ? undefined : instrument?.assetType
  const candidates = candidatesFor(capability, assetType)
  if (candidates.length === 0) {
    throw new TushareMcpError(
      `TuShare MCP does not map ${capability} for asset type ${assetType ?? 'none'}`,
      'unsupported',
      'schema-drift',
    )
  }

  const problems: string[] = []
  for (const candidate of candidates) {
    const tool = inventory.tools.get(candidate.name)
    if (tool === undefined) continue
    const problem = toolProblem(tool, candidate, capability)
    if (problem === undefined) return tool
    problems.push(problem)
  }
  if (problems.length > 0) {
    throw new TushareMcpError(
      `TuShare MCP tool schema does not satisfy ${capability}: ${problems.join('; ')}`,
      'schema-drift',
      'schema-drift',
    )
  }
  throw new TushareMcpError(
    `TuShare MCP does not advertise an approved ${capability} tool`,
    'unsupported',
    'schema-drift',
  )
}

export function toolAcceptsInput(tool: Tool, name: string): boolean {
  return name in (tool.inputSchema.properties ?? {}) || tool.inputSchema.additionalProperties !== false
}

export function validateToolArguments(tool: Tool, argumentsValue: Readonly<Record<string, unknown>>): void {
  try {
    const result = toolArgumentValidator
      .getValidator<Record<string, unknown>>(tool.inputSchema as unknown as JsonSchemaType)
      (argumentsValue)
    if (!result.valid) {
      throw new TushareMcpError(
        `mapped arguments do not satisfy ${tool.name} input schema: ${result.errorMessage}`,
        'schema-drift',
        'schema-drift',
      )
    }
  } catch (error) {
    if (error instanceof TushareMcpError) throw error
    throw new TushareMcpError(
      `tool ${tool.name} has an invalid input schema`,
      'schema-drift',
      'schema-drift',
    )
  }
}

export function validateToolResult(tool: Tool, result: CallToolResult): void {
  if (tool.execution?.taskSupport === 'required') {
    throw new TushareMcpError(
      `tool ${tool.name} requires the unsupported MCP task execution path`,
      'schema-drift',
      'schema-drift',
    )
  }
  if (tool.outputSchema === undefined || result.isError === true) return
  if (result.structuredContent === undefined) {
    throw new TushareMcpError(
      `tool ${tool.name} declares an output schema but returned no structured content`,
      'schema-drift',
      'schema-drift',
    )
  }
  try {
    const validation = toolArgumentValidator
      .getValidator<unknown>(tool.outputSchema as unknown as JsonSchemaType)(result.structuredContent)
    if (!validation.valid) {
      throw new TushareMcpError(
        `tool ${tool.name} structured content does not satisfy its output schema: ${validation.errorMessage}`,
        'schema-drift',
        'schema-drift',
      )
    }
  } catch (error) {
    if (error instanceof TushareMcpError) throw error
    throw new TushareMcpError(
      `tool ${tool.name} has an invalid output schema`,
      'schema-drift',
      'schema-drift',
    )
  }
}
