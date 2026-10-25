// VER-05: the weekly upstream self-check of Claude Code and Codex. The
// script compares what the newest releases report (offline, no prompt)
// with config/executor-upstream-baseline.json (Claude Code) and the newest
// protocol/codex-*/ snapshot (Codex), and opens or updates one
// executor-upstream issue on a difference. Here a fixture stands in for npm,
// the installs and the CLIs, and a fake `gh` records every call.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeFacts,
  codexDefaultOn,
} from '../../../scripts/ci/weekly-executor-upstream.mjs'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const script = path.join(
  repoRoot,
  'scripts',
  'ci',
  'weekly-executor-upstream.mjs',
)
const protocolRoot = path.join(
  repoRoot,
  'packages',
  'core',
  'src',
  'harness',
  'delegation',
  'protocol',
)
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'config', 'executor-upstream-baseline.json'),
    'utf8',
  ),
) as {
  schemaVersion: 1
  claude: { builtinPlugins: string[] }
}

function temp(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** The newest recorded Codex protocol: what an unchanged Codex reports. */
function newestCodex(dir = protocolRoot) {
  const versions = fs
    .readdirSync(dir)
    .filter((name) => /^codex-\d+\.\d+\.\d+$/.test(name))
    .map((name) => name.slice('codex-'.length))
    .sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.split('.').map(Number))
      return x![0]! - y![0]! || x![1]! - y![1]! || x![2]! - y![2]!
    })
  const version = versions.at(-1)!
  const folder = path.join(dir, `codex-${version}`)
  const digest = JSON.parse(
    fs.readFileSync(path.join(folder, 'digest.json'), 'utf8'),
  ) as { digests: string[] }
  const features = JSON.parse(
    fs.readFileSync(path.join(folder, 'features.json'), 'utf8'),
  ) as { features: Record<string, { enabled: boolean }> }
  return {
    version,
    digest: digest.digests[0]!,
    defaultOn: Object.entries(features.features)
      .filter(([, f]) => f.enabled)
      .map(([name]) => name)
      .sort(),
  }
}

type Fixture = Record<string, unknown>
/** Everything as recorded: Claude Code as the baseline, Codex as its snapshot. */
function unchanged(over: Fixture = {}): Fixture {
  const codex = newestCodex()
  return {
    latest: { claude: '2.1.312', codex: '0.163.2' },
    claude: {
      builtinPlugins: baseline.claude.builtinPlugins,
      mcpServers: [],
      hooksApplied: true,
      selfCheck: 'adapted',
    },
    codex: {
      digest: codex.digest,
      defaultOn: codex.defaultOn,
      selfCheck: 'ok',
    },
    ...over,
  }
}

function run(
  fixture: Fixture,
  options: {
    dryRun?: boolean
    issues?: unknown[]
    protocolDir?: string
  } = {},
) {
  const dir = temp('emperor-upstream-')
  const fixtureFile = path.join(dir, 'fixture.json')
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture))
  // A gh that records its arguments and answers `issue list` with [].
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const calls = path.join(dir, 'gh-calls')
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$1 $2" in "issue list") echo '[]';; esac\nexit 0\n`,
    { mode: 0o755 },
  )
  const args = [
    script,
    '--fixture',
    fixtureFile,
    ...(options.dryRun === false ? [] : ['--dry-run']),
    ...(options.protocolDir ? ['--protocol-dir', options.protocolDir] : []),
  ]
  if (options.issues) {
    const issuesFile = path.join(dir, 'issues.json')
    fs.writeFileSync(issuesFile, JSON.stringify(options.issues))
    args.push('--issues-json', issuesFile)
  }
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    timeout: 60_000,
  })
  const lines = result.stdout.trim().split('\n')
  let plan: Record<string, unknown> = {}
  try {
    plan = JSON.parse(lines.at(-1) ?? '{}')
  } catch {
    plan = {}
  }
  const ghCalls = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n')
    : []
  return { result, plan, ghCalls }
}

