// REL-04 tests 3 and 4: the nightly runs every mode that needs no real
// model, keeps going after a failure, and a failure opens (dry-run) an issue.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const nightly = path.join(repoRoot, 'scripts', 'ci', 'nightly.mjs')
const opener = path.join(repoRoot, 'scripts', 'ci', 'open-failure-issue.mjs')

function node(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

const tempDir = (prefix: string) =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix))

interface PlannedStep {
  id: string
  command?: string[]
  cwd?: string
  skip?: string
  hook?: string
  retry?: string[]
}

describe('the nightly plan (REL-04 test 3)', () => {
  const plan = (): PlannedStep[] =>
    JSON.parse(node(nightly, ['--list', '--json']).stdout)

  it('runs the visual suite, every Electron mode without a real model, the Kill-9 loop and the hardening probes', () => {
    const steps = plan()
    expect(steps.map((step) => step.id)).toEqual([
      'build',
      'visual',
      'visual:perf',
      'visual-baselines',
      'e2e:smoke',
      'e2e:contract',
      'e2e:extra',
      'e2e:userbrowser',
      'e2e:browser-security',
      'e2e:fullstack',
      'e2e:references',
      'e2e:plugins',
      'e2e:userbrowser-app',
      'e2e:settings',
      'e2e:renderer-security',
      'e2e:diagnostics',
      'e2e:real',
      'e2e:references-real',
      'external-agents',
      'kill9',
      'kill9-power-loss',
      'package',
      'package:probe',
    ])
    const byId = Object.fromEntries(steps.map((step) => [step.id, step]))
    expect(byId['visual']).toMatchObject({
      command: [
        'npx',
        'playwright',
        'test',
        '-c',
        'playwright.config.ts',
        '--grep-invert',
        '@perf',
      ],
      cwd: 'desktop',
    })
    expect(byId['visual']?.retry).toBeUndefined()
    expect(byId['e2e:settings']).toMatchObject({
      command: ['node', 'scripts/e2e-cu.mjs', '--mode=settings'],
      cwd: 'desktop',
    })
    expect(byId['kill9']).toMatchObject({
      command: ['node', 'scripts/session-log-kill9.mjs', '--runs', '20'],
    })
    expect(byId['kill9-power-loss']).toMatchObject({
      command: [
        'node',
        'scripts/session-log-kill9.mjs',
        '--runs',
        '20',
        '--truncate-tail',
      ],
    })
    // Modes that call a real model or real executors are listed, with why.
    for (const id of ['e2e:real', 'e2e:references-real', 'external-agents'])
      expect(byId[id]?.skip, id).toMatch(/real model/)
  })

  // FIX-08: frame-rate and frame-time budgets measure wall-clock time. In
  // the main visual run they share the machine with the other workers and
  // failed under load; they run alone, and only they get one retry of what
  // failed, reported as such.
  it('runs the timing budgets alone, after the visual suite, with one retry', () => {
    const steps = plan()
    const perf = steps.find((step) => step.id === 'visual:perf')
    expect(perf).toMatchObject({
      command: [
        'npx',
        'playwright',
        'test',
        '-c',
        'playwright.config.ts',
        '--grep',
        '@perf',
        '--workers=1',
      ],
      retry: [
        'npx',
        'playwright',
        'test',
        '-c',
        'playwright.config.ts',
        '--grep',
        '@perf',
        '--workers=1',
        '--last-failed',
      ],
      cwd: 'desktop',
    })
    // No other step retries: their failures are real.
    expect(steps.filter((step) => step.retry).map((step) => step.id)).toEqual([
      'visual:perf',
    ])
  })

  it('tags every wall-clock budget of the streaming suite @perf', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'desktop', 'tests', 'visual', 'streaming.spec.ts'),
      'utf8',
    )
    const titles = [
      ...source.matchAll(/test\(\s*`?'?([^'`]+)['`],\s*(\{[^}]*\})?/g),
    ]
    const timing = titles.filter(([, title]) => /fps|p95|frames/.test(title!))
    expect(timing.length).toBeGreaterThanOrEqual(3)
    for (const [, title, details] of timing)
      expect(details ?? '', title).toContain("tag: '@perf'")
    // The selection test measures nothing and stays in the main run.
    const selection = titles.find(([, title]) => /stays selected/.test(title!))
    expect(selection?.[2] ?? '').not.toContain('@perf')
  })

  it('leaves a named hook for the DS-06 pixel baselines', () => {
    const hook = plan().find((step) => step.id === 'visual-baselines')
    expect(hook).toMatchObject({ hook: 'visual:baselines', cwd: 'desktop' })
    const desktop = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'desktop', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    // Skipped until DS-06 adds the script; run as soon as it exists.
    if (!desktop.scripts['visual:baselines'])
      expect(hook?.skip).toMatch(/DS-06/)
    else expect(hook?.command).toEqual(['npm', 'run', 'visual:baselines'])
  })

  it('runs every mode e2e-cu.mjs knows, apart from the ones it skips', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'desktop', 'scripts', 'e2e-cu.mjs'),
      'utf8',
    )
    const usage = /--mode=([a-z|-]+)\]/.exec(source)?.[1]?.split('|') ?? []
    expect(usage.length).toBeGreaterThan(10)
    const ids = plan().map((step) => step.id)
    for (const mode of usage) expect(ids, mode).toContain(`e2e:${mode}`)
  })
})

