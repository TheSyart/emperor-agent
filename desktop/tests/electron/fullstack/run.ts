/**
 * Full-stack computer use suite: the real desktop app (dev build, isolated
 * Emperor Home) driven through its UI by Playwright, with a scripted model
 * server and the local fixture site. Covers the path of the AI-driven
 * experience (2026-09-29):
 *   switch on in Settings → trusted settings (profile, site permission,
 *   credential) → open / observe / fill / click / wait with no card → the
 *   conversation preview shows the tab while the task runs → the task end
 *   releases it (the preview goes, the page stays) → the next task's stale
 *   handle says released-at-task-end, it takes the tab back and moves to
 *   another site without a card → a high-impact click still asks, once →
 *   the emergency stop releases and blocks the next call → resume → a
 *   credential fill asks once and leaks nowhere → the Computer Use plugin
 *   (能力 › 插件) shows its drivers, and turning it off refuses the next
 *   call and turns Settings off (and back on from Settings) → the plugin
 *   switch never clears the emergency stop → switching off closes every
 *   Agent tab.
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
import {
  lastToolResult,
  refIn,
  startFakeModel,
  summaryIn,
  type FakeModel,
  type Step,
  type StepReply,
} from './fake-model'

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

/** Unfold 高级 (profiles, credentials, downloads …) in the open section. */
async function openAdvanced(page: Page): Promise<void> {
  const advanced = page
    .getByRole('dialog', { name: '设置' })
    .getByTestId('computer-use-advanced')
  if ((await advanced.getAttribute('open')) === null)
    await advanced.locator('summary').click()
  await until(
    async () => (await advanced.getAttribute('open')) !== null,
    5_000,
    '高级 open',
  )
}

/** The master switch. */
function settingsSwitch(page: Page) {
  return page
    .getByRole('dialog', { name: '设置' })
    .locator('#computer-use-enabled')
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
  const box = page.getByLabel('消息输入框').first()
  await box.click()
  await box.fill(text)
  await box.press('Enter')
}

/**
 * Answer grant cards as they come until `done` holds; returns the targets
 * seen. Only high-impact actions and credential fills show a card now, and
 * a card allows this one call only.
 */
async function answerCardsUntil(
  page: Page,
  done: () => Promise<boolean>,
  answer: (card: { target: string; highImpact: boolean }) => 'once' | 'deny',
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
      await card
        .getByRole('button', { name: choice === 'deny' ? '拒绝' : '允许' })
        .click()
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

/**
 * A step that waits until `release()` before answering: the turn (and the
 * task) stays open meanwhile, so its controlled targets can be looked at.
 */
function hold(reply: StepReply): {
  step: Step
  readonly reached: boolean
  release: () => void
} {
  let reached = false
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    step: async () => {
      reached = true
      await released
      return reply
    },
    get reached() {
      return reached
    },
    release: () => release(),
  }
}

/** Tool rows (`tool:state`) in the conversation. */
async function toolStates(page: Page): Promise<string[]> {
  return await page
    .locator('.tool-row')
    .evaluateAll((rows) =>
      rows.map(
        (row) =>
          `${row.getAttribute('data-tool')}:${row.getAttribute('data-state')}`,
      ),
    )
}