describe('weekly executor upstream (VER-05)', () => {
  it('1 · as recorded: nothing to report, gh is never run', () => {
    const { result, plan, ghCalls } = run(unchanged(), { dryRun: false })
    expect(result.status).toBe(0)
    expect(plan).toMatchObject({
      action: 'none',
      versions: { claude: '2.1.312', codex: '0.163.2' },
    })
    // A new version alone is not a difference.
    expect(plan.differences).toEqual([])
    expect(ghCalls).toEqual([])
  })

  it('2 · one more builtin plugin: an issue whose body lists the difference in a table', () => {
    const { plan } = run(
      unchanged({
        claude: {
          builtinPlugins: [
            ...baseline.claude.builtinPlugins,
            'cc-plugin-new-thing@builtin',
          ],
          mcpServers: [],
          hooksApplied: true,
          selfCheck: 'adapted',
        },
      }),
    )
    expect(plan).toMatchObject({
      action: 'create',
      title: '上游变化：Claude Code 2.1.312 · Codex 0.163.2',
      labels: ['executor-upstream'],
    })
    const body = String(plan.body)
    expect(body).toContain('| 子智能体 | 版本 | 变化 | 类型 |')
    expect(body).toContain('cc-plugin-new-thing@builtin')
    expect(body).toContain('config/executor-upstream-baseline.json')
  })

  it('3 · a Codex protocol digest that is not recorded: P0', () => {
    const { plan } = run(
      unchanged({
        codex: {
          digest: 'f'.repeat(64),
          defaultOn: newestCodex().defaultOn,
          selfCheck: 'ok',
        },
      }),
    )
    expect(plan).toMatchObject({
      action: 'create',
      labels: ['executor-upstream', 'P0'],
    })
    expect(String(plan.body)).toContain('协议')
    // An MCP server or hooks not applied are P0 too.
    expect(
      run(
        unchanged({
          claude: {
            builtinPlugins: baseline.claude.builtinPlugins,
            mcpServers: ['x'],
            hooksApplied: false,
            selfCheck: 'incompatible',
          },
        }),
      ).plan,
    ).toMatchObject({ labels: ['executor-upstream', 'P0'] })
  })

  it('4 · an issue already open: a comment on it, never a second issue', () => {
    const { plan } = run(
      unchanged({
        codex: {
          digest: newestCodex().digest,
          defaultOn: [...newestCodex().defaultOn, 'shiny_new_mode'],
          selfCheck: 'ok',
        },
      }),
      {
        issues: [
          {
            number: 41,
            title: '上游变化：Claude Code 2.1.310 · Codex 0.163.0',
          },
        ],
      },
    )
    expect(plan).toMatchObject({
      action: 'comment',
      issue: 41,
      gh: ['issue', 'comment', '41', '--body-file', '-'],
    })
    expect(String(plan.body)).toContain('shiny_new_mode')
  })

  it('5 · npm unreachable: tries three times, then fails without an issue', () => {
    const { result, ghCalls } = run(
      unchanged({ latest: { error: 'offline' } }),
      { dryRun: false },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('3 次')
    expect(ghCalls).toEqual([])
  })

  it('6 · an install that fails: an issue of type 安装失败', () => {
    const { plan } = run(
      unchanged({ install: { claude: 'failed: postinstall download failed' } }),
    )
    expect(plan.action).toBe('create')
    expect(String(plan.body)).toContain('安装失败')
    expect(String(plan.body)).toContain('postinstall download failed')
    // A self-check that cannot run on the runner: an issue, marked as such.
    const env = run(
      unchanged({
        claude: {
          builtinPlugins: baseline.claude.builtinPlugins,
          mcpServers: [],
          hooksApplied: true,
          selfCheck: 'error',
        },
      }),
    )
    expect(String(env.plan.body)).toContain('环境问题待确认')
  })

  it('a self-check that refuses says why (VER-07: issue #10 only said 离线自检判定不兼容)', () => {
    const { plan } = run(
      unchanged({
        codex: {
          digest: newestCodex().digest,
          defaultOn: newestCodex().defaultOn,
          selfCheck: 'incompatible',
          selfCheckIssues: [
            'Codex 0.165.0 不在 Emperor 支持的范围（0.153.x / 0.163.x / 0.164.x）。',
          ],
        },
      }),
    )
    expect(plan).toMatchObject({ labels: ['executor-upstream', 'P0'] })
    expect(String(plan.body)).toContain(
      '离线自检判定不兼容：Codex 0.165.0 不在 Emperor 支持的范围（0.153.x / 0.163.x / 0.164.x）',
    )
    // The cell stays one table cell.
    expect(String(plan.body)).not.toMatch(/支持的范围[^|\n]*\n[^|]/)
  })

  it('7 · Codex is compared with the newest protocol/codex-*/ snapshot', () => {
    const dir = temp('emperor-protocols-')
    for (const name of fs.readdirSync(protocolRoot))
      fs.cpSync(path.join(protocolRoot, name), path.join(dir, name), {
        recursive: true,
      })
    // A newer verified snapshot: the script reads it instead.
    const newer = path.join(dir, 'codex-0.170.0')
    fs.cpSync(
      path.join(protocolRoot, `codex-${newestCodex().version}`),
      newer,
      {
        recursive: true,
      },
    )
    const digestFile = path.join(newer, 'digest.json')
    const digest = JSON.parse(fs.readFileSync(digestFile, 'utf8'))
    digest.codexVersion = '0.170.0'
    digest.digests = ['a'.repeat(64)]
    fs.writeFileSync(digestFile, JSON.stringify(digest))
    const { plan } = run(
      unchanged({
        codex: {
          digest: 'a'.repeat(64),
          defaultOn: newestCodex().defaultOn,
          selfCheck: 'ok',
        },
      }),
      { protocolDir: dir },
    )
    expect(plan).toMatchObject({ action: 'none', snapshot: '0.170.0' })
  })

  it('8 · the workflow passes the workflow lint and the action pins', () => {
    for (const checker of ['check-workflows.mjs', 'check-action-pins.mjs']) {
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'ci', checker)],
        { cwd: repoRoot, encoding: 'utf8' },
      )
      expect(
        result.status,
        `${checker}: ${result.stdout}${result.stderr}`,
      ).toBe(0)
    }
    const workflow = fs.readFileSync(
      path.join(
        repoRoot,
        '.github',
        'workflows',
        'weekly-executor-upstream.yml',
      ),
      'utf8',
    )
    expect(workflow).toContain("cron: '0 3 * * 1'")
    expect(workflow).toContain('workflow_dispatch')
    expect(workflow).toContain('node scripts/ci/weekly-executor-upstream.mjs')
    // No secret beyond the run's own token.
    expect(workflow.match(/secrets\.\w+/g) ?? []).toEqual([])
  })

  it('8 · the lint catches a copy that cannot open its issue or uses a secret', () => {
    const dir = temp('emperor-workflows-')
    const source = path.join(repoRoot, '.github', 'workflows')
    for (const name of fs.readdirSync(source))
      fs.copyFileSync(path.join(source, name), path.join(dir, name))
    const file = path.join(dir, 'weekly-executor-upstream.yml')
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace('issues: write', 'issues: read')
        .replace('${{ github.token }}', '${{ secrets.NPM_TOKEN }}'),
    )
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'ci', 'check-workflows.mjs'), dir],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toContain('weekly-executor-upstream.yml')
    expect(output).toContain('issues: write')
    expect(output).toContain('secret')
  })

  it('the live run reads the --raw handshake report and `codex features list` as recorded', () => {
    // The shape scripts/claude-init-handshake.mjs --raw wrote for 2.1.310.
    expect(
      claudeFacts({
        raw: true,
        promptless: {
          hooksApplied: true,
          reload: {
            supported: true,
            plugins: [
              {
                name: 'cc-plugin-plugin-authoring',
                path: 'builtin',
                source: 'cc-plugin-plugin-authoring@builtin',
              },
              {
                name: 'cc-plugin-agents-md',
                path: 'builtin',
                source: 'cc-plugin-agents-md@builtin',
              },
              // Not shipped by the binary: not a builtin.
              { name: 'x', path: '/u/.claude/plugins/x', source: 'x@market' },
            ],
            mcpServers: [],
            errorCount: 0,
          },
          mcpStatus: ['late'],
        },
      }),
    ).toEqual({
      builtinPlugins: baseline.claude.builtinPlugins,
      mcpServers: ['late'],
      hooksApplied: true,
    })
    expect(() =>
      claudeFacts({ promptless: { reload: { supported: false } } }),
    ).toThrow('reloadPlugins')
    expect(
      codexDefaultOn(
        [
          'apply_patch_freeform   stable        true',
          'web_search             experimental  false',
          'shell_tool             stable        true',
          '',
        ].join('\n'),
      ),
    ).toEqual(['apply_patch_freeform', 'shell_tool'])
  })
})
