#!/usr/bin/env node
// Synthetic engineering acceptance through the real operator CLI.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { sha256 } from '../packages/research-core/lib/index.js'
import { quantArtifactComputation } from '../packages/dsh-finance-tools/lib/index.js'

const project = fileURLToPath(new URL('..', import.meta.url))
const outputParent = join(project, '.runtime', 'factor-smoke-runs')
mkdirSync(outputParent, { recursive: true, mode: 0o700 })
const output = mkdtempSync(join(realpathSync(outputParent), 'run-'))
const runtimeRoot = join(output, 'runtime')
const env = { ...process.env, NGFI_RUNTIME_DATA_ROOT: runtimeRoot }
const options = {
  quantProjectRoot: join(project, 'packages/combinatorial-optimization'),
  runtimeRoot, uvExecutable: process.env.NGFI_UV_EXECUTABLE || 'uv'
}
const manifest = { synthetic: true, promotionEligible: false, output, runtimeRoot, workspace: 'factor-smoke', steps: [] }
const save = (name, value) => {
  const file = join(output, `${name}.json`)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}
let sequence = 0, caseId, revision, datasetId, evaluationId
function cli(label, args, expectedError) {
  console.log(`${++sequence}. ${label}`)
  const command = [join(project, 'scripts/quant-research.mjs'), '--workspace', manifest.workspace, ...args.map(String)]
  const result = spawnSync(process.execPath, command, {
    cwd: project, env, encoding: 'utf8',
    timeout: 180_000, maxBuffer: 16 * 1024 * 1024
  })
  save(`${sequence}-command`, { executable: process.execPath, args: command, env: { NGFI_RUNTIME_DATA_ROOT: runtimeRoot } })
  if (result.error) throw result.error
  if (expectedError) {
    assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`)
    assert.match(result.stderr, expectedError)
    save(`${sequence}-rejection`, { stderr: result.stderr })
    manifest.steps.push({ label, status: 'expected-rejection' })
    return
  }
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  save(`${sequence}-result`, value)
  manifest.steps.push({ label, status: 'passed' })
  if (value.revision !== undefined && value.caseId === caseId) revision = value.revision
  return value
}
const write = (label, args, error) => cli(label, [...args, '--case', caseId, '--revision', revision], error)
const factorGet = (label, runId, section) => cli(label,
  ['factor-get', runId, '--case', caseId, '--section', section, '--limit', 200])

console.log(`Synthetic acceptance artifacts: ${output}`)
try {
  const demo = await quantArtifactComputation(options, 'demo', {})
  const data = {
    ...demo.dataset, schemaVersion: '3', snapshotId: 'synthetic-factor-smoke-v3',
    provenance: 'Synthetic engineering fixture: prices, weekdays, volumes, flat index and return decomposition; no market evidence.'
  }
  const key = instrument => `${instrument.market}:${instrument.exchange}:${instrument.symbol}:equity`
  const prices = new Map()
  data.bars.forEach((bar, index) => {
    const day = Math.floor(index / 8), stock = index % 8
    bar.volume = Math.round(1_000_000 * (1.2 + 0.3 * Math.sin(day * (stock + 1) * 0.37) + stock * 0.03))
    bar.amount = bar.close * bar.volume
    prices.set(`${bar.date}/${key(bar.instrument)}`, bar.close)
  })
  const securities = [...new Set(data.bars.map(bar => key(bar.instrument)))].sort()
  data.benchmark = {
    instrument: 'CN:SSE:000300:index', convention: 'price',
    sourceHash: sha256('synthetic-flat-index'), points: data.calendar.map(row =>
      ({ date: row.date, value: 100, availableAt: row.decisionAt }))
  }
  data.returnAttribution = data.calendar.slice(1).map((day, index) => {
    const previous = data.calendar[index]
    return {
      date: day.date, previousDate: previous.date, weightsAvailableAt: previous.decisionAt,
      factorReturnsAvailableAt: day.decisionAt, modelHash: sha256('synthetic-country-model'),
      sourceHash: sha256('synthetic-price-returns'), benchmarkWeights: Object.fromEntries(securities.map(name => [name, 1 / securities.length])),
      exposures: Object.fromEntries(securities.map(name => [name, { COUNTRY: 1 }])),
      factorKinds: { COUNTRY: 'country' }, factorReturns: { COUNTRY: 0 },
      industries: Object.fromEntries(securities.map(name => [name, 'synthetic'])),
      specificReturns: Object.fromEntries(securities.map(name => [name,
        prices.get(`${day.date}/${name}`) / prices.get(`${previous.date}/${name}`) - 1]))
    }
  })
  const dataFile = save('dataset', data)
  const imported = cli('Import synthetic v3 dataset', ['import', dataFile])
    ; ({ caseId, revision, datasetId } = imported)
  manifest.caseId = caseId
  manifest.datasetId = datasetId
  cli('Operator catalog', ['factor-catalog'])
  const hypothesis = 'Synthetic engineering acceptance of bounded reversal-volume research; not an alpha claim.'
  const deriveFile = save('derive', { generator: 'reversal-volume-v1', hypothesis, budget: 17 })
  const family = write('Derive 17 candidates', ['factor-derive', '--request', deriveFile])
  const definitions = factorGet('Inspect definitions', family.runId, 'definitions').items
  const lineage = factorGet('Inspect lineage', family.runId, 'lineage').items
  assert.equal(definitions.length, 17)
  assert.equal(lineage.length, 17)
  assert(lineage.some(row => row.parents.length === 2))
  const factorFile = save('factors', { factors: definitions, hypothesis })
  write('Register versioned assets', ['factor-register', '--request', factorFile])
  const dates = data.calendar.map(row => row.date)
  const selectedFeature = 'reversal_volume_5_10'
  const spec = {
    ...demo.spec, schemaVersion: '3', trainingStartDate: dates[25], startDate: dates[75], endDate: dates[98],
    factors: definitions.filter(row => ['reversal_5', 'volume_10', selectedFeature].includes(row.id)),
    modelFeatures: [selectedFeature], model: { ...demo.spec.model, horizon: 1, trainSessions: 20 }
  }
  const controls = { controls: ['industry'], weighting: 'uniform', horizon: 1, maximumCondition: 1_000_000 }
  const registration = {
    hypothesis, familyId: family.familyId, factors: definitions, candidateBudget: 17,
    train: { start: dates[25], end: dates[54] }, validation: { start: dates[55], end: dates[74] },
    test: { start: dates[75], end: dates[99] }, horizons: [1], maximumSelected: 32,
    minimumRankIc: -1, duplicateCorrelation: 1, styleControls: [controls], experimentSpec: spec
  }
  const registrationFile = save('evaluation', registration), specFile = save('spec', spec)
  const evaluationArgs = ['factor-evaluate', '--dataset-id', datasetId, '--registration', registrationFile]
  const before = revision
  write('Reject misspelled stage', [...evaluationArgs, '--stage', 'developmnt'], /Unknown evaluation stage/)
  const listing = cli('Verify rejected request leaves revision unchanged', ['list'])
  assert.equal(listing.cases.find(row => row.caseId === caseId).revision, before)
  const development = write('Evaluate development partitions', [...evaluationArgs, '--stage', 'development'])
  evaluationId = development.evaluationId
  manifest.evaluationId = evaluationId
  const selection = Object.fromEntries(factorGet('Inspect frozen selection', development.runId, 'selection').items.map(row => [row.key, row.value]))
  assert(selection.selected.includes(selectedFeature), 'Preregistered feature did not qualify; do not tune on test')
  cli('Compare candidates', ['factor-compare', '--case', caseId, '--evaluation-id', evaluationId])
  const explanationFile = save('explanation', {
    factors: definitions, factor: selectedFeature,
    partition: registration.validation, ...controls
  })
  const explanation = write('Explain industry exposure', ['factor-explain', '--evaluation-id', evaluationId, '--request', explanationFile])
  assert.equal(explanation.status, 'complete')
  factorGet('Inspect daily style explanation', explanation.runId, 'days')
  const test = write('Consume frozen test', [...evaluationArgs, '--stage', 'test'])
  assert.equal(test.status, 'complete')
  assert.equal(write('Replay test idempotently', [...evaluationArgs, '--stage', 'test']).replay, true)
  const runArgs = ['run', '--dataset-id', datasetId, '--evaluation-id', evaluationId, '--spec', specFile]
  const experiment = write('Run preregistered model and portfolio', runArgs)
  assert.equal(experiment.status, 'complete')
  assert.equal(experiment.promotionEligible, false)
  manifest.runId = experiment.runId
  assert.equal(write('Replay experiment idempotently', runArgs).replay, true)
  for (const kind of ['model', 'returns', 'risk']) {
    const summary = cli(`Read ${kind} attribution`, ['attribute', experiment.runId, '--case', caseId, '--kind', kind])
    assert.equal(summary.status, kind === 'risk' ? 'partial' : 'complete')
    const rows = cli(`Read ${kind} details`, ['attribute', experiment.runId, '--case', caseId, '--kind', kind,
      '--section', kind === 'returns' ? 'daily' : 'rows', '--limit', 200])
    assert(rows.total > 0)
    if (kind === 'risk') assert(rows.items.every(row => row.status === 'blocked'))
    if (kind === 'returns') assert.equal(summary.linked.status, 'available')
  }
  const other = cli('Import into a second workspace', ['--workspace', 'factor-smoke-other', 'import', dataFile])
  cli('Reject shared holdout reuse', ['--workspace', 'factor-smoke-other', ...evaluationArgs,
    '--case', other.caseId, '--revision', other.revision], /overlaps/)
  manifest.status = 'passed'
  manifest.limitations = ['Synthetic engineering checks only', 'Risk snapshots absent: expected blocked rows',
    'No real CNE6, source quality, full-market capacity or forward performance acceptance']
  save('manifest', manifest)
  console.log(`PASS: ${manifest.steps.length} CLI checks. Manifest: ${join(output, 'manifest.json')}`)
} catch (error) {
  manifest.status = 'failed'
  manifest.error = error.message
  save('manifest', manifest)
  console.error(error)
  process.exitCode = 1
}
