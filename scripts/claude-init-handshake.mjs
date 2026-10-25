#!/usr/bin/env node
// Checks a Claude Code CLI against Emperor's real adapter, offline (VER-01).
//
//   node scripts/claude-init-handshake.mjs --claude <path> [--out <file>]
//        [--golden <file>] [--expect-plugin <source>]... [--raw]
//
// For a new Claude Code release, before it is listed as verified. Pass a
// claude installed into a temporary prefix
//   npm install --prefix "$TMP/claude-<version>" @anthropic-ai/claude-code@<version>
// never the user's own. It bundles Emperor's Claude adapter from source and
// starts the binary through it (the run's real SDK options), with a private
// HOME, CLAUDE_CONFIG_DIR and TMPDIR, a dummy API key, no login, and every
// network connection denied by Seatbelt (`sandbox-exec`, macOS). The only
// connection allowed is to a local proxy that answers 403 and forwards
// nothing: it names the hosts the CLI tries. So no model can be reached.
// The user's ~/.claude, ~/.codex and ~/.emperor are unreadable, nothing
// under the real HOME or a global npm prefix is writable, and `security`
// (the keychain) answers "not found".
//
// E1 promptless  reloadPlugins() before any prompt: the plugins it loads
// E2 flag layer  applyFlagSettings({enabledPlugins}) + reloadPlugins():
//                can a builtin plugin be turned off without a restart?
// E3 seeded      a process started with those plugins already off:
//                reloadPlugins(), then one prompt for its system/init
// E4 old CLIs    E1–E3 on an older claude (the same script, another --claude)
// E5 ordering    one prompt with the run's options: does system/init arrive
//                before the first network attempt the prompt causes? (5m:
//                the same with ANTHROPIC_BASE_URL on a local stand-in that
//                answers 500, so the first Messages API request is exact)
// E6 updater     started without DISABLE_AUTOUPDATER (6a) and with the run's
//                own environment (6b, no CLAUDE_CODE_DISABLE_NONESSENTIAL_
//                TRAFFIC either): does it try an update host?
// E7 initialize  SDK initialize answered with hooks_applied === true
// E8 MCP         mcpServerStatus() before any prompt is empty
//
// Network attempts come from the proxy (host names) and from Seatbelt's
// denial log (`log stream`), tagged per experiment. Claude Code (2.1.281–
// 2.1.310) makes its own startup requests to api.anthropic.com before any
// prompt, and its initialize waits ~20 s for them to fail offline; none of
// them reaches the Messages API (E5m). --golden writes the
// scrubbed fixture (versions, plugin names and sources, MCP names only).
// --raw (VER-04/05): nothing Emperor knows is turned off at launch (no
// seed, no ledger), and E1 reports what the preflight first saw — the
// plugins this release itself ships, to compare with the upstream
// baseline. Without it, E1 shows what is left after Emperor's own list.
// Exit 0 when every self-check passes, 1 when one fails, 2 on bad input.
import { build } from 'esbuild'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
function usage(message) {
  console.error(message)
  process.exit(2)
}
const claudeArgument = argument('--claude')
if (!claudeArgument)
  usage(
    '用法：node scripts/claude-init-handshake.mjs --claude <装在临时 prefix 里的 claude> [--out <文件>] [--golden <文件>] [--expect-plugin <source>] [--raw]',
  )
if (!existsSync(resolve(claudeArgument)))
  usage(
    `找不到 Claude Code：${claudeArgument}。先 npm install --prefix "$TMP/claude-<版本>" @anthropic-ai/claude-code@<版本>，再传入 <prefix>/node_modules/.bin/claude。`,
  )
if (process.platform !== 'darwin') usage('离线检查需要 macOS 的 sandbox-exec。')
const claude = realpathSync(resolve(claudeArgument))
const own = (() => {
  try {
    return realpathSync(
      execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim(),
    )
  } catch {
    return undefined
  }
})()
if (own === claude)
  usage(
    '这是 PATH 上你自己在用的 claude。请传入装在临时 prefix 里的副本，不要用它。',
  )
const out = argument('--out')
const golden = argument('--golden')
const expected = process.argv.flatMap((value, i) =>
  process.argv[i - 1] === '--expect-plugin' ? [value] : [],
)
const raw = process.argv.includes('--raw')

