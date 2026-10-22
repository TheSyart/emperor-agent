/**
 * `--mode=browser-security` (SEC-10): the Agent browser's data and input
 * safety in real Electron.
 *
 *   1. cookies imported from a (fixture) Chrome profile, through the same
 *      import service and sink main uses, are sealed in
 *      `browser/profiles/<id>/imported-cookies.el1` and never reach the
 *      profile's Chromium `Cookies` database, even after a clean shutdown;
 *      the profile folder is excluded from Time Machine;
 *   2. a fresh launch on that profile is signed in to the imported site;
 *   3. a page that moves the focus into a cross-origin iframe when a field
 *      is focused gets FOCUS_IN_CROSS_ORIGIN_FRAME (typing, filling, keys and
 *      credential fill), the frame's field stays empty and Electron's main
 *      thread keeps running;
 *   4. a finished inbox download carries `com.apple.quarantine`.
 *
 * Cases 1–3 run in their own Electron processes (`--mode=sec10_phase`, see
 * main.ts), spawned with a watchdog: typing into a cross-origin frame hangs
 * Electron's main thread (E-B3), so a missed guard fails the case instead
 * of hanging the suite. Everything lives in a temporary directory; the
 * Chrome profile is a fixture with a made-up Safe Storage password, so no
 * real browser profile and no Keychain item is ever read.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ActHooks,
  DriverObservation,
  TargetSnapshot,
} from '@emperor/core/host-capabilities'
import { localSecretKeyPath } from '@emperor/core/host-capabilities'
import type { UiAction } from '@emperor/core/runtime-contract'
import { session } from 'electron'
import { userDataDir } from '../../../src/main/browser-import/browser-discovery'
import { deriveKey } from '../../../src/main/browser-import/chrome-crypto'
import { importBrowserData } from '../../../src/main/browser-import/import-service'
import { CredentialVault } from '../../../src/main/computer-use/credential-vault'
import { EmbeddedBrowserDriver } from '../../../src/main/computer-use/embedded-browser-driver'
import { electronBrowserFactory } from '../../../src/main/computer-use/electron-factory'
import { nativeImageCodec } from '../../../src/main/computer-use/images'
import {
  IMPORTED_COOKIES_FILE,
  ImportedCookieStore,
} from '../../../src/main/computer-use/imported-cookies'
import { LocalSecretStore } from '../../../src/main/local-secret-store'
import { startFixtureSite, type FixtureSite } from '../fixtures/site'
import type { E2eResult } from './main'

const { DatabaseSync } = process.getBuiltinModule('node:sqlite')

const PROFILE = 'p_5ec10c00c1e5'
const SAFE_STORAGE_PASSWORD = 'sec10-fixture-pass'
const PHASE_TIMEOUT_MS = 90_000
/** Typing that hangs the main thread never answers: give up well before. */
const FOCUS_TIMEOUT_MS = 60_000
const BUDGET = {
  maxElements: 400,
  maxTextBytes: 8_192,
  maxDepth: 8,
  timeoutMs: 3_000,
}

type Summary = Record<string, unknown>

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const signal = (): AbortSignal => new AbortController().signal
const hooks = (): ActHooks & { count: number } => {
  const value = {
    count: 0,
    dispatched() {
      value.count += 1
    },
  }
  return value
}
/** Input that must be refused before any side effect. */
const NEVER_DISPATCH: ActHooks = {
  dispatched() {
    throw new Error('the driver dispatched input it should have refused')
  },
}

// ---------------------------------------------------------------------------
// A fixture Chrome profile (Network/Cookies, schema 24, v10 values)

const CHROME_EPOCH_OFFSET = 11644473600n

function chromeCookie(hostKey: string, value: string): Buffer {
  const key = deriveKey(SAFE_STORAGE_PASSWORD)
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  const plain = Buffer.concat([
    createHash('sha256').update(hostKey).digest(),
    Buffer.from(value, 'utf8'),
  ])
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(plain),
    cipher.final(),
  ])
}

