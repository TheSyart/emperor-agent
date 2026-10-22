/**
 * REL-01 acceptance in the real desktop app (dev build, isolated Emperor
 * Home). With EMPEROR_CONFIG_DIR set, logs and Crashpad live in
 * `<home>/logs`, so nothing here touches ~/Library/Logs.
 *
 * Launch 1 (a working home):
 * - main.log carries the startup record; core.log carries Core's own
 *   warning (a broken mcp_config.json);
 * - an sk- key and a URL token reach main.log only as sk-*** / ***;
 * - an uncaught exception and an unhandled rejection in main are logged
 *   and the app keeps answering;
 * - a crashed renderer leaves a minidump in <home>/logs/Crashpad and a
 *   「renderer process gone」 line;
 * - 设置 › 高级 › 诊断 › 导出诊断包 lists the contents, exports a zip whose
 *   files are exactly that list, and the zip holds neither the model key
 *   nor a session title.
 * Launch 2 (installation.json broken): the recovery page; main.log has the
 * full cause with its stack; 打开日志 opens main.log; 导出诊断包 works there.
 * REL-03 (data versions, 备份与恢复), on homes of their own:
 * - Launch 3: 设置 › 高级 › 存储 › 导出备份 writes a zip with the memory and
 *   without the vault, the local key or a plain model key;
 * - Launch 4: 从备份恢复 of that zip into another home schedules the
 *   restore and asks to restart; launch 5 applies it at startup, the data
 *   it replaced is in migrations/backup-<ts>, and a notice says so;
 * - Launch 6: a home a newer Emperor (99.0.0) ran last: the startup
 *   banner; its settings.json stays byte for byte and 存储 names it.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=diagnostics   (after `npm run build`)
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { startFakeModel, type FakeModel } from '../fullstack/fake-model'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'diagnostics')
const SUITE = 'diagnostics'
const SESSION_MARKER = 'REL01-e2e-session-7c1d'

interface Result {
  suite: string
  name: string
  ok: boolean
  ms: number
  detail?: unknown
  error?: string
}

const results: Result[] = []

function report(result: Result): void {
  results.push(result)
  process.stdout.write(`E2E-RESULT ${JSON.stringify(result)}\n`)
}

class Abort extends Error {}

async function check<T>(
  page: Page,
  name: string,
  body: () => Promise<T>,
  options: { critical?: boolean } = {},
): Promise<void> {
  const started = Date.now()
  try {
    const detail = await body()
    report({
      suite: SUITE,
      name,
      ok: true,
      ms: Date.now() - started,
      ...(detail === undefined ? {} : { detail }),
    })
  } catch (error) {
    report({
      suite: SUITE,
      name,
      ok: false,
      ms: Date.now() - started,
      error:
        error instanceof Error
          ? error.message.split('\n').slice(0, 6).join(' ')
          : String(error),
    })
    await page
      .screenshot({
        path: join(shots, `fail-${name.replace(/[^\w-]+/g, '_')}.png`),
      })
      .catch(() => undefined)
    if (options.critical) throw new Abort(name)
  }
}

function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, reject) => {
    const tick = async (): Promise<void> => {
      try {
        if (await predicate()) return resolvePromise()
      } catch {
        // retry until the deadline
      }
      if (Date.now() > deadline)
        return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(() => void tick(), 150)
    }
    void tick()
  })
}

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

/** `unzip -Z1`: file entries of the zip, without its top folder. */
function zipFiles(zip: string): string[] {
  return execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.endsWith('/'))
    .map((line) => line.slice(line.indexOf('/') + 1))
    .sort()
}

/** Every text in the extracted zip that contains one of `needles`. */
function scanZip(zip: string, needles: readonly string[]): string[] {
  const out = mkdtempSync(join(tmpdir(), 'emperor-e2e-bundle-'))
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out])
    const hits: string[] = []
    for (const file of filesUnder(out)) {
      const text = readFileSync(file, 'utf8')
      for (const needle of needles)
        if (text.includes(needle))
          hits.push(`${relative(out, file)}: ${needle}`)
    }
    return hits
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-diagnostics',
      models: [
        {
          entryId: 'fake-diagnostics',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'fake-diagnostics',
          displayName: 'Fake Diagnostics',
          apiBase: model.apiBase,
          apiKey: 'sk-fake-rel01-e2e-key',
          contextWindowTokens: 128_000,
          maxTokens: 4096,
          reasoningEffort: null,
        },
      ],
    }),
    { mode: 0o600 },
  )
  // Core isolates a broken MCP config and says so through its logger.
  writeFileSync(join(home, 'mcp_config.json'), '{"mcpServers": {', {
    mode: 0o600,
  })
}

