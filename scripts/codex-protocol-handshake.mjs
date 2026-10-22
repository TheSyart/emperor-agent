#!/usr/bin/env node
// Checks a Codex CLI against Emperor's real adapter, offline (AGT-13).
//
//   node scripts/codex-protocol-handshake.mjs --codex <path> [--out <file>]
//
// For a new Codex release, next to codex-protocol-digest.mjs. Pass a codex
// installed into a temporary prefix
//   npm install --prefix "$TMP/codex-<version>" @openai/codex@<version>
// never the user's own. It bundles Emperor's Codex adapter, RPC and registry
// from source and runs the binary with a private HOME, CODEX_HOME and TMPDIR,
// no login, and every network connection denied by Seatbelt
// (`sandbox-exec`, macOS), so no model can be reached:
//
// 1. probe   `codex --version` and the protocol digest (ExecutorRegistry);
//    features  `codex features list` with the adapter's overrides: every
//            feature Emperor turns off is off (CODEX_FEATURES);
// 2. open    `app-server --listen stdio://` with the adapter's flags:
//            initialize, the user-agent check, initialized, thread/start;
// 3. turn    turn/start (Codex waits for a network it cannot reach),
//            turn/steer, turn/interrupt, until turn_finished;
// 4. close   the run's process group is gone, nothing it started is left
//            running, and no daemon socket was made under the private root;
// 5. resume  the adapter's history check: thread/resume (excludeTurns),
//            thread/read, thread/turns/list;
// 6. models  a process with the run's arguments: config/read shows the
//            overrides, model/list is read as FIX-16 reads it.
//
// What needs a login — a model's answer, tools, usage, a model refusal, the
// ChatGPT model list — is out of reach here; a real run checks those.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const codexArgument = argument('--codex')
if (!codexArgument) {
  console.error(
    'usage: codex-protocol-handshake.mjs --codex <path to a codex in a temporary prefix> [--out <file>]',
  )
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.error('the offline check needs macOS sandbox-exec')
  process.exit(2)
}
const codex = realpathSync(resolve(codexArgument))
const out = argument('--out')
const repo = resolve(import.meta.dirname, '..')
const cache = join(repo, 'node_modules', '.cache', 'emperor-codex-handshake')
mkdirSync(cache, { recursive: true })
const bundle = join(cache, 'core.mjs')
await build({
  stdin: {
    contents: [
      'export { CodexExecutorAdapter, CODEX_FEATURES, codexAppServerArgs } from "./packages/core/src/harness/delegation/adapters/codex"',
      'export { CodexRpc } from "./packages/core/src/harness/delegation/adapters/codex-rpc"',
      'export { ManagedAgentProcess } from "./packages/core/src/harness/delegation/process"',
      'export { ExecutorRegistry } from "./packages/core/src/harness/delegation/registry"',
      'export { defaultExecutorConfig } from "./packages/core/src/harness/delegation/config"',
      'export { codexModelRows, replacementModel } from "./packages/core/src/harness/delegation/model-choice"',
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

/** Every network connection, Unix sockets included, is denied. */
const OFFLINE = '(version 1)(allow default)(deny network*)'
const root = realpathSync(
  mkdtempSync(join(tmpdir(), 'emperor-codex-handshake-')),
)
for (const dir of ['home', 'codex', 'tmp', 'workspace'])
  mkdirSync(join(root, dir))
const environment = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin:' + resolve(process.execPath, '..'),
  HOME: join(root, 'home'),
  CODEX_HOME: join(root, 'codex'),
  TMPDIR: join(root, 'tmp'),
  LANG: 'en_US.UTF-8',
}
const receipt = {
  codex,
  root,
  network: 'denied (sandbox-exec ' + OFFLINE + ')',
  login: 'none',
  steps: {},
}
const step = async (name, run) => {
  const started = Date.now()
  try {
    receipt.steps[name] = { ok: true, ...(await run()) }
  } catch (error) {
    receipt.steps[name] = { ok: false, error: String(error?.message ?? error) }
  }
  receipt.steps[name].ms = Date.now() - started
  console.error(
    `${receipt.steps[name].ok ? 'ok  ' : 'FAIL'} ${name}` +
      (receipt.steps[name].ok ? '' : ': ' + receipt.steps[name].error),
  )
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await sleep(50)
  }
  throw new Error('timed out waiting for ' + what)
}
/** Unix sockets under a folder (a daemon would leave one). */
function sockets(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sockets(path))
    else if (lstatSync(path).isSocket()) found.push(path)
  }
  return found
}
/** Processes started from this binary's package or under the private root. */
function leftovers() {
  const prefix = codex.split('/node_modules/')[0]
  return execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,command='], {
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
}