function writeChromeProfile(home: string, value: string): void {
  const network = join(userDataDir('chrome', home), 'Default', 'Network')
  mkdirSync(network, { recursive: true })
  const db = new DatabaseSync(join(network, 'Cookies'))
  db.exec(`CREATE TABLE cookies (
    host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL DEFAULT '',
    encrypted_value BLOB DEFAULT x'', path TEXT NOT NULL,
    expires_utc INTEGER NOT NULL DEFAULT 0, is_secure INTEGER NOT NULL DEFAULT 0,
    is_httponly INTEGER NOT NULL DEFAULT 0, samesite INTEGER NOT NULL DEFAULT -1)`)
  db.exec(`CREATE TABLE meta (key TEXT NOT NULL UNIQUE, value TEXT)`)
  db.prepare(`INSERT INTO meta (key, value) VALUES ('version', '24')`).run()
  const expires =
    (BigInt(Math.floor(Date.now() / 1000) + 86_400) + CHROME_EPOCH_OFFSET) *
    1_000_000n
  const insert = db.prepare(
    `INSERT INTO cookies (host_key, name, value, encrypted_value, path,
       expires_utc, is_secure, is_httponly, samesite)
     VALUES (?, ?, '', ?, '/', ?, 0, ?, 1)`,
  )
  insert.run(
    '127.0.0.1',
    'emperor_session',
    chromeCookie('127.0.0.1', value),
    expires,
    1,
  )
  insert.run(
    '127.0.0.1',
    'emperor_theme',
    chromeCookie('127.0.0.1', 'dark'),
    expires,
    0,
  )
  db.close()
}

/** Every file of a folder whose bytes contain `needle`. */
function filesContaining(directory: string, needle: string): string[] {
  const found: string[] = []
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && readFileSync(path).includes(needle))
        found.push(path.slice(directory.length + 1))
    }
  }
  walk(directory)
  return found
}

/** Rows of the profile's Chromium cookie store with this name. */
function chromiumCookieRows(profileDir: string, name: string): number {
  const path = join(profileDir, 'Cookies')
  if (!existsSync(path)) return 0
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM cookies WHERE name = ?')
      .get(name) as { count: number }
    return Number(row.count)
  } finally {
    db.close()
  }
}