describe('the nightly runner', () => {
  function runPlan(steps: PlannedStep[], extra: string[] = []) {
    const dir = tempDir('emperor-nightly-')
    const planFile = path.join(dir, 'plan.json')
    fs.writeFileSync(planFile, JSON.stringify(steps))
    const report = path.join(dir, 'report')
    const result = node(
      nightly,
      ['--plan', planFile, '--report', report, ...extra],
      {
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'TheSyart/emperor-agent',
        GITHUB_RUN_ID: '42',
        GITHUB_SHA: 'd'.repeat(40),
      },
    )
    const summary = fs.existsSync(path.join(report, 'summary.json'))
      ? JSON.parse(fs.readFileSync(path.join(report, 'summary.json'), 'utf8'))
      : null
    return { result, summary, report }
  }

  it('keeps going after a failed step, then fails with a summary', () => {
    const { result, summary, report } = runPlan([
      { id: 'first', command: ['node', '-e', 'console.log("one")'] },
      {
        id: 'broken',
        command: ['node', '-e', 'console.error("boom"); process.exit(3)'],
      },
      { id: 'skipped', skip: 'needs a real model' },
      { id: 'last', command: ['node', '-e', 'console.log("three")'] },
    ])
    expect(result.status).toBe(1)
    expect(summary).toMatchObject({
      ok: false,
      commit: 'd'.repeat(40),
      runUrl: 'https://github.com/TheSyart/emperor-agent/actions/runs/42',
      steps: [
        { id: 'first', status: 'passed', exitCode: 0 },
        { id: 'broken', status: 'failed', exitCode: 3 },
        { id: 'skipped', status: 'skipped', reason: 'needs a real model' },
        { id: 'last', status: 'passed', exitCode: 0 },
      ],
    })
    expect(summary.steps[1].logTail).toContain('boom')
    expect(
      fs.readFileSync(path.join(report, 'logs', 'broken.log'), 'utf8'),
    ).toContain('boom')
    const markdown = fs.readFileSync(path.join(report, 'report.md'), 'utf8')
    expect(markdown).toContain('| broken | failed | 3 |')
    expect(markdown).toContain('| skipped | skipped | — | needs a real model |')
  })

  it('passes when every step passes or is skipped', () => {
    const { result, summary } = runPlan([
      { id: 'one', command: ['node', '-e', '0'] },
      { id: 'two', skip: 'no' },
    ])
    expect(result.status).toBe(0)
    expect(summary).toMatchObject({ ok: true })
  })

  it('runs only the steps asked for', () => {
    const { summary } = runPlan(
      [
        { id: 'one', command: ['node', '-e', '0'] },
        { id: 'two', command: ['node', '-e', 'process.exit(1)'] },
      ],
      ['--only', 'one'],
    )
    expect(summary.steps.map((step: { id: string }) => step.id)).toEqual([
      'one',
    ])
    expect(summary.ok).toBe(true)
  })

  it('retries a step once when it says how, and says it passed on retry', () => {
    const dir = tempDir('emperor-nightly-retry-')
    const marker = path.join(dir, 'tried')
    const flaky = `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.error('fps 41'); process.exit(1)`
    const { result, summary, report } = runPlan([
      {
        id: 'perf',
        command: ['node', '-e', flaky],
        retry: ['node', '-e', flaky],
      },
      {
        id: 'perf-broken',
        command: ['node', '-e', 'process.exit(1)'],
        retry: ['node', '-e', 'console.error("still slow"); process.exit(2)'],
      },
      { id: 'plain', command: ['node', '-e', 'process.exit(1)'] },
    ])
    expect(result.status).toBe(1)
    expect(summary.steps).toMatchObject([
      {
        id: 'perf',
        status: 'passed',
        exitCode: 0,
        retried: true,
        firstExitCode: 1,
      },
      {
        id: 'perf-broken',
        status: 'failed',
        exitCode: 2,
        retried: true,
        firstExitCode: 1,
      },
      { id: 'plain', status: 'failed', exitCode: 1 },
    ])
    expect(summary.steps[2].retried).toBeUndefined()
    expect(summary.steps[1].logTail).toContain('still slow')
    const log = fs.readFileSync(path.join(report, 'logs', 'perf.log'), 'utf8')
    expect(log).toContain('fps 41')
    expect(log).toContain('nightly: retrying')
    const markdown = fs.readFileSync(path.join(report, 'report.md'), 'utf8')
    expect(markdown).toMatch(/\| perf \| passed \| 0 \| passed on retry/)
  })

  it('runs the Electron modes without ELECTRON_RUN_AS_NODE', () => {
    const { summary } = runPlan([
      {
        id: 'env',
        command: [
          'node',
          '-e',
          'process.exit(process.env.ELECTRON_RUN_AS_NODE === undefined ? 0 : 9)',
        ],
      },
    ])
    expect(summary.steps[0]).toMatchObject({ status: 'passed' })
  })
})

