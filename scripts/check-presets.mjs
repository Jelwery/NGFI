#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const generatedRoot = resolve(root, 'generated/agent-presets')
const sourceRoot = resolve(root, 'config/agent-presets')

if (!existsSync(sourceRoot)) {
  process.stdout.write('preset drift check: generated presets are the transitional source of truth for Phase 1\n')
} else {
  const failures = []
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of ['agent.cordis.yml', 'preset.yml']) {
      const source = resolve(sourceRoot, entry.name, file)
      const generated = resolve(generatedRoot, entry.name, file)
      if (!existsSync(source) || !existsSync(generated)) failures.push(`${entry.name}/${file}: missing source or generated file`)
      else if (JSON.stringify(parse(readFileSync(source, 'utf8'))) !== JSON.stringify(parse(readFileSync(generated, 'utf8')))) {
        failures.push(`${entry.name}/${file}: generated preset drift`)
      }
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`preset check: ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('preset drift check passed\n')
  }
}