async function launch(
  home: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value
  delete env.ELECTRON_RUN_AS_NODE
  env.EMPEROR_CONFIG_DIR = home
  const app = await _electron.launch({
    args: ['.'],
    cwd: desktop,
    env,
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  await page
    .setViewportSize({ width: 1440, height: 900 })
    .catch(() => undefined)
  return { app, page }
}

/** Answer the next save dialog with `target`. */
async function answerSaveDialog(
  app: ElectronApplication,
  target: string,
): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: chosen,
    })) as unknown as typeof dialog.showSaveDialog
  }, target)
}

// ---------------------------------------------------------------------------

async function workingApp(
  app: ElectronApplication,
  page: Page,
  home: string,
  out: string,
): Promise<void> {
  const logs = join(home, 'logs')
  const mainLog = join(logs, 'main.log')

  await check(
    page,
    'main.log has the startup record, in the overridden log folder',
    async () => {
      await page.locator('.app-frame').waitFor({ timeout: 60_000 })
      await until(
        () => /\[info\] Emperor Agent \S+ starting/.test(read(mainLog)),
        10_000,
        'the startup record',
      )
      const start = read(mainLog)
        .split('\n')
        .find((line) => / starting/.test(line))
      return { mainLog: relative(home, mainLog), start }
    },
    { critical: true },
  )

  await check(page, "core.log carries Core's own logger output", async () => {
    const coreLog = join(logs, 'core.log')
    await until(
      () => read(coreLog).includes('Invalid MCP config isolated'),
      15_000,
      "Core's warning in core.log",
    )
    if (read(mainLog).includes('Invalid MCP config isolated'))
      throw new Error('the Core warning went to main.log as well')
    return {
      line: read(coreLog)
        .split('\n')
        .find((line) => line.includes('Invalid MCP config')),
    }
  })

  await check(
    page,
    'sk- keys and URL tokens reach main.log redacted',
    async () => {
      await app.evaluate(() => {
        console.warn(
          'REL01 probe sk-rel01e2eSECRET123 https://x.example/v1?token=rel01tok&model=m',
        )
      })
      await until(
        () => read(mainLog).includes('REL01 probe'),
        5_000,
        'the probe line',
      )
      const line = read(mainLog)
        .split('\n')
        .find((entry) => entry.includes('REL01 probe'))!
      if (/rel01e2eSECRET123|rel01tok/.test(read(mainLog)))
        throw new Error(`secret in main.log: ${line}`)
      if (!line.includes('sk-***') || !line.includes('token=***'))
        throw new Error(`not redacted as expected: ${line}`)
      return { line }
    },
  )

  await check(
    page,
    'an uncaught exception and a rejection in main are logged; the app keeps running',
    async () => {
      const pid = await app.evaluate(() => {
        setTimeout(() => {
          throw new Error('REL01 e2e uncaught')
        }, 10)
        void Promise.reject(new Error('REL01 e2e rejection'))
        return process.pid
      })
      await until(
        () =>
          read(mainLog).includes('REL01 e2e uncaught') &&
          read(mainLog).includes('REL01 e2e rejection'),
        5_000,
        'both errors in main.log',
      )
      await new Promise((done) => setTimeout(done, 500))
      const after = await app.evaluate(({ BrowserWindow }) => ({
        pid: process.pid,
        windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
          .length,
      }))
      if (after.pid !== pid) throw new Error('main restarted')
      if (after.windows < 1) throw new Error('no window left')
      await page.locator('.app-frame').waitFor({ timeout: 5_000 })
      const text = read(mainLog)
      return {
        uncaught: text.includes('uncaught exception (main keeps running)'),
        rejection: text.includes('unhandled rejection (main keeps running)'),
        windows: after.windows,
      }
    },
  )

  await check(page, 'a crashed renderer leaves a minidump', async () => {
    const crashpad = join(logs, 'Crashpad')
    const before = filesUnder(crashpad).filter((file) => file.endsWith('.dmp'))
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = new BrowserWindow({ show: false })
      await win.loadURL('about:blank')
      win.webContents.forcefullyCrashRenderer()
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy()
      }, 3_000)
    })
    await until(
      () =>
        filesUnder(crashpad).filter((file) => file.endsWith('.dmp')).length >
        before.length,
      20_000,
      'a new .dmp in <home>/logs/Crashpad',
    )
    await until(
      () => read(mainLog).includes('renderer process gone'),
      5_000,
      'the render-process-gone line',
    )
    const fresh = filesUnder(crashpad).filter(
      (file) => file.endsWith('.dmp') && !before.includes(file),
    )
    // A minidump, not an empty marker: it starts with the MDMP signature.
    await until(
      () =>
        fresh.length > 0 &&
        readFileSync(fresh[0]!).subarray(0, 4).toString('latin1') === 'MDMP',
      10_000,
      'the MDMP signature',
    )
    const dumps = fresh.map((file) => relative(home, file))
    return {
      dumps,
      bytes: readFileSync(fresh[0]!).length,
      line: read(mainLog)
        .split('\n')
        .find((entry) => entry.includes('renderer process gone')),
    }
  })

  await check(
    page,
    '设置 › 诊断 lists the bundle, exports exactly that list, with no key or session text',
    async () => {
      // A session whose title must not reach the bundle.
      await page.evaluate(
        async (title) =>
          await (
            window as unknown as {
              emperor: {
                invokeCore(key: string, input: unknown): Promise<unknown>
              }
            }
          ).emperor.invokeCore('sessions.create', { title }),
        SESSION_MARKER,
      )
      const settings = page.getByRole('dialog', { name: '设置' })
      if (!(await settings.isVisible()))
        await page
          .getByRole('button', { name: '设置', exact: true })
          .first()
          .click()
      await settings.waitFor()
      await settings.locator('.nav-cell[data-section="advanced"]').click()
      await settings.locator('[data-advanced-page="diagnostics"]').click()
      await settings.getByTestId('diagnostics-overview').waitFor()
      await settings
        .locator('.settings-header [data-action="export-bundle"]')
        .click()
      const dialog = page.getByTestId('diagnostics-export-dialog')
      await dialog.locator('[data-entry]').first().waitFor({ timeout: 15_000 })
      const listed = (
        await dialog
          .locator('[data-entry]')
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute('data-entry') ?? ''),
          )
      ).sort()
      await page.screenshot({ path: join(shots, 'export-contents.png') })
      const target = join(out, 'settings-bundle.zip')
      await answerSaveDialog(app, target)
      await dialog.locator('[data-action="export"]').click()
      await dialog.getByText('已导出').waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(shots, 'export-done.png') })
      const zipped = zipFiles(target)
      if (JSON.stringify(zipped) !== JSON.stringify(listed))
        throw new Error(
          `list ${JSON.stringify(listed)} vs zip ${JSON.stringify(zipped)}`,
        )
      const leaks = scanZip(target, [
        'sk-fake-rel01-e2e-key',
        'rel01e2eSECRET123',
        'rel01tok',
        SESSION_MARKER,
      ])
      if (leaks.length) throw new Error(`leaks ${JSON.stringify(leaks)}`)
      const facts = JSON.parse(
        execFileSync('/usr/bin/unzip', ['-p', target, '*/app.json'], {
          encoding: 'utf8',
        }),
      ) as {
        versions: { electron: string }
        fuses: Record<string, unknown> | string
        helper: unknown
        extension: unknown
      }
      if (typeof facts.fuses !== 'object')
        throw new Error(`fuses ${JSON.stringify(facts.fuses)}`)
      await dialog.locator('[data-action="done"]').click()
      return {
        files: zipped.length,
        listed,
        electron: facts.versions.electron,
        fuses: Object.keys(facts.fuses).length,
        helper: facts.helper === null ? 'none' : 'reported',
        extension: facts.extension === null ? 'none' : 'reported',
      }
    },
  )
}