describe('a failed nightly opens an issue (REL-04 test 4, dry-run)', () => {
  function report(ok: boolean) {
    const dir = tempDir('emperor-nightly-report-')
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        ok,
        startedAt: '2026-10-21T18:00:00.000Z',
        finishedAt: '2026-10-21T19:10:00.000Z',
        commit: 'e'.repeat(40),
        runUrl: 'https://github.com/TheSyart/emperor-agent/actions/runs/42',
        steps: [
          { id: 'visual', status: 'passed', exitCode: 0, ms: 1000 },
          {
            id: 'e2e:settings',
            status: 'failed',
            exitCode: 1,
            ms: 2000,
            logTail: '✗ [settings] opens 设置 › 语音 — timeout',
          },
          { id: 'e2e:real', status: 'skipped', reason: 'needs a real model' },
        ],
      }),
    )
    return dir
  }
  const issues = (value: unknown) => {
    const file = path.join(tempDir('emperor-issues-'), 'issues.json')
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }

  it('plans a new issue naming the failed steps and the run', () => {
    const result = node(opener, [
      '--report',
      report(false),
      '--dry-run',
      '--issues-json',
      issues([]),
    ])
    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout)
    expect(plan).toMatchObject({
      action: 'create',
      title: '夜间门禁失败 · 2026-10-21 · eeeeeee',
      labels: ['nightly-failure', 'release-blocker'],
      gh: [
        'issue',
        'create',
        '--title',
        '夜间门禁失败 · 2026-10-21 · eeeeeee',
        '--label',
        'nightly-failure',
        '--label',
        'release-blocker',
        '--body-file',
        '-',
      ],
    })
    expect(plan.body).toContain('e2e:settings')
    expect(plan.body).toContain('opens 设置 › 语音 — timeout')
    expect(plan.body).toContain(
      'https://github.com/TheSyart/emperor-agent/actions/runs/42',
    )
    expect(plan.body).toContain('发布')
    expect(plan.body).not.toContain('| visual |')
  })

  it('comments on the open failure issue instead of opening another', () => {
    const result = node(opener, [
      '--report',
      report(false),
      '--dry-run',
      '--issues-json',
      issues([{ number: 12, title: '夜间门禁失败 · 2026-10-20 · fffffff' }]),
    ])
    const plan = JSON.parse(result.stdout)
    expect(plan).toMatchObject({
      action: 'comment',
      issue: 12,
      gh: ['issue', 'comment', '12', '--body-file', '-'],
    })
  })

  it('closes the open failure issue once the nightly is green again', () => {
    const result = node(opener, [
      '--report',
      report(true),
      '--dry-run',
      '--issues-json',
      issues([{ number: 12, title: '夜间门禁失败 · 2026-10-20 · fffffff' }]),
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: 'close',
      issue: 12,
      gh: [
        'issue',
        'close',
        '12',
        '--comment',
        expect.stringContaining('eeeeeee'),
      ],
    })
  })

  it('does nothing for a green nightly with no open issue', () => {
    const result = node(opener, [
      '--report',
      report(true),
      '--dry-run',
      '--issues-json',
      issues([]),
    ])
    expect(JSON.parse(result.stdout)).toEqual({ action: 'none' })
  })

  it('never calls gh in a dry run', () => {
    const bin = tempDir('emperor-fake-gh-')
    const marker = path.join(bin, 'called')
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\ntouch "${marker}"\nexit 0\n`,
      { mode: 0o755 },
    )
    node(opener, ['--report', report(false), '--dry-run'], {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    })
    expect(fs.existsSync(marker)).toBe(false)
  })
})
