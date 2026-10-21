// REL-04 (MAIN-29): the CI gates are scripts the workflows call, so they can
// be run and tested here; GitHub only schedules them.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const ci = (name: string) => path.join(repoRoot, 'scripts', 'ci', name)
const workflowsRoot = path.join(repoRoot, '.github', 'workflows')

function node(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const SHA = '11d5960a326750d5838078e36cf38b85af677262'

describe('every uses: is pinned to a 40-hex commit (REL-04 test 6)', () => {
  it('passes for the workflows in this repository', () => {
    const result = node(ci('check-action-pins.mjs'), [])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/\d+ uses: pinned to a commit/)
  })

  it('names every tag, branch or short-SHA reference it finds', () => {
    const dir = tempDir('emperor-pins-')
    fs.writeFileSync(
      path.join(dir, 'bad.yml'),
      [
        'jobs:',
        '  a:',
        '    runs-on: macos-15',
        '    steps:',
        '      - uses: actions/checkout@v4',
        `      - uses: actions/setup-node@${SHA.slice(0, 7)}`,
        '      - uses: "actions/upload-artifact@main"',
        `      - uses: actions/attest@${SHA} # v4.2.2`,
        '      - uses: ./.github/actions/local',
        '      - name: inline',
        '        uses: owner/repo/path@v1.2.3',
        '  b:',
        '    uses: owner/repo/.github/workflows/x.yml@v2',
        '      - uses: docker://alpine:3.20',
        '      - uses: docker://alpine@sha256:' + 'a'.repeat(64),
        '',
      ].join('\n'),
    )
    const result = node(ci('check-action-pins.mjs'), [dir])
    expect(result.status).toBe(1)
    const lines = result.stderr.trim().split('\n')
    expect(lines).toEqual([
      expect.stringContaining('bad.yml:5: actions/checkout@v4'),
      expect.stringContaining(
        `bad.yml:6: actions/setup-node@${SHA.slice(0, 7)}`,
      ),
      expect.stringContaining('bad.yml:7: actions/upload-artifact@main'),
      expect.stringContaining('bad.yml:11: owner/repo/path@v1.2.3'),
      expect.stringContaining(
        'bad.yml:13: owner/repo/.github/workflows/x.yml@v2',
      ),
      expect.stringContaining('bad.yml:14: docker://alpine:3.20'),
      expect.stringMatching(/6 uses: not pinned/),
    ])
  })

  it('keeps the version a pin stands for next to it', () => {
    const files = fs
      .readdirSync(workflowsRoot)
      .filter((name) => name.endsWith('.yml'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const text = fs.readFileSync(path.join(workflowsRoot, name), 'utf8')
      for (const line of text.split('\n').filter((l) => /\buses:/.test(l)))
        expect(line, name).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
    }
  })
})

describe('workflow lint: which job runs which script, and only on macOS', () => {
  it('passes for the workflows in this repository', () => {
    const result = node(ci('check-workflows.mjs'), [])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('fails a Linux or Windows runner in a macOS-only workflow', () => {
    const dir = tempDir('emperor-workflows-')
    for (const name of fs.readdirSync(workflowsRoot))
      fs.copyFileSync(path.join(workflowsRoot, name), path.join(dir, name))
    const ciText = fs.readFileSync(path.join(dir, 'ci.yml'), 'utf8')
    fs.writeFileSync(
      path.join(dir, 'ci.yml'),
      ciText.replace('runs-on: macos-15-intel', 'runs-on: ubuntu-24.04'),
    )
    const internal = fs.readFileSync(
      path.join(dir, 'release-internal.yml'),
      'utf8',
    )
    fs.writeFileSync(
      path.join(dir, 'release-internal.yml'),
      internal.replace(
        '          - runner: macos-15-intel',
        '          - runner: windows-2022',
      ),
    )
    const result = node(ci('check-workflows.mjs'), [dir])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'ci.yml: job macos-x64-build runs on ubuntu-24.04, not macOS',
    )
    expect(result.stderr).toContain(
      'release-internal.yml: job package runs on windows-2022, not macOS',
    )
  })

  it('fails when a gate stops calling its script or loses its trigger', () => {
    const dir = tempDir('emperor-workflows-')
    for (const name of fs.readdirSync(workflowsRoot))
      fs.copyFileSync(path.join(workflowsRoot, name), path.join(dir, name))
    const edit = (name: string, from: RegExp | string, to: string) => {
      const file = path.join(dir, name)
      const text = fs.readFileSync(file, 'utf8')
      const next = text.replace(from, to)
      expect(next, name).not.toBe(text)
      fs.writeFileSync(file, next)
    }
    edit('ci.yml', 'run: scripts/ci/pr-gate.sh\n', 'run: make check\n')
    edit('nightly.yml', /\n {2}schedule:\n {4}- cron: .*\n/, '\n')
    edit(
      'nightly.yml',
      'node scripts/ci/open-failure-issue.mjs',
      'echo no issue',
    )
    edit(
      'weekly-model-metadata.yml',
      'node scripts/ci/weekly-model-metadata.mjs',
      'npm run models:check',
    )
    edit(
      'release-preview.yml',
      'node scripts/ci/require-green-nightly.mjs',
      'echo skip',
    )
    const result = node(ci('check-workflows.mjs'), [dir])
    expect(result.status).toBe(1)
    for (const problem of [
      'ci.yml: no macOS arm64 job runs scripts/ci/pr-gate.sh',
      'nightly.yml: has no schedule',
      'nightly.yml: no step opens an issue on failure (scripts/ci/open-failure-issue.mjs)',
      'weekly-model-metadata.yml: no job runs scripts/ci/weekly-model-metadata.mjs',
      'release-preview.yml: releases are not blocked on the nightly (scripts/ci/require-green-nightly.mjs)',
    ])
      expect(result.stderr).toContain(problem)
  })

  it('never lets a pull request wait on the nightly', () => {
    const dir = tempDir('emperor-workflows-')
    for (const name of fs.readdirSync(workflowsRoot))
      fs.copyFileSync(path.join(workflowsRoot, name), path.join(dir, name))
    const file = path.join(dir, 'nightly.yml')
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace('\non:\n', '\non:\n  pull_request:\n'),
    )
    const result = node(ci('check-workflows.mjs'), [dir])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'nightly.yml: runs on pull requests; the nightly must not block them',
    )
  })
})

