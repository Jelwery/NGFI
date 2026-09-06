import type { WorkflowDefinition, WorkflowStageDefinition } from './contracts.js'

export class WorkflowDefinitionError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowDefinitionError'
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === '') throw new WorkflowDefinitionError(label + ' must be non-empty')
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  assertNonEmpty(definition.id, 'workflow id')
  assertNonEmpty(definition.version, 'workflow version')
  if (definition.stages.length === 0) throw new WorkflowDefinitionError('workflow must register at least one stage')
  const byId = new Map<string, WorkflowStageDefinition>()
  for (const stage of definition.stages) {
    assertNonEmpty(stage.id, 'stage id')
    if (byId.has(stage.id)) throw new WorkflowDefinitionError('duplicate stage id: ' + stage.id)
    if (!Number.isInteger(stage.maxAttempts) || stage.maxAttempts < 1) {
      throw new WorkflowDefinitionError('stage maxAttempts must be a positive integer: ' + stage.id)
    }
    if (new Set(stage.dependsOn).size !== stage.dependsOn.length) {
      throw new WorkflowDefinitionError('stage repeats a dependency: ' + stage.id)
    }
    if (stage.dependsOn.includes(stage.id)) throw new WorkflowDefinitionError('stage depends on itself: ' + stage.id)
    byId.set(stage.id, stage)
  }
  if (!byId.has(definition.finalStage)) {
    throw new WorkflowDefinitionError('final stage is not registered: ' + definition.finalStage)
  }
  for (const stage of definition.stages) {
    for (const dependency of stage.dependsOn) {
      if (!byId.has(dependency)) {
        throw new WorkflowDefinitionError('stage ' + stage.id + ' has unknown dependency ' + dependency)
      }
    }
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (stage: WorkflowStageDefinition): void => {
    if (visited.has(stage.id)) return
    if (visiting.has(stage.id)) throw new WorkflowDefinitionError('workflow stage dependency cycle includes ' + stage.id)
    visiting.add(stage.id)
    for (const dependency of stage.dependsOn) visit(byId.get(dependency)!)
    visiting.delete(stage.id)
    visited.add(stage.id)
  }
  for (const stage of definition.stages) visit(stage)
  return structuredClone(definition)
}

export function workflowStagesInDependencyOrder(definition: WorkflowDefinition): WorkflowStageDefinition[] {
  const valid = validateWorkflowDefinition(definition)
  const byId = new Map(valid.stages.map(stage => [stage.id, stage]))
  const ordered: WorkflowStageDefinition[] = []
  const visited = new Set<string>()
  const visit = (stage: WorkflowStageDefinition): void => {
    if (visited.has(stage.id)) return
    for (const dependency of stage.dependsOn) visit(byId.get(dependency)!)
    visited.add(stage.id)
    ordered.push(stage)
  }
  for (const stage of valid.stages) visit(stage)
  return ordered
}

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>()

  register(definition: WorkflowDefinition): void {
    const valid = validateWorkflowDefinition(definition)
    if (this.definitions.has(valid.id)) throw new WorkflowDefinitionError('duplicate workflow id: ' + valid.id)
    this.definitions.set(valid.id, valid)
  }

  get(id: string): WorkflowDefinition {
    const definition = this.definitions.get(id)
    if (definition === undefined) throw new WorkflowDefinitionError('unknown workflow id: ' + id)
    return structuredClone(definition)
  }

  list(): WorkflowDefinition[] {
    return [...this.definitions.values()].map(definition => structuredClone(definition))
  }
}