const repo = resolve(import.meta.dirname, '..')
const cache = join(repo, 'node_modules', '.cache', 'emperor-claude-handshake')
mkdirSync(cache, { recursive: true })
const bundle = join(cache, 'core.mjs')
await build({
  stdin: {
    contents: [
      'export { ClaudeExecutorAdapter } from "./packages/core/src/harness/delegation/adapters/claude"',
      'export { BuiltinPluginLedger } from "./packages/core/src/harness/delegation/claude-builtin-plugins"',
      'export { ManagedAgentProcess } from "./packages/core/src/harness/delegation/process"',
      'export { defaultExecutorConfig } from "./packages/core/src/harness/delegation/config"',
      'export { CLAUDE_SDK_VERSION } from "./packages/core/src/harness/delegation/compatibility"',
      'export { startup } from "@anthropic-ai/claude-agent-sdk"',
    ].join('\n'),
    resolveDir: repo,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundle,
  logLevel: 'error',
})
const core = await import(pathToFileURL(bundle).href)

const DUMMY_KEY = 'sk-ant-api03-offline-probe'
const realHome = realpathSync(homedir())
const root = realpathSync(
  mkdtempSync(join(tmpdir(), 'emperor-claude-handshake-')),
)
for (const dir of ['home', 'config', 'tmp', 'workspace', 'bin'])
  mkdirSync(join(root, dir))
// Claude Code reads its login from the keychain through `security` on PATH
// first (FIX-19): answered "not found" here, the real tool is never run.
writeFileSync(
  join(root, 'bin', 'security'),
  '#!/bin/sh\ncase "$1" in find-generic-password|delete-generic-password) exit 44 ;; esac\nexit 1\n',
  { mode: 0o755 },
)
// An updater would run npm or brew: these record the call and fail.
for (const tool of ['npm', 'npx', 'brew'])
  writeFileSync(
    join(root, 'bin', tool),
    `#!/bin/sh\necho "${tool} $*" >> "${join(root, 'spawned.log')}"\nexit 1\n`,
    { mode: 0o755 },
  )
const MARK = 'emperor-probe:' + randomUUID().slice(0, 8)
/** Seatbelt profile of one experiment; `ports` are its local stand-ins. */
function seatbelt(tag, ports = []) {
  const state = ['.claude', '.codex', '.emperor'].map(
    (dir) => `(subpath "${join(realHome, dir)}")`,
  )
  return [
    '(version 1)',
    '(allow default)',
    `(deny network* (with message "${MARK}:${tag}:net"))`,
    ...ports.map(
      (port) => `(allow network-outbound (remote ip "localhost:${port}"))`,
    ),
    `(deny file-read* (with message "${MARK}:${tag}:read") ${state.join(' ')} (literal "${join(realHome, '.claude.json')}"))`,
    `(deny file-write* (with message "${MARK}:${tag}:write") (subpath "${realHome}") (subpath "/opt/homebrew") (subpath "/usr/local"))`,
    `(deny process-exec (with message "${MARK}:${tag}:exec") (literal "/usr/bin/security"))`,
  ].join('')
}
const baseEnvironment = {
  PATH: join(root, 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: join(root, 'home'),
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  TMPDIR: join(root, 'tmp'),
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: DUMMY_KEY,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
}
const withProxy = (environment, port) => {
  const url = `http://127.0.0.1:${port}`
  return {
    ...environment,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
function within(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${ms} ms`)),
        ms,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}
const message = (error) => String(error?.message ?? error).slice(0, 400)

/** A proxy that names the host of each connection and forwards nothing. */
async function proxy() {
  const log = []
  const server = createServer((socket) => {
    const at = Date.now()
    let head = ''
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n')
      if (end === -1 && head.length < 8192) return
      socket.removeAllListeners('data')
      const [method = '?', target = '?'] = head
        .slice(0, end === -1 ? 256 : end)
        .split(' ')
      let host = target
      if (method !== 'CONNECT')
        try {
          host = new URL(target).host
        } catch {
          host = '?'
        }
      log.push({ at, via: 'proxy', method, host })
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      )
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: server.address().port,
    log,
    close: () => new Promise((done) => server.close(() => done())),
  }
}

/** A stand-in for the Messages API: names each request, answers 500. */
async function fakeApi() {
  const log = []
  const server = createHttpServer((request, response) => {
    const at = Date.now()
    request.resume()
    request.on('end', () => {
      log.push({
        at,
        via: 'api',
        method: request.method,
        path: String(request.url).split('?')[0],
      })
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        '{"type":"error","error":{"type":"api_error","message":"offline probe"}}',
      )
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: server.address().port,
    log,
    close: () => new Promise((done) => server.close(() => done())),
  }
}

// Seatbelt's denials, tagged per experiment, as the kernel reports them.
const sandboxLog = join(root, 'sandbox.ndjson')
const logFd = openSync(sandboxLog, 'w')
const logger = spawnChild(
  '/usr/bin/log',
  [
    'stream',
    '--style',
    'ndjson',
    '--predicate',
    `sender == "Sandbox" AND eventMessage CONTAINS "${MARK}"`,
  ],
  { stdio: ['ignore', logFd, 'ignore'] },
)
await sleep(1500)
function denials() {
  const rows = []
  for (const line of readFileSync(sandboxLog, 'utf8').split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const text = String(row.eventMessage ?? '')
    const tag = new RegExp(MARK + ':([^:\\s]+):(\\w+)').exec(text)
    if (!tag) continue
    const when = /^(\S+) (\S+?)([+-]\d\d)(\d\d)$/.exec(String(row.timestamp))
    // The kernel folds repeats into "N duplicate reports for …".
    const repeats = Number(
      /^(\d+) duplicate reports? for /.exec(text)?.[1] ?? 1,
    )
    const row0 = {
      at: when ? Date.parse(`${when[1]}T${when[2]}${when[3]}:${when[4]}`) : 0,
      via: 'sandbox',
      experiment: tag[1],
      kind: tag[2],
      what: text
        .split('\n')[0]
        .replace(/^\d+ duplicate reports? for /, '')
        .replace(/^Sandbox: /, ''),
    }
    for (let i = 0; i < repeats; i++) rows.push(row0)
  }
  return rows
}
// Canary: a denied connection must show up, or the log is not readable.
// (curl's denials are reported; Node's own are not, on macOS 26.)
try {
  execFileSync(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      seatbelt('canary'),
      '/usr/bin/curl',
      '-s',
      '-m',
      '1',
      'http://127.0.0.1:9/',
    ],
    { stdio: 'ignore' },
  )
} catch {
  /* denied, as it should be */
}
let logAvailable = false
for (let i = 0; i < 50 && !logAvailable; i++) {
  await sleep(100)
  logAvailable = denials().some((d) => d.experiment === 'canary')
}

const claudeVersion = (() => {
  try {
    const text = execFileSync(
      '/usr/bin/sandbox-exec',
      ['-p', seatbelt('version'), claude, '--version'],
      { env: baseEnvironment, encoding: 'utf8', timeout: 30_000 },
    )
    return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null
  } catch {
    return null
  }
})()
console.error(`claude ${claudeVersion} · ${claude}`)

// Every spawn of the adapter runs the binary inside the offline boundary.
const processes = new core.ManagedAgentProcess({ stopGraceMs: 2000 })
const spawn = processes.spawn.bind(processes)
let current
processes.spawn = (spec) => {
  current.spawnedAt = Date.now()
  return spawn({
    ...spec,
    executable: '/usr/bin/sandbox-exec',
    args: [
      '-p',
      seatbelt(current.experiment, current.ports),
      spec.executable,
      ...spec.args,
    ],
  })
}
const profile = {
  ...core.defaultExecutorConfig().profiles[0],
  enabled: true,
  executablePath: claude,
}

/** The Query the adapter iterates, with every message time-stamped. */
function recording(query, run) {
  const iterator = (async function* () {
    for await (const value of query) {
      run.messages.push({ at: Date.now(), value })
      yield value
    }
  })()
  return new Proxy(query, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => iterator
      if (['next', 'return', 'throw'].includes(property))
        return iterator[property].bind(iterator)
      if (property === 'initializationResult')
        return async () => (run.init = await target.initializationResult())
      // Every answer, in order: the first is what the preflight saw.
      if (property === 'reloadPlugins')
        return async () => {
          const answer = await target.reloadPlugins()
          ;(run.reloads ??= []).push(answer)
          return answer
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
const runs = []
/** Opens a session through the real adapter; `mutate` edits its options. */
async function open(
  experiment,
  { environment = baseEnvironment, mutate, api } = {},
) {
  const run = { experiment, messages: [], events: [], init: null }
  run.proxy = await proxy()
  run.ports = [run.proxy.port, ...(api ? [api.port] : [])]
  if (api)
    environment = {
      ...environment,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
  runs.push(run)
  current = run
  const adapter = new core.ClaudeExecutorAdapter({
    processes,
    // --raw: no seed and no ledger, so the release's own plugins load.
    ...(raw
      ? { ledger: new core.BuiltinPluginLedger(undefined, { seed: false }) }
      : {}),
    startup: async (options) => {
      mutate?.(options)
      run.options = options
      const warm = await core.startup({ options, initializeTimeoutMs: 30_000 })
      return {
        close: () => warm.close(),
        query: (prompts) => {
          run.query = warm.query(prompts)
          return recording(run.query, run)
        },
      }
    },
  })
  const opening = Date.now()
  run.session = await adapter.open({
    delegationId: 'dlg-handshake',
    profile,
    cwd: join(root, 'workspace'),
    environment: withProxy(environment, run.proxy.port),
    runtimeRoot: join(root, 'config'),
    policy: {
      mode: 'danger-full-access',
      workspaceRoot: join(root, 'workspace'),
      privateTempRoot: join(root, 'tmp'),
    },
    boundaryReceiptId: 'handshake',
    generation: 1,
    signal: new AbortController().signal,
  })
  run.openMs = Date.now() - opening
  void (async () => {
    for await (const event of run.session.events) run.events.push(event)
  })().catch(() => {})
  return run
}
/** One prompt; with the network denied it cannot reach a model. */
async function prompt(run, waitMs) {
  run.promptAt = Date.now()
  const outcome = run.session
    .submit({
      runId: 'dgr-handshake',
      messageId: 'dgm-handshake-' + run.experiment,
      text: 'Reply with OK.',
    })
    .then(
      () => 'accepted',
      (error) => message(error),
    )
  await sleep(waitMs)
  run.outcome = await Promise.race([outcome, sleep(0).then(() => 'pending')])
}
async function close(run) {
  try {
    run.quiescent = (await run.session.close()).quiescent
  } finally {
    await run.proxy.close()
  }
}
async function step(name, body) {
  const started = Date.now()
  try {
    await body()
    console.error(`ok   ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    experiments[name] = { ...experiments[name], error: message(error) }
    console.error(`FAIL ${name}: ${message(error)}`)
  }
}
const plugins = (list) =>
  (Array.isArray(list) ? list : []).map((p) => ({
    name: String(p?.name),
    path: String(p?.path),
    ...(typeof p?.source === 'string' ? { source: p.source } : {}),
    ...(typeof p?.version === 'string' ? { version: p.version } : {}),
  }))
const names = (list) =>
  (Array.isArray(list) ? list : []).map((s) => String(s?.name ?? s))
const initOf = (run) =>
  run?.messages.find(
    (m) => m.value?.type === 'system' && m.value?.subtype === 'init',
  )
const sourceOf = (p) => p.source ?? p.name

const experiments = {}
const report = {
  claudeVersion,
  sdkVersion: core.CLAUDE_SDK_VERSION,
  raw,
  promptless: {
    hooksApplied: null,
    reload: null,
    afterFlagSettings: null,
    mcpStatus: null,
  },
  withSeed: null,
  ordering: { initBeforeFirstNetworkAttempt: null, networkAttempts: 0 },
  autoUpdateAttempted: null,
  modelCalls: 0,
}

let first, seeded, ordering
const updater = {}
await step('E1', async () => {
  first = await open('E1')
  report.promptless.hooksApplied =
    typeof first.init?.hooks_applied === 'boolean'
      ? first.init.hooks_applied
      : null
  const started = Date.now()
  try {
    // --raw: the preflight's first answer, before it turned anything off.
    const reloaded =
      raw && first.reloads?.length
        ? first.reloads[0]
        : await within(first.query.reloadPlugins(), 10_000, 'reloadPlugins')
    report.promptless.reload = {
      supported: true,
      plugins: plugins(reloaded.plugins),
      mcpServers: names(reloaded.mcpServers),
      errorCount: Number(reloaded.error_count ?? 0),
    }
    first.reloadMs = Date.now() - started
  } catch (error) {
    report.promptless.reload = {
      supported: false,
      plugins: [],
      mcpServers: [],
      errorCount: 0,
      error: message(error),
    }
  }
  experiments.E1 = {
    ...report.promptless.reload,
    openMs: first.openMs,
    reloadMs: first.reloadMs ?? null,
  }
})
await step('E8', async () => {
  if (!first) throw new Error('no session')
  try {
    report.promptless.mcpStatus = names(
      await within(first.query.mcpServerStatus(), 10_000, 'mcpServerStatus'),
    )
    experiments.E8 = {
      supported: true,
      servers: report.promptless.mcpStatus,
      empty: report.promptless.mcpStatus.length === 0,
    }
  } catch (error) {
    experiments.E8 = { supported: false, error: message(error) }
  }
})
await step('E2', async () => {
  if (!first) throw new Error('no session')
  const found = report.promptless.reload?.plugins ?? []
  const enabledPlugins = {
    ...first.options.settings.enabledPlugins,
    ...Object.fromEntries(found.map((p) => [sourceOf(p), false])),
  }
  // Without a plugin to turn off, only whether the request is understood.
  const applying = Date.now()
  try {
    await within(
      first.query.applyFlagSettings({ enabledPlugins }),
      10_000,
      'applyFlagSettings',
    )
  } catch (error) {
    experiments.E2 = {
      applied: enabledPlugins,
      applyFlagSettings: { supported: false, error: message(error) },
    }
    return
  }
  const applyMs = Date.now() - applying
  if (!report.promptless.reload?.supported || !found.length) {
    experiments.E2 = {
      applyFlagSettings: { supported: true, ms: applyMs },
      skipped: report.promptless.reload?.supported
        ? 'E1 listed no plugin'
        : 'reloadPlugins is not supported',
    }
    return
  }
  const reloading = Date.now()
  const reloaded = await within(
    first.query.reloadPlugins(),
    10_000,
    'reloadPlugins',
  )
  const reloadMs = Date.now() - reloading
  report.promptless.afterFlagSettings = {
    plugins: plugins(reloaded.plugins).map(({ name, source }) => ({
      name,
      ...(source ? { source } : {}),
    })),
  }
  // The run's own init gate must then see no plugin either.
  await prompt(first, 3000)
  const init = initOf(first)?.value
  const initPlugins = init ? plugins(init.plugins).map(sourceOf) : null
  experiments.E2 = {
    applied: enabledPlugins,
    applyFlagSettings: { supported: true, ms: applyMs },
    reloadMs,
    plugins: report.promptless.afterFlagSettings.plugins,
    initPlugins,
    initMcpServers: init ? names(init.mcp_servers) : null,
    outcome: first.outcome,
    cleared:
      report.promptless.afterFlagSettings.plugins.length === 0 &&
      initPlugins?.length === 0 &&
      first.outcome === 'accepted',
  }
})
if (first) await close(first)

// E3: the builtins E1 found, and the 2.1.308 one whether or not this CLI
// has it (turning off a plugin a CLI lacks must be harmless, E4).
const seed = [
  ...new Set([
    ...(report.promptless.reload?.plugins ?? []).map(sourceOf),
    'cc-plugin-plugin-authoring@builtin',
  ]),
]
await step('E3', async () => {
  seeded = await open('E3', {
    mutate: (options) => {
      options.settings = {
        ...options.settings,
        enabledPlugins: {
          ...options.settings.enabledPlugins,
          ...Object.fromEntries(seed.map((s) => [s, false])),
        },
      }
    },
  })
  let reload
  try {
    const reloaded = await within(
      seeded.query.reloadPlugins(),
      10_000,
      'reloadPlugins',
    )
    reload = {
      supported: true,
      plugins: plugins(reloaded.plugins).map(sourceOf),
    }
  } catch (error) {
    reload = { supported: false, error: message(error) }
  }
  await prompt(seeded, 4000)
  const init = initOf(seeded)?.value
  report.withSeed = init
    ? {
        initPlugins: plugins(init.plugins).map(sourceOf),
        initMcpServers: names(init.mcp_servers),
      }
    : null
  experiments.E3 = {
    seed,
    reload,
    init: report.withSeed,
    outcome: seeded.outcome,
    cleared:
      (!reload.supported || reload.plugins.length === 0) &&
      !!report.withSeed &&
      report.withSeed.initPlugins.length === 0 &&
      report.withSeed.initMcpServers.length === 0,
  }
  await close(seeded)
})

await step('E5', async () => {
  ordering = await open('E5')
  await prompt(ordering, 6000)
  await close(ordering)
})
// E5 again, the Messages API pointed at a local stand-in: its log names
// each request, so the first model request is known exactly.
let modelPath
await step('E5m', async () => {
  const api = await fakeApi()
  try {
    modelPath = await open('E5m', { api })
    modelPath.api = api.log
    await prompt(modelPath, 4000)
    await close(modelPath)
  } finally {
    await api.close()
  }
})

for (const [name, environment] of [
  ['E6a', { ...baseEnvironment, DISABLE_AUTOUPDATER: undefined }],
  [
    'E6b',
    {
      ...baseEnvironment,
      DISABLE_AUTOUPDATER: undefined,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined,
    },
  ],
])
  await step(name, async () => {
    const env = Object.fromEntries(
      Object.entries(environment).filter(([, v]) => v !== undefined),
    )
    const before = new Set(files(root))
    const run = await open(name, { environment: env })
    await sleep(8000)
    run.promptlessUntil = Date.now()
    await prompt(run, 6000)
    await close(run)
    updater[name] = {
      run,
      newFiles: files(root).filter(
        (f) =>
          !before.has(f) &&
          /update|version|\.lock|install|native/i.test(f) &&
          !f.startsWith('sandbox'),
      ),
    }
  })

/** Files under the private root, relative to it. */
function files(dir) {
  const found = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(relative(root, path))
    }
  }
  try {
    walk(dir)
  } catch {
    /* a folder removed while walking */
  }
  return found
}

// Wait for the kernel log to catch up, then attribute every attempt.
await sleep(2000)
logger.kill('SIGTERM')
closeSync(logFd)
const denied = denials()
function attempts(run, from = 0, until = Infinity) {
  if (!run) return []
  return [
    ...run.proxy.log,
    ...denied.filter(
      (d) => d.experiment === run.experiment && d.kind === 'net',
    ),
  ]
    .filter((a) => a.at >= from && a.at < until)
    .sort((a, b) => a.at - b.at)
}
const describe = (list, since) =>
  list.map((a) => ({
    ms: since ? a.at - since : undefined,
    via: a.via,
    ...(a.host ? { host: a.host } : { what: a.what }),
  }))

// Model calls: anything that only an answering model produces.
for (const run of runs)
  for (const { value } of run.messages) {
    const model = value?.message?.model
    if (
      (value?.type === 'assistant' && model && model !== '<synthetic>') ||
      (value?.type === 'result' &&
        value.subtype === 'success' &&
        !value.is_error) ||
      (value?.type === 'stream_event' && value.event?.type === 'message_start')
    )
      report.modelCalls++
  }

const promptlessAttempts = [
  ...attempts(first, 0, first?.promptAt ?? Infinity),
  ...attempts(seeded, 0, seeded?.promptAt ?? Infinity),
]
const modelRequest = (a) => a.method === 'POST' && /\/messages$/.test(a.path)
if (modelPath) {
  const init = initOf(modelPath)
  const firstModel = modelPath.api.find(modelRequest)
  experiments.E5m = {
    outcome: modelPath.outcome,
    initMsAfterPrompt: init ? init.at - modelPath.promptAt : null,
    apiBeforePrompt: modelPath.api
      .filter((a) => a.at < modelPath.promptAt)
      .map((a) => `${a.method} ${a.path}`),
    apiAfterPrompt: modelPath.api
      .filter((a) => a.at >= modelPath.promptAt)
      .map((a) => ({
        ms: a.at - modelPath.promptAt,
        request: `${a.method} ${a.path}`,
      })),
    firstModelRequestMsAfterPrompt: firstModel
      ? firstModel.at - modelPath.promptAt
      : null,
    initBeforeFirstModelRequest:
      init && firstModel ? init.at <= firstModel.at : null,
    otherAttempts: describe(attempts(modelPath), modelPath.spawnedAt),
  }
}
if (ordering) {
  const init = initOf(ordering)
  const all = attempts(ordering)
  const afterPrompt = all.filter((a) => a.at >= ordering.promptAt)
  // Claude Code makes its own startup requests before any prompt (E1);
  // what counts is the first attempt the prompt causes.
  const proxied = init
    ? logAvailable
      ? !afterPrompt.some((a) => a.at < init.at)
      : null
    : null
  const model = experiments.E5m?.initBeforeFirstModelRequest ?? null
  report.ordering = {
    initBeforeFirstNetworkAttempt:
      proxied === null || model === null ? null : proxied && model,
    networkAttempts: all.length,
    startupAttemptsBeforePrompt: all.length - afterPrompt.length,
  }
  experiments.E5 = {
    outcome: ordering.outcome,
    initMsAfterPrompt: init ? init.at - ordering.promptAt : null,
    attemptsBeforePrompt: describe(
      all.filter((a) => a.at < ordering.promptAt),
      ordering.spawnedAt,
    ),
    attemptsAfterPrompt: describe(
      all.filter((a) => a.at >= ordering.promptAt),
      ordering.promptAt,
    ),
    initPlugins: init ? plugins(init.value.plugins).map(sourceOf) : null,
    initVersion: init?.value?.claude_code_version ?? null,
  }
}
const UPDATE_HOST =
  /storage\.googleapis\.com|registry\.npmjs\.org|npmjs\.(com|org)|downloads\.claude\.ai|claude\.ai$|github(usercontent)?\.com/i
for (const [name, { run, newFiles }] of Object.entries(updater)) {
  const promptless = attempts(run, 0, run.promptlessUntil)
  const later = attempts(run, run.promptlessUntil)
  const hosts = [
    ...new Set([...promptless, ...later].flatMap((a) => a.host ?? [])),
  ]
  const unattributed = [...promptless, ...later].filter((a) => !a.host).length
  experiments[name] = {
    environment: name === 'E6a' ? 'no DISABLE_AUTOUPDATER' : 'run environment',
    promptlessAttempts: describe(promptless, run.spawnedAt),
    afterPromptAttempts: describe(later, run.promptAt),
    hosts,
    unattributed,
    newFiles,
    updateHost: hosts.some((h) => UPDATE_HOST.test(h.replace(/:\d+$/, ''))),
  }
}
const spawnedTools = existsSync(join(root, 'spawned.log'))
  ? readFileSync(join(root, 'spawned.log'), 'utf8').split('\n').filter(Boolean)
  : []
const sixB = experiments.E6b
report.autoUpdateAttempted = sixB
  ? sixB.updateHost || sixB.newFiles.length > 0 || spawnedTools.length > 0
    ? true
    : sixB.unattributed > 0 || !logAvailable
      ? null
      : false
  : null
experiments.E4 = {
  reloadPluginsSupported: report.promptless.reload?.supported ?? null,
  applyFlagSettingsSupported:
    experiments.E2?.applyFlagSettings?.supported ?? null,
  applyFlagSettingsWorked: experiments.E2?.cleared ?? null,
  npmOrBrewRun: spawnedTools,
  disablingAnAbsentPluginIsHarmless:
    experiments.E3?.init !== undefined && experiments.E3?.init !== null,
}
experiments.E7 = { hooksApplied: report.promptless.hooksApplied }

const leftovers = (() => {
  const prefix = claude.split('/node_modules/')[0]
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        Number(line.split(/\s+/)[0]) !== process.pid &&
        (line.includes(root) || line.includes(prefix)),
    )
})()
const userState = denied.filter((d) =>
  ['read', 'write', 'exec'].includes(d.kind),
)

