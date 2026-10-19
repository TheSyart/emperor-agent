/**
 * SEC-05 acceptance in the real desktop app (dev build out/, isolated
 * Emperor Home, scripted model, no network): the main window's renderer
 * defenses.
 *   - app://bundle sends the CSP header and index.html carries the same meta;
 *   - a realistic UI run (Build session, a reply with links and an image,
 *     settings) reports no CSP violation;
 *   - eval, inline script and a renderer fetch to another origin are blocked;
 *   - the default session refuses the microphone and notifications, while
 *     the main window may still write to the clipboard;
 *   - no link in a reply navigates the window: a relative path goes to the
 *     reference resolver, mailto: to shell.openExternal, other schemes do
 *     nothing; window.open and location changes are stopped by main;
 *   - a remote image in a reply is not requested until clicked, and then
 *     only through main (whose SSRF guard refuses this loopback address);
 *   - emperor:open-path refuses any path the renderer names.
 * Prints `E2E-RESULT {json}` lines like the other Electron suites.
 *
 *   node scripts/e2e-cu.mjs --mode=renderer-security   (after `npm run build`)
 */

import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { startFakeModel, type FakeModel } from '../fullstack/fake-model'
import { rendererContentSecurityPolicy } from '../../../src/shared/content-security-policy'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'renderer-security')
const SUITE = 'renderer-security'

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

/** A local server that only records what reaches it. */
async function startProbeServer(): Promise<{
  origin: string
  requests: string[]
  close(): Promise<void>
}> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(200, {
      'content-type': 'image/gif',
      'access-control-allow-origin': '*',
    })
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  }
}

function prepareHome(home: string, model: FakeModel): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'fake-sec',
      models: [
        {
          entryId: 'fake-sec',
          provider: 'custom',
          protocol: 'openai',
          modelId: 'fake-sec',
          displayName: 'Fake Security',
          apiBase: model.apiBase,
          apiKey: 'sk-fake',
          contextWindowTokens: 128_000,
          maxTokens: 4096,
          reasoningEffort: null,
        },
      ],
    }),
    { mode: 0o600 },
  )
}

function prepareProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-e2e-sec-')))
  mkdirSync(join(root, 'packages', 'core'), { recursive: true })
  writeFileSync(join(root, 'packages', 'core', 'index.ts'), 'export {}\n')
  writeFileSync(join(root, 'README.md'), '# Fixture\n')
  const git = (...args: string[]) =>
    spawnSync('git', args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'E2E',
        GIT_AUTHOR_EMAIL: 'e2e@example.com',
        GIT_COMMITTER_NAME: 'E2E',
        GIT_COMMITTER_EMAIL: 'e2e@example.com',
      },
    })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return root
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
    args: ['.', `--user-data-dir=${join(home, 'electron-profile')}`],
    cwd: desktop,
    env,
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  await page
    .setViewportSize({ width: 1440, height: 900 })
    .catch(() => undefined)
  await page.locator('.app-frame').waitFor({ timeout: 60_000 })
  return { app, page }
}

/**
 * Main-side recorders: navigations of the main window, and what would have
 * reached the system (shell.openExternal / openPath / showItemInFolder are
 * replaced so nothing opens on this machine).
 */
async function instrumentMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, shell }) => {
    const record = globalThis as unknown as {
      __sec: {
        didNavigate: string[]
        willNavigate: string[]
        external: string[]
        openPath: string[]
        revealed: string[]
      }
    }
    record.__sec = {
      didNavigate: [],
      willNavigate: [],
      external: [],
      openPath: [],
      revealed: [],
    }
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
    )
    win?.webContents.on('did-navigate', (_event, url) =>
      record.__sec.didNavigate.push(url),
    )
    win?.webContents.on('will-navigate', (_event, url) =>
      record.__sec.willNavigate.push(url),
    )
    shell.openExternal = (async (url: string) => {
      record.__sec.external.push(url)
    }) as typeof shell.openExternal
    shell.openPath = (async (target: string) => {
      record.__sec.openPath.push(target)
      return ''
    }) as typeof shell.openPath
    shell.showItemInFolder = ((target: string) => {
      record.__sec.revealed.push(target)
    }) as typeof shell.showItemInFolder
  })
}

async function recorded(app: ElectronApplication) {
  return await app.evaluate(
    () =>
      (
        globalThis as unknown as {
          __sec: {
            didNavigate: string[]
            willNavigate: string[]
            external: string[]
            openPath: string[]
            revealed: string[]
          }
        }
      ).__sec,
  )
}

/** Collect the page's CSP violations from now on (until a reload). */
async function watchViolations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list: Array<Record<string, unknown>> = []
    ;(window as unknown as { __cspViolations: unknown[] }).__cspViolations =
      list
    document.addEventListener('securitypolicyviolation', (event) => {
      list.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        sample: event.sample,
        source: event.sourceFile,
      })
    })
  })
}

