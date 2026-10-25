#!/usr/bin/env node
// Weekly (VER-05): did the newest Claude Code or Codex change something
// Emperor relies on? weekly-executor-upstream.yml runs it, and so can you:
//
//   node scripts/ci/weekly-executor-upstream.mjs --dry-run      what it would do
//   node scripts/ci/weekly-executor-upstream.mjs                check, then open or update the issue (CI)
//   … [--fixture <file>] [--issues-json <file>] [--baseline <file>]
//     [--protocol-dir <dir>] [--work-dir <dir>]
//
// It reads both packages' latest version from npm (three tries, then it
// fails without an issue), installs each into a temporary prefix (never
// -g), and checks them offline, without a login or a prompt:
//   - Claude Code: scripts/claude-init-handshake.mjs --raw (the plugins the
//     release ships with nothing turned off, MCP servers, hooks) and the
//     product's self-check (ExecutorSelfCheck);
//   - Codex: its generated protocol schema's digest and `codex features
//     list` (defaults, no overrides) against the newest recorded
//     packages/core/src/harness/delegation/protocol/codex-<version>/
//     snapshot (digest.json, features.json), and the self-check.
// Claude Code is compared with config/executor-upstream-baseline.json. A
// new version alone is not a difference; a changed builtin set, an MCP
// server, hooks not applied, an unknown protocol digest, a changed set of
// default features, a failed install or a self-check that could not run
// are. On a difference it opens one issue labelled executor-upstream (P0
// when the release is incompatible) or comments on the one already open;
// otherwise it does nothing. It needs no secret beyond GITHUB_TOKEN.
//
// --fixture stands in for npm, the installs and the CLIs (tests); --dry-run
// never runs gh; --issues-json stands in for `gh issue list`. The last line
// of stdout is the plan as JSON. Exit 0 when the plan ran (or was printed),
// 3 when npm could not be reached, 2 on any other error.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const LABEL = 'executor-upstream'
export const P0 = 'P0'
const PROTOCOLS = join(
  repoRoot,
  'packages',
  'core',
  'src',
  'harness',
  'delegation',
  'protocol',
)
const BASELINE = join(repoRoot, 'config', 'executor-upstream-baseline.json')
const PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
}
const NAME = { claude: 'Claude Code', codex: 'Codex' }
const TRIES = 3

