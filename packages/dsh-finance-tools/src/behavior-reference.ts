import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

export const BEHAVIOR_REFERENCE_TOPICS = [
  'preference-and-choice',
  'belief-and-learning',
  'market-aggregation',
  'diagnosis-and-evidence',
  'interventions-and-boundaries',
] as const

export type BehaviorReferenceTopic = typeof BEHAVIOR_REFERENCE_TOPICS[number]

const TOPIC_FILES: Record<BehaviorReferenceTopic, string> = {
  'preference-and-choice': 'preference-and-choice.md',
  'belief-and-learning': 'belief-and-learning.md',
  'market-aggregation': 'market-aggregation.md',
  'diagnosis-and-evidence': 'diagnosis-and-evidence.md',
  'interventions-and-boundaries': 'interventions-and-boundaries.md',
}

export interface BehaviorReferenceOptions {
  skillsRoot?: string
  maxBytes?: number
}

function isBehaviorReferenceTopic(value: string): value is BehaviorReferenceTopic {
  return Object.hasOwn(TOPIC_FILES, value)
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !path.startsWith(sep)
}

async function readBehaviorReference(topic: string, options: BehaviorReferenceOptions): Promise<{
  topic: BehaviorReferenceTopic
  content: string
}> {
  if (!isBehaviorReferenceTopic(topic)) {
    throw new RangeError('unsupported behavior reference topic: ' + topic)
  }
  const configuredRoot = options.skillsRoot ?? process.env.FINANCE2DSH_SKILLS_DIR
  if (configuredRoot === undefined || configuredRoot.trim() === '') {
    throw new Error('FINANCE2DSH_SKILLS_DIR is required to read behavior references')
  }
  const referenceRoot = resolve(
    configuredRoot,
    'investment-behavior-diagnosis',
    'references',
  )
  const root = await realpath(referenceRoot)
  const requested = join(referenceRoot, TOPIC_FILES[topic])
  const requestedStat = await lstat(requested)
  if (requestedStat.isSymbolicLink()) throw new Error('behavior reference files must not be symbolic links')
  const target = await realpath(requested)
  if (!isWithin(root, target) || dirname(target) !== root) {
    throw new Error('behavior reference resolved outside the approved reference directory')
  }
  const targetStat = await stat(target)
  const maxBytes = options.maxBytes ?? 256 * 1024
  if (!targetStat.isFile()) throw new Error('behavior reference target is not a regular file')
  if (targetStat.size > maxBytes) throw new Error('behavior reference exceeds ' + maxBytes + ' bytes')
  return { topic, content: await readFile(target, 'utf8') }
}

export function createBehaviorReferenceTool(options: BehaviorReferenceOptions = {}): ToolDefinition {
  return defineTool({
    name: 'finance_behavior_reference',
    description: 'Read one approved theory or method reference bundled with investment-behavior-diagnosis. For any behavioral-finance interpretation or theory request, first load investment-behavior-diagnosis with the skill tool; this reference is progressive detail, not a substitute for the entrypoint. Then load only the topic needed for deeper theory, formulas, evidence rules, or intervention boundaries.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        enum: [...BEHAVIOR_REFERENCE_TOPICS],
        description: 'Approved reference topic.',
      },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return await readBehaviorReference(args.topic, options) as never
    },
  })
}
