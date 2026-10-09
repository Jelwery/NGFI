#!/usr/bin/env node
import { openSync, readSync, fstatSync, closeSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { executeQuantResearch, quantArtifactComputation } from '../packages/dsh-finance-tools/lib/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  workspace: { type: 'string', default: 'default' }, case: { type: 'string' }, revision: { type: 'string' },
  'dataset-id': { type: 'string' }, spec: { type: 'string' }, section: { type: 'string' },
  offset: { type: 'string' }, limit: { type: 'string' }, resume: { type: 'boolean' },
  request: { type: 'string' }, registration: { type: 'string' }, stage: { type: 'string' }, 'evaluation-id': { type: 'string' },
  kind: { type: 'string' },
} })
const options = { quantProjectRoot: resolve(root, 'packages/combinatorial-optimization'),
  runtimeRoot: process.env.NGFI_RUNTIME_DATA_ROOT || resolve(root, '.runtime/finance-data'),
  uvExecutable: process.env.NGFI_UV_EXECUTABLE || 'uv' }
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

function readJson(file) {
  if (!file) throw new Error('A local JSON file is required')
  const descriptor = openSync(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('Input must be a regular JSON file within 128 MiB')
    const buffers = []
    const chunk = Buffer.allocUnsafe(65536)
    let total = 0
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null)
      if (!count) break
      total += count
      if (total > 128 * 1024 * 1024) throw new Error('Input exceeds 128 MiB')
      buffers.push(Buffer.from(chunk.subarray(0, count)))
    }
    return Buffer.concat(buffers).toString('utf8')
  } finally { closeSync(descriptor) }
}

try {
  const action = positionals[0]
  let result
  if (action === 'demo') {
    const input = await quantArtifactComputation(options, 'demo', {}, controller.signal)
    const imported = await executeQuantResearch(options, values.workspace, { action: 'import', dataset: input.dataset }, controller.signal)
    result = await executeQuantResearch(options, values.workspace, { action: 'run', caseId: imported.caseId,
      expectedRevision: imported.revision, datasetId: imported.datasetId, spec: input.spec }, controller.signal)
  } else {
    if (!['catalog', 'schema', 'import', 'run', 'get', 'list', 'factor-catalog', 'factor-register', 'factor-derive', 'factor-evaluate', 'factor-explain', 'factor-compare', 'factor-get', 'attribute'].includes(action)) throw new Error('Unknown command; see docs/quant-research.md for experiment and factor commands')
    const request = { action }
    if (values.case !== undefined) request.caseId = values.case
    if (values.revision !== undefined) request.expectedRevision = Number(values.revision)
    if (action === 'import') request.dataset = await quantArtifactComputation(options, 'parse-json', { text: readJson(positionals[1]) }, controller.signal)
    if (action === 'run') {
      request.datasetId = values['dataset-id']
      if (values['evaluation-id']) request.evaluationId = values['evaluation-id']
      request.spec = await quantArtifactComputation(options, 'parse-json', { text: readJson(values.spec) }, controller.signal)
      if (values.resume !== undefined) request.resume = values.resume
    }
    if (['factor-register', 'factor-derive', 'factor-explain'].includes(action)) {
      request.request = await quantArtifactComputation(options, 'parse-json', { text: readJson(values.request) }, controller.signal)
      if (values['evaluation-id']) request.evaluationId = values['evaluation-id']
      if (values.resume !== undefined) request.resume = values.resume
    }
    if (action === 'factor-evaluate') {
      request.datasetId = values['dataset-id']
      request.registration = await quantArtifactComputation(options, 'parse-json', { text: readJson(values.registration) }, controller.signal)
      if (values.stage) request.stage = values.stage
      if (values.resume !== undefined) request.resume = values.resume
    }
    if (action === 'get' || action === 'factor-get' || action === 'factor-compare' || action === 'attribute') {
      if (action !== 'factor-compare') request.runId = positionals[1]
      if (action === 'factor-compare' && values['evaluation-id']) request.evaluationId = values['evaluation-id']
      if (action === 'attribute') request.kind = values.kind
      if (values.section !== undefined) request.section = values.section
      if (values.offset !== undefined) request.offset = Number(values.offset)
      if (values.limit !== undefined) request.limit = Number(values.limit)
    }
    result = await executeQuantResearch(options, values.workspace, request, controller.signal)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