function parseArgs(argv) {
  const options = {
    dryRun: false,
    fixture: null,
    issues: null,
    baseline: BASELINE,
    protocolDir: PROTOCOLS,
    workDir: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return resolve(next)
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--fixture') options.fixture = value()
    else if (arg === '--issues-json') options.issues = value()
    else if (arg === '--baseline') options.baseline = value()
    else if (arg === '--protocol-dir') options.protocolDir = value()
    else if (arg === '--work-dir') options.workDir = value()
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

const byVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** The newest recorded Codex protocol: its digests, files and defaults. */
export function newestSnapshot(protocolDir = PROTOCOLS) {
  const version = readdirSync(protocolDir)
    .filter((name) => /^codex-\d+\.\d+\.\d+$/.test(name))
    .map((name) => name.slice('codex-'.length))
    .sort(byVersion)
    .at(-1)
  if (!version)
    throw new Error(`no protocol/codex-* snapshot in ${protocolDir}`)
  const folder = join(protocolDir, `codex-${version}`)
  const digest = JSON.parse(readFileSync(join(folder, 'digest.json'), 'utf8'))
  const features = JSON.parse(
    readFileSync(join(folder, 'features.json'), 'utf8'),
  )
  return {
    version,
    files: digest.files,
    digests: digest.digests,
    defaultOn: Object.entries(features.features)
      .filter(([, f]) => f.enabled)
      .map(([name]) => name)
      .sort(),
  }
}

const setDiff = (now = [], before = []) => ({
  added: now.filter((x) => !before.includes(x)).sort(),
  removed: before.filter((x) => !now.includes(x)).sort(),
})
const listed = (diff) =>
  [
    diff.added.length ? `新增 ${diff.added.join('、')}` : '',
    diff.removed.length ? `去掉 ${diff.removed.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；')

/**
 * What changed: `{ backend, kind, detail, p0?, environment? }` each. A new
 * version alone is not one.
 */
export function compare(observed, baseline, snapshot) {
  const differences = []
  const add = (backend, kind, detail, extra = {}) =>
    differences.push({ backend, kind, detail, ...extra })
  for (const backend of ['claude', 'codex']) {
    const install = observed.install?.[backend]
    if (install && install !== 'ok') {
      add(backend, 'install', String(install).replace(/^failed:\s*/, ''))
      continue
    }
    const seen = observed[backend] ?? {}
    if (seen.error) {
      add(backend, 'environment', String(seen.error), { environment: true })
      continue
    }
    if (backend === 'claude') {
      const plugins = setDiff(
        seen.builtinPlugins,
        baseline.claude.builtinPlugins,
      )
      if (plugins.added.length || plugins.removed.length)
        add(backend, 'builtin_plugins', `内置插件${listed(plugins)}`)
      if (seen.mcpServers?.length)
        add(
          backend,
          'mcp',
          `加载了 MCP server：${seen.mcpServers.join('、')}`,
          {
            p0: true,
          },
        )
      if (seen.hooksApplied !== true)
        add(backend, 'hooks', '没有应用 Emperor 的工具钩子', { p0: true })
    } else {
      if (!snapshot.digests.includes(seen.digest))
        add(
          backend,
          'protocol',
          `协议摘要不在 ${snapshot.version} 的记录里（${String(seen.digest).slice(0, 12)}…）`,
          { p0: true },
        )
      const features = setDiff(seen.defaultOn, snapshot.defaultOn)
      if (features.added.length || features.removed.length)
        add(backend, 'features', `默认开启的功能${listed(features)}`)
    }
    if (seen.selfCheck === 'incompatible')
      add(backend, 'self_check', '离线自检判定不兼容', { p0: true })
    else if (seen.selfCheck === 'error')
      add(backend, 'self_check_error', '离线自检没有完成', {
        environment: true,
      })
  }
  return {
    versions: {
      claude: observed.latest?.claude ?? null,
      codex: observed.latest?.codex ?? null,
    },
    snapshot: snapshot.version,
    differences,
    p0: differences.some((d) => d.p0),
  }
}

export function issueTitle(versions) {
  return `上游变化：Claude Code ${versions.claude} · Codex ${versions.codex}`
}

const TYPE = (d) =>
  d.kind === 'install'
    ? '安装失败'
    : d.environment
      ? '环境问题待确认'
      : d.p0
        ? '不兼容（P0）'
        : '差异'

export function issueBody(
  result,
  date = new Date().toISOString().slice(0, 10),
) {
  const run =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null
  const lines = [
    `每周上游自检（weekly-executor-upstream.yml，${date}）发现 Claude Code / Codex 的最新版与 Emperor 的记录不同。`,
    '',
    run ? `运行记录：${run}` : '运行记录：本地运行',
    '',
    '| 子智能体 | 版本 | 变化 | 类型 |',
    '| --- | --- | --- | --- |',
    ...result.differences.map(
      (d) =>
        `| ${NAME[d.backend]} | ${result.versions[d.backend] ?? '—'} | ${String(d.detail).replaceAll('|', '\\|')} | ${TYPE(d)} |`,
    ),
    '',
    `对照：Claude Code 是 \`config/executor-upstream-baseline.json\`；Codex 是 \`packages/core/src/harness/delegation/protocol/codex-${result.snapshot}/\`（digest.json、features.json）。`,
  ]
  if (result.differences.some((d) => d.environment))
    lines.push(
      '',
      '「环境问题待确认」：自检没能在 runner 上完成（例如 Seatbelt 或网络行为与本机不同），先在本机用临时 prefix 重跑确认，再决定是不是上游的变化。',
    )
  lines.push(
    '',
    '处理流程见 docs/development/external-agent-adapters.md「收到上游变化 issue 之后」：评估 → 更新基线、`KNOWN_CLAUDE_VERSIONS` / `KNOWN_CODEX_PROTOCOLS`，必要时更新 `SEED_BUILTIN_PLUGINS` 与 Codex 的关闭清单 → PR。这个脚本不会自己改任何东西。',
  )
  return lines.join('\n')
}

/** What to do with the issue tracker. */
export function planIssue(result, openIssues) {
  if (!result.differences.length) return { action: 'none' }
  const body = issueBody(result)
  const open = openIssues[0] ?? null
  if (open)
    return {
      action: 'comment',
      issue: open.number,
      body,
      gh: ['issue', 'comment', String(open.number), '--body-file', '-'],
      ...(result.p0
        ? { then: ['issue', 'edit', String(open.number), '--add-label', P0] }
        : {}),
    }
  const labels = result.p0 ? [LABEL, P0] : [LABEL]
  const title = issueTitle(result.versions)
  return {
    action: 'create',
    title,
    labels,
    body,
    gh: [
      'issue',
      'create',
      '--title',
      title,
      ...labels.flatMap((label) => ['--label', label]),
      '--body-file',
      '-',
    ],
  }
}

function gh(args, input) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    )
  return result.stdout
}

class Offline extends Error {}

// ── Live observation (CI): npm, temporary installs, offline checks ──────

