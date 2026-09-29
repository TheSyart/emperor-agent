/**
 * Full-stack computer use suite: the real desktop app (dev build, isolated
 * Emperor Home) driven through its UI by Playwright, with a scripted model
 * server and the local fixture site. Covers the M1 exit path:
 *   switch on in Settings → grant card → open / observe / fill / click / wait
 *   → screenshot thumbnail → Browser pane preview survives a pane switch →
 *   cross-origin asks again (denied) → full access auto-approves navigation
 *   but a high-impact click still asks → emergency stop blocks the next call
 *   → resume → switching off closes every Agent tab.
 * Prints `E2E-RESULT {json}` lines like the Electron harness.
 *
 *   node out-e2e/fullstack.cjs            (via scripts/e2e-cu.mjs --mode=fullstack)
 *   node out-e2e/fullstack.cjs --real     (real model from EMPEROR_E2E_MODEL_CONFIG)
 */

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { startFixtureSite, type FixtureSite } from '../fixtures/site'
import { refIn, startFakeModel, type FakeModel, type Step } from './fake-model'

const desktop = resolve(__dirname, '..')
const shots = join(desktop, 'out-e2e', 'fullstack')
const real = process.argv.includes('--real')
const SUITE = real ? 'real-model' : 'fullstack'

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
  page: Page | null,
  name: string,
  body: () => Promise<T>,
  options: { critical?: boolean } = {},
): Promise<T | undefined> {
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
    return detail
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.split('\n').slice(0, 6).join(' ')
        : String(error)
    report({
      suite: SUITE,
      name,
      ok: false,
      ms: Date.now() - started,
      error: message,
    })
    if (page)
      await page
        .screenshot({
          path: join(shots, `fail-${name.replace(/[^\w-]+/g, '_')}.png`),
        })
        .catch(() => undefined)
    if (options.critical) throw new Abort(name)
    return undefined
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

// ---------------------------------------------------------------------------
// App helpers

async function core<T>(page: Page, op: string, ...args: unknown[]): Promise<T> {
  return (await page.evaluate(
    async ({ op, args }) => {
      const bridge = (
        window as unknown as {
          emperor: {
            invokeCore: (op: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).emperor
      return await bridge.invokeCore(op, ...args)
    },
    { op, args },
  )) as T
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.waitFor()
  await dialog.locator('.nav-cell[data-section="computer"]').click()
  const badge = dialog.getByTestId('computer-use-status')
  await badge.waitFor()
  // The first status read is asynchronous; wait until it has landed.
  await until(
    async () => (await badge.innerText()).trim() !== '读取中',
    10_000,
    'computer use status loaded',
  )
}

/** A settings switch by id (the section has several). */
function settingsSwitch(
  page: Page,
  id: 'computer-use-enabled' | 'computer-use-unrestricted',
) {
  return page.getByRole('dialog', { name: '设置' }).locator(`#${id}`)
}

async function setUnrestricted(page: Page, on: boolean): Promise<void> {
  await openSettings(page)
  const toggle = settingsSwitch(page, 'computer-use-unrestricted')
  if (((await toggle.getAttribute('aria-checked')) === 'true') !== on)
    await toggle.click()
  await until(
    async () => ((await toggle.getAttribute('aria-checked')) === 'true') === on,
    10_000,
    `持续允许 ${on ? 'on' : 'off'}`,
  )
  await closeSettings(page)
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'hidden' })
}

async function statusBadge(page: Page): Promise<string> {
  return (
    await page
      .getByRole('dialog', { name: '设置' })
      .getByTestId('computer-use-status')
      .innerText()
  ).trim()
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator('.composer-root textarea').first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}

/** Answer grant cards as they come until `done` holds; returns the targets seen. */
async function answerCardsUntil(
  page: Page,
  done: () => Promise<boolean>,
  answer: (card: {
    target: string
    highImpact: boolean
  }) => 'session' | 'once' | 'deny',
  timeoutMs = 60_000,
): Promise<Array<{ target: string; highImpact: boolean; answer: string }>> {
  const seen: Array<{ target: string; highImpact: boolean; answer: string }> =
    []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await done()) return seen
    const card = page.locator('[data-takeover="grant"]')
    if (await card.isVisible().catch(() => false)) {
      const target = (await card.getByTestId('grant-target').innerText()).trim()
      const highImpact = await card
        .getByTestId('grant-high-impact')
        .isVisible()
        .catch(() => false)
      const choice = answer({ target, highImpact })
      if (choice === 'deny')
        await card.getByRole('button', { name: '拒绝' }).click()
      else {
        if (choice === 'session') {
          const radio = card.getByRole('radio', { name: '本会话' })
          if (await radio.isVisible().catch(() => false)) await radio.click()
        }
        await card.getByRole('button', { name: '允许' }).click()
      }
      seen.push({ target, highImpact, answer: choice })
      await card.waitFor({ state: 'hidden' }).catch(() => undefined)
      continue
    }
    await page.waitForTimeout(150)
  }
  throw new Error(`timed out; cards answered: ${JSON.stringify(seen)}`)
}

