#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const tracePath = process.argv[2]
const exitCode = Number(process.argv[3] ?? '0')
if (tracePath === undefined || !Number.isSafeInteger(exitCode)) {
  throw new Error('trace path and integer exit code are required')
}

const childSource = String.raw`
  const { appendFileSync } = require('node:fs')
  const tracePath = process.argv[1]
  const trace = message => appendFileSync(tracePath, message + '\n', 'utf8')
  process.on('SIGTERM', () => trace('term:child:' + process.pid))
  trace('child-ready:' + process.pid)
  if (process.send) process.send('ready')
  if (process.disconnect) process.disconnect()
  setTimeout(() => { trace('self-timeout:' + process.pid); process.exit(0) }, 2500)
  setInterval(() => {}, 1000)
`
const child = spawn(process.execPath, ['-e', childSource, tracePath], {
  stdio: ['ignore', process.stdout, process.stderr, 'ipc'],
})
child.unref()
appendFileSync(tracePath, `parent-ready:${process.pid}:${child.pid}\n`, 'utf8')

child.once('message', () => {
  const response = JSON.stringify({
    version: '1',
    ok: true,
    data: {
      datetime: '2026-09-04T15:00:00+08:00',
      price: 12.34,
      padding: 'x'.repeat(64 * 1024),
    },
    meta: { attempts: 1, serverIndex: 0 },
  })
  const midpoint = Math.floor(response.length / 2)
  process.stdout.write(response.slice(0, midpoint), () => {
    process.stdout.write(response.slice(midpoint), () => {
      process.exit(exitCode)
    })
  })
})
