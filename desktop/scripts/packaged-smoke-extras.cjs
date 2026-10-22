// REL-04 (MAIN-29) additions to the packaged smoke runner
// (run-packaged-smoke.cjs): the Native Messaging host's handshake, a clean
// quit, nothing left running, and the 0.1.0-preview.4 upgrade fixture.
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require('node:fs')
const { userInfo } = require('node:os')
const { dirname, join, relative, resolve, sep } = require('node:path')

/** The pinned extension id of Emperor's Chrome/Edge extension. */
const NM_EXTENSION_ORIGIN =
  'chrome-extension://oobcokoopgkhlhpohfdpelkafiidojjn/'
const FOREIGN_ORIGIN = 'https://example.com/'

/** An Emperor Home written by Emperor 0.1.0-preview.4 itself (see fixture.json). */
const UPGRADE_FIXTURE = resolve(
  __dirname,
  '..',
  '..',
  'packages',
  'core',
  'fixtures',
  'emperor-home-0.1.0-preview.4',
)

const STARTUP = /\[info\] Emperor Agent \S+ starting/
const QUIT = /\[info\] quit(\s|$)/
const UNCLEAN = /failed to close CoreApi|shutdown did not finish/

/** Chrome's Native Messaging frame: native-endian u32 length, UTF-8 JSON. */
function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}

function decodeNativeMessages(buffer) {
  const messages = []
  let offset = 0
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset)
    if (buffer.length - offset - 4 < length) break
    messages.push(
      JSON.parse(
        buffer.subarray(offset + 4, offset + 4 + length).toString('utf8'),
      ),
    )
    offset += 4 + length
  }
  return { messages, rest: buffer.subarray(offset) }
}

/** Where emperor-nm-host looks for Emperor: the account's own ~/.emperor. */
function defaultNmSocketPath() {
  return join(
    userInfo().homedir,
    '.emperor',
    'run',
    `nm-${process.getuid()}.sock`,
  )
}

function runHost(hostPath, origin, input, timeoutMs) {
  return new Promise((done, fail) => {
    // Chrome starts the host with the extension's origin and talks on stdio.
    const child = spawn(hostPath, [origin], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    // The host may exit before it reads (no Emperor): ignore EPIPE.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, stdout: Buffer.concat(stdout), stderr })
    })
  })
}

/**
 * The packaged emperor-nm-host under its hardened runtime: Chrome's framing
 * with Emperor's extension origin gets the host's fixed EMPEROR_NOT_RUNNING
 * frame (no Emperor at the account's socket), a foreign origin is refused
 * with no frame. Never talks to a running Emperor: beside a live socket it
 * skips, or fails when `required` (CI, where none may run).
 */
async function nmHostHandshake(
  hostPath,
  {
    liveSocketPath = defaultNmSocketPath(),
    required = false,
    timeoutMs = 10_000,
  } = {},
) {
  if (existsSync(liveSocketPath)) {
    if (required)
      throw new Error(
        `an Emperor owns the Native Messaging socket ${liveSocketPath}; the handshake would reach it`,
      )
    return { ok: true, skipped: 'an Emperor owns the Native Messaging socket' }
  }
  const hello = encodeNativeMessage({ type: 'hello', id: 1 })
  const valid = await runHost(hostPath, NM_EXTENSION_ORIGIN, hello, timeoutMs)
  const frames = decodeNativeMessages(valid.stdout).messages
  const answer = frames[0]
  if (
    frames.length !== 1 ||
    answer?.type !== 'response' ||
    answer.id !== 0 ||
    answer.ok !== false ||
    answer.error?.code !== 'EMPEROR_NOT_RUNNING'
  )
    throw new Error(
      `the Native Messaging host did not answer EMPEROR_NOT_RUNNING: exit ${valid.code ?? valid.signal}, frames ${JSON.stringify(frames)}, ${valid.stderr.trim()}`,
    )
  const foreign = await runHost(hostPath, FOREIGN_ORIGIN, hello, timeoutMs)
  if (
    foreign.stdout.length !== 0 ||
    foreign.code === 0 ||
    !/EXTENSION_ORIGIN_REJECTED/.test(foreign.stderr)
  )
    throw new Error(
      `the Native Messaging host did not refuse a foreign origin: exit ${foreign.code ?? foreign.signal}, ${foreign.stdout.length} bytes out, ${foreign.stderr.trim()}`,
    )
  return {
    ok: true,
    extensionOrigin: NM_EXTENSION_ORIGIN,
    answered: 'EMPEROR_NOT_RUNNING',
    foreignOriginRefused: true,
  }
}

/**
 * The app left through before-quit and will-quit (Cmd+Q's path): main.log
 * has "quit" after its last start, and Core closed within the deadline.
 * app.exit() and crashes write no quit record.
 */
function checkCleanQuit(stateRoot) {
  const path = join(stateRoot, 'logs', 'main.log')
  if (!existsSync(path))
    throw new Error(`packaged main.log is missing: ${path}`)
  const lines = readFileSync(path, 'utf8').split('\n')
  let start = -1
  lines.forEach((line, index) => {
    if (STARTUP.test(line)) start = index
  })
  if (start < 0)
    throw new Error(`packaged main.log has no startup record: ${path}`)
  const after = lines.slice(start + 1)
  const unclean = after.find((line) => UNCLEAN.test(line))
  if (unclean)
    throw new Error(`the packaged app did not quit cleanly: ${unclean}`)
  const quit = after.find((line) => QUIT.test(line))
  if (!quit)
    throw new Error(
      'packaged main.log has no quit record after its last start: the app did not leave through before-quit and will-quit',
    )
  return { quitLine: quit.trim() }
}

