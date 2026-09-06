#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import {
  VendorError,
  checkVendor,
  discoverLatestStableTag,
  syncVendor,
} from './a-stock-data/vendor-lib.mjs'

function usage() {
  return `Usage:
  node scripts/sync-a-stock-data.mjs check [--json]
  node scripts/sync-a-stock-data.mjs sync --version vX.Y.Z [--source-dir PATH] [--dry-run] [--json]
  node scripts/sync-a-stock-data.mjs discover [--json]
  node scripts/sync-a-stock-data.mjs --latest [--dry-run] [--json] [--fail-on-blocked]

Network access occurs only for sync without --source-dir and for discover/--latest.
`
}

function parseArgs(argv) {
  const options = { json: false, dryRun: false, failOnBlocked: false }
  let command = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (['check', 'sync', 'discover', 'latest'].includes(arg) && command === null) command = arg
    else if (arg === '--check') command = 'check'
    else if (arg === '--latest') command = 'latest'
    else if (arg === '--json') options.json = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--fail-on-blocked') options.failOnBlocked = true
    else if (arg === '--version') options.version = argv[++index]
    else if (arg === '--source-dir') options.sourceDir = argv[++index]
    else if (arg === '--root') options.root = argv[++index]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new VendorError(`unknown argument: ${arg}`, { code: 'arguments' })
  }
  return { command: command ?? 'check', options }
}

function render(result, json) {
  if (json) return `${JSON.stringify(result, null, 2)}\n`
  const lines = [`a-stock-data ${result.status}`]
  if (result.version) lines.push(`version: ${result.version}`)
  if (result.current) lines.push(`current: ${result.current.version}`)
  if (result.candidate) lines.push(`candidate: ${result.candidate.version}`)
  if (result.changedFiles?.length) lines.push(...result.changedFiles.map(path => `changed: ${path}`))
  if (result.errors?.length) lines.push(...result.errors.map(message => `error: ${message}`))
  if (result.blockers?.length) lines.push(...result.blockers.map(message => `blocked: ${message}`))
  return `${lines.join('\n')}\n`
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv)
  if (options.help) { process.stdout.write(usage()); return 0 }
  let result
  if (command === 'check') {
    if (options.version || options.sourceDir || options.dryRun) throw new VendorError('check does not accept sync options', { code: 'arguments' })
    result = await checkVendor(options)
  } else if (command === 'discover' || command === 'latest') {
    if (options.version || options.sourceDir) throw new VendorError(`${command} does not accept --version or --source-dir`, { code: 'arguments' })
    result = await discoverLatestStableTag({ ...options, allowNetwork: true })
  } else {
    if (!options.version) throw new VendorError('sync requires --version', { code: 'arguments' })
    result = await syncVendor({ ...options, allowNetwork: !options.sourceDir })
  }
  process.stdout.write(render(result, options.json))
  if (result.status === 'blocked' && options.failOnBlocked) return 2
  if (result.status === 'drift' || result.ok === false) return 1
  return 0
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) {
  try { process.exitCode = await main() }
  catch (error) {
    const result = { schemaVersion: 1, status: error?.blocked ? 'blocked' : 'error', changed: false, blockers: error?.blocked ? [error.message] : [], errors: error?.blocked ? [] : [error.message], code: error?.code ?? 'unexpected' }
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = error?.blocked && process.argv.includes('--fail-on-blocked') ? 2 : 1
  }
}