describe('the macOS PR gate (REL-04 tests 1 and 2)', () => {
  it('runs make check, then the packaged verification, then the unsealed probes', () => {
    const result = spawnSync(ci('pr-gate.sh'), ['--dry-run'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      'pr-gate: ./scripts/check.sh',
      'pr-gate: npm --prefix desktop run package:verify',
      'pr-gate: node scripts/ci/gate-negative-probe.mjs',
    ])
  })

  it('builds instead of the full check on the x64 job', () => {
    const result = spawnSync(ci('pr-gate.sh'), ['--build-only', '--dry-run'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      'pr-gate: npm --prefix desktop run build',
      'pr-gate: npm --prefix desktop run package:verify',
      'pr-gate: node scripts/ci/gate-negative-probe.mjs',
    ])
  })

  it('checks a given app with the packaged step alone', () => {
    const result = spawnSync(
      ci('pr-gate.sh'),
      ['--app', '/tmp/Some Build/Emperor Agent.app', '--dry-run'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      'pr-gate: node desktop/scripts/run-packaged-smoke.cjs --app /tmp/Some Build/Emperor Agent.app/Contents/MacOS/Emperor Agent',
    ])
  })

  it('refuses an unknown option', () => {
    const result = spawnSync(ci('pr-gate.sh'), ['--sign'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: scripts/ci/pr-gate.sh')
  })

  it('makes unsealed copies that the packaged gate must refuse', () => {
    const result = node(ci('gate-negative-probe.mjs'), ['--list'])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      {
        id: 'signature-removed',
        expect: 'code object is not signed at all',
      },
      { id: 'no-hardened-runtime', expect: 'lacks the hardened runtime' },
      { id: 'run-as-node-fuse', expect: 'RunAsNode is true, expected false' },
    ])
  })
})

describe('a red nightly blocks a release, never a pull request', () => {
  const write = (dir: string, name: string, value: unknown) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }
  const now = Date.parse('2026-10-21T08:00:00Z')
  const run = (conclusion: string, hoursAgo = 3) => ({
    conclusion,
    headSha: 'c'.repeat(40),
    url: 'https://github.com/TheSyart/emperor-agent/actions/runs/1',
    createdAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
  })
  const gate = (runs: unknown, issues: unknown) => {
    const dir = tempDir('emperor-nightly-gate-')
    return node(ci('require-green-nightly.mjs'), [
      '--runs-json',
      write(dir, 'runs.json', runs),
      '--issues-json',
      write(dir, 'issues.json', issues),
      '--now',
      new Date(now).toISOString(),
    ])
  }

  it('passes on a recent green nightly with no open failure issue', () => {
    const result = gate([run('success')], [])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('nightly is green')
  })

  it.each([
    [
      'a red nightly',
      [run('failure')],
      [],
      'the last nightly concluded failure',
    ],
    ['no nightly at all', [], [], 'no completed nightly run'],
    [
      'a stale nightly',
      [run('success', 100)],
      [],
      'the last nightly is 100 hours old',
    ],
    [
      'an open failure issue',
      [run('success')],
      [{ number: 7, url: 'https://github.com/x/y/issues/7' }],
      'nightly failure issue #7 is still open',
    ],
  ])('fails on %s', (_name, runs, issues, message) => {
    const result = gate(runs, issues)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })
})
