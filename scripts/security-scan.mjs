#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VALID_MODES = new Set(['--tracked', '--worktree', '--staged'])
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const DISALLOWED_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

// Binary files cannot be searched reliably for text credentials, so they fail
// closed. If a reviewed binary ever has to be committed, pin the exact path,
// a conservative size ceiling, and its content digest here. Never allow a
// binary based only on its extension or containing directory.
const ALLOWED_BINARY_BLOBS = new Map([
  // ['path/to/reviewed.bin', { maxBytes: 1_024, sha256: '<64 lowercase hex chars>' }],
])

// Only whole, deliberately recognizable placeholders are exempt. A real value
// is never ignored merely because it happens to contain "test" or "fixture".
const SAFE_PLACEHOLDER = /^(?:[$][{][A-Za-z_][A-Za-z0-9_]*[}]|<(?:YOUR|SAFE)_[A-Z][A-Z0-9_]*>|process\.env\.[A-Z][A-Z0-9_]*|your_key_here|your-api-key|replace-with-your-(?:key|tdx-data-key|tushare-token|ifind-credential|iwencai-key)|(?:fixture-secret|fixture-secret-that-must-not-leak|tdx-test-secret-that-must-not-leak|ifind-secret-that-must-not-leak|test-only-placeholder|configured|configured-secret|must-not-be-read)|0123456789(?:abcdef|abcdefghijklmnop|abcdefghijklmnopqrstuvwxyz))$/iu
const QUOTED_ASSIGNMENT = /(?:^|[\s{,(;])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1\s*:\s*(["'])([^"'\r\n]{12,})\3/gu
const UNQUOTED_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*([$][{][A-Za-z_][A-Za-z0-9_]*[}]|[^\s#;,}\]]{12,})/gu
const DECLARED_ASSIGNMENT = /^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(["'])([^"'\r\n]{12,})\2/gu
const credentialPatterns = [
  {
    rule: 'credential-url',
    regex: /(?:[?&](?:api[_-]?key|access[_-]?token|auth|auth[_-]?token|authorization|cookie|credential|data[_-]?key|password|secret|signature|token)=|\/token=)([^&#\s"'<>`]{12,})/giu,
  },
  { rule: 'basic-auth', regex: /\bAuthorization\s*:\s*Basic\s+([A-Za-z0-9+/]{12,}={0,2})/giu },
  { rule: 'bearer-token', regex: /\bBearer\s+([A-Za-z0-9._~-]{16,})/gu },
  { rule: 'github-token', regex: /\b((?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}))\b/gu },
]
const absolutePathPatterns = [
  /\/Users\/[^/\s]+\//gu,
  /\/home\/[^/\s]+\//gu,
]

function nulList(args) {
  const output = execFileSync('git', args, { cwd: root })
  return output.toString('utf8').split('\0').filter(Boolean)
}

function stagedIndex() {
  const entries = new Map()
  for (const record of nulList(['ls-files', '--stage', '-z'])) {
    const separator = record.indexOf('\t')
    if (separator < 0) continue
    const [fileMode, oid, stage] = record.slice(0, separator).split(' ')
    const relative = record.slice(separator + 1)
    if (stage === '0' && oid !== undefined) entries.set(relative, { fileMode, oid })
  }
  return entries
}

function candidates(mode) {
  if (mode === '--staged') {
    const index = stagedIndex()
    return nulList(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
      .map(relative => ({ relative, ...index.get(relative) }))
  }
  if (mode === '--worktree') {
    return nulList(['ls-files', '-co', '--exclude-standard', '-z']).map(relative => ({ relative }))
  }
  return nulList(['ls-files', '-z']).map(relative => ({ relative }))
}

function candidateContent(mode, candidate) {
  if (mode === '--staged') {
    if (candidate.oid === undefined || candidate.fileMode === '160000') {
      throw new Error(`staged path has no scannable blob: ${candidate.relative}`)
    }
    return execFileSync('git', ['cat-file', 'blob', candidate.oid], { cwd: root })
  }
  return readFileSync(resolve(root, candidate.relative))
}

function decodeText(buffer) {
  try {
    const text = utf8Decoder.decode(buffer)
    return DISALLOWED_TEXT_CONTROLS.test(text) ? null : text
  } catch {
    return null
  }
}

function allowedBinary(relative, buffer) {
  const policy = ALLOWED_BINARY_BLOBS.get(relative)
  if (policy === undefined || buffer.length > policy.maxBytes) return false
  return createHash('sha256').update(buffer).digest('hex') === policy.sha256
}

function sensitiveName(name) {
  return /^(?:TDX_DATA_KEY|IFIND_MCP_CREDENTIAL)$/iu.test(name)
    || /(?:(?:api|data)[_-]?key|access[_-]?token|auth[_-]?token|token|secret|credential|password|authorization|cookie)$/iu.test(name)
}

function assignmentMatches(line) {
  const matches = []
  QUOTED_ASSIGNMENT.lastIndex = 0
  for (const match of line.matchAll(QUOTED_ASSIGNMENT)) {
    const value = match[4] ?? ''
    if (sensitiveName(match[2] ?? '') && !matches.includes(value)) matches.push(value)
  }
  UNQUOTED_ASSIGNMENT.lastIndex = 0
  for (const match of line.matchAll(UNQUOTED_ASSIGNMENT)) {
    const value = match[2] ?? ''
    if (sensitiveName(match[1] ?? '') && !matches.includes(value)) matches.push(value)
  }
  DECLARED_ASSIGNMENT.lastIndex = 0
  for (const match of line.matchAll(DECLARED_ASSIGNMENT)) {
    const value = match[3] ?? ''
    if (sensitiveName(match[1] ?? '') && !matches.includes(value)) matches.push(value)
  }
  return matches
}

function normalizedAssignmentValue(value) {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value
}

export function scanText(relative, text, localSecrets = []) {
  const findings = []
  const lines = text.split(/\r?\n/u)

  for (const secret of localSecrets) {
    if (secret.length < 12) continue
    for (let index = 0; index < lines.length; index += 1) {
      if ((lines[index] ?? '').includes(secret)) {
        findings.push({ file: relative, line: index + 1, rule: 'local-secret-value' })
      }
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    for (const rawValue of assignmentMatches(line)) {
      const value = normalizedAssignmentValue(rawValue)
      if (!SAFE_PLACEHOLDER.test(value)) {
        findings.push({ file: relative, line: index + 1, rule: 'credential-assignment' })
      }
    }
    for (const { rule, regex } of credentialPatterns) {
      regex.lastIndex = 0
      for (const match of line.matchAll(regex)) {
        const value = match[1] ?? ''
        if (!SAFE_PLACEHOLDER.test(value)) {
          findings.push({ file: relative, line: index + 1, rule })
        }
      }
    }
    for (const regex of absolutePathPatterns) {
      regex.lastIndex = 0
      if (regex.test(line)) findings.push({ file: relative, line: index + 1, rule: 'absolute-machine-path' })
    }
    if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u.test(line)) {
      findings.push({ file: relative, line: index + 1, rule: 'private-key' })
    }
  }
  return findings
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line}: ${finding.rule}`
}

function loadLocalSecrets() {
  const values = []
  const secretPath = resolve(root, '.runtime', 'secrets', 'a-share-data.env')
  if (!existsSync(secretPath)) return values
  for (const raw of readFileSync(secretPath, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/u.exec(line)
    if (match === null) continue
    let value = match[1] ?? ''
    if ((value.startsWith('\"') && value.endsWith('\"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/u, '').trim()
    }
    if (value.length >= 12) values.push(value)
  }
  return values
}

export function runSecurityScan(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error('usage: node scripts/security-scan.mjs [--tracked|--worktree|--staged]')
  }
  const selected = candidates(mode)
  const localSecrets = loadLocalSecrets()
  const findings = []
  for (const candidate of selected) {
    const { relative } = candidate
    let buffer
    try {
      buffer = candidateContent(mode, candidate)
    } catch (error) {
      if (mode !== '--staged' && !existsSync(resolve(root, relative))) continue
      findings.push({ file: relative, line: 1, rule: 'unscannable-text' })
      continue
    }
    const text = decodeText(buffer)
    if (text === null) {
      if (!allowedBinary(relative, buffer)) {
        findings.push({ file: relative, line: 1, rule: 'binary-not-allowlisted' })
      }
      continue
    }
    // Deliberately scan text of every size. The previous 2 MiB skip created a
    // trivial credential-hiding boundary after the scanner had already read it.
    findings.push(...scanText(relative, text, localSecrets))
  }
  return { files: selected.map(candidate => candidate.relative), findings }
}

function main() {
  const mode = process.argv[2] ?? '--tracked'
  const result = runSecurityScan(mode)
  if (result.findings.length > 0) {
    for (const finding of result.findings) process.stderr.write(`${formatFinding(finding)}\n`)
    process.stderr.write(`security scan failed with ${result.findings.length} finding(s); secret values were not printed\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`security scan passed (${mode}, ${result.files.length} candidate files)\n`)
  }
}

if (process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