async function recoveryPage(
  app: ElectronApplication,
  page: Page,
  home: string,
  out: string,
): Promise<void> {
  const mainLog = join(home, 'logs', 'main.log')

  await check(
    page,
    'a startup failure writes its full cause and stack to main.log',
    async () => {
      await page.locator('#title').waitFor({ timeout: 60_000 })
      await until(
        () => read(mainLog).includes('Emperor startup failed'),
        10_000,
        'the startup failure in main.log',
      )
      const text = read(mainLog)
      const from = text.indexOf('Emperor startup failed')
      const block = text.slice(from, from + 4000)
      if (!block.includes('installation_invalid_state'))
        throw new Error('no error code in the log')
      if (!/\n\s+at /.test(block)) throw new Error('no stack frames in the log')
      if (!block.includes('Caused by: SyntaxError'))
        throw new Error('the cause is missing')
      await page.screenshot({ path: join(shots, 'recovery.png') })
      return {
        title: (await page.locator('#title').innerText()).trim(),
        frames: (block.match(/\n\s+at /g) ?? []).length,
      }
    },
    { critical: true },
  )

  await check(page, 'the recovery page 打开日志 opens main.log', async () => {
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { __rel01Opened?: string[] }).__rel01Opened = opened
      shell.openPath = (async (target: string) => {
        opened.push(target)
        return ''
      }) as typeof shell.openPath
    })
    await page.getByRole('button', { name: '打开日志' }).click()
    await until(
      async () =>
        (
          await app.evaluate(
            () =>
              (globalThis as { __rel01Opened?: string[] }).__rel01Opened ?? [],
          )
        ).length > 0,
      5_000,
      'shell.openPath',
    )
    const opened = await app.evaluate(
      () => (globalThis as { __rel01Opened?: string[] }).__rel01Opened ?? [],
    )
    if (opened[0] !== mainLog)
      throw new Error(`opened ${JSON.stringify(opened)}`)
    return { opened: relative(home, opened[0]!) }
  })

  await check(
    page,
    'the recovery page lists and exports the diagnostics bundle',
    async () => {
      await page.getByRole('button', { name: '导出诊断包' }).click()
      const entries = page.locator('#bundle-entries [data-entry]')
      await entries.first().waitFor({ timeout: 15_000 })
      const listed = (
        await entries.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-entry') ?? ''),
        )
      ).sort()
      await page.screenshot({ path: join(shots, 'recovery-bundle.png') })
      const target = join(out, 'recovery-bundle.zip')
      await answerSaveDialog(app, target)
      await page.locator('#bundle-export').click()
      await until(
        async () =>
          (await page.locator('#status').innerText()).includes('已导出'),
        15_000,
        '已导出',
      )
      const zipped = zipFiles(target)
      if (JSON.stringify(zipped) !== JSON.stringify(listed))
        throw new Error(
          `list ${JSON.stringify(listed)} vs zip ${JSON.stringify(zipped)}`,
        )
      return { files: zipped.length }
    },
  )
}