async function violations(page: Page): Promise<Array<Record<string, unknown>>> {
  return await page.evaluate(
    () =>
      (
        window as unknown as {
          __cspViolations?: Array<Record<string, unknown>>
        }
      ).__cspViolations ?? [],
  )
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('消息输入框').first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const model = await startFakeModel({ agentTool: 'read' })
  const probe = await startProbeServer()
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-sec-home-'))
  const project = prepareProject()
  prepareHome(home, model)
  let app: ElectronApplication | null = null
  try {
    const launched = await launch(home)
    app = launched.app
    const page = launched.page
    const electron = app
    await instrumentMain(electron)
    await watchViolations(page)
    const expected = rendererContentSecurityPolicy()

    await check(
      page,
      'app://bundle sends the CSP header and meta',
      async () => {
        const seen = await page.evaluate(async () => {
          const response = await fetch(location.href, { cache: 'no-store' })
          return {
            url: location.href,
            header: response.headers.get('content-security-policy'),
            meta:
              document
                .querySelector('meta[http-equiv="Content-Security-Policy"]')
                ?.getAttribute('content') ?? null,
          }
        })
        if (!seen.url.startsWith('app://bundle/'))
          throw new Error(`not the production bundle: ${seen.url}`)
        if (seen.header !== expected) throw new Error(`header ${seen.header}`)
        if (seen.meta !== expected) throw new Error(`meta ${seen.meta}`)
        return { header: 'matches', meta: 'matches' }
      },
    )

    // --- a realistic run: Build session, a reply with links and an image.
    await check(
      page,
      'a Build session opens on the temporary project',
      async () => {
        await electron.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [dir],
          })) as typeof dialog.showOpenDialog
        }, project)
        // UI-S01: projects are opened from the 项目 header's 「+」 menu.
        await page.getByRole('button', { name: '项目操作' }).click()
        await page.getByRole('menuitem', { name: '使用现有文件夹' }).click()
        await page.getByLabel('消息输入框').first().waitFor({ timeout: 10_000 })
      },
      { critical: true },
    )

    const imageUrl = `${probe.origin}/pixel.gif`
    const reply = [
      '看看这些：',
      '',
      '- [packages/core](packages/core)',
      '- [写信](mailto:someone@example.com)',
      '- [短信](sms:10086)',
      '- [本节](#top)',
      '',
      `![统计图](${imageUrl})`,
    ].join('\n')
    await check(
      page,
      'the reply renders its links',
      async () => {
        model.enqueue(() => ({ text: reply }))
        await send(page, '给我几个链接')
        await page
          .locator('.ds-md a[href="mailto:someone@example.com"]')
          .last()
          .waitFor({ timeout: 30_000 })
        await page.waitForTimeout(500)
        await page.screenshot({ path: join(shots, 'reply.png') })
      },
      { critical: true },
    )

    await check(
      page,
      'a remote image shows a click-to-load placeholder (UI-38)',
      async () => {
        const placeholder = page.locator('[data-md-remote-image]').last()
        await placeholder.waitFor({ timeout: 5_000 })
        const text = (await placeholder.innerText()).trim()
        if (!text.includes('点击加载图片'))
          throw new Error(`placeholder ${text}`)
        return { placeholder: text }
      },
    )

    await check(
      page,
      'the remote image is not requested before a click',
      async () => {
        await page.waitForTimeout(500)
        if (probe.requests.length)
          throw new Error(`requests ${probe.requests.join(', ')}`)
        const images = await page
          .locator('.ds-md img')
          .evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLImageElement).currentSrc),
          )
        if (images.some((src) => src.startsWith('http')))
          throw new Error(`remote img ${images.join(', ')}`)
        return { requests: 0 }
      },
    )

    await check(
      page,
      'a relative link in a reply does not navigate the window (UI-4)',
      async () => {
        const before = page.url()
        await page.locator('.ds-md a[href="packages/core"]').last().click()
        await page.waitForTimeout(800)
        const seen = await recorded(electron)
        if (seen.didNavigate.length)
          throw new Error(`did-navigate ${seen.didNavigate.join(', ')}`)
        if (seen.willNavigate.length)
          throw new Error(`will-navigate ${seen.willNavigate.join(', ')}`)
        if (page.url() !== before) throw new Error(`url ${page.url()}`)
        // Core resolved it: the folder opens in 文件.
        const row = page.locator('.file-tree-row[data-path="packages/core"]')
        const opened = await row
          .waitFor({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false)
        return { url: 'unchanged', filesPane: opened }
      },
    )

    await check(page, 'a mailto: link goes to shell.openExternal', async () => {
      await page
        .locator('.ds-md a[href="mailto:someone@example.com"]')
        .last()
        .click()
      await until(
        async () =>
          (await recorded(electron)).external.includes(
            'mailto:someone@example.com',
          ),
        5_000,
        'shell.openExternal(mailto:)',
      )
      const seen = await recorded(electron)
      if (seen.didNavigate.length) throw new Error('the window navigated')
      return { external: seen.external }
    })

    await check(page, 'other schemes and anchors do nothing', async () => {
      const before = (await recorded(electron)).external.length
      await page.locator('.ds-md a[href="sms:10086"]').last().click()
      await page.locator('.ds-md a[href="#top"]').last().click()
      await page.waitForTimeout(500)
      const seen = await recorded(electron)
      if (seen.external.length !== before)
        throw new Error(`opened ${seen.external.slice(before).join(', ')}`)
      if (seen.didNavigate.length) throw new Error('the window navigated')
      return { external: 'none' }
    })

    await check(
      page,
      'clicking the image placeholder fetches through main (SSRF guard)',
      async () => {
        const placeholder = page.locator('[data-md-remote-image]').last()
        await placeholder.click({ timeout: 5_000 })
        await until(
          async () => (await placeholder.innerText()).includes('内网'),
          10_000,
          'the refusal from main',
        )
        if (probe.requests.length)
          throw new Error(`requests ${probe.requests.join(', ')}`)
        return { shown: (await placeholder.innerText()).trim() }
      },
    )

    await check(
      page,
      'settings open from the UI without violations',
      async () => {
        await page
          .getByRole('button', { name: '设置', exact: true })
          .first()
          .click()
        const dialog = page.getByRole('dialog', { name: '设置' })
        await dialog.waitFor()
        for (const section of [
          'general',
          'model',
          'browser',
          'voice',
          'diagnostics',
        ]) {
          await dialog.locator(`.nav-cell[data-section="${section}"]`).click()
          await dialog
            .locator(`.settings-options[data-section="${section}"]`)
            .waitFor({ timeout: 10_000 })
        }
        await page.keyboard.press('Escape')
      },
    )

    await check(
      page,
      'the whole UI run reported no CSP violation',
      async () => {
        const seen = await violations(page)
        if (seen.length) throw new Error(JSON.stringify(seen.slice(0, 5)))
        return { violations: 0 }
      },
    )

    // --- deliberate probes: each must be blocked.
    await check(
      page,
      'eval and new Function throw (no unsafe-eval)',
      async () => {
        const outcome = await page.evaluate(
          () =>
            new Promise<Record<string, string>>((done) => {
              setTimeout(() => {
                const result: Record<string, string> = {}
                try {
                  ;(0, eval)('1')
                  result.eval = 'allowed'
                } catch (error) {
                  result.eval = (error as Error).name
                }
                try {
                  new Function('return 1')()
                  result.fn = 'allowed'
                } catch (error) {
                  result.fn = (error as Error).name
                }
                done(result)
              }, 0)
            }),
        )
        if (outcome.eval !== 'EvalError' || outcome.fn !== 'EvalError')
          throw new Error(JSON.stringify(outcome))
        return outcome
      },
    )

    await check(page, 'an injected inline script does not run', async () => {
      const ran = await page.evaluate(async () => {
        const script = document.createElement('script')
        script.textContent = 'window.__inlineRan = true'
        document.body.appendChild(script)
        await new Promise((done) => setTimeout(done, 100))
        script.remove()
        return (window as unknown as { __inlineRan?: boolean }).__inlineRan
      })
      if (ran) throw new Error('inline script ran')
    })

    await check(page, 'the renderer cannot fetch another origin', async () => {
      const outcome = await page.evaluate(async (url) => {
        try {
          await fetch(url)
          return 'fetched'
        } catch (error) {
          return (error as Error).name
        }
      }, `${probe.origin}/exfiltrate`)
      if (outcome === 'fetched') throw new Error('fetch went through')
      if (probe.requests.includes('/exfiltrate'))
        throw new Error('the request reached the server')
      return { outcome }
    })

    await check(
      page,
      'the microphone and notifications are refused (MAIN-3)',
      async () => {
        const outcome = await page.evaluate(async () => {
          const microphone = await navigator.permissions
            .query({ name: 'microphone' as PermissionName })
            .then((status) => status.state)
            .catch((error: Error) => `error:${error.name}`)
          // Never reach the real microphone (a macOS prompt) from a test:
          // ask for it only once the permission check already says no.
          const media =
            microphone === 'denied'
              ? await navigator.mediaDevices
                  .getUserMedia({ audio: true })
                  .then((stream) => {
                    stream.getTracks().forEach((track) => track.stop())
                    return 'granted'
                  })
                  .catch((error: Error) => error.name)
              : 'not-asked'
          const notifications = await Notification.requestPermission()
          return { microphone, media, notifications }
        })
        if (outcome.media !== 'NotAllowedError')
          throw new Error(`getUserMedia ${outcome.media}`)
        if (outcome.microphone !== 'denied')
          throw new Error(`permissions.query ${outcome.microphone}`)
        if (outcome.notifications !== 'denied')
          throw new Error(`notifications ${outcome.notifications}`)
        return outcome
      },
    )

    await check(
      page,
      'the main window can still copy text to the clipboard',
      async () => {
        const saved = await electron.evaluate(({ clipboard }) =>
          clipboard.readText(),
        )
        try {
          await electron.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()
              .find((win) => win.isVisible())
              ?.focus()
          })
          await page.bringToFront().catch(() => undefined)
          const outcome = await page.evaluate(async () => {
            window.focus()
            try {
              await navigator.clipboard.writeText('emperor-sec05-clipboard')
              return 'ok'
            } catch (error) {
              return `${(error as Error).name}: ${(error as Error).message}`
            }
          })
          const text = await electron.evaluate(({ clipboard }) =>
            clipboard.readText(),
          )
          if (outcome !== 'ok' || text !== 'emperor-sec05-clipboard')
            throw new Error(`${outcome}, clipboard ${text}`)
          return { writeText: outcome }
        } finally {
          await electron.evaluate(
            ({ clipboard }, value) => clipboard.writeText(value),
            saved,
          )
        }
      },
    )

    await check(
      page,
      'window.open is denied and routed as a link',
      async () => {
        const opened = await page.evaluate(
          () => window.open('https://example.com/from-window-open') === null,
        )
        await until(
          async () =>
            (await recorded(electron)).external.some((url) =>
              url.startsWith('https://example.com/from-window-open'),
            ),
          5_000,
          'the system-browser hand-off',
        )
        if (!opened) throw new Error('window.open returned a window')
        return { popup: 'denied' }
      },
    )

    await check(
      page,
      'emperor:open-path refuses any path the renderer names (MAIN-27)',
      async () => {
        const outcome = await page.evaluate(async () => {
          const bridge = (
            window as unknown as {
              emperor: { openPath(target: unknown): Promise<unknown> }
            }
          ).emperor
          return {
            app: await bridge.openPath('/System/Applications/Calculator.app'),
            object: await bridge.openPath({ kind: 'path', path: '/etc' }),
            invalid: await bridge.openPath({
              kind: 'invalid-skill',
              path: '/etc',
            }),
            home: await bridge.openPath({
              kind: 'diagnostic',
              rowId: 'global-state-root',
            }),
          }
        })
        const seen = await recorded(electron)
        const refused = (value: unknown) =>
          (value as { ok?: boolean }).ok === false
        if (
          !refused(outcome.app) ||
          !refused(outcome.object) ||
          !refused(outcome.invalid)
        )
          throw new Error(JSON.stringify(outcome))
        if ((outcome.home as { ok?: boolean }).ok !== true)
          throw new Error(`Emperor Home ${JSON.stringify(outcome.home)}`)
        const homes = [home, realpathSync(home)]
        if (seen.openPath.length !== 1 || !homes.includes(seen.openPath[0]!))
          throw new Error(`opened ${seen.openPath.join(', ')}`)
        return { refused: 3, opened: 'Emperor Home only' }
      },
    )

    await check(
      page,
      'a script cannot move the window off its document',
      async () => {
        const before = page.url()
        await page.evaluate(() => {
          location.href = 'packages/core'
        })
        await page.waitForTimeout(1_000)
        const seen = await recorded(electron)
        if (seen.didNavigate.length)
          throw new Error(`did-navigate ${seen.didNavigate.join(', ')}`)
        if (page.url() !== before) throw new Error(`url ${page.url()}`)
        return { willNavigate: seen.willNavigate.length }
      },
    )

    await check(page, 'the application menu is Emperor’s own', async () => {
      const menu = await electron.evaluate(({ Menu }) =>
        (Menu.getApplicationMenu()?.items ?? []).map((item) => ({
          label: item.label,
          roles: (item.submenu?.items ?? []).map(
            (sub) => sub.role ?? sub.label,
          ),
        })),
      )
      const labels = menu.map((item) => item.label)
      for (const label of ['编辑', '显示', '窗口', '帮助'])
        if (!labels.includes(label))
          throw new Error(`menus ${labels.join(', ')}`)
      // A dev build keeps reload / DevTools; the packaged smoke checks the
      // production menu (no reload, no DevTools).
      return { menus: labels }
    })
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
    await model.close().catch(() => undefined)
    await probe.close().catch(() => undefined)
    rmSync(project, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