function excludedFromTimeMachine(path: string): boolean {
  try {
    execFileSync(
      '/usr/bin/xattr',
      ['-p', 'com.apple.metadata:com_apple_backup_excludeItem', path],
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Child side (`--mode=sec10_phase`)

async function observe(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
): Promise<DriverObservation> {
  const now = driver.snapshot(target.targetId)!
  return await driver.observe(
    {
      targetId: target.targetId,
      generation: now.generation,
      budget: BUDGET,
      includeText: true,
    },
    signal(),
  )
}

async function observeUntil(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
  name: string,
): Promise<DriverObservation> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const observation = await observe(driver, target)
    if (observation.elements.some((item) => item.name === name))
      return observation
    check(Date.now() < deadline, `element "${name}" never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const refOf = (observation: DriverObservation, name: string): string => {
  const element = observation.elements.find((item) => item.name === name)
  check(element !== undefined, `element "${name}" not observed`)
  return element.ref
}

const valueOf = (observation: DriverObservation, name: string) =>
  observation.elements.find((item) => item.name === name)?.value ?? ''

async function act(
  driver: EmbeddedBrowserDriver,
  target: TargetSnapshot,
  observation: DriverObservation,
  action: UiAction,
  actHooks: ActHooks = hooks(),
) {
  return await driver.act(
    {
      operationId: `op-${Math.random()}`,
      targetId: target.targetId,
      generation: driver.snapshot(target.targetId)!.generation,
      expectedRevision: observation.revision,
      action,
      deadlineMs: 10_000,
    },
    actHooks,
    signal(),
  )
}

/** The code and reason of a refused call ('ok' if it went through). */
async function outcome(
  work: Promise<unknown>,
): Promise<{ code: string; reason?: string; message?: string }> {
  try {
    await work
    return { code: 'ok' }
  } catch (error) {
    const failure = error as { code?: string; reason?: string }
    return {
      code: failure.code ?? 'thrown',
      ...(failure.reason === undefined ? {} : { reason: failure.reason }),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function cookieStore(stateRoot: string): ImportedCookieStore {
  return new ImportedCookieStore({
    profilesRoot: join(stateRoot, 'browser', 'profiles'),
    storage: new LocalSecretStore({ keyPath: localSecretKeyPath(stateRoot) }),
    sessionFromPath: (path) => session.fromPath(path),
  })
}

async function importPhase(env: NodeJS.ProcessEnv): Promise<Summary> {
  const stateRoot = env.SEC10_STATE ?? ''
  const store = cookieStore(stateRoot)
  // What `browserImport.run` in src/main/index.ts does, with a fixture
  // Chrome home and its made-up Safe Storage password.
  const result = await importBrowserData(
    {
      browser: 'chrome',
      profileDir: 'Default',
      passwords: false,
      cookies: true,
      targetProfileId: PROFILE,
    },
    {
      homeDir: env.SEC10_CHROME_HOME ?? '',
      readSafeStoragePassword: async () => SAFE_STORAGE_PASSWORD,
      detect: () => ({ running: false, reason: 'no-lock' }),
      profileExists: (profileId) => profileId === PROFILE,
      cookieSink: (profileId) => store.sinkFor(profileId),
    },
  )
  const profileSession = session.fromPath(
    join(stateRoot, 'browser', 'profiles', PROFILE),
  )
  const inMemory = await profileSession.cookies.get({
    name: 'emperor_session',
  })
  await profileSession.cookies.flushStore()
  await profileSession.flushStorageData()
  return {
    result,
    inMemory: inMemory.map((cookie) => ({
      value: cookie.value,
      session: cookie.session,
      httpOnly: cookie.httpOnly,
    })),
  }
}

async function openPhase(env: NodeJS.ProcessEnv): Promise<Summary> {
  const stateRoot = env.SEC10_STATE ?? ''
  const driver = new EmbeddedBrowserDriver({
    electron: electronBrowserFactory(),
    images: nativeImageCodec,
    platform: 'macos',
    profilesRoot: join(stateRoot, 'browser', 'profiles'),
    profileStorage: cookieStore(stateRoot),
  })
  driver.setNavigationPolicy(() => 'allow')
  try {
    const target = await driver.open(
      {
        profile: { kind: 'persistent', profileId: PROFILE },
        url: `${env.SEC10_ORIGIN}/account`,
        ownerSessionId: 'sec10',
      },
      signal(),
    )
    const observation = await observe(driver, target)
    const tab = driver.manager.get(target.targetId)!
    await tab.session.cookies.flushStore()
    return { text: observation.textExcerpt ?? '' }
  } finally {
    await driver.shutdown()
  }
}

/**
 * Where the focus phase is, on stderr, written synchronously: a crash then
 * still names its last step.
 */
function step(name: string): void {
  writeSync(2, `SEC10-STEP ${name}\n`)
}

async function focusPhase(env: NodeJS.ProcessEnv): Promise<Summary> {
  const origin = env.SEC10_ORIGIN ?? ''
  const root = mkdtempSync(join(tmpdir(), 'emperor-e2e-sec10-vault-'))
  // Main-thread watch: a hang stops this interval (and the watchdog kills us).
  let last = Date.now()
  let maxGapMs = 0
  const ticker = setInterval(() => {
    const now = Date.now()
    maxGapMs = Math.max(maxGapMs, now - last)
    last = now
  }, 20)
  const vault = new CredentialVault({
    path: join(root, 'computer-use', 'vault.json'),
    storage: new LocalSecretStore({
      keyPath: join(root, 'computer-use', 'secrets', 'local.key'),
    }),
  })
  const secret = 'sec10-private-password-5517'
  const handle = vault.save({
    label: 'fixture',
    bindings: [{ kind: 'origin', origin }],
    username: 'alice',
    password: secret,
  })
  const driver = new EmbeddedBrowserDriver({
    electron: electronBrowserFactory(),
    images: nativeImageCodec,
    platform: 'macos',
    credentials: vault,
  })
  driver.setNavigationPolicy(() => 'allow')
  const open = (url: string) =>
    driver.open(
      { profile: { kind: 'temporary' }, url, ownerSessionId: 'sec10' },
      signal(),
    )
  try {
    // At once: every way of typing is refused, nothing reaches the frame.
    step('sync: open')
    const target = await open(`${origin}/focus-steal?mode=sync`)
    step('sync: observe')
    const first = await observeUntil(driver, target, 'Frame note')
    const trap = refOf(first, 'Trap field')
    step('sync: typeText')
    const sync = {
      typeText: await outcome(
        act(
          driver,
          target,
          first,
          { kind: 'typeText', ref: trap, text: 'hello' },
          NEVER_DISPATCH,
        ),
      ),
      fill: await outcome(
        (async () => {
          step('sync: fill')
          const now = await observe(driver, target)
          return await act(
            driver,
            target,
            now,
            { kind: 'fill', ref: refOf(now, 'Trap field'), text: 'hello' },
            NEVER_DISPATCH,
          )
        })(),
      ),
      press: await outcome(
        (async () => {
          step('sync: press')
          const now = await observe(driver, target)
          return await act(
            driver,
            target,
            now,
            { kind: 'press', ref: refOf(now, 'Trap field'), key: 'a' },
            NEVER_DISPATCH,
          )
        })(),
      ),
      credential: await outcome(
        (async () => {
          step('sync: credential')
          const now = await observe(driver, target)
          return await driver.fillCredential(
            {
              operationId: 'sec10-credential',
              targetId: target.targetId,
              generation: driver.snapshot(target.targetId)!.generation,
              expectedRevision: now.revision,
              ref: refOf(now, 'Trap password'),
              handleId: handle.handleId,
              field: 'password',
              origin,
            },
            NEVER_DISPATCH,
            signal(),
          )
        })(),
      ),
      // Keys without a ref while the focus is in the frame.
      unfocused: await outcome(
        act(
          driver,
          target,
          await (step('sync: unfocused'), observe(driver, target)),
          { kind: 'typeText', text: 'hello' },
          NEVER_DISPATCH,
        ),
      ),
    }
    const afterSync = await observe(driver, target)
    // A field the page leaves alone still types (the guard is not a wall).
    const plain = refOf(afterSync, 'Plain field')
    step('control: fill')
    const control = await outcome(
      act(driver, target, afterSync, { kind: 'fill', ref: plain, text: 'ok' }),
    )
    const afterControl = await observe(driver, target)

    // On the next task: either refused, or the fence kept the frame from
    // taking the focus and the text went into the field.
    step('async: open')
    const later = await open(`${origin}/focus-steal?mode=async`)
    const second = await observeUntil(driver, later, 'Frame note')
    step('async: typeText')
    const asyncOutcome = await outcome(
      act(driver, later, second, {
        kind: 'typeText',
        ref: refOf(second, 'Trap field'),
        text: 'hello',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterAsync = await observe(driver, later)
    // The fence is lifted afterwards (read in the page; test only). A click
    // into this frame is not tried: its script focuses its field on window
    // focus, and a click there crashes Electron's offscreen view whatever
    // the driver does (found here, not part of SEC-10).
    step('async: fence')
    const fenced = await driver.manager
      .get(later.targetId)!
      .contents.executeJavaScript(
        "document.getElementById('other').hasAttribute('inert')",
      )
    return {
      sync,
      syncFrameNote: valueOf(afterSync, 'Frame note'),
      syncTrap: valueOf(afterSync, 'Trap field'),
      secretSeen: JSON.stringify(afterSync).includes(secret),
      control,
      controlValue: valueOf(afterControl, 'Plain field'),
      async: asyncOutcome,
      asyncTrap: valueOf(afterAsync, 'Trap field'),
      asyncFrameNote: valueOf(afterAsync, 'Frame note'),
      fenced,
      maxGapMs,
    }
  } catch (error) {
    // Said before the tabs close, in case closing them takes the process.
    step(
      `failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    )
    throw error
  } finally {
    clearInterval(ticker)
    await driver.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
}

export async function runSec10Phase(): Promise<void> {
  const env = process.env
  const phase = env.SEC10_PHASE
  const output =
    phase === 'import'
      ? await importPhase(env)
      : phase === 'open'
        ? await openPhase(env)
        : phase === 'focus'
          ? await focusPhase(env)
          : null
  check(output !== null, `unknown SEC-10 phase ${String(phase)}`)
  process.stdout.write(`E2E-PHASE ${JSON.stringify(output)}\n`)
}

// ---------------------------------------------------------------------------
// Parent side

function runPhase(
  phase: 'import' | 'open' | 'focus',
  env: Record<string, string>,
  timeoutMs = PHASE_TIMEOUT_MS,
): Promise<Summary> {
  return new Promise((resolvePhase, reject) => {
    const childEnv: Record<string, string> = {}
    for (const [key, item] of Object.entries(process.env))
      if (item !== undefined) childEnv[key] = item
    delete childEnv.ELECTRON_RUN_AS_NODE
    Object.assign(childEnv, env, { SEC10_PHASE: phase })
    // This bundle (out-e2e/harness.cjs) in a new Electron process.
    const child = spawn(process.execPath, [__filename, '--mode=sec10_phase'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('exit', (code, exitSignal) => {
      clearTimeout(timer)
      const line = stdout
        .split('\n')
        .find((item) => item.startsWith('E2E-PHASE '))
      if (code === 0 && line !== undefined) {
        resolvePhase(JSON.parse(line.slice('E2E-PHASE '.length)) as Summary)
        return
      }
      const noise =
        /task_policy_set|Failed to load URL: devtools|ApplePersistenceIgnoreState/
      const tail = [
        ...stdout.split('\n').filter((item) => item.startsWith('E2E-PHASE')),
        ...stderr.split('\n').filter((item) => item && !noise.test(item)),
      ]
        .join('\n')
        .slice(-1500)
      reject(
        new Error(
          killed
            ? `${phase} phase did not answer within ${timeoutMs / 1000} s (Electron's main thread blocked?)`
            : `${phase} phase exited ${code ?? exitSignal}${line === undefined ? ' without a result' : ''}: ${tail}`,
        ),
      )
    })
  })
}

interface Context {
  readonly site: FixtureSite
  readonly dir: string
  readonly stateRoot: string
  readonly profileDir: string
  readonly value: string
  readonly env: Record<string, string>
}

const CASES: Record<string, (context: Context) => Promise<unknown>> = {
  '1: imported cookies are sealed in imported-cookies.el1, never in Chromium’s Cookies':
    async ({ env, profileDir, value }) => {
      const phase = await runPhase('import', env)
      const result = phase.result as { ok?: boolean; sites?: number }
      check(
        result.ok === true && result.sites === 1,
        `import result ${JSON.stringify(result)}`,
      )
      const inMemory = phase.inMemory as Array<{
        value: string
        session: boolean
        httpOnly: boolean
      }>
      check(
        inMemory.length === 1 &&
          inMemory[0]!.value === value &&
          inMemory[0]!.session &&
          inMemory[0]!.httpOnly,
        `the profile session holds ${JSON.stringify(inMemory.map((item) => ({ ...item, value: item.value === value ? '<imported>' : item.value })))}`,
      )
      // After a clean shutdown Chromium has written everything it keeps.
      const sealed = join(profileDir, IMPORTED_COOKIES_FILE)
      check(existsSync(sealed), `${IMPORTED_COOKIES_FILE} is missing`)
      const bytes = readFileSync(sealed)
      check(
        bytes.subarray(0, 3).toString('ascii') === 'el1',
        'the imported cookies are not an el1 envelope',
      )
      check(
        (statSync(sealed).mode & 0o777) === 0o600,
        `${IMPORTED_COOKIES_FILE} mode ${(statSync(sealed).mode & 0o777).toString(8)}`,
      )
      const leaked = filesContaining(profileDir, value)
      check(
        leaked.length === 0,
        `the imported cookie value is on disk in ${leaked.join(', ')}`,
      )
      const rows = chromiumCookieRows(profileDir, 'emperor_session')
      check(rows === 0, `Chromium's Cookies holds ${rows} imported row(s)`)
      check(
        excludedFromTimeMachine(profileDir),
        'the profile folder is not excluded from Time Machine',
      )
      return {
        sites: result.sites,
        sealed: IMPORTED_COOKIES_FILE,
        chromiumRows: rows,
        plaintextFiles: leaked.length,
        timeMachineExcluded: true,
      }
    },
  '2: a fresh launch on the profile is signed in to the imported site': async ({
    env,
    profileDir,
    value,
  }) => {
    const phase = await runPhase('open', env)
    const text = String(phase.text)
    check(
      text.includes(`Signed in as ${value}`),
      `the site sees ${JSON.stringify(text.replace(value, '<imported>').slice(0, 200))}`,
    )
    // Browsing with it did not write it to disk either.
    const leaked = filesContaining(profileDir, value)
    check(
      leaked.length === 0,
      `after browsing, the value is on disk in ${leaked.join(', ')}`,
    )
    check(
      chromiumCookieRows(profileDir, 'emperor_session') === 0,
      'after browsing, Chromium stored the imported cookie',
    )
    return { signedIn: true, plaintextFiles: 0 }
  },
  '3: focus moved into a cross-origin iframe: FOCUS_IN_CROSS_ORIGIN_FRAME, main thread keeps running':
    async ({ env }) => {
      const phase = await runPhase('focus', env, FOCUS_TIMEOUT_MS)
      const sync = phase.sync as Record<
        string,
        { code: string; reason?: string; message?: string }
      >
      for (const [name, result] of Object.entries(sync))
        check(
          result.code === 'CAPABILITY_DISABLED' &&
            result.reason === 'FOCUS_IN_CROSS_ORIGIN_FRAME',
          `${name}: ${JSON.stringify(result)}`,
        )
      check(
        phase.syncFrameNote === '' && phase.syncTrap === '',
        `refused input still landed: frame ${JSON.stringify(phase.syncFrameNote)}, field ${JSON.stringify(phase.syncTrap)}`,
      )
      check(phase.secretSeen === false, 'the credential leaked')
      check(
        (phase.control as { code: string }).code === 'ok' &&
          phase.controlValue === 'ok',
        `a plain field no longer types: ${JSON.stringify(phase.control)} ${String(phase.controlValue)}`,
      )
      const later = phase.async as { code: string; reason?: string }
      check(
        (later.code === 'CAPABILITY_DISABLED' &&
          later.reason === 'FOCUS_IN_CROSS_ORIGIN_FRAME' &&
          phase.asyncTrap === '') ||
          (later.code === 'ok' && phase.asyncTrap === 'hello'),
        `on the next task: ${JSON.stringify(later)}, field ${JSON.stringify(phase.asyncTrap)}`,
      )
      check(
        phase.asyncFrameNote === '',
        `the frame's field changed to ${JSON.stringify(phase.asyncFrameNote)}`,
      )
      check(phase.fenced === false, 'the frame stayed fenced (inert)')
      const gap = Number(phase.maxGapMs)
      check(gap < 1_500, `the main thread stalled for ${gap} ms`)
      return {
        refused: Object.fromEntries(
          Object.entries(sync).map(([name, result]) => [name, result.reason]),
        ),
        async: later.code === 'ok' ? 'typed into the field' : later.reason,
        maxMainThreadGapMs: gap,
      }
    },
  '4: a finished inbox download carries com.apple.quarantine': async ({
    site,
    dir,
  }) => {
    const downloads = join(dir, 'downloads')
    const driver = new EmbeddedBrowserDriver({
      electron: electronBrowserFactory(),
      images: nativeImageCodec,
      platform: 'macos',
      downloadsRoot: downloads,
    })
    driver.setNavigationPolicy(() => 'allow')
    try {
      const target = await driver.open(
        {
          profile: { kind: 'temporary' },
          url: `${site.origin}/files`,
          ownerSessionId: 'sec10',
        },
        signal(),
      )
      const observation = await observe(driver, target)
      const record = await driver.download(
        {
          operationId: 'sec10-download',
          targetId: target.targetId,
          generation: observation.generation,
          expectedRevision: observation.revision,
          ref: refOf(observation, 'Download report'),
          taskId: 'sec10',
          maxBytes: 1_000_000,
          timeoutMs: 10_000,
        },
        hooks(),
        signal(),
      )
      check(record.state === 'completed', `download ${record.state}`)
      const path = driver.downloads!.pathOf(record.downloadId)!
      const mark = execFileSync(
        '/usr/bin/xattr',
        ['-p', 'com.apple.quarantine', path],
        { encoding: 'utf8' },
      ).trim()
      check(
        /^0083;[0-9a-f]+;Emperor Agent;$/.test(mark),
        `quarantine mark ${JSON.stringify(mark)}`,
      )
      check(
        driver.downloads!.list()[0]?.unmarked === undefined,
        'the inbox says the file is unmarked',
      )
      return { file: record.filename, quarantine: mark.split(';')[0] }
    } finally {
      await driver.shutdown()
    }
  },
}

export async function runBrowserSecurity(
  report: (result: E2eResult) => void,
): Promise<void> {
  const site = await startFixtureSite()
  const dir = mkdtempSync(join(tmpdir(), 'emperor-e2e-sec10-'))
  const stateRoot = join(dir, 'home')
  const chromeHome = join(dir, 'chrome-home')
  const value = `alice-${randomBytes(6).toString('hex')}`
  writeChromeProfile(chromeHome, value)
  const context: Context = {
    site,
    dir,
    stateRoot,
    profileDir: join(stateRoot, 'browser', 'profiles', PROFILE),
    value,
    env: {
      SEC10_STATE: stateRoot,
      SEC10_CHROME_HOME: chromeHome,
      SEC10_ORIGIN: site.origin,
      SEC10_USER_DATA: join(dir, 'user-data'),
    },
  }
  try {
    for (const [name, run] of Object.entries(CASES)) {
      const started = Date.now()
      try {
        const detail = await run(context)
        report({
          suite: 'browser-security',
          name,
          ok: true,
          ms: Date.now() - started,
          ...(detail === undefined ? {} : { detail }),
        })
      } catch (error) {
        report({
          suite: 'browser-security',
          name,
          ok: false,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