// --- REL-03 ----------------------------------------------------------------

const MEMORY_A = 'REL03-e2e-memory-a'
const MEMORY_B = 'REL03-e2e-memory-b'
const PLAIN_KEY = 'sk-fake-rel03-e2e-plain-key'

/** A home with a model (its key still plain, as 0.1 left it) and memory. */
function prepareDataHome(home: string, model: FakeModel, memory: string): void {
  prepareHome(home, model)
  writeFileSync(
    join(home, 'model_config.json'),
    read(join(home, 'model_config.json')).replace(
      'sk-fake-rel01-e2e-key',
      PLAIN_KEY,
    ),
  )
  writeFileSync(join(home, 'mcp_config.json'), '{"version": 1, "servers": {}}')
  mkdirSync(join(home, 'memory'), { recursive: true })
  // Core reads (and first renames) the legacy MEMORY.md as MEMORY.local.md.
  writeFileSync(join(home, 'memory', 'MEMORY.md'), `# Memory\n\n${memory}\n`)
}

async function openStorage(page: Page): Promise<ReturnType<Page['getByRole']>> {
  const settings = page.getByRole('dialog', { name: '设置' })
  if (!(await settings.isVisible()))
    await page
      .getByRole('button', { name: '设置', exact: true })
      .first()
      .click()
  await settings.waitFor()
  await settings.locator('.nav-cell[data-section="advanced"]').click()
  await settings.locator('[data-advanced-page="storage"]').click()
  await settings.locator('[data-group="storage-backup"]').waitFor()
  return settings
}

function pendingRestore(home: string): string {
  return join(home, 'migrations', 'restore-pending', 'restore.json')
}

