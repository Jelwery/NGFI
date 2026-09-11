#!/usr/bin/env node
/** Fixed JSON-only bridge to the canonical finance-core calculations. No dynamic code or shell. */
import { calculateDcf, calculateDcfSensitivity, calculateWacc } from '../lib/valuation.js'

const operations = Object.freeze({
  dcf: calculateDcf,
  dcf_sensitivity: calculateDcfSensitivity,
  wacc: calculateWacc,
})

try {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new RangeError('input exceeds 2 MiB')
  }
  const request = JSON.parse(text)
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['op', 'input'].includes(key))
      || !Object.hasOwn(operations, request.op)
      || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new TypeError('expected {op: dcf|dcf_sensitivity|wacc, input: object}')
  }
  const result = operations[request.op](request.input)
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
