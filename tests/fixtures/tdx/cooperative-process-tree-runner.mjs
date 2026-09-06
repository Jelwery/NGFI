#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const tracePath = process.argv[2]
if (tracePath === undefined) throw new Error('trace path is required')

function trace(message) {
  appendFileSync(tracePath, `${message}\n`, 'utf8')
}

process.on('SIGTERM', () => {
  trace(`term:parent:${process.pid}`)
  process.exit(0)
})

const childSource = String.raw`
  const { appendFileSync } = require('node:fs')
  const tracePath = process.argv[1]
  const trace = message => appendFileSync(tracePath, message + '\n', 'utf8')
  process.on('SIGTERM', () => {
    trace('term:child:' + process.pid)
    process.exit(0)
  })
  trace('child-ready:' + process.pid)
  setInterval(() => {}, 1000)
`
const child = spawn(process.execPath, ['-e', childSource, tracePath], {
  stdio: 'ignore',
})
child.unref()

trace(`parent-ready:${process.pid}:${child.pid}`)
setInterval(() => {}, 1_000)