async function assistantSaid(page: Page, text: string): Promise<boolean> {
  return (
    (await page.locator('.assistant-step').filter({ hasText: text }).count()) >
    0
  )
}

function toolRow(page: Page, tool: string) {
  return page.locator(`.tool-row[data-tool="${tool}"]`)
}

async function expand(
  page: Page,
  tool: string,
  index = -1,
): Promise<ReturnType<Page['locator']>> {
  const rows = toolRow(page, tool)
  const row = index < 0 ? rows.last() : rows.nth(index)
  // The row header is a div[role=button] (DisclosureRow expandOnRowClick).
  await row
    .locator('.ds-disclosure [role="button"], .ds-disclosure button')
    .first()
    .click()
  return row
}

// ---------------------------------------------------------------------------
// Scripted steps

const call =
  (name: string, args: Record<string, unknown> = {}): Step =>
  () => ({ tools: [{ name, args }] })
const say =
  (text: string): Step =>
  () => ({ text })

function prepareHome(home: string, model: FakeModel | null): void {
  mkdirSync(home, { recursive: true })
  if (model !== null) {
    writeFileSync(
      join(home, 'model_config.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          activeModelId: 'fake-cu',
          models: [
            {
              entryId: 'fake-cu',
              provider: 'custom',
              protocol: 'openai',
              modelId: 'fake-cu',
              displayName: 'Fake CU',
              apiBase: model.apiBase,
              apiKey: 'sk-fake',
              contextWindowTokens: 128_000,
              maxTokens: 4096,
              reasoningEffort: null,
            },
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    return
  }
  const source = process.env.EMPEROR_E2E_MODEL_CONFIG
  if (!source)
    throw new Error(
      'EMPEROR_E2E_MODEL_CONFIG must point at a model_config.json for --real',
    )
  copyFileSync(source, join(home, 'model_config.json'))
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
  await page.locator('.app-frame').waitFor({ timeout: 60_000 })
  return { app, page }
}

// ---------------------------------------------------------------------------

async function fullstack(
  app: ElectronApplication,
  page: Page,
  model: FakeModel,
  site: FixtureSite,
  home: string,
): Promise<void> {
  const origin = site.origin
  const other = site.otherOrigin
  const fixturePassword = 'M2-e2e-private-39407'
  let credentialHandleId = ''

  await check(
    page,
    'settings switch turns computer use on',
    async () => {
      await openSettings(page)
      if ((await statusBadge(page)) !== '已关闭')
        throw new Error(`initial badge ${await statusBadge(page)}`)
      // The persistent 持续允许 mode is the default; the card flows below
      // run in scoped mode and turn 3 switches it back on.
      if (
        (await settingsSwitch(page, 'computer-use-unrestricted').getAttribute(
          'aria-checked',
        )) !== 'true'
      )
        throw new Error('持续允许 is not the default mode')
      await settingsSwitch(page, 'computer-use-enabled').click()
      await until(
        async () => (await statusBadge(page)) === '已开启',
        10_000,
        'badge 已开启',
      )
      await page.screenshot({ path: join(shots, 'settings-on.png') })
      await closeSettings(page)
      await setUnrestricted(page, false)
    },
    { critical: true },
  )

  await check(
    page,
    'M2 settings manage profile, permission and credential through trusted UI',
    async () => {
      await openSettings(page)
      const dialog = page.getByRole('dialog', { name: '设置' })
      const profileForm = dialog.locator('.cu-settings-form').first()
      await profileForm.locator('input').fill('E2E profile')
      await profileForm.getByRole('button', { name: '新建 profile' }).click()
      const profiles = await core<Array<{ profileId: string; name: string }>>(
        page,
        'computerUse.listProfiles',
      )
      const profile = profiles.find((item) => item.name === 'E2E profile')
      if (!profile) throw new Error('profile was not created')
      const permissionForm = dialog.locator('.cu-settings-form').nth(1)
      await permissionForm
        .locator('select')
        .first()
        .selectOption(profile.profileId)
      await permissionForm.locator('input').first().fill(origin)
      await permissionForm
        .locator('select')
        .nth(1)
        .selectOption('notifications')
      await permissionForm
        .getByRole('button', { name: '放行此站点权限' })
        .click()
      const allowed = await core<
        Array<{ profileId: string; origin: string; kind: string }>
      >(page, 'computerUse.listSitePermissions')
      if (
        !allowed.some(
          (item) =>
            item.profileId === profile.profileId &&
            item.origin === origin &&
            item.kind === 'notifications',
        )
      )
        throw new Error('site permission was not saved')
      await dialog
        .getByText('凭据', { exact: true })
        .first()
        .scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, 'settings-m2.png') })
      const vaultForm = dialog.locator('.vault-form')
      await vaultForm.locator('input').nth(0).fill('E2E credential')
      await vaultForm
        .getByRole('textbox', { name: '网站 origin（每行一个）' })
        .fill(origin)
      await vaultForm.locator('input').nth(1).fill('e2e-user')
      await vaultForm.locator('input').nth(2).fill(fixturePassword)
      await vaultForm.getByRole('button', { name: '添加凭据' }).click()
      await until(
        async () =>
          (await dialog.getByText('E2E credential', { exact: true }).count()) >
          0,
        5_000,
        'credential saved in Settings',
      )
      const vault = await page.evaluate(
        async () =>
          await (
            window as unknown as {
              emperor: {
                vaultStatus(): Promise<{
                  handles: Array<{ handleId: string; label: string }>
                }>
              }
            }
          ).emperor.vaultStatus(),
      )
      credentialHandleId =
        vault.handles.find((item) => item.label === 'E2E credential')
          ?.handleId ?? ''
      if (!credentialHandleId) throw new Error('credential handle missing')
      if ((await dialog.innerText()).includes(fixturePassword))
        throw new Error('password appeared in Settings text')
      page.once('dialog', (prompt) => {
        void prompt.accept()
      })
      const row = dialog
        .locator('.ds-settings-row')
        .filter({ hasText: 'E2E profile' })
        .first()
      await row.getByRole('button', { name: '清空' }).click()
      await until(
        async () => {
          const afterClear = await core<Array<{ profileId: string }>>(
            page,
            'computerUse.listSitePermissions',
          )
          return !afterClear.some(
            (item) => item.profileId === profile.profileId,
          )
        },
        5_000,
        'profile clear and permission revocation',
      )
      page.once('dialog', (prompt) => {
        void prompt.accept()
      })
      await row.getByRole('button', { name: '删除' }).click()
      await closeSettings(page)
      return {
        profileCreated: true,
        sitePermissionRevokedOnClear: true,
        credentialSaved: true,
      }
    },
    { critical: true },
  )

  // Turn 1: grant card → open / observe / fill / click / wait / screenshot.
  model.enqueue(
    call('browser_open', { url: `${origin}/form` }),
    call('browser_observe'),
    (request) => ({
      tools: [
        {
          name: 'browser_fill',
          args: { ref: refIn(request, 'Name'), text: '张三' },
        },
      ],
    }),
    // The fill result carries no observation; observe again for the next refs.
    call('browser_observe'),
    (request) => ({
      tools: [
        {
          name: 'browser_fill',
          args: { ref: refIn(request, 'Email'), text: 'zhangsan@example.com' },
        },
      ],
    }),
    call('browser_observe'),
    (request) => ({
      tools: [
        { name: 'browser_click', args: { ref: refIn(request, 'Submit') } },
      ],
    }),
    call('browser_wait', {
      condition: { kind: 'text', contains: 'Thanks for signing up' },
      timeoutMs: 5000,
    }),
    call('browser_screenshot'),
    say('表单已提交，页面显示 Thanks for signing up。'),
  )
  await check(
    page,
    'turn 1: grant card then open, observe, fill, click, wait',
    async () => {
      await send(page, `请打开 ${origin}/form，填写姓名和邮箱后提交。`)
      const cards = await answerCardsUntil(
        page,
        () => assistantSaid(page, '表单已提交'),
        () => 'session',
      )
      if (cards.length === 0) throw new Error('no grant card was shown')
      if (!cards[0]!.target.includes(new URL(origin).host))
        throw new Error(`first card target ${cards[0]!.target}`)
      const tools = await page
        .locator('.tool-row')
        .evaluateAll((rows) =>
          rows.map(
            (row) =>
              `${row.getAttribute('data-tool')}:${row.getAttribute('data-state')}`,
          ),
        )
      const failed = tools.filter(
        (entry) => entry.startsWith('browser_') && !entry.endsWith(':ok'),
      )
      if (failed.length > 0)
        throw new Error(
          `failed rows: ${failed.join(', ')} (all: ${tools.join(', ')})`,
        )
      return { cards: cards.length, tools }
    },
    { critical: true },
  )

  await check(page, 'screenshot row shows a thumbnail', async () => {
    const row = await expand(page, 'browser_screenshot')
    const img = row.locator('.shot img')
    await img.waitFor({ timeout: 10_000 })
    await until(
      async () =>
        (await img.evaluate(
          (node) => (node as HTMLImageElement).naturalWidth,
        )) > 0,
      10_000,
      'thumbnail load',
    )
    await page.screenshot({ path: join(shots, 'turn1-tools.png') })
  })

  await check(
    page,
    'controlled target shows the floating stop control',
    async () => {
      await until(
        async () =>
          (await app.windows()).some(
            (window) =>
              window.url().startsWith('data:text/html') && window !== page,
          ),
        10_000,
        'control overlay window',
      )
      const overlay = (await app.windows()).find(
        (window) =>
          window !== page && window.url().startsWith('data:text/html'),
      )
      if (!overlay) throw new Error('control overlay window missing')
      await overlay.getByText('Emperor 正在操作', { exact: false }).waitFor()
      await overlay.getByRole('button', { name: '停止' }).waitFor()
      return { text: await overlay.locator('body').innerText() }
    },
  )

  await check(
    page,
    'browser pane previews the Agent tab and survives a pane switch',
    async () => {
      const row = toolRow(page, 'browser_screenshot').last()
      await row.getByRole('button', { name: '在浏览器面板查看' }).click()
      const pane = page.locator('.browser-pane')
      await pane.waitFor()
      await until(
        async () => (await pane.getAttribute('data-state')) === 'agent',
        10_000,
        'agent tab selected',
      )
      await until(
        async () =>
          (await pane
            .locator('.agent-tab-canvas')
            .getAttribute('data-phase')) === 'live',
        10_000,
        'live frame',
      )
      await page.screenshot({ path: join(shots, 'browser-pane-agent.png') })
      // Leave the session (the pane is keyed by session and unmounts), come
      // back: the Agent tab is still there.
      const chatUrl = page.url()
      const mounted = await pane.elementHandle()
      await page.getByRole('button', { name: '新对话' }).first().click()
      await until(() => page.url() !== chatUrl, 10_000, 'left the chat')
      await until(
        async () =>
          (await mounted!.evaluate((node) => !node.isConnected)) === true,
        10_000,
        'the pane unmounted',
      )
      const status = await core<{
        targets: Array<{ state: string; title: string }>
      }>(page, 'computerUse.status')
      const live = status.targets.filter(
        (target) => target.state !== 'closed' && target.state !== 'lost',
      )
      if (live.length !== 1)
        throw new Error(
          `targets after pane switch: ${JSON.stringify(status.targets)}`,
        )
      await page.goBack()
      await until(() => page.url() === chatUrl, 10_000, 'back on the chat')
      const segments = page.getByRole('group', { name: '工作台面板' })
      if (await segments.isVisible().catch(() => false))
        await segments.getByRole('button', { name: '浏览器' }).click()
      await page.locator('.browser-tab', { hasText: live[0]!.title }).waitFor()
      await page.screenshot({
        path: join(shots, 'browser-pane-after-switch.png'),
      })
      return { title: live[0]!.title }
    },
  )

  // Turn 2: another origin asks again; the user refuses.
  model.enqueue(
    call('browser_navigate', { url: `${other}/embed` }),
    (request) => {
      const text = JSON.stringify(
        request.messages[request.messages.length - 1]?.content ?? '',
      )
      return {
        text: text.includes('PERMISSION_DENIED')
          ? '用户拒绝了跳转，已停止。'
          : `意外结果：${text.slice(0, 200)}`,
      }
    },
  )
  await check(
    page,
    'turn 2: cross-origin navigation asks again and a refusal stops it',
    async () => {
      await send(page, `再打开 ${other}/embed 看看。`)
      const cards = await answerCardsUntil(
        page,
        () => assistantSaid(page, '已停止'),
        () => 'deny',
      )
      if (cards.length !== 1 || !cards[0]!.target.includes(new URL(other).host))
        throw new Error(`cards: ${JSON.stringify(cards)}`)
      if (await assistantSaid(page, '意外结果'))
        throw new Error('model did not see PERMISSION_DENIED')
      return { card: cards[0]!.target }
    },
  )

  // Turn 3: 持续允许 auto-approves the navigation; a high-impact click still asks.
  await setUnrestricted(page, true)
  model.enqueue(
    call('browser_navigate', { url: `${other}/embed` }),
    call('browser_navigate', { url: `${origin}/checkout` }),
    call('browser_observe'),
    (request) => ({
      tools: [
        { name: 'browser_click', args: { ref: refIn(request, 'Pay now') } },
      ],
    }),
    say('已完成付款确认。'),
  )
  await check(
    page,
    'turn 3: 持续允许 auto-approves navigation, high impact still asks',
    async () => {
      await send(page, '现在去对方页面，然后回到结账页点击付款。')
      const cards = await answerCardsUntil(
        page,
        () => assistantSaid(page, '已完成付款确认'),
        () => 'once',
      )
      if (cards.length !== 1 || !cards[0]!.highImpact)
        throw new Error(`cards: ${JSON.stringify(cards)}`)
      // The hop to the other origin is auto-approved (持续允许); the way back
      // uses the session grant from turn 1.
      const suffix = toolRow(page, 'browser_navigate').locator(
        '.summary-suffix',
        { hasText: '自动放行' },
      )
      if ((await suffix.count()) < 1)
        throw new Error('no auto-approved navigation row')
      await page.screenshot({ path: join(shots, 'turn3-high-impact.png') })
      return { cards: cards.length }
    },
  )

  // Turn 4: the emergency stop blocks the next action until resumed.
  await check(
    page,
    'emergency stop blocks the next action; resume restores',
    async () => {
      const overlay = (await app.windows()).find(
        (window) =>
          window !== page && window.url().startsWith('data:text/html'),
      )
      if (!overlay) throw new Error('control overlay window missing')
      // The click synchronously hides this non-focusable window. Playwright may
      // keep waiting for actionability after the main process has already
      // stopped control, so assert the Core state instead of the click promise.
      const clickError = await overlay
        .getByRole('button', { name: '停止' })
        .click({ noWaitAfter: true, timeout: 5_000 })
        .then(
          () => null,
          (error: unknown) => error,
        )
      await until(
        async () =>
          (await core<{ stopped: boolean }>(page, 'computerUse.status'))
            .stopped,
        10_000,
        `overlay stop effect${clickError ? ` (${String(clickError)})` : ''}`,
      )
      await openSettings(page)
      await until(
        async () => (await statusBadge(page)) === '已急停',
        10_000,
        'badge 已急停',
      )
      await closeSettings(page)
      model.enqueue(call('browser_observe'), (request) => {
        const text = JSON.stringify(
          request.messages[request.messages.length - 1]?.content ?? '',
        )
        return {
          text: text.includes('emergency-stop')
            ? '操作已被急停。'
            : `意外结果：${text.slice(0, 200)}`,
        }
      })
      await send(page, '再看一下页面。')
      await until(
        () => assistantSaid(page, '操作已被急停'),
        30_000,
        'stop reply',
      )
      await openSettings(page)
      await page
        .getByRole('dialog', { name: '设置' })
        .getByRole('button', { name: '恢复' })
        .click()
      await until(
        async () => (await statusBadge(page)) === '已开启',
        10_000,
        'badge 已开启',
      )
      await closeSettings(page)
    },
  )

  model.enqueue(
    call('browser_open', { url: `${origin}/form` }),
    call('ui_credential_list', { origin }),
    call('browser_observe'),
    (request) => ({
      tools: [
        {
          name: 'browser_fill_credential',
          args: {
            ref: refIn(request, 'Password'),
            handleId: credentialHandleId,
            field: 'password',
          },
        },
      ],
    }),
    say('凭据代填已完成。'),
  )
  await check(
    page,
    'M2 fullstack credential handle reaches real browser without leaking',
    async () => {
      await send(page, '打开登录表单，用保存的凭据句柄填入密码，并确认已填入。')
      // Credential fills always ask, once, even in 持续允许 mode.
      const cards = await answerCardsUntil(
        page,
        () => assistantSaid(page, '凭据代填已完成'),
        () => 'once',
        30_000,
      )
      if (cards.length !== 1)
        throw new Error(
          `expected one confirmation card, got ${JSON.stringify(cards)}`,
        )
      const row = toolRow(page, 'browser_fill_credential').last()
      if ((await row.getAttribute('data-state')) !== 'ok')
        throw new Error(
          `credential tool state ${await row.getAttribute('data-state')}`,
        )
      if ((await page.locator('body').innerText()).includes(fixturePassword))
        throw new Error('password appeared in renderer text')
      const scan = (dir: string): boolean =>
        readdirSync(dir, { withFileTypes: true }).some((entry) => {
          const file = join(dir, entry.name)
          if (entry.isDirectory()) return scan(file)
          return (
            entry.isFile() &&
            readFileSync(file).includes(Buffer.from(fixturePassword))
          )
        })
      if (scan(home)) throw new Error('password appeared in Emperor Home files')
      await openSettings(page)
      const dialog = page.getByRole('dialog', { name: '设置' })
      page.once('dialog', (prompt) => {
        void prompt.accept()
      })
      await dialog
        .locator('.ds-settings-row')
        .filter({ hasText: 'E2E credential' })
        .first()
        .getByRole('button', { name: '删除' })
        .click()
      await until(
        async () =>
          (await dialog
            .getByText('E2E credential', { exact: true })
            .count()) === 0,
        5_000,
        'credential removal',
      )
      await closeSettings(page)
      return { filled: true, logScanClean: true, deleted: true }
    },
    { critical: true },
  )

  await check(
    page,
    'switching off closes every Agent tab and removes the tools',
    async () => {
      await openSettings(page)
      await settingsSwitch(page, 'computer-use-enabled').click()
      await until(
        async () => (await statusBadge(page)) === '已关闭',
        10_000,
        'badge 已关闭',
      )
      await closeSettings(page)
      await until(
        async () => {
          const status = await core<{ targets: Array<{ state: string }> }>(
            page,
            'computerUse.status',
          )
          return status.targets.every(
            (target) => target.state === 'closed' || target.state === 'lost',
          )
        },
        10_000,
        'targets closed',
      )
    },
  )

  if (model.errors.length > 0)
    throw new Error(`model step errors: ${String(model.errors[0])}`)
}

