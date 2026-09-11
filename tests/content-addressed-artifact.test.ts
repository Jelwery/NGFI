import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { readContentAddressedJson } from '@finance2dsh/dsh-tools'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngfi-content-addressed-'))
  roots.push(dir)
  return dir
}

function writeJson(dir: string, name: string, value: unknown): { file: string; hash: `sha256:${string}` } {
  const file = path.join(dir, name)
  const text = JSON.stringify(value)
  fs.writeFileSync(file, text)
  return { file, hash: `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` }
}

describe('content-addressed artifact reader', () => {
  it('reads a JSON object when the hash matches and reports byte length', () => {
    const dir = tempDir()
    const { file, hash } = writeJson(dir, 'mandate.json', { schemaVersion: '1', id: 'm' })
    const read = readContentAddressedJson(file, hash)
    expect(read.value).toEqual({ schemaVersion: '1', id: 'm' })
    expect(read.hash).toBe(hash)
    expect(read.bytes).toBe(fs.statSync(file).size)
  })

  it('rejects a hash mismatch without exposing the value', () => {
    const dir = tempDir()
    const { file } = writeJson(dir, 'mandate.json', { schemaVersion: '1' })
    expect(() => readContentAddressedJson(file, `sha256:${'0'.repeat(64)}`)).toThrow(/hash mismatch/u)
  })

  it('enforces the byte cap before parsing', () => {
    const dir = tempDir()
    const big = { schemaVersion: '1', blob: 'x'.repeat(1024) }
    const { file, hash } = writeJson(dir, 'big.json', big)
    expect(() => readContentAddressedJson(file, hash, { maxBytes: 256 })).toThrow(/exceeds 256 bytes/u)
  })

  it('refuses symlinked artifacts', () => {
    const dir = tempDir()
    const { file, hash } = writeJson(dir, 'real.json', { schemaVersion: '1' })
    const link = path.join(dir, 'link.json')
    fs.symlinkSync(file, link)
    expect(() => readContentAddressedJson(link, hash)).toThrow(/regular file/u)
  })

  it('checks optional schemaVersion and row count and fails closed', () => {
    const dir = tempDir()
    const wrong = writeJson(dir, 'schema.json', { schemaVersion: '2' })
    expect(() => readContentAddressedJson(wrong.file, wrong.hash, { schemaVersion: '1' })).toThrow(/schemaVersion must be 1/u)
    const rows = writeJson(dir, 'rows.json', { schemaVersion: '1', securities: [1, 2, 3] })
    expect(() => readContentAddressedJson(rows.file, rows.hash, { maxRows: 2, rowsField: 'securities' })).toThrow(/exceeds 2 rows/u)
    const ok = readContentAddressedJson(rows.file, rows.hash, { schemaVersion: '1', maxRows: 3, rowsField: 'securities' })
    expect((ok.value as { securities: number[] }).securities).toEqual([1, 2, 3])
  })

  it('rejects invalid JSON and non-object roots', () => {
    const dir = tempDir()
    const file = path.join(dir, 'broken.json')
    fs.writeFileSync(file, '{ not json')
    const hash = `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` as const
    expect(() => readContentAddressedJson(file, hash)).toThrow(/not valid JSON/u)
    const scalar = writeJson(dir, 'scalar.json', 42)
    expect(() => readContentAddressedJson(scalar.file, scalar.hash)).toThrow(/must be a JSON object or array/u)
  })
})