export async function bundleCore() {
  const { build } = await import(
    pathToFileURL(join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js'))
      .href
  )
  const d = './packages/core/src/harness/delegation'
  const out = join(
    repoRoot,
    'node_modules',
    '.cache',
    'emperor-upstream',
    'core.mjs',
  )
  await build({
    stdin: {
      contents: [
        `export { ExecutorSelfCheck } from "${d}/self-check"`,
        `export { ExecutorRegistry } from "${d}/registry"`,
        `export { ExecutorHealthStore } from "${d}/executor-health"`,
        `export { BuiltinPluginLedger } from "${d}/claude-builtin-plugins"`,
        `export { defaultExecutorConfig } from "${d}/config"`,
        `export { codexProtocolDigest } from "${d}/compatibility"`,
        `export { registryFetcher, NPM_REGISTRY_URL } from "${d}/published-versions"`,
        'export { nodeUpdateTransport } from "./packages/core/src/updates/http"',
      ].join('\n'),
      resolveDir: repoRoot,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    loader: { '.json': 'json' },
    outfile: out,
    logLevel: 'error',
  })
  return import(pathToFileURL(out).href)
}

async function latestVersions(core) {
  const fetch = core.registryFetcher({
    transport: core.nodeUpdateTransport,
    registry: new URL(core.NPM_REGISTRY_URL),
    userAgent: 'Emperor-Agent-weekly-upstream',
  })
  let last
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const [claude, codex] = await Promise.all([
        fetch(PACKAGES.claude),
        fetch(PACKAGES.codex),
      ])
      if (claude.latest && codex.latest)
        return { claude: claude.latest, codex: codex.latest }
      last = new Error('npm answered without a latest version')
    } catch (error) {
      last = error
    }
    if (attempt < TRIES) await new Promise((r) => setTimeout(r, attempt * 5000))
  }
  throw new Offline(String(last?.message ?? last))
}

function install(workDir, key, version) {
  const prefix = join(workDir, `${key}-${version}`)
  mkdirSync(prefix, { recursive: true })
  const result = spawnSync(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      `${PACKAGES[key]}@${version}`,
      '--no-fund',
      '--no-audit',
    ],
    { encoding: 'utf8', timeout: 600_000 },
  )
  const bin = join(prefix, 'node_modules', '.bin', key)
  if (result.status !== 0 || !existsSync(bin))
    return {
      status: `failed: ${(result.stderr || result.stdout || 'npm install failed').trim().split('\n').slice(-3).join(' ')}`,
    }
  return { status: 'ok', bin }
}

async function selfCheck(core, workDir, key, bin) {
  const root = mkdtempSync(join(workDir, `self-check-${key}-`))
  const PATH = [
    dirname(bin),
    dirname(process.execPath),
    '/usr/bin',
    '/bin',
  ].join(':')
  const backend = key === 'claude' ? 'claude-code' : 'codex'
  const profile = {
    ...core.defaultExecutorConfig().profiles.find((p) => p.backend === backend),
    enabled: true,
    executablePath: bin,
  }
  const check = new core.ExecutorSelfCheck({
    root,
    registry: new core.ExecutorRegistry({ home: root, environment: { PATH } }),
    environment: () => ({ PATH }),
    health: new core.ExecutorHealthStore(root),
    ledger: new core.BuiltinPluginLedger(join(root, 'claude-code')),
  })
  try {
    return (await check.run(profile, 'manual')).status
  } finally {
    await check.close()
  }
}

/** What a `claude-init-handshake.mjs --raw` report says the release ships. */
export function claudeFacts(report) {
  const reload = report?.promptless?.reload
  if (!reload?.supported) throw new Error('reloadPlugins was not answered')
  return {
    builtinPlugins: reload.plugins
      .filter((p) => p.path === 'builtin' && p.source === `${p.name}@builtin`)
      .map((p) => p.source)
      .sort(),
    mcpServers: [
      ...new Set([
        ...(reload.mcpServers ?? []),
        ...(report.promptless.mcpStatus ?? []),
      ]),
    ].sort(),
    hooksApplied: report.promptless.hooksApplied === true,
  }
}

/** `codex features list` with no overrides: the features on by default. */
export function codexDefaultOn(output) {
  const on = []
  for (const line of String(output ?? '').split('\n')) {
    const [name, , state] = line.trim().split(/\s{2,}/)
    if (name && state === 'true') on.push(name)
  }
  return on.sort()
}

function claudeHandshake(workDir, bin) {
  const out = join(workDir, 'claude-handshake.json')
  spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts', 'claude-init-handshake.mjs'),
      '--claude',
      bin,
      '--raw',
      '--out',
      out,
    ],
    { encoding: 'utf8', timeout: 900_000 },
  )
  if (!existsSync(out)) throw new Error('the handshake wrote no report')
  return claudeFacts(JSON.parse(readFileSync(out, 'utf8')))
}