// The scrubbed fixture: versions, plugin names and sources, MCP names.
const fixture = {
  claudeVersion: report.claudeVersion,
  sdkVersion: report.sdkVersion,
  ...(raw ? { raw: true } : {}),
  promptless: {
    hooksApplied: report.promptless.hooksApplied,
    reload: report.promptless.reload && {
      supported: report.promptless.reload.supported,
      plugins: report.promptless.reload.plugins.map((p) => ({
        name: p.name,
        path: p.path === 'builtin' ? 'builtin' : '<not builtin>',
        ...(p.source ? { source: p.source } : {}),
      })),
      mcpServers: report.promptless.reload.mcpServers,
      errorCount: report.promptless.reload.errorCount,
    },
    afterFlagSettings: report.promptless.afterFlagSettings,
    mcpStatus: report.promptless.mcpStatus,
  },
  withSeed: report.withSeed,
  ordering: report.ordering,
  autoUpdateAttempted: report.autoUpdateAttempted,
  modelCalls: report.modelCalls,
}
const fixtureText = JSON.stringify(fixture, null, 2) + '\n'

const checks = []
const check = (name, ok, detail) =>
  checks.push({ name, ok: !!ok, detail: String(detail) })
check(
  'version matches claude --version',
  report.claudeVersion &&
    [experiments.E5?.initVersion, initOf(seeded)?.value?.claude_code_version]
      .filter(Boolean)
      .every((v) => v === report.claudeVersion) &&
    (experiments.E5?.initVersion || initOf(seeded)),
  `--version ${report.claudeVersion}; init ${experiments.E5?.initVersion ?? initOf(seeded)?.value?.claude_code_version}`,
)
check('no model call', report.modelCalls === 0, report.modelCalls)
check('denial log readable', logAvailable, 'canary denial seen')
check(
  'before a prompt, only Claude Code’s own startup requests to api.anthropic.com (E1, E2, E8, E3)',
  logAvailable &&
    promptlessAttempts.every((a) => a.host === 'api.anthropic.com:443'),
  `${promptlessAttempts.length} attempts: ` +
    JSON.stringify([
      ...new Set(promptlessAttempts.map((a) => a.host ?? a.what)),
    ]),
)
check(
  'no Messages API request before a prompt (E5m)',
  modelPath && !modelPath.api.some((a) => a.at < modelPath.promptAt),
  JSON.stringify(experiments.E5m?.apiBeforePrompt),
)
check(
  'user state untouched (~/.claude, ~/.codex, ~/.emperor, HOME, keychain)',
  userState.length === 0,
  JSON.stringify(userState.map((d) => `${d.experiment} ${d.what}`)),
)
check(
  'E7 initialize applied the hooks',
  report.promptless.hooksApplied === true,
  report.promptless.hooksApplied,
)
const builtins = (report.promptless.reload?.plugins ?? []).length
check(
  'plugins E1 found can be turned off (E2 or E3)',
  !builtins || experiments.E2?.cleared || experiments.E3?.cleared,
  `E1 ${builtins}; E2 ${experiments.E2?.cleared}; E3 ${experiments.E3?.cleared}`,
)
for (const source of expected)
  check(
    `E1 lists ${source}`,
    report.promptless.reload?.plugins?.some((p) => p.source === source),
    JSON.stringify(report.promptless.reload?.plugins?.map(sourceOf)),
  )
check(
  'every process stopped',
  runs.every((r) => r.quiescent !== false) && !leftovers.length,
  JSON.stringify(leftovers),
)
const leaks = [realHome, root, DUMMY_KEY, 'sk-ant', '"email"', '"account"']
  .concat(['orgId', 'organization', 'apiKey', '/Users/', '/private/'])
  .concat(['/var/folders', '/tmp/'])
  .filter((needle) => fixtureText.includes(needle))
check('fixture is scrubbed', leaks.length === 0, JSON.stringify(leaks))

for (const c of checks)
  console.error(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
const full = {
  claude,
  network: {
    boundary: 'sandbox-exec: deny network*, allow only a local 403 proxy',
    logAvailable,
  },
  ...report,
  experiments,
  checks,
}
const text = JSON.stringify(full, null, 2) + '\n'
if (out) writeFileSync(out, text)
else process.stdout.write(text)
if (golden) writeFileSync(golden, fixtureText)
rmSync(root, { recursive: true, force: true })
process.exit(checks.every((c) => c.ok) ? 0 : 1)
