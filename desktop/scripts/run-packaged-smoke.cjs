#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const {
  packagedFuses,
  readPackagedFuses,
  verifyMacHardening,
} = require('./harden-package.cjs')
const { readGitCommit } = require('./build-commit.cjs')
const { checkStartupLog } = require('./packaged-log-check.cjs')
const {
  UPGRADE_FIXTURE,
  checkCleanQuit,
  checkUpgradeReceipt,
  launchServicesLeftovers,
  nmHostHandshake,
  prepareUpgradeHome,
  waitForNoLeftovers,
} = require('./packaged-smoke-extras.cjs')

const desktopRoot = resolve(__dirname, '..')
const repoRoot = resolve(desktopRoot, '..')
const appPath = resolveAppPath(process.argv.slice(2))
// Not the real path: macOS sockets allow 104 bytes, and the helper socket
// under this folder (or under TMPDIR, which is this folder) fits only with
// the shorter /var/folders form. The leftover check uses both forms.
const tempRoot = mkdtempSync(join(tmpdir(), 'emperor-packaged-smoke-'))
const stateRoot = join(tempRoot, 'state')
const homeRoot = join(tempRoot, 'home')
const emptyBin = join(tempRoot, 'empty-bin')
const appDataRoot = join(homeRoot, 'AppData', 'Roaming')
const localAppDataRoot = join(homeRoot, 'AppData', 'Local')
const receiptPath = join(tempRoot, 'receipt.json')
// REL-04: the second launch, on a copy of a 0.1.0-preview.4 Emperor Home.
// No longer than `state`: the helper socket path limit above.
const upgradeStateRoot = join(tempRoot, 'up')
const upgradeReceiptPath = join(tempRoot, 'upgrade-receipt.json')
mkdirSync(stateRoot, { recursive: true })
mkdirSync(homeRoot, { recursive: true })
mkdirSync(emptyBin, { recursive: true })
mkdirSync(appDataRoot, { recursive: true })
mkdirSync(localAppDataRoot, { recursive: true })

const args = [
  '--emperor-packaged-smoke',
  '--emperor-smoke-receipt',
  receiptPath,
]
if (process.platform === 'linux') {
  args.unshift('--headless', '--disable-gpu', '--ozone-platform=headless')
  args.unshift('--no-sandbox')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(`smoke workspace retained for inspection: ${tempRoot}`)
  process.exitCode = 1
})

async function main() {
  // SEC-04: the package itself first. Unsigned is not unsealed: the seal,
  // the hardened runtime and the fuses must all be in place.
  const seal = await verifyPackage(appPath)
  // REL-04: the Native Messaging host answers Chrome's framing under the
  // hardened runtime. CI runs no Emperor, so there the handshake may not skip.
  const nmHost =
    process.platform === 'darwin'
      ? await nmHostHandshake(
          join(
            bundlePath(appPath),
            'Contents',
            'Library',
            'Helpers',
            'emperor-nm-host',
          ),
          { required: process.env.CI === 'true' },
        )
      : { ok: true, skipped: 'not macOS' }
  // A packaged app must not load the page ELECTRON_RENDERER_URL names; this
  // server stands in for it and must see no request.
  const decoy = await startDecoyRenderer()
  let result
  let upgradeResult
  let upgradeManifest
  try {
    result = await run(
      appPath,
      args,
      smokeEnvironment({ ELECTRON_RENDERER_URL: decoy.url }),
    )
    if (result.code === 0) {
      upgradeManifest = prepareUpgradeHome(UPGRADE_FIXTURE, upgradeStateRoot)
      upgradeResult = await run(
        appPath,
        [
          ...args.map((arg) =>
            arg === receiptPath ? upgradeReceiptPath : arg,
          ),
          '--emperor-smoke-scenario',
          'upgrade',
        ],
        smokeEnvironment(
          { ELECTRON_RENDERER_URL: decoy.url },
          upgradeStateRoot,
        ),
      )
    }
  } finally {
    await decoy.close()
  }
  const { code, stdout, stderr } = result
  if (code !== 0)
    throw new Error(
      `packaged smoke exited ${code}\n${bounded(stderr || stdout)}`,
    )
  if (decoy.requests() !== 0)
    throw new Error(
      `packaged app requested ELECTRON_RENDERER_URL ${decoy.requests()} time(s)`,
    )
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  validateReceipt(receipt)
  receipt.package = seal
  receipt.nmHost = nmHost
  // REL-01: the packaged app wrote its startup record to main.log.
  const log = checkStartupLog(stateRoot)
  receipt.mainLog = { bytes: log.bytes, startLine: log.startLine }
  // REL-04: it left the way Cmd+Q does, and nothing of it kept running.
  const quit = { fresh: checkCleanQuit(stateRoot).quitLine }
  await assertNothingLeftRunning()

  // REL-04: the same build on a 0.1.0-preview.4 Emperor Home.
  if (upgradeResult.code !== 0)
    throw new Error(
      `packaged smoke on the 0.1.0-preview.4 home exited ${upgradeResult.code}\n${bounded(upgradeResult.stderr || upgradeResult.stdout)}`,
    )
  const upgrade = JSON.parse(readFileSync(upgradeReceiptPath, 'utf8'))
  checkUpgradeReceipt(upgrade, upgradeManifest)
  checkStartupLog(upgradeStateRoot)
  quit.upgrade = checkCleanQuit(upgradeStateRoot).quitLine
  await assertNothingLeftRunning()
  // SEC-04/REL-04: the helper copies this smoke launched left LaunchServices.
  const registered = launchServicesLeftovers([
    `${tempRoot}/`,
    `${realpathSync(tempRoot)}/`,
  ])
  if (registered.length)
    throw new Error(
      `helper copies still registered with LaunchServices:\n${registered.join('\n')}`,
    )
  receipt.quit = quit
  receipt.upgrade = {
    fromVersion: upgradeManifest.appVersion,
    sessions: upgrade.sessions,
    model: upgrade.model,
    memoryLineKept: true,
  }
  if (JSON.stringify(receipt).includes(tempRoot))
    throw new Error('packaged smoke receipt contains private host paths')
  const outputDir = join(desktopRoot, 'dist', 'packaged-smoke')
  const outputPath = join(outputDir, `${receipt.platform}-${receipt.arch}.json`)
  mkdirSync(outputDir, { recursive: true })
  writeAtomic(outputPath, receipt)
  console.log(`packaged smoke passed: ${outputPath}`)
  rmSync(tempRoot, { recursive: true, force: true })
}