function codexFacts(core, workDir, bin, snapshot) {
  const home = mkdtempSync(join(workDir, 'codex-home-'))
  const env = {
    PATH: [dirname(bin), dirname(process.execPath), '/usr/bin', '/bin'].join(
      ':',
    ),
    HOME: home,
    CODEX_HOME: join(home, 'codex'),
  }
  mkdirSync(env.CODEX_HOME)
  const schema = join(home, 'schema')
  const generated = spawnSync(
    bin,
    ['app-server', 'generate-json-schema', '--out', schema],
    { env, encoding: 'utf8', timeout: 120_000 },
  )
  if (generated.status !== 0)
    throw new Error('codex app-server generate-json-schema failed')
  const read = (file) => {
    try {
      return readFileSync(join(schema, file), 'utf8')
    } catch {
      return undefined
    }
  }
  const digest = core.codexProtocolDigest(read, snapshot.files)
  const listedFeatures = spawnSync(bin, ['features', 'list'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (listedFeatures.status !== 0) throw new Error('codex features list failed')
  return {
    digest: digest ?? 'unreadable',
    defaultOn: codexDefaultOn(listedFeatures.stdout),
  }
}

async function observeLive(options, snapshot) {
  // $RUNNER_TEMP/executors/<pkg>-<version> on the runner; a fresh folder here.
  const workDir =
    options.workDir ??
    (process.env.RUNNER_TEMP
      ? join(process.env.RUNNER_TEMP, 'executors')
      : mkdtempSync(join(tmpdir(), 'emperor-executors-')))
  mkdirSync(workDir, { recursive: true })
  const core = await bundleCore()
  const latest = await latestVersions(core)
  const observed = { latest, install: {} }
  for (const key of ['claude', 'codex']) {
    const installed = install(workDir, key, latest[key])
    observed.install[key] = installed.status
    if (installed.status !== 'ok') continue
    try {
      const facts =
        key === 'claude'
          ? claudeHandshake(workDir, installed.bin)
          : codexFacts(core, workDir, installed.bin, snapshot)
      observed[key] = {
        ...facts,
        selfCheck: await selfCheck(core, workDir, key, installed.bin),
      }
    } catch (error) {
      observed[key] = {
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (!options.workDir) rmSync(workDir, { recursive: true, force: true })
  return observed
}

function observeFixture(file) {
  const fixture = JSON.parse(readFileSync(file, 'utf8'))
  if (fixture.latest?.error) {
    // As the live fetch does: three tries, then give up.
    throw new Offline(String(fixture.latest.error))
  }
  return fixture
}

async function main(argv) {
  const options = parseArgs(argv)
  const baseline = JSON.parse(readFileSync(options.baseline, 'utf8'))
  if (baseline.schemaVersion !== 1)
    throw new Error(`unsupported baseline ${options.baseline}`)
  const snapshot = newestSnapshot(options.protocolDir)
  let observed
  try {
    observed = options.fixture
      ? observeFixture(options.fixture)
      : await observeLive(options, snapshot)
  } catch (error) {
    if (!(error instanceof Offline)) throw error
    console.error(
      `npm 连不上（试了 ${TRIES} 次）：${error.message}。不开 issue，下周再查。`,
    )
    return 3
  }
  const result = compare(observed, baseline, snapshot)
  if (!result.differences.length) {
    console.log(JSON.stringify({ action: 'none', ...result }))
    return 0
  }
  const openIssues = options.issues
    ? JSON.parse(readFileSync(options.issues, 'utf8'))
    : options.dryRun
      ? []
      : JSON.parse(
          gh([
            'issue',
            'list',
            '--state',
            'open',
            '--label',
            LABEL,
            '--json',
            'number,title,url',
            '--limit',
            '20',
          ]) || '[]',
        )
  const plan = { ...planIssue(result, openIssues), ...result }
  if (options.dryRun) {
    console.log(JSON.stringify(plan))
    return 0
  }
  for (const label of plan.labels ?? [LABEL]) {
    const made = spawnSync(
      'gh',
      [
        'label',
        'create',
        label,
        '--force',
        '--color',
        label === P0 ? 'b60205' : '1d76db',
      ],
      { encoding: 'utf8' },
    )
    if (made.status !== 0)
      console.warn(
        `could not create label ${label}: ${(made.stderr || '').trim()}`,
      )
  }
  const output = gh(plan.gh, plan.body)
  if (output.trim()) console.log(output.trim())
  if (plan.then) gh(plan.then)
  console.log(JSON.stringify({ ...plan, done: true }))
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
      // A child or a socket left by a self-check must not hold the job open.
      setTimeout(() => process.exit(code), 2000).unref()
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 2
    })
}