async function exportBackup(
  app: ElectronApplication,
  page: Page,
  out: string,
): Promise<string> {
  const zip = join(out, 'rel03.emperor-backup.zip')
  await check(
    page,
    '存储 › 导出备份 writes a zip with the memory, without the vault, the local key or a plain model key',
    async () => {
      await page.locator('.app-frame').waitFor({ timeout: 60_000 })
      const settings = await openStorage(page)
      await settings.locator('[data-backup-export]').click()
      const dialog = page.getByTestId('backup-export-dialog')
      await dialog
        .locator('[data-category]')
        .first()
        .waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(shots, 'backup-export.png') })
      await answerSaveDialog(app, zip)
      await dialog.locator('[data-action="export"]').click()
      await dialog.getByText('已导出').waitFor({ timeout: 30_000 })
      const files = zipFiles(zip)
      if (!files.includes('home/memory/MEMORY.local.md'))
        throw new Error(`no memory in ${JSON.stringify(files)}`)
      const secret = files.filter(
        (file) =>
          file.startsWith('home/computer-use/') ||
          file === 'credentials.emperor-vault',
      )
      if (secret.length) throw new Error(`secrets in the zip ${secret}`)
      const leaks = scanZip(zip, [PLAIN_KEY])
      if (leaks.length) throw new Error(`plain key in ${JSON.stringify(leaks)}`)
      if (!scanZip(zip, [MEMORY_A]).length)
        throw new Error('the memory text is not in the zip')
      await dialog.locator('[data-action="done"]').click()
      return { files: files.length }
    },
    { critical: true },
  )
  return zip
}

async function scheduleRestore(
  app: ElectronApplication,
  page: Page,
  home: string,
  zip: string,
  out: string,
): Promise<void> {
  const marker = join(out, 'rel03-relaunch.txt')
  await check(
    page,
    '存储 › 从备份恢复 schedules the restore, then restarts the app',
    async () => {
      await page.locator('.app-frame').waitFor({ timeout: 60_000 })
      // The real relaunch would start an app Playwright does not own: note
      // it instead, and let the app quit by itself.
      await app.evaluate(
        ({ app: electronApp, dialog }, paths) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [paths.zip],
          })) as unknown as typeof dialog.showOpenDialog
          const fs = process.getBuiltinModule(
            'node:fs',
          ) as typeof import('node:fs')
          electronApp.relaunch = (() =>
            fs.writeFileSync(
              paths.marker,
              'relaunch',
            )) as typeof electronApp.relaunch
        },
        { zip, marker },
      )
      const settings = await openStorage(page)
      await settings.locator('[data-backup-restore]').click()
      const dialog = page.getByTestId('backup-restore-dialog')
      await dialog.waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(shots, 'backup-restore.png') })
      const closed = app.waitForEvent('close', { timeout: 30_000 })
      await dialog.locator('[data-action="restore"]').click()
      await closed
      if (read(marker) !== 'relaunch') throw new Error('no relaunch')
      if (!existsSync(pendingRestore(home)))
        throw new Error('no restore-pending/restore.json')
      return { pending: relative(home, pendingRestore(home)) }
    },
    { critical: true },
  )
}

async function restoredApp(page: Page, home: string): Promise<void> {
  await check(
    page,
    'the next start applies the restore; what it replaced is in migrations/backup-<ts>',
    async () => {
      await page.locator('.app-frame').waitFor({ timeout: 60_000 })
      if (existsSync(pendingRestore(home)))
        throw new Error('the restore is still pending')
      const memory = read(join(home, 'memory', 'MEMORY.local.md'))
      if (!memory.includes(MEMORY_A))
        throw new Error(`memory not restored: ${memory}`)
      const migrations = join(home, 'migrations')
      const backup = readdirSync(migrations).find((name) =>
        name.startsWith('backup-'),
      )
      if (!backup) throw new Error('no migrations/backup-<ts>')
      if (
        !read(join(migrations, backup, 'memory', 'MEMORY.local.md')).includes(
          MEMORY_B,
        )
      )
        throw new Error('the replaced memory is not in the backup folder')
      const log = read(join(migrations, 'log.jsonl'))
      if (!/"kind":"restore"[^\n]*"status":"applied"/.test(log))
        throw new Error(`no restore in log.jsonl: ${log}`)
      await page
        .locator('[role="status"]')
        .filter({ hasText: '已从备份恢复' })
        .waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(shots, 'backup-restored.png') })
      return { backup: `migrations/${backup}` }
    },
  )
}

function prepareNewerHome(home: string, model: FakeModel): string {
  prepareHome(home, model)
  writeFileSync(join(home, 'mcp_config.json'), '{"version": 1, "servers": {}}')
  writeFileSync(
    join(home, 'installation.json'),
    JSON.stringify({
      schemaVersion: 1,
      stateLayoutVersion: 1,
      appVersion: '99.0.0',
      lastRunVersion: '99.0.0',
      runtimeRevision: 'future',
      initializedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      emperorHomeSource: 'env',
      migration: 'existing',
      dataVersion: 1,
    }),
  )
  const settings = `${JSON.stringify({ version: 99, browser: { showFullUrl: false }, futureOnly: true }, null, 2)}\n`
  writeFileSync(join(home, 'settings.json'), settings)
  return settings
}