// Every spawn of the adapter runs the binary inside the offline boundary.
const processes = new core.ManagedAgentProcess({ stopGraceMs: 2000 })
const spawn = processes.spawn.bind(processes)
const spawned = []
processes.spawn = (spec) => {
  const handle = spawn({
    ...spec,
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', OFFLINE, spec.executable, ...spec.args],
  })
  spawned.push(handle)
  return handle
}
const profile = {
  ...core.defaultExecutorConfig().profiles[1],
  enabled: true,
  executablePath: codex,
}
const input = (generation, extra = {}) => ({
  delegationId: 'dlg-handshake',
  profile,
  cwd: join(root, 'workspace'),
  environment,
  runtimeRoot: join(root, 'codex'),
  policy: {
    mode: 'danger-full-access',
    workspaceRoot: join(root, 'workspace'),
    privateTempRoot: join(root, 'tmp'),
  },
  boundaryReceiptId: 'handshake',
  generation,
  signal: new AbortController().signal,
  ...extra,
})

await step('probe', async () => {
  const probe = await new core.ExecutorRegistry({
    home: join(root, 'home'),
    environment,
  }).probe(profile)
  if (probe.status !== 'available')
    throw new Error(probe.diagnostic ?? probe.status)
  return {
    executableVersion: probe.executableVersion,
    requiredVersion: probe.requiredVersion,
    compatibility: probe.compatibility,
    protocolVersion: probe.protocolVersion,
    ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
  }
})

