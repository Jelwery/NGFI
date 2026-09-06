import type {
  ExecutionDefinition,
  JsonObject,
  ScreenerDefinition,
  ScreenerMatch,
  StrategyDefinition,
  StrategyEvaluationContext,
  StrategyRunInput,
} from './contracts.js'
import { configHash, deepFreeze, strategyHash, strategyInputHash } from './identity.js'
import {
  assertExecutionDefinition,
  assertScreenerDefinition,
  assertScreenerMatch,
  assertSignalSequence,
  assertStrategyRunInput,
  assertStrategyDefinition,
  resolveStrategyConfig,
} from './validation.js'

export type StrategyRegistryErrorCode =
  | 'duplicate-plugin-id'
  | 'duplicate-execution-id'
  | 'unknown-plugin'
  | 'wrong-plugin-kind'
  | 'unknown-execution-definition'

export class StrategyRegistryError extends Error {
  constructor(
    message: string,
    readonly code: StrategyRegistryErrorCode,
  ) {
    super(message)
    this.name = 'StrategyRegistryError'
  }
}

export type IsolatedStrategyResult =
  | { readonly ok: true; readonly observations: ReturnType<StrategyRegistry['evaluateStrategy']> }
  | { readonly ok: false; readonly error: { readonly name: string; readonly message: string } }

export class StrategyRegistry {
  readonly #strategies = new Map<string, StrategyDefinition>()
  readonly #screeners = new Map<string, ScreenerDefinition>()
  readonly #executions = new Map<string, ExecutionDefinition>()

  registerExecution(definition: ExecutionDefinition): this {
    assertExecutionDefinition(definition)
    if (this.#executions.has(definition.id)) {
      throw new StrategyRegistryError(
        `execution definition ${definition.id} is already registered`,
        'duplicate-execution-id',
      )
    }
    this.#executions.set(definition.id, deepFreeze({
      ...definition,
      unfillableConditions: [...definition.unfillableConditions],
    }))
    return this
  }

  registerStrategy(definition: StrategyDefinition): this {
    assertStrategyDefinition(definition)
    this.#assertPluginIdAvailable(definition.spec.id)
    if (!this.#executions.has(definition.executionDefinitionId)) {
      throw new StrategyRegistryError(
        `strategy ${definition.spec.id} references unknown execution definition ${definition.executionDefinitionId}`,
        'unknown-execution-definition',
      )
    }
    this.#strategies.set(definition.spec.id, Object.freeze({
      ...definition,
      spec: deepFreeze(structuredClone(definition.spec)),
    }))
    return this
  }

  registerScreener(definition: ScreenerDefinition): this {
    assertScreenerDefinition(definition)
    this.#assertPluginIdAvailable(definition.spec.id)
    this.#screeners.set(definition.spec.id, Object.freeze({
      ...definition,
      spec: deepFreeze(structuredClone(definition.spec)),
    }))
    return this
  }

  strategyIds(): readonly string[] {
    return Object.freeze([...this.#strategies.keys()].sort())
  }

  screenerIds(): readonly string[] {
    return Object.freeze([...this.#screeners.keys()].sort())
  }

  executionIds(): readonly string[] {
    return Object.freeze([...this.#executions.keys()].sort())
  }

  resolveStrategy(id: string): StrategyDefinition {
    const definition = this.#strategies.get(id)
    if (definition === undefined) {
      if (this.#screeners.has(id)) throw new StrategyRegistryError(`${id} is a screener, not a strategy`, 'wrong-plugin-kind')
      throw new StrategyRegistryError(`unknown strategy ${id}`, 'unknown-plugin')
    }
    return definition
  }

  resolveScreener(id: string): ScreenerDefinition {
    const definition = this.#screeners.get(id)
    if (definition === undefined) {
      if (this.#strategies.has(id)) throw new StrategyRegistryError(`${id} is a strategy, not a screener`, 'wrong-plugin-kind')
      throw new StrategyRegistryError(`unknown screener ${id}`, 'unknown-plugin')
    }
    return definition
  }

  resolveExecution(id: string): ExecutionDefinition {
    const definition = this.#executions.get(id)
    if (definition === undefined) {
      throw new StrategyRegistryError(`unknown execution definition ${id}`, 'unknown-execution-definition')
    }
    return definition
  }

  evaluateStrategy(
    id: string,
    input: StrategyRunInput,
    config: Readonly<JsonObject> = {},
  ) {
    const definition = this.resolveStrategy(id)
    assertStrategyRunInput(input)
    const resolvedConfig = resolveStrategyConfig(definition.spec, config)
    const executionDefinition = this.resolveExecution(definition.executionDefinitionId)
    const semanticStrategyHash = strategyHash(definition.spec)
    const inputHash = strategyInputHash(input)
    const semanticConfigHash = configHash(resolvedConfig)
    const context: StrategyEvaluationContext = deepFreeze({
      ...input,
      instrument: { ...input.instrument },
      bars: input.bars.map(bar => ({ ...bar })),
      strategyHash: semanticStrategyHash,
      inputHash,
      configHash: semanticConfigHash,
      executionDefinition,
    })
    const observations: unknown = definition.evaluate(context, resolvedConfig)
    assertSignalSequence(observations, input.bars, {
      asOf: input.asOf,
      executionDefinitionIds: this.executionIds(),
      expectedStrategyId: definition.spec.id,
      expectedStrategyHash: semanticStrategyHash,
      expectedInputHash: inputHash,
      expectedSnapshotId: input.snapshotId,
      expectedConfigHash: semanticConfigHash,
      expectedInstrument: input.instrument,
      expectedExecutionDefinitionId: definition.executionDefinitionId,
    })
    return deepFreeze(structuredClone([...observations]))
  }

  evaluateScreener(
    id: string,
    input: StrategyRunInput,
    config: Readonly<JsonObject> = {},
  ): ScreenerMatch | null {
    const definition = this.resolveScreener(id)
    assertStrategyRunInput(input)
    const resolvedConfig = resolveStrategyConfig(definition.spec, config)
    const inputHash = strategyInputHash(input)
    const semanticConfigHash = configHash(resolvedConfig)
    const match: unknown = definition.evaluate(deepFreeze({
      ...input,
      instrument: { ...input.instrument },
      bars: input.bars.map(bar => ({ ...bar })),
      inputHash,
      configHash: semanticConfigHash,
      screenerHash: strategyHash(definition.spec),
    }), resolvedConfig)
    assertScreenerMatch(match)
    return match === null ? null : deepFreeze(structuredClone(match))
  }

  evaluateAllStrategies(
    input: StrategyRunInput,
    configs: Readonly<Record<string, Readonly<JsonObject>>> = {},
  ): Readonly<Record<string, IsolatedStrategyResult>> {
    const output: Record<string, IsolatedStrategyResult> = {}
    for (const id of this.strategyIds()) {
      try {
        output[id] = { ok: true, observations: this.evaluateStrategy(id, input, configs[id] ?? {}) }
      } catch (error) {
        output[id] = {
          ok: false,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }
    return deepFreeze(output)
  }

  #assertPluginIdAvailable(id: string): void {
    if (this.#strategies.has(id) || this.#screeners.has(id)) {
      throw new StrategyRegistryError(`plugin ${id} is already registered`, 'duplicate-plugin-id')
    }
  }
}