async function cardShown(page: Page): Promise<boolean> {
  return await page
    .locator('[data-takeover="grant"]')
    .isVisible()
    .catch(() => false)
}

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
      await settingsSwitch(page).click()
      await until(
        async () => (await statusBadge(page)) === '已开启',
        10_000,
        'badge 已开启',
      )
      await page.screenshot({ path: join(shots, 'settings-on.png') })
      await closeSettings(page)
    },
    { critical: true },
  )

  await check(
    page,
    'M2 settings manage profile, permission and credential through trusted UI',
    async () => {
      await openSettings(page)
      await openAdvanced(page)
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

  // Turn 1: open / observe / fill / click / wait / screenshot, no card. The
  // last step waits so the preview can be looked at while the task runs.
  const last = hold({ text: '表单已提交，页面显示 Thanks for signing up。' })
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
    last.step,
  )
  await check(
    page,
    'turn 1: open, observe, fill, click and wait run without a card',
    async () => {
      await send(page, `请打开 ${origin}/form，填写姓名和邮箱后提交。`)
      await until(() => last.reached, 60_000, 'the last step of the task')
      if (await cardShown(page))
        throw new Error('a grant card was shown for ordinary actions')
      const tools = await toolStates(page)
      const failed = tools.filter(
        (entry) => entry.startsWith('browser_') && !entry.endsWith(':ok'),
      )
      if (failed.length > 0)
        throw new Error(
          `failed rows: ${failed.join(', ')} (all: ${tools.join(', ')})`,
        )
      return { tools }
    },
    { critical: true },
  )

  await check(
    page,
    'the conversation preview shows the tab read-only while the task runs',
    async () => {
      const preview = page.locator('.cu-preview')
      await preview.waitFor({ timeout: 10_000 })
      const card = preview.locator('.cu-card').first()
      const status = (await card.locator('.cu-card-status').innerText()).trim()
      if (status !== '操作中') throw new Error(`card status ${status}`)
      await until(
        async () =>
          ((await card.locator('img').first().getAttribute('src')) ?? '')
            .length > 0,
        15_000,
        'a frame in the card',
      )
      const text = await preview.innerText()
      for (const word of ['暂停', '接管', '交还'])
        if (text.includes(word)) throw new Error(`preview offers ${word}`)
      await page.screenshot({ path: join(shots, 'preview-live.png') })
      return {
        title: (await card.locator('.cu-card-title').innerText()).trim(),
      }
    },
  )

  await check(
    page,
    'the task end releases the tab: the preview goes, the page stays',
    async () => {
      last.release()
      await until(
        () => assistantSaid(page, '表单已提交'),
        30_000,
        'the closing reply',
      )
      await until(
        async () =>
          !(await page
            .locator('.cu-preview')
            .isVisible()
            .catch(() => false)),
        15_000,
        'the preview group to go',
      )
      const status = await core<{ targets: unknown[] }>(
        page,
        'computerUse.status',
      )
      if (status.targets.length !== 0)
        throw new Error(`targets after the task: ${JSON.stringify(status)}`)
      await page.screenshot({ path: join(shots, 'after-release.png') })
    },
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

  // Turn 2: the old handle says it was released; the task takes the tab
  // back and moves to another site, with no card.
  let staleResult = ''
  let listed: unknown
  model.enqueue(
    call('browser_observe'),
    (request) => {
      staleResult = lastToolResult(request)
      return { tools: [{ name: 'browser_tab_list', args: {} }] }
    },
    (request) => {
      listed = summaryIn(request)
      const tabs = (listed as { tabs?: Array<Record<string, unknown>> }).tabs
      const tab = tabs?.find((item) => item.released === true)
      if (tab === undefined)
        throw new Error(`no released tab listed: ${JSON.stringify(listed)}`)
      return {
        tools: [
          { name: 'browser_tab_select', args: { targetId: tab.targetId } },
        ],
      }
    },
    call('browser_observe'),
    call('browser_navigate', { url: `${other}/embed` }),
    say('已重新接手标签页并打开另一个站点。'),
  )
  await check(
    page,
    'turn 2: a stale handle says released, the tab is taken back and moves on without a card',
    async () => {
      await send(page, `继续用刚才的标签页，再打开 ${other}/embed。`)
      const cards = await answerCardsUntil(
        page,
        () => assistantSaid(page, '已重新接手'),
        () => 'deny',
      )
      if (cards.length !== 0)
        throw new Error(`unexpected cards: ${JSON.stringify(cards)}`)
      if (!staleResult.includes('released-at-task-end'))
        throw new Error(`first observe answered: ${staleResult.slice(0, 300)}`)
      for (const tool of [
        'browser_tab_select',
        'browser_observe',
        'browser_navigate',
      ]) {
        const state = await toolRow(page, tool)
          .last()
          .getAttribute('data-state')
        if (state !== 'ok') throw new Error(`${tool} ${state}`)
      }
      return { listed }
    },
  )

  // Turn 3: a high-impact click asks for this one action.
  model.enqueue(
    call('browser_tab_list'),
    (request) => {
      const tabs = (
        summaryIn(request) as {
          tabs?: Array<Record<string, unknown>>
        }
      ).tabs
      const tab = tabs?.find((item) => item.released === true)
      if (tab === undefined) throw new Error('no released tab to take back')
      return {
        tools: [
          { name: 'browser_tab_select', args: { targetId: tab.targetId } },
        ],
      }
    },
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
    'turn 3: a high-impact click still asks, for this action only',
    async () => {
      await send(page, '回到结账页点击付款。')
      const cards = await answerCardsUntil(
        page,
        () => assistantSaid(page, '已完成付款确认'),
        () => 'once',
      )
      if (cards.length !== 1 || !cards[0]!.highImpact)
        throw new Error(`cards: ${JSON.stringify(cards)}`)
      await page.screenshot({ path: join(shots, 'turn3-high-impact.png') })
      return { cards: cards.length }
    },
  )

  // Turn 4: the emergency stop blocks the next action until resumed.
  await check(
    page,
    'emergency stop blocks the next action; resume restores',
    async () => {
      await openSettings(page)
      await page
        .getByRole('dialog', { name: '设置' })
        .getByRole('button', { name: '立即停止' })
        .click()
      await until(
        async () => (await statusBadge(page)) === '已急停',
        10_000,
        'badge 已急停',
      )
      await closeSettings(page)
      model.enqueue(call('browser_observe'), (request) => {
        const text = lastToolResult(request)
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
      // Credential fills always ask, once.
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
      await openAdvanced(page)
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

  // PL-09: the Computer Use plugin is the master switch under another name.
  await check(
    page,
    'turning the Computer Use plugin off blocks the next action, and Settings follows',
    async () => {
      await page
        .getByRole('navigation', { name: '侧栏导航' })
        .getByRole('button', { name: '能力', exact: true })
        .click()
      await page.locator('[data-plugin-id="computer-use"]').first().click()
      const detail = page.locator('[data-plugin-detail="computer-use"]')
      await detail.waitFor()
      // Its Skill and the three drivers, each with a state.
      for (const member of [
        'computer-use',
        'embedded-browser',
        'external-browser',
        'desktop',
      ])
        await detail.locator(`[data-member="${member}"]`).waitFor()
      await page.screenshot({ path: join(shots, 'plugin-detail-on.png') })

      await detail.getByRole('switch', { name: '启用' }).click()
      await until(
        async () =>
          !(await core<{ enabled: boolean }>(page, 'computerUse.status'))
            .enabled,
        10_000,
        'the master switch to follow the plugin',
      )
      // Back to the conversation (the list, then the detail, were pushed).
      const composer = page.getByLabel('消息输入框').first()
      for (let step = 0; step < 3 && !(await composer.isVisible()); step += 1)
        await page.goBack()
      await composer.waitFor({ timeout: 10_000 })
      // Once off, the agent's request carries no GUI tools; the model
      // calls one anyway and must be refused.
      let refused = ''
      model.enqueue(call('browser_observe'), (request) => {
        refused = lastToolResult(request)
        return {
          text: refused.includes('unknown tool')
            ? '电脑操作已关闭。'
            : `意外结果：${refused.slice(0, 200)}`,
        }
      })
      await send(page, '再看一下刚才的页面。')
      // What the model was told is the evidence; the reply may still be
      // below the fold of a long conversation.
      await until(
        async () => refused !== '',
        30_000,
        'the model to see the refused call',
      )
      if (!refused.includes('unknown tool'))
        throw new Error(`observe answered: ${refused.slice(0, 300)}`)
      await until(
        async () => {
          const bottom = page.getByRole('button', { name: '回到底部' })
          if (await bottom.isVisible().catch(() => false))
            await bottom.click().catch(() => undefined)
          return await assistantSaid(page, '电脑操作已关闭')
        },
        30_000,
        'the reply',
      )
      await page.screenshot({ path: join(shots, 'plugin-off-refused.png') })
      const skills = await core<{ skills: Array<{ name: string }> }>(
        page,
        'skills.list',
      )
      if (skills.skills.some((skill) => skill.name === 'computer-use'))
        throw new Error('the computer-use Skill is still listed')

      // Settings shows it off; turning it on there turns the plugin on.
      await openSettings(page)
      if ((await statusBadge(page)) !== '已关闭')
        throw new Error(`badge ${await statusBadge(page)}`)
      await settingsSwitch(page).click()
      await until(
        async () => (await statusBadge(page)) === '已开启',
        10_000,
        'badge 已开启',
      )
      await closeSettings(page)
      await until(
        async () =>
          (
            await core<Array<{ pluginId: string; activation: string }>>(
              page,
              'plugins.list',
            )
          ).some(
            (plugin) =>
              plugin.pluginId === 'computer-use' &&
              plugin.activation === 'active',
          ),
        10_000,
        'the plugin to follow Settings',
      )
      return { refused: refused.slice(0, 120) }
    },
  )

  await check(
    page,
    'the plugin switch never clears the emergency stop',
    async () => {
      await core(page, 'computerUse.stop')
      const ref = { pluginId: 'computer-use', scope: 'managed' }
      await core(page, 'plugins.setEnabled', { ...ref, enabled: false })
      await core(page, 'plugins.setEnabled', { ...ref, enabled: true })
      const status = await core<{ enabled: boolean; stopped: boolean }>(
        page,
        'computerUse.status',
      )
      if (!status.enabled || !status.stopped)
        throw new Error(`after off and on: ${JSON.stringify(status)}`)
      const detail = await core<{
        components: Array<{ id: string; state: string; reason: string | null }>
      }>(page, 'plugins.getDetail', ref)
      const browser = detail.components.find(
        (member) => member.id === 'embedded-browser',
      )
      if (browser?.state !== 'disabled' || !browser.reason?.includes('急停'))
        throw new Error(`built-in browser: ${JSON.stringify(browser)}`)
      await core(page, 'computerUse.resume')
      return { drivers: detail.components.map((member) => member.state) }
    },
  )

  await check(
    page,
    'switching off closes every Agent tab and removes the tools',
    async () => {
      await openSettings(page)
      await settingsSwitch(page).click()
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
        await settingsSwitch(page).click()
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
        () => 'once',
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
  const model = real
    ? null
    : await startFakeModel({ agentTool: ['browser_open', 'bash'] })
  const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-fullstack-'))
  let app: ElectronApplication | null = null
  try {
    prepareHome(home, model)
    const launched = await launch(home)
    app = launched.app
    if (real) await realModel(launched.page, site)
    else await fullstack(launched.page, model!, site, home)
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