/**
 * macOS: codesign --verify --deep --strict, identifier, hardened runtime and
 * entitlements of every piece of Emperor's code, and the fuses. Elsewhere:
 * the fuses of the executable.
 */
async function verifyPackage(executable) {
  if (process.platform === 'darwin') {
    const app = resolve(executable, '..', '..', '..')
    if (!app.endsWith('.app'))
      throw new Error(`packaged executable is not inside an app: ${executable}`)
    return await verifyMacHardening(app)
  }
  const fuses = await readPackagedFuses(executable)
  const expected = packagedFuses(process.platform)
  const wrong = Object.keys(expected).filter(
    (name) => fuses[name] !== expected[name],
  )
  if (wrong.length)
    throw new Error(`packaged app fuses are wrong: ${wrong.join(', ')}`)
  return { fuses }
}

/** The .app around a packaged executable (macOS), else its folder. */
function bundlePath(executable) {
  return process.platform === 'darwin'
    ? resolve(executable, '..', '..', '..')
    : resolve(executable, '..')
}

/** No process of the app bundle or of the smoke folder outlives the app. */
async function assertNothingLeftRunning() {
  const left = await waitForNoLeftovers([
    `${bundlePath(appPath)}/`,
    `${tempRoot}/`,
    `${realpathSync(tempRoot)}/`,
  ])
  if (left.length)
    throw new Error(
      `processes still running after the packaged app quit:\n${left.join('\n')}`,
    )
}