async function newerHome(
  page: Page,
  home: string,
  settings: string,
): Promise<void> {
  await check(
    page,
    'running an older Emperor than last time shows the startup banner',
    async () => {
      await page.locator('.app-frame').waitFor({ timeout: 60_000 })
      const banner = page
        .locator('[role="status"]')
        .filter({ hasText: '比上次打开的 99.0.0 旧' })
      await banner.waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(shots, 'downgrade-banner.png') })
      return { text: (await banner.innerText()).trim() }
    },
  )
  await check(
    page,
    'settings.json from a newer Emperor stays byte for byte; Core refuses; 存储 names it',
    async () => {
      const result = (await page.evaluate(
        async () =>
          await (
            window as unknown as {
              emperor: {
                invokeCore(key: string, input: unknown): Promise<unknown>
              }
            }
          ).emperor.invokeCore('browser.setPreferences', { showFullUrl: true }),
      )) as { ok?: boolean; error?: { code?: string; message?: string } }
      if (result?.error?.code !== 'data_file_newer')
        throw new Error(`Core accepted the save: ${JSON.stringify(result)}`)
      if (read(join(home, 'settings.json')) !== settings)
        throw new Error('settings.json changed')
      const quarantined = readdirSync(home).filter((name) =>
        name.startsWith('settings.json.'),
      )
      if (quarantined.length) throw new Error(`moved aside: ${quarantined}`)
      const storage = await openStorage(page)
      const notice = storage.locator('[data-storage-readonly]')
      await notice.waitFor({ timeout: 10_000 })
      const text = await notice.innerText()
      if (!text.includes('settings.json')) throw new Error(text)
      await page.screenshot({ path: join(shots, 'readonly-notice.png') })
      return { message: result.error.message }
    },
  )
}

/** The user's own log folders (the packaged and the dev app name). */
function realLogFolders(): string {
  return JSON.stringify(
    ['Emperor Agent', 'emperor-agent-desktop'].map((name) => {
      const folder = join(homedir(), 'Library', 'Logs', name)
      return existsSync(folder)
        ? [name, statSync(folder).mtimeMs]
        : [name, null]
    }),
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const before = realLogFolders()
  const model = await startFakeModel({ agentTool: 'read' })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-diagnostics-'))
  const broken = mkdtempSync(join(tmpdir(), 'emperor-e2e-diagnostics-broken-'))
  const out = mkdtempSync(join(tmpdir(), 'emperor-e2e-diagnostics-out-'))
  const source = mkdtempSync(join(tmpdir(), 'emperor-e2e-rel03-source-'))
  const target = mkdtempSync(join(tmpdir(), 'emperor-e2e-rel03-target-'))
  const newer = mkdtempSync(join(tmpdir(), 'emperor-e2e-rel03-newer-'))
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    await workingApp(app, launched.page, home, out)
    await app.close()
    app = null

    writeFileSync(join(broken, 'installation.json'), '{"stateLayoutVersion": ')
    const recovering = await launch(broken)
    app = recovering.app
    await recoveryPage(app, recovering.page, broken, out)
    await app.close()
    app = null
    await check(
      recovering.page,
      'nothing was written to ~/Library/Logs',
      async () => {
        const after = realLogFolders()
        if (after !== before) throw new Error(`${before} → ${after}`)
        return { folders: JSON.parse(after) as unknown }
      },
    )

    // REL-03: export from one home, restore into another, a newer home.
    prepareDataHome(source, model, MEMORY_A)
    const exporting = await launch(source)
    app = exporting.app
    const zip = await exportBackup(app, exporting.page, out)
    await app.close()
    app = null

    prepareDataHome(target, model, MEMORY_B)
    const restoring = await launch(target)
    app = restoring.app
    await scheduleRestore(app, restoring.page, target, zip, out)
    await app.close().catch(() => undefined)
    app = null
    const restarted = await launch(target)
    app = restarted.app
    await restoredApp(restarted.page, target)
    await app.close()
    app = null

    const settings = prepareNewerHome(newer, model)
    const older = await launch(newer)
    app = older.app
    await newerHome(older.page, newer, settings)
    await app.close()
    app = null
  } catch (error) {
    if (!(error instanceof Abort))
      report({
        suite: SUITE,
        name: 'runner',
        ok: false,
        ms: 0,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      })
  } finally {
    await app?.close().catch(() => undefined)
    await model.close()
    for (const dir of [home, broken, out, source, target, newer])
      rmSync(dir, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