/** `ps -axo pid=,command=` lines whose executable lives under a needle. */
function findLeftoverProcesses(psOutput, needles) {
  return psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      const command = line.replace(/^\d+\s+/, '')
      return needles.some((needle) => command.startsWith(needle))
    })
}

/** Waits for every process from the app bundle or the smoke folder to end. */
async function waitForNoLeftovers(needles, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let left = []
  for (;;) {
    const ps = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
    })
    left = findLeftoverProcesses(ps.stdout || '', needles)
    if (!left.length || Date.now() > deadline) return left
    await new Promise((wait) => setTimeout(wait, 250))
  }
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'

/** LaunchServices `path:` entries under a needle (`lsregister -dump` text). */
function findLaunchServicesLeftovers(dump, needles) {
  const paths = new Set()
  for (const line of dump.split('\n')) {
    const match = /^path:\s+(.+?)(?:\s+\(0x[0-9a-f]+\))?$/.exec(line.trim())
    if (match && needles.some((needle) => match[1].startsWith(needle)))
      paths.add(match[1])
  }
  return [...paths].sort()
}

/** Helper copies of this smoke still registered with LaunchServices (macOS). */
function launchServicesLeftovers(needles) {
  if (process.platform !== 'darwin' || !existsSync(LSREGISTER)) return []
  const dump = spawnSync(LSREGISTER, ['-dump'], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: 10_000,
  })
  if (dump.error || dump.status !== 0)
    throw new Error(
      `LaunchServices inspection failed: ${dump.error?.message || dump.stderr || dump.status}`,
    )
  return findLaunchServicesLeftovers(dump.stdout || '', needles)
}

/** `lsregister -u` may return before lsd publishes its updated database. */
async function waitForNoLaunchServicesLeftovers(
  needles,
  { timeoutMs = 5_000, read = () => launchServicesLeftovers(needles) } = {},
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const left = read()
    if (!left.length || Date.now() >= deadline) return left
    await new Promise((wait) => setTimeout(wait, 100))
  }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/**
 * Copies the fixture's Emperor Home to `stateRoot` with its path tokens
 * filled in (its own location, and a runtime root that does not exist) and
 * the modes preview.4 gave each file. The modes come from fixture.json's
 * `modes` (octal strings): git keeps only 100644 / 100755, so a checkout's
 * own modes say nothing (FIX-08). A file without a recorded mode is refused.
 * Returns fixture.json.
 */
function prepareUpgradeHome(fixtureRoot, stateRoot) {
  const manifest = JSON.parse(
    readFileSync(join(fixtureRoot, 'fixture.json'), 'utf8'),
  )
  const source = join(fixtureRoot, 'home')
  const runtime = join(dirname(stateRoot), 'preview4-runtime')
  const modes = manifest.modes ?? {}
  for (const file of walk(source)) {
    const name = relative(source, file).split(sep).join('/')
    const mode = /^[0-7]{3}$/.test(modes[name] ?? '')
      ? Number.parseInt(modes[name], 8)
      : null
    if (mode === null)
      throw new Error(
        `upgrade fixture: fixture.json records no mode for ${name}`,
      )
    const target = join(stateRoot, relative(source, file))
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(
      target,
      readFileSync(file, 'utf8')
        .split('__EMPEROR_HOME__')
        .join(stateRoot)
        .split('__PREVIEW4_RUNTIME__')
        .join(runtime),
    )
    chmodSync(target, mode)
  }
  return manifest
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** The upgrade launch read what preview.4 wrote (fixture.json's expect). */
function checkUpgradeReceipt(receipt, manifest) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.scenario !== 'upgrade' ||
    receipt.exitCode !== 0 ||
    !Array.isArray(receipt.sessions)
  )
    throw new Error('packaged upgrade smoke receipt is invalid')
  for (const expected of manifest.expect.sessions) {
    const read = receipt.sessions.find((session) => session.id === expected.id)
    if (!read)
      throw new Error(`session ${expected.id} was not read after the upgrade`)
    if (read.userMessages !== expected.userMessages)
      throw new Error(
        `session ${expected.id}: ${read.userMessages} user messages, expected ${expected.userMessages}`,
      )
    if (read.assistantMessages !== expected.assistantMessages)
      throw new Error(
        `session ${expected.id}: ${read.assistantMessages} assistant messages, expected ${expected.assistantMessages}`,
      )
    if (read.lastAssistantSha256 !== sha256(expected.lastAssistantText))
      throw new Error(
        `session ${expected.id}: its last reply is not the one preview.4 wrote`,
      )
    if (read.rendered !== true)
      throw new Error(`session ${expected.id} was not shown in the window`)
  }
  const active = receipt.model?.active
  if (
    active?.modelId !== manifest.expect.model.modelId ||
    active.displayName !== manifest.expect.model.displayName
  )
    throw new Error(
      `the active model is ${JSON.stringify(active ?? null)}, expected ${JSON.stringify(manifest.expect.model)}`,
    )
  if (!receipt.memory?.lineSha256?.includes(sha256(manifest.expect.memoryLine)))
    throw new Error('the long-term memory lost the line preview.4 wrote')
}

module.exports = {
  NM_EXTENSION_ORIGIN,
  UPGRADE_FIXTURE,
  checkCleanQuit,
  checkUpgradeReceipt,
  decodeNativeMessages,
  defaultNmSocketPath,
  encodeNativeMessage,
  findLaunchServicesLeftovers,
  waitForNoLaunchServicesLeftovers,
  findLeftoverProcesses,
  launchServicesLeftovers,
  nmHostHandshake,
  prepareUpgradeHome,
  waitForNoLeftovers,
}