function startDecoyRenderer() {
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>decoy</title>')
  })
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolvePromise({
        url: `http://127.0.0.1:${port}/`,
        requests: () => requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

function resolveAppPath(argv) {
  const explicitIndex = argv.indexOf('--app')
  const explicit =
    explicitIndex >= 0 ? String(argv[explicitIndex + 1] || '').trim() : ''
  if (explicit) {
    const value = resolve(explicit)
    if (!existsSync(value)) throw new Error(`packaged app not found: ${value}`)
    return value
  }
  const envPath = String(process.env.EMPEROR_SMOKE_APP || '').trim()
  if (envPath) return resolveAppPath(['--app', envPath])

  const distRoot = join(desktopRoot, 'dist')
  let candidates = []
  if (process.platform === 'darwin') {
    candidates = readdirSync(distRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
      .map((entry) =>
        join(
          distRoot,
          entry.name,
          'Emperor Agent.app',
          'Contents',
          'MacOS',
          'Emperor Agent',
        ),
      )
  } else if (process.platform === 'win32') {
    candidates = [join(distRoot, 'win-unpacked', 'Emperor Agent.exe')]
  } else {
    candidates = [join(distRoot, 'linux-unpacked', 'emperor-agent')]
  }
  const existing = candidates.filter(existsSync)
  if (existing.length !== 1)
    throw new Error(
      `expected exactly one unpacked app for ${process.platform}/${process.arch}; found ${existing.length}`,
    )
  return existing[0]
}

function smokeEnvironment(extra = {}, root = stateRoot) {
  const env = {
    ...extra,
    // A synthetic HOME on every platform, macOS included: Emperor's secrets
    // use its own key under the state root, so nothing may need the user's
    // login Keychain (the app's local-key and master-password round trip
    // fails the smoke if something does).
    HOME: homeRoot,
    // macOS: NSHomeDirectory too (AppKit saved state, caches), not only $HOME.
    ...(process.platform === 'darwin' ? { CFFIXED_USER_HOME: homeRoot } : {}),
    USERPROFILE: homeRoot,
    EMPEROR_CONFIG_DIR: root,
    // The packaged app checks every model request against its log (KRN-13).
    EMPEROR_ASSERT_INVARIANT: '1',
    EMPEROR_BUILD_COMMIT: readGitCommit(repoRoot),
    EMPEROR_SMOKE_NODE: process.execPath,
    EMPEROR_SMOKE_NPM_CLI: process.env.npm_execpath || '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    APPDATA: join(homeRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(homeRoot, 'AppData', 'Local'),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    ...(process.env.APPIMAGE_EXTRACT_AND_RUN === '1'
      ? { APPIMAGE_EXTRACT_AND_RUN: '1' }
      : {}),
    PATH: emptyBin,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
  for (const name of ['COMSPEC', 'PROGRAMDATA', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function run(executable, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: tempRoot,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) =>
      bounded(current + Buffer.from(chunk).toString('utf8'))
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
    const timeoutMs = Math.min(
      180_000,
      Math.max(5_000, Number(process.env.EMPEROR_SMOKE_TIMEOUT_MS) || 60_000),
    )
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `packaged smoke timed out after ${Math.ceil(timeoutMs / 1000)} seconds\n${bounded(stderr || stdout)}`,
        ),
      )
    }, timeoutMs)
    timer.unref()
  })
}

function validateReceipt(receipt) {
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.exitCode !== 0 ||
    receipt.stateRoot !== '$TEMP/stateRoot' ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeManifestHash || '') ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeRevision || '') ||
    receipt.installJobs?.before !== 0 ||
    receipt.installJobs?.after !== 0
  )
    throw new Error('packaged smoke receipt is invalid')
  for (const name of [
    'bootstrap',
    'diagnostics',
    'environment',
    'glob',
    'grep',
    'terminal',
    'seatbelt',
    'renderer',
    'windows',
  ]) {
    if (receipt.operations?.[name]?.ok !== true)
      throw new Error(`packaged smoke operation failed: ${name}`)
  }
  if (
    receipt.platform === 'darwin' &&
    (receipt.operations.helpers?.ok !== true ||
      receipt.operations.helpers.computerUse?.handshake !== true ||
      receipt.operations.helpers.computerUse?.hardenedCopy !== true ||
      receipt.operations.helpers.dictation?.available !== true)
  )
    throw new Error('packaged macOS helpers did not answer (SEC-04)')
  if (
    receipt.platform === 'darwin' &&
    (receipt.operations.seatbelt.mode !== 'workspace-write' ||
      receipt.operations.seatbelt.commands < 18 ||
      receipt.operations.seatbelt.protectedStateDenied !== true)
  )
    throw new Error('packaged macOS Seatbelt command matrix is invalid')
  const renderer = receipt.operations.renderer
  if (
    renderer.nodeGlobalsAbsent !== true ||
    renderer.coreBridge !== true ||
    renderer.coreBootstrap !== true ||
    // REL-05: the renderer read the app's own version from main.
    renderer.appVersion !== receipt.appVersion ||
    renderer.deepLinkRenders !== true ||
    renderer.attachment?.ok !== true ||
    !Number.isSafeInteger(renderer.attachment?.bytes) ||
    renderer.attachment.bytes <= 0 ||
    renderer.webPreferences?.sandbox !== true ||
    renderer.webPreferences?.contextIsolation !== true ||
    renderer.webPreferences?.nodeIntegration !== false ||
    renderer.security?.rendererUrlPinned !== true ||
    renderer.security?.protocolTraversalRefused !== true ||
    !['enabled', 'disabled-for-linux-test'].includes(
      renderer.chromiumSandbox,
    ) ||
    (renderer.chromiumSandbox === 'disabled-for-linux-test' &&
      receipt.platform !== 'linux')
  )
    throw new Error('packaged renderer sandbox receipt is invalid')
  const body = JSON.stringify(receipt)
  if (
    body.includes(tempRoot) ||
    body.includes(homeRoot) ||
    body.includes(process.env.HOME || '__no_home__') ||
    body.includes(process.env.PATH || '__no_path__')
  )
    throw new Error('packaged smoke receipt contains private host paths')
}

function writeAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function bounded(value) {
  const max = 1024 * 1024
  return value.length <= max ? value : value.slice(value.length - max)
}
