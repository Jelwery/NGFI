import { execFile as execFileCallback } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// @ts-expect-error The vendoring implementation is intentionally plain Node ESM.
import { discoverLatestStableTag, syncVendor } from '../scripts/a-stock-data/vendor-lib.mjs'
// @ts-expect-error The report implementation is intentionally plain Node ESM.
import { compareManifestSets } from '../scripts/a-stock-data/report.mjs'

const execFile = promisify(execFileCallback)
const ROOT = process.cwd()
const UPSTREAM = join(ROOT, 'packages/finance-data-service/providers/astock/upstream')
const SNAPSHOT_FILES = [
  'SKILL.md', 'LICENSE', 'CHANGELOG.md', 'tests/test_official_data.py', 'docs/source-integration-v3.8.0.md',
]

async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFile('git', args, { cwd, env: { ...process.env, ...env } })
}

async function prepareLocalTag(options: { license?: string; notice?: string } = {}) {
  const source = await mkdtemp(join(tmpdir(), 'ngfi-astock-source-'))
  for (const relativePath of SNAPSHOT_FILES) {
    const destination = join(source, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(UPSTREAM, relativePath), destination)
  }
  if (options.license !== undefined) await writeFile(join(source, 'LICENSE'), options.license)
  if (options.notice !== undefined) await writeFile(join(source, 'NOTICE'), options.notice)
  await git(source, ['init', '--quiet'])
  await git(source, ['add', '.'])
  const dates = { GIT_AUTHOR_DATE: '2026-09-05T01:42:49Z', GIT_COMMITTER_DATE: '2026-09-05T01:42:49Z' }
  await git(source, ['-c', 'user.name=NGFI Test', '-c', 'user.email=ngfi-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], dates)
  await git(source, ['-c', 'user.name=NGFI Test', '-c', 'user.email=ngfi-test@example.invalid', 'tag', '-a', 'v0.0.1', '-m', 'fixture tag'], dates)
  return source
}

async function commitTag(source: string, version: string, mutate: () => Promise<void>) {
  await mutate()
  await git(source, ['add', '.'])
  const date = version === 'v0.0.2' ? '2026-09-06T01:42:49Z' : '2026-09-07T01:42:49Z'
  const dates = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  await git(source, ['-c', 'user.name=NGFI Test', '-c', 'user.email=ngfi-test@example.invalid', 'commit', '--quiet', '-m', version], dates)
  await git(source, ['-c', 'user.name=NGFI Test', '-c', 'user.email=ngfi-test@example.invalid', 'tag', '-a', version, '-m', `${version} tag`], dates)
}

async function prepareDestination() {
  const destination = await mkdtemp(join(tmpdir(), 'ngfi-astock-destination-'))
  const copies: Array<readonly [string, string]> = [
    ['scripts/a-stock-data/extraction-spec.json', 'scripts/a-stock-data/extraction-spec.json'],
    ['packages/finance-data-service/providers/astock/upstream/source-manifest.json', 'packages/finance-data-service/providers/astock/upstream/source-manifest.json'],
  ]
  for (const [from, to] of copies) {
    await mkdir(dirname(join(destination, to)), { recursive: true })
    await cp(join(ROOT, from), join(destination, to))
  }
  return destination
}

interface WorkflowStep {
  id?: string
  name?: string
  if?: string
  'continue-on-error'?: boolean
  uses?: string
  run?: string
  with?: Record<string, unknown>
}

interface WorkflowJob {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  env?: Record<string, string>
  steps?: WorkflowStep[]
}

function loadWorkflow(): Promise<{ permissions?: Record<string, string>; jobs: Record<string, WorkflowJob> }> {
  return parseWorkflow(readFile(join(ROOT, '.github/workflows/sync-a-stock-data.yml'), 'utf8'))
}

async function parseWorkflow(source: Promise<string>) {
  return parse(await source) as { permissions?: Record<string, string>; jobs: Record<string, WorkflowJob> }
}

function jobScript(job: WorkflowJob): string {
  return (job.steps ?? []).map(step => step.run ?? '').join('\n')
}

describe('a-stock-data synchronization and reporting', () => {
  it('isolates the candidate suite and never executes candidate code with a write token', async () => {
    const workflow = await loadWorkflow()
    const prepare = workflow.jobs.prepare
    const publish = workflow.jobs.publish
    const blocked = workflow.jobs.report_blocked
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(prepare?.permissions).toEqual({ contents: 'read' })
    expect(publish?.permissions).toEqual({ contents: 'write', issues: 'write', 'pull-requests': 'write' })
    expect(blocked?.permissions).toEqual({ contents: 'none', issues: 'write', 'pull-requests': 'write' })

    for (const id of [
      'package_manager', 'node_dependencies', 'setup_uv', 'python_dependencies', 'candidate',
      'requested_version', 'sync_result', 'scope', 'checks', 'candidate_suite', 'report', 'artifact', 'upload',
    ]) {
      const step = prepare?.steps?.find(candidate => candidate.id === id)
      expect(step?.['continue-on-error'], id + ' must preserve a blocked result').toBe(true)
    }

    const isolatedStep = prepare?.steps?.find(step => step.run?.includes('unittest discover -s tests -v'))
    expect(isolatedStep?.run).toContain('docker run')
    expect(isolatedStep?.run).toContain('--network none')
    expect(isolatedStep?.run).toContain('--read-only')
    expect(isolatedStep?.run).toContain('--cap-drop ALL')
    expect(isolatedStep?.run).toContain('--security-opt no-new-privileges')
    expect(isolatedStep?.run).toMatch(/--user [^\s]+/u)
    expect(isolatedStep?.run).toContain('--pids-limit')
    expect(isolatedStep?.run).toContain('--memory')
    expect(isolatedStep?.run).toContain('--cpus')
    expect(isolatedStep?.run).toMatch(/python:[^\s]+@sha256:[0-9a-f]{64}/u)
    expect(isolatedStep?.run).toContain('--env ASTOCK_LIVE_TRADE_DATE=')
    expect(isolatedStep?.run).toContain('--env ASTOCK_LIVE_MARGIN_DATE=')
    expect(isolatedStep?.run).toContain(':ro')
    expect(isolatedStep?.run).toContain('unittest discover -s tests -v')
    expect(isolatedStep?.run).toContain('a-stock-candidate-suite.stdout')
    expect(isolatedStep?.run).toContain('a-stock-candidate-suite.stderr')
    expect(isolatedStep?.run).not.toMatch(/(?:pip|uv)\s+(?:install|sync)/u)
    expect(isolatedStep?.run).not.toContain('$GITHUB_TOKEN')

    const artifactStep = prepare?.steps?.find(step => step.id === 'artifact')
    const uploadStep = prepare?.steps?.find(step => step.id === 'upload')
    expect(artifactStep?.if).toContain("steps.candidate_suite.outcome == 'success'")
    expect(uploadStep?.if).toBe("steps.artifact.outcome == 'success'")

    const publishScript = jobScript(publish ?? {})
    expect(publishScript).not.toMatch(/(?:python(?:3)?|uv|pnpm|npm|yarn|bun)\s/u)
    expect(publishScript).not.toContain('scripts/')
    expect(publishScript).not.toContain('test_official_data.py')
    expect(publishScript).toContain('git fetch --no-tags origin')
    expect(publishScript).toContain('git diff --name-status -z')
    expect(publishScript).toContain('git rev-list --count')
    expect(publishScript).toContain('git diff-tree --root --no-commit-id --name-status -r -z')
    expect(publish?.if).toBe("needs.prepare.result == 'success' && needs.prepare.outputs.state == 'ready'")

    const allowedPaths = 'packages/finance-data-service/providers/astock/upstream/*|packages/finance-data-service/providers/astock/python/generated/*|THIRD_PARTY_NOTICES.md'
    expect(jobScript(prepare ?? {})).toContain(allowedPaths)
    expect(publishScript).toContain(allowedPaths)
    expect(jobScript(prepare ?? {})).toContain("status.includes('R') || status.includes('C')")
    expect(publishScript).toMatch(/(?:R\*|C\*)[\s\S]*check_path "[$]other"/u)
  })

  it('reports blocked preparation through a minimal non-candidate write path', async () => {
    const workflow = await loadWorkflow()
    const blocked = workflow.jobs.report_blocked
    expect(blocked?.needs).toBe('prepare')
    expect(blocked?.if).toContain('always()')
    expect(blocked?.if).toContain("needs.prepare.outputs.state == 'blocked'")
    expect(blocked?.permissions?.contents).toBe('none')
    expect(blocked?.permissions?.issues).toBe('write')
    expect(blocked?.permissions?.['pull-requests']).toBe('write')
    expect(blocked?.env?.GH_REPO).toBe('${{ github.repository }}')
    expect(blocked?.steps?.some(step => step.uses?.startsWith('actions/checkout@'))).toBe(false)
    expect(blocked?.steps?.some(step => step.uses?.startsWith('actions/download-artifact@'))).toBe(false)

    const script = jobScript(blocked ?? {})
    const resultStep = workflow.jobs.prepare?.steps?.find(step => step.id === 'result')
    const finalFailureStep = workflow.jobs.prepare?.steps?.find(step => step.name?.includes('Fail a blocked preparation'))
    expect(resultStep?.if).toBe('always()')
    expect(resultStep?.run).toContain('candidate-offline-suite-failed')
    expect(resultStep?.run).toContain('trusted-environment-failed')
    expect(finalFailureStep?.if).toContain("steps.result.outputs.state == 'blocked'")
    expect(script).toContain('blocked-upstream')
    expect(blocked?.env?.REASON_CODE).toBe('${{ needs.prepare.outputs.reason_code }}')
    expect(script).toContain('gh issue create')
    expect(script).toContain('gh issue edit')
    expect(script).not.toMatch(/(?:python(?:3)?|node|uv|pnpm|npm|yarn|bun|git apply)\s/u)
    expect(script).not.toMatch(/(?:stderr|ERROR_FILE|SUMMARY_FILE|candidate\.patch)/u)
    expect(script).toContain('GITHUB_RUN_ID')
    expect(script).toMatch(/case "\$REASON_CODE" in[\s\S]*candidate-offline-suite-failed/u)
    const pullRequestStep = workflow.jobs.publish?.steps?.find(step => step.name?.includes('version pull request'))
    expect(pullRequestStep?.run).toContain('isolated candidate upstream offline suite passed')
    expect(pullRequestStep?.run).not.toContain('static and fixture-only vendoring checks passed')
  })

  it('pins every external action and forbids automatic/default-branch publication', async () => {
    const workflowText = await readFile(join(ROOT, '.github/workflows/sync-a-stock-data.yml'), 'utf8')
    const workflow = parse(workflowText) as { jobs: Record<string, WorkflowJob> }
    const externalActions = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
      .map(step => step.uses).filter((uses): uses is string => uses !== undefined && !uses.startsWith('./'))
    expect(externalActions.length).toBeGreaterThan(0)
    for (const uses of externalActions) expect(uses).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u)

    const allScripts = Object.values(workflow.jobs).map(jobScript).join('\n')
    expect(allScripts).not.toMatch(/gh\s+pr\s+merge|--auto(?:\s|$)|enablePullRequestAutoMerge/u)
    expect(allScripts).not.toMatch(/git\s+push[^\n]*(?:HEAD:)?(?:refs\/heads\/)?(?:main|master)|git\s+push[^\n]*\$BASE_BRANCH/u)
    expect(jobScript(workflow.jobs.publish ?? {})).toContain('HEAD:refs/heads/$BRANCH')
  })

  it('discovers only stable annotated tags and blocks a moved tag', async () => {
    const refsText = [
      `${'1'.repeat(40)}\trefs/tags/v3.8.0`,
      `${'2'.repeat(40)}\trefs/tags/v3.8.0^{}`,
      `${'3'.repeat(40)}\trefs/tags/v3.10.0`,
      `${'4'.repeat(40)}\trefs/tags/v3.10.0^{}`,
      `${'5'.repeat(40)}\trefs/tags/v4.0.0-rc.1`,
    ].join('\n')
    const update = await discoverLatestStableTag({
      refsText,
      currentLock: { version: 'v3.8.0', tagObject: '1'.repeat(40), peeledCommit: '2'.repeat(40) },
    })
    expect(update).toMatchObject({ status: 'update-ready', changed: true, candidate: { version: 'v3.10.0' } })

    const moved = await discoverLatestStableTag({
      refsText: refsText.split('\n').slice(0, 2).join('\n'),
      currentLock: { version: 'v3.8.0', tagObject: '9'.repeat(40), peeledCommit: '2'.repeat(40) },
    })
    expect(moved).toMatchObject({ status: 'blocked', blockers: ['tag v3.8.0 moved'] })
  })

  it('produces deterministic clean and blocking manifest reports', async () => {
    const manifests = {
      lock: await json(join(UPSTREAM, 'upstream.lock.json')),
      capability: await json(join(UPSTREAM, 'capability-manifest.json')),
      source: await json(join(UPSTREAM, 'source-manifest.json')),
    }
    const clean = compareManifestSets(manifests, structuredClone(manifests))
    expect(clean).toMatchObject({ status: 'clean', changed: false, blocked: false, blockers: [] })
    expect(clean.markdown).toContain('No manifest differences were detected.')

    const removed = structuredClone(manifests)
    const removedName = removed.capability.functionInventory[0].name
    removed.capability.functionInventory.shift()
    const blocked = compareManifestSets(manifests, removed)
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockers).toContain(`function removed: ${removedName}`)
    expect(compareManifestSets(manifests, removed).markdown).toBe(blocked.markdown)

    const moved = structuredClone(manifests)
    moved.lock.tagObject = '0'.repeat(40)
    expect(compareManifestSets(manifests, moved).blockers).toContain('immutable upstream tag moved: v3.8.0')
  })

  it('requires every base and current manifest to own numeric schemaVersion 1', async () => {
    const manifests = {
      lock: await json(join(UPSTREAM, 'upstream.lock.json')),
      capability: await json(join(UPSTREAM, 'capability-manifest.json')),
      source: await json(join(UPSTREAM, 'source-manifest.json')),
    }
    const invalidVersions = [
      {
        name: 'missing',
        apply(manifest: Record<string, unknown>) {
          delete manifest.schemaVersion
          return manifest
        },
      },
      {
        name: 'string',
        apply(manifest: Record<string, unknown>) {
          manifest.schemaVersion = '1'
          return manifest
        },
      },
      {
        name: 'unsupported number',
        apply(manifest: Record<string, unknown>) {
          manifest.schemaVersion = 2
          return manifest
        },
      },
      {
        name: 'inherited',
        apply(manifest: Record<string, unknown>) {
          delete manifest.schemaVersion
          return Object.assign(Object.create({ schemaVersion: 1 }), manifest) as Record<string, unknown>
        },
      },
    ]

    for (const side of ['base', 'current'] as const) {
      for (const type of ['lock', 'capability', 'source'] as const) {
        for (const invalid of invalidVersions) {
          const base = structuredClone(manifests)
          const current = structuredClone(manifests)
          const target = side === 'base' ? base : current
          target[type] = invalid.apply(structuredClone(target[type]))

          const report = compareManifestSets(base, current)
          const scenario = `${side} ${type} schemaVersion is ${invalid.name}`
          expect(report.status, scenario).toBe('blocked')
          expect(report.blocked, scenario).toBe(true)
          expect(report.blockers.some((blocker: string) =>
            blocker.includes(`${side} ${type} manifest`) && blocker.includes('schemaVersion'),
          ), scenario).toBe(true)
        }
      }
    }
  })

  it('keeps dry-run write-free and repeated local-tag synchronization idempotent', async () => {
    const source = await prepareLocalTag()
    const dryRoot = await prepareDestination()
    const dryRun = await syncVendor({ root: dryRoot, sourceDir: source, version: 'v0.0.1', dryRun: true })
    expect(dryRun).toMatchObject({ status: 'updated', changed: true, dryRun: true })
    await expect(readFile(join(dryRoot, 'packages/finance-data-service/providers/astock/upstream/upstream.lock.json'))).rejects.toThrow()

    const destination = await prepareDestination()
    const first = await syncVendor({ root: destination, sourceDir: source, version: 'v0.0.1' })
    const firstLock = await readFile(join(destination, 'packages/finance-data-service/providers/astock/upstream/upstream.lock.json'), 'utf8')
    const firstSource = await json(join(destination, 'packages/finance-data-service/providers/astock/upstream/source-manifest.json'))
    const firstGenerated = await readFile(join(destination, 'packages/finance-data-service/providers/astock/python/generated/astock_upstream.py'), 'utf8')
    const second = await syncVendor({ root: destination, sourceDir: source, version: 'v0.0.1' })
    const secondLock = await readFile(join(destination, 'packages/finance-data-service/providers/astock/upstream/upstream.lock.json'), 'utf8')
    const secondGenerated = await readFile(join(destination, 'packages/finance-data-service/providers/astock/python/generated/astock_upstream.py'), 'utf8')

    expect(first.changed).toBe(true)
    const parsedLock = JSON.parse(firstLock)
    expect(firstSource).toMatchObject({
      upstreamVersion: parsedLock.version,
      peeledCommit: parsedLock.peeledCommit,
      snapshotFiles: parsedLock.files,
    })
    expect(second).toMatchObject({ status: 'up-to-date', changed: false, changedFiles: [] })
    expect(secondLock).toBe(firstLock)
    expect(secondGenerated).toBe(firstGenerated)
  }, 60_000)

  it('validates Apache-2.0 and blocks legal-file changes before writing', async () => {
    const invalidSource = await prepareLocalTag({ license: 'MIT License\n' })
    const invalidDestination = await prepareDestination()
    await expect(syncVendor({ root: invalidDestination, sourceDir: invalidSource, version: 'v0.0.1' }))
      .rejects.toMatchObject({ blocked: true, code: 'license-policy' })

    const source = await prepareLocalTag()
    const destination = await prepareDestination()
    await syncVendor({ root: destination, sourceDir: source, version: 'v0.0.1' })
    const before = await readFile(join(destination, 'packages/finance-data-service/providers/astock/upstream/upstream.lock.json'), 'utf8')
    await commitTag(source, 'v0.0.2', () => appendFile(join(source, 'LICENSE'), '\n'))
    await expect(syncVendor({ root: destination, sourceDir: source, version: 'v0.0.2' }))
      .rejects.toMatchObject({ blocked: true, code: 'legal-review' })
    expect(await readFile(join(destination, 'packages/finance-data-service/providers/astock/upstream/upstream.lock.json'), 'utf8')).toBe(before)
  }, 60_000)

  it('snapshots NOTICE when present and blocks its later appearance or change', async () => {
    const noticeSource = await prepareLocalTag({ notice: 'Upstream attribution\n' })
    const noticeDestination = await prepareDestination()
    await syncVendor({ root: noticeDestination, sourceDir: noticeSource, version: 'v0.0.1' })
    const noticeLock = await json(join(noticeDestination, 'packages/finance-data-service/providers/astock/upstream/upstream.lock.json'))
    const noticeManifest = await json(join(noticeDestination, 'packages/finance-data-service/providers/astock/upstream/source-manifest.json'))
    expect(noticeLock.files.map((entry: { path: string }) => entry.path)).toContain('NOTICE')
    expect(noticeManifest.snapshotFiles).toEqual(noticeLock.files)
    await commitTag(noticeSource, 'v0.0.2', () => appendFile(join(noticeSource, 'NOTICE'), 'Changed\n'))
    await expect(syncVendor({ root: noticeDestination, sourceDir: noticeSource, version: 'v0.0.2' }))
      .rejects.toMatchObject({ blocked: true, code: 'legal-review' })

    const source = await prepareLocalTag()
    const destination = await prepareDestination()
    await syncVendor({ root: destination, sourceDir: source, version: 'v0.0.1' })
    await commitTag(source, 'v0.0.2', () => writeFile(join(source, 'NOTICE'), 'New attribution\n'))
    await expect(syncVendor({ root: destination, sourceDir: source, version: 'v0.0.2' }))
      .rejects.toMatchObject({ blocked: true, code: 'legal-review' })
  }, 60_000)

  it('reports manifest inconsistency and legal-file changes as blockers', async () => {
    const manifests = {
      lock: await json(join(UPSTREAM, 'upstream.lock.json')),
      capability: await json(join(UPSTREAM, 'capability-manifest.json')),
      source: await json(join(UPSTREAM, 'source-manifest.json')),
    }
    const inconsistent = structuredClone(manifests)
    inconsistent.source.peeledCommit = '0'.repeat(40)
    expect(compareManifestSets(inconsistent, structuredClone(inconsistent)).blockers)
      .toContain('base source manifest peeledCommit differs from upstream lock')

    const changedLicense = structuredClone(manifests)
    changedLicense.lock.files.find((entry: { path: string }) => entry.path === 'LICENSE').sha256 = '0'.repeat(64)
    expect(compareManifestSets(manifests, changedLicense).blockers)
      .toContain('legal file changed: LICENSE')

    const addedNotice = structuredClone(manifests)
    addedNotice.lock.files.push({ path: 'NOTICE', sha256: '0'.repeat(64), gitBlob: '0'.repeat(40), size: 0, lines: 0 })
    expect(compareManifestSets(manifests, addedNotice).blockers)
      .toContain('legal file added: NOTICE')
  })

  it('runs the report CLI entirely from local manifests', async () => {
    const { stdout } = await execFile(process.execPath, [
      'scripts/report-a-stock-data-diff.mjs',
      '--base', UPSTREAM,
      '--current', UPSTREAM,
      '--json',
      '--fail-on', 'blocked',
    ], { cwd: ROOT, env: { ...process.env, PATH: '/path-disabled-for-offline-report' } })
    expect(JSON.parse(stdout)).toMatchObject({ status: 'clean', changed: false, blocked: false })
  })
})