await step('features', async () => {
  const flags = Object.entries(core.CODEX_FEATURES).flatMap(([name, on]) => [
    '-c',
    `features.${name}=${on}`,
  ])
  const output = execFileSync(
    '/usr/bin/sandbox-exec',
    ['-p', OFFLINE, codex, 'features', ...flags, 'list'],
    { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const effective = {}
  for (const line of output.split('\n')) {
    const [name, , state] = line.trim().split(/\s{2,}/)
    if (name && (state === 'true' || state === 'false'))
      effective[name] = state === 'true'
  }
  const wrong = Object.entries(core.CODEX_FEATURES)
    .filter(([name, on]) => name in effective && effective[name] !== on)
    .map(([name]) => name)
  if (wrong.length)
    throw new Error('overrides not in effect: ' + wrong.join(', '))
  return {
    off: Object.entries(core.CODEX_FEATURES)
      .filter(([name, on]) => !on && name in effective)
      .map(([name]) => name),
    unknownToThisCodex: Object.keys(core.CODEX_FEATURES).filter(
      (name) => !(name in effective),
    ),
    leftOn: Object.keys(effective)
      .filter((name) => effective[name])
      .sort(),
  }
})

const adapter = new core.CodexExecutorAdapter({ processes })
let session, threadId, threadModel
const events = []
await step('open', async () => {
  session = await adapter.open(input(1))
  threadId = session.providerSessionId
  void (async () => {
    for await (const event of session.events) events.push(event)
  })().catch(() => {})
  return { threadId }
})

await step('turn', async () => {
  if (!session) throw new Error('no session')
  const { providerTurnId } = await session.submit({
    runId: 'dgr-handshake',
    messageId: 'dgm-handshake-1',
    text: 'Reply with OK.',
  })
  // Codex starts the turn shortly after answering turn/start.
  await sleep(1500)
  await session.steer({
    providerTurnId,
    messageId: 'dgm-handshake-2',
    text: 'Then stop.',
  })
  await session.interrupt(providerTurnId)
  await until(
    () => events.some((e) => e.type === 'turn_finished'),
    15000,
    'turn_finished',
  )
  const metadata = events.find((e) => e.type === 'runtime_metadata')
  threadModel = metadata?.model
  return {
    providerTurnId,
    model: metadata?.model,
    provider: metadata?.provider,
    events: events.map((e) =>
      e.type === 'turn_finished'
        ? { type: e.type, status: e.status, error: e.error }
        : { type: e.type },
    ),
  }
})

await step('close', async () => {
  if (!session) throw new Error('no session')
  const exit = await session.close()
  await sleep(500)
  const left = leftovers()
  const daemonSockets = sockets(root)
  if (!exit.quiescent) throw new Error('the process group did not stop')
  if (left.length) throw new Error('left running: ' + left.join(' | '))
  if (daemonSockets.length)
    throw new Error('sockets left: ' + daemonSockets.join(' | '))
  return {
    quiescent: exit.quiescent,
    processesSpawned: spawned.length,
    leftRunning: left,
    sockets: daemonSockets,
  }
})

await step('resume', async () => {
  if (!threadId) throw new Error('no thread')
  const history = await adapter.inspect(input(2, { resumeSessionId: threadId }))
  return {
    sessionId: history.sessionId,
    nativeStatus: history.nativeStatus,
    turns: history.turns.map((t) => ({ id: t.id, status: t.status })),
  }
})

await step('models', async () => {
  const handle = processes.spawn({
    executable: codex,
    // The arguments of a run and of the model list.
    args: core.codexAppServerArgs(),
    cwd: join(root, 'workspace'),
    env: environment,
    policy: input(3).policy,
  })
  await handle.started
  const rpc = new core.CodexRpc({
    input: handle.stdout,
    output: handle.stdin,
    generation: 3,
    requestTimeoutMs: 8000,
    onRequest: (id) => void rpc.reject(id, -32601, 'no tools here', 3),
  })
  try {
    const initialized = await rpc.request('initialize', {
      clientInfo: { name: 'emperor-model-picker', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    await rpc.notify('initialized')
    const config = await rpc.request('config/read', {
      includeLayers: false,
      cwd: join(root, 'workspace'),
    })
    const list = await rpc.request('model/list', {
      limit: 100,
      includeHidden: true,
    })
    const rows = core.codexModelRows(list.data)
    const features = config.config?.features ?? {}
    const notOff = Object.entries(core.CODEX_FEATURES)
      .filter(([name, on]) => !on && features[name] !== false)
      .map(([name]) => name)
    if (notOff.length)
      throw new Error('config/read does not show off: ' + notOff.join(', '))
    return {
      userAgent: initialized.userAgent,
      configReadShowsOverridesOff: true,
      configuredModel: config.config?.model ?? null,
      rows: rows.length,
      defaults: rows.filter((r) => r.isDefault).map((r) => r.id),
      hidden: rows.filter((r) => r.hidden).map((r) => r.id),
      threadModel,
      threadModelListed: rows.some((r) => r.id === threadModel),
      replacementForThreadModel:
        core.replacementModel(rows, threadModel) ?? null,
    }
  } finally {
    rpc.close()
    await handle.terminate()
  }
})

receipt.leftovers = leftovers()
receipt.sockets = sockets(root)
receipt.ok =
  Object.values(receipt.steps).every((s) => s.ok) &&
  !receipt.leftovers.length &&
  !receipt.sockets.length
const text = JSON.stringify(receipt, null, 2) + '\n'
if (out) writeFileSync(out, text)
else process.stdout.write(text)
rmSync(root, { recursive: true, force: true })
process.exit(receipt.ok ? 0 : 1)
