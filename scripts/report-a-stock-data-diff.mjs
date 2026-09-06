#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDiffReport, ReportInputError } from './a-stock-data/report.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `Usage: node scripts/report-a-stock-data-diff.mjs [options]

Compare local A-stock vendor manifests without network access.

Required baseline (choose one):
  --base PATH               Base directory or manifest/bundle JSON
  --base-manifest PATH      Base capability manifest or manifest bundle
  --base-ref REF            Base Git ref (local repository objects only)

Current snapshot:
  --current PATH            Current directory or manifest/bundle JSON
  --current-manifest PATH   Current capability manifest or manifest bundle
  --current-ref REF         Current Git ref (local repository objects only)
                            Defaults to the working tree manifests

Output:
  --json                    Alias for --format json
  --format markdown|json    Output format (default: markdown)
  --output PATH             Write output to PATH instead of stdout
  --fail-on blocked         Exit 2 when the report is blocked
  --help                    Show this help
`

function invalid(message) {
  const error = new ReportInputError(message, 'cli-invalid')
  error.showUsage = true
  return error
}

function takeValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw invalid(`${option} requires a value`)
  return value
}

export function parseArgs(argv) {
  const options = { root: ROOT }
  let format = 'markdown'
  let output = null
  let failOn = null
  let help = false
  const seen = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--json') {
      format = 'json'
      continue
    }
    if (argument === '--base' || argument === '--base-manifest' || argument === '--base-ref'
      || argument === '--current' || argument === '--current-manifest' || argument === '--current-ref'
      || argument === '--format' || argument === '--output' || argument === '--fail-on') {
      if (seen.has(argument)) throw invalid(`${argument} may be specified only once`)
      seen.add(argument)
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === '--base') options.base = value
      else if (argument === '--base-manifest') options.baseManifest = value
      else if (argument === '--base-ref') options.baseRef = value
      else if (argument === '--current') options.current = value
      else if (argument === '--current-manifest') options.currentManifest = value
      else if (argument === '--current-ref') options.currentRef = value
      else if (argument === '--format') format = value
      else if (argument === '--output') output = value
      else failOn = value
      continue
    }
    throw invalid(`unknown option: ${argument}`)
  }

  const baseInputs = ['base', 'baseManifest', 'baseRef'].filter(key => options[key] !== undefined)
  const currentInputs = ['current', 'currentManifest', 'currentRef'].filter(key => options[key] !== undefined)
  if (!help && baseInputs.length !== 1) throw invalid('choose exactly one of --base, --base-manifest, or --base-ref')
  if (currentInputs.length > 1) throw invalid('choose at most one of --current, --current-manifest, or --current-ref')
  if (!['markdown', 'json'].includes(format)) throw invalid('--format must be markdown or json')
  if (failOn !== null && failOn !== 'blocked') throw invalid('--fail-on only supports blocked')

  return { options, format, output, failOn, help }
}

async function emit(content, output) {
  if (output) {
    const path = resolve(process.cwd(), output)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return
  }
  process.stdout.write(content)
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const report = await buildDiffReport(parsed.options)
  const content = parsed.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : report.markdown
  await emit(content, parsed.output)
  return parsed.failOn === 'blocked' && report.blocked ? 2 : 0
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntryPoint) {
  try {
    process.exitCode = await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`a-stock-data diff: ${message}\n`)
    if (error?.showUsage) process.stderr.write(`\n${USAGE}`)
    process.exitCode = 1
  }
}