async function realModel(page: Page, site: FixtureSite): Promise<void> {
  const origin = site.origin
  await check(
    page,
    'settings switch turns computer use on',
    async () => {
      await openSettings(page)
      if ((await statusBadge(page)) !== '已开启')
        await settingsSwitch(page, 'computer-use-enabled').click()
      await until(
        async () => (await statusBadge(page)) === '已开启',
        10_000,
        'badge 已开启',
      )
      await closeSettings(page)
    },
    { critical: true },
  )
  await check(
    page,
    'real model fills and submits the fixture form',
    async () => {
      await send(
        page,
        `请用内置浏览器打开 ${origin}/form ，把 Name 填成「张三」，Email 填成 zhangsan@example.com，国家选 Japan，勾选 I agree，然后提交表单，并确认页面出现提交成功的提示。不要填写密码、卡号和验证码。完成后用一句话告诉我结果。`,
      )
      // The site itself says what was submitted; the model may close the
      // tab once it has confirmed the result.
      const received = () =>
        site
          .submissions()
          .find(
            (item) =>
              item.path === '/done' &&
              item.fields.name === '张三' &&
              item.fields.email === 'zhangsan@example.com',
          )
      const cards = await answerCardsUntil(
        page,
        async () => {
          const submitted = received() !== undefined
          const idle =
            (await page.locator('.tool-row[data-state="running"]').count()) ===
            0
          const stopVisible = await page
            .getByRole('button', { name: /停止/ })
            .first()
            .isVisible()
            .catch(() => false)
          return submitted && idle && !stopVisible
        },
        () => 'session',
        5 * 60_000,
      )
      await page.waitForTimeout(3000)
      const tools = await page
        .locator('.tool-row')
        .evaluateAll((rows) =>
          rows.map(
            (row) =>
              `${row.getAttribute('data-tool')}:${row.getAttribute('data-state')}`,
          ),
        )
      await page.screenshot({
        path: join(shots, 'real-model.png'),
        fullPage: true,
      })
      const reply = (
        await page.locator('.assistant-step').last().innerText()
      ).slice(0, 400)
      const submission = received()!.fields
      if (
        submission.country !== 'Japan' ||
        submission.agree === undefined ||
        (submission.password ?? '') !== '' ||
        (submission.card ?? '') !== '' ||
        (submission.otp ?? '') !== ''
      )
        throw new Error(
          `unexpected submission ${JSON.stringify({ ...submission, csrf: undefined })}`,
        )
      return { cards, tools, reply, submission: { ...submission, csrf: '-' } }
    },
  )
}

async function main(): Promise<void> {
  mkdirSync(shots, { recursive: true })
  const site = await startFixtureSite()
  const model = real ? null : await startFakeModel()
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-fullstack-'))
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    if (real) await realModel(launched.page, site)
    else await fullstack(launched.app, launched.page, model!, site, home)
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
    await model?.close()
    await site.close()
    rmSync(home, { recursive: true, force: true })
    process.stdout.write('E2E-DONE\n')
  }
}

void main().then(() =>
  process.exit(results.every((result) => result.ok) ? 0 : 1),
)
