import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replyChunks, type ScriptedReply } from '../harness/testing'
import { isGuiToolName } from '../harness/computer-use/tools/catalog'
import { FakeComputerUsePort } from '../harness/computer-use/testing/fake-port'
import type { DriverCapability } from '../harness/computer-use/types'
import { eventOf, makeApi, tmp, waitFor, type ApiFixture } from './test-helpers'

// The Computer Use plugin (plugin contract §5, PL-09): the only source of
// the computer-use Skill, the master switch under another name, and a
// detail that shows each driver's real state.

const REPO = join(__dirname, '..', '..', '..', '..')
const PACKAGE = 'computer-use'
const REF = { pluginId: PACKAGE, scope: 'managed' } as const

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

/** A runtime root with the repository's built-in Skills and managed packages. */
function runtimeRoot(): string {
  const root = tmp('emperor-cu-plugin-')
  cpSync(join(REPO, 'skills'), join(root, 'skills'), { recursive: true })
  cpSync(
    join(REPO, 'packages', 'core', 'bundled-plugins'),
    join(root, 'bundled-plugins'),
    { recursive: true },
  )
  return root
}

async function cuApi(
  options: { port?: FakeComputerUsePort; replies?: ScriptedReply[] } = {},
) {
  const port = options.port ?? new FakeComputerUsePort()
  const fixture = await makeApi({
    root: runtimeRoot(),
    ...(options.replies ? { replies: options.replies } : {}),
    extra: {
      computerUsePort: port,
      github: { resolveRuntime: async () => null },
    },
  })
  fixtures.push(fixture)
  return { ...fixture, port }
}

function skillSources(api: ApiFixture['api'], name: string): string[] {
  return api.skills
    .list()
    .skills.filter((skill) => skill.name === name)
    .map((skill) => skill.source)
}

function row(api: ApiFixture['api']) {
  const found = api.plugins
    .list()
    .find((plugin) => plugin.pluginId === PACKAGE && plugin.scope === 'managed')
  if (!found) throw new Error('no Computer Use plugin row')
  return found
}

function guiTools(api: ApiFixture['api']): string[] {
  return api.host.tools.names().filter(isGuiToolName)
}

function lastToolText(request: { messages: Array<{ content?: unknown }> }) {
  const last = request.messages[request.messages.length - 1]
  return JSON.stringify(last?.content ?? '')
}

/** Everything the model was sent (a Skill catalog reminder can follow the tool result). */
function allText(request: { messages: Array<{ content?: unknown }> }) {
  return JSON.stringify(request.messages)
}

// As the desktop app's drivers report themselves (external-browser-driver.ts,
// port.ts): an unpaired Chrome is an experimental driver that is not ready;
// only a driver the machine lacks is `unavailable`.
const CHROME_NOT_PAIRED: DriverCapability = {
  driver: 'external-browser',
  platform: 'macos',
  stage: 'experimental',
  label: 'Chrome/Edge 连接',
  enabled: true,
  available: false,
  actions: ['click', 'fill'],
  missing: [],
  reason: '请在扩展中完成配对并连接标签页',
}

const HELPER_MISSING: DriverCapability = {
  driver: 'desktop',
  platform: 'macos',
  stage: 'unavailable',
  label: 'macOS 桌面',
  enabled: false,
  available: false,
  actions: [],
  missing: [],
  reason: '没有找到 Emperor Computer Helper',
}

describe('the Computer Use plugin', () => {
  it('is the only source of the computer-use Skill, listed only while it is on', async () => {
    const { api } = await cuApi()
    // Built-in Skills stay; computer-use is no longer one of them.
    expect(skillSources(api, 'skill-creator')).toEqual(['builtin'])
    expect(skillSources(api, 'computer-use')).toEqual([])

    await api.computerUse.setEnabled(true)
    expect(skillSources(api, 'computer-use')).toEqual(['plugin'])

    await api.plugins.setEnabled({ ...REF, enabled: false })
    expect(skillSources(api, 'computer-use')).toEqual([])
  })

  it('keeps the plugin and the settings switch in step, both ways', async () => {
    const { api, events } = await cuApi()
    expect([row(api).enabled, row(api).activation]).toEqual([false, 'disabled'])

    await api.computerUse.setEnabled(true)
    expect([row(api).enabled, row(api).activation]).toEqual([true, 'active'])

    await api.plugins.setEnabled({ ...REF, enabled: false })
    expect((await api.computerUse.status()).enabled).toBe(false)
    expect(guiTools(api)).toEqual([])

    await api.plugins.setEnabled({ ...REF, enabled: true })
    expect((await api.computerUse.status()).enabled).toBe(true)
    expect(guiTools(api).length).toBeGreaterThan(0)

    const reasons = (name: string) =>
      events
        .filter((event) => event.event === name)
        .map((event) => event.reason)
    expect(
      reasons('computer_use_changed').filter((r) => r === 'state'),
    ).toHaveLength(3)
    expect(reasons('plugins_changed').length).toBeGreaterThanOrEqual(3)
  })

  it('refuses the next GUI action once the plugin is turned off', async () => {
    const results: string[] = []
    const { api } = await cuApi({
      replies: [
        {
          tools: [
            {
              name: 'browser_open',
              args: { url: 'https://fixture.test/checkout' },
            },
          ],
        },
        (request) => {
          results.push(lastToolText(request))
          return replyChunks({ text: 'opened' })
        },
        {
          tools: [
            {
              name: 'browser_open',
              args: { url: 'https://fixture.test/checkout' },
            },
          ],
        },
        (request) => {
          results.push(lastToolText(request))
          return replyChunks({ text: 'refused' })
        },
      ],
    })
    await api.computerUse.setEnabled(true)
    const sessionId = String(api.sessions.create({ title: 'GUI' }).id)
    await api.chat.submit({ content: 'open it', sessionId })
    expect(results[0]).not.toContain('unknown tool')

    await api.plugins.setEnabled({ ...REF, enabled: false })
    const status = await api.computerUse.status()
    expect(
      status.targets.every(
        (target) => target.state === 'closed' || target.state === 'lost',
      ),
    ).toBe(true)

    await api.chat.submit({ content: 'again', sessionId })
    expect(results[1]).toContain('unknown tool \\"browser_open\\"')
  })

  it('switches off from the plugin page even while a card is pending', async () => {
    let refused = ''
    const { api, events } = await cuApi({
      replies: [
        {
          tools: [
            {
              name: 'browser_open',
              args: { url: 'https://fixture.test/checkout' },
            },
          ],
        },
        { tools: [{ name: 'browser_observe' }] },
        // High-impact: a card is asked for.
        { tools: [{ name: 'browser_click', args: { ref: 'r1.1' } }] },
        (request) => {
          refused = allText(request)
          return replyChunks({ text: 'stopped' })
        },
      ],
    })
    await api.computerUse.setEnabled(true)
    const sessionId = String(api.sessions.create({ title: 'GUI' }).id)
    const submitted = api.chat.submit({ content: 'go', sessionId })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)

    // Widening waits for the card; narrowing never does, as in Settings.
    await expect(
      api.plugins.setEnabled({ ...REF, enabled: true }),
    ).rejects.toThrow()
    await api.plugins.setEnabled({ ...REF, enabled: false })
    expect((await submitted).content).toBe('stopped')
    expect(refused).toContain('PERMISSION_DENIED')
    expect((await api.computerUse.status()).enabled).toBe(false)
  })

  it('never clears the emergency stop', async () => {
    const port = new FakeComputerUsePort()
    port.extraDrivers = [CHROME_NOT_PAIRED, HELPER_MISSING]
    const { api } = await cuApi({ port })
    await api.computerUse.setEnabled(true)
    await api.computerUse.stop()

    await api.plugins.setEnabled({ ...REF, enabled: false })
    await api.plugins.setEnabled({ ...REF, enabled: true })
    expect((await api.computerUse.status()).stopped).toBe(true)

    const detail = await api.plugins.getDetail(REF)
    expect(
      detail.components
        .filter((member) => member.kind === 'app')
        .map((member) => [member.id, member.state, member.reason]),
    ).toEqual([
      // A driver this machine lacks stays unsupported, stop or not.
      ['desktop', 'unsupported', '没有找到 Emperor Computer Helper'],
      [
        'embedded-browser',
        'disabled',
        '已急停；在「设置 › 电脑操作」里恢复后可用',
      ],
      [
        'external-browser',
        'disabled',
        '已急停；在「设置 › 电脑操作」里恢复后可用',
      ],
    ])
  })

  it("shows each driver's real state, and asks the host nothing while off", async () => {
    const port = new FakeComputerUsePort()
    port.extraDrivers = [CHROME_NOT_PAIRED, HELPER_MISSING]
    const { api } = await cuApi({ port })

    // Off: every member says the plugin is off, and the host (which may
    // launch the Helper to answer) is not asked.
    const before = port.capabilityCalls
    const off = await api.plugins.getDetail(REF)
    expect(off.components.map((member) => member.state)).toEqual([
      'disabled',
      'disabled',
      'disabled',
      'disabled',
    ])
    expect(port.capabilityCalls).toBe(before)

    await api.computerUse.setEnabled(true)
    const view = async () =>
      (await api.plugins.getDetail(REF)).components.map((member) => [
        member.kind,
        member.id,
        member.title,
        member.state,
        member.reason,
      ])
    expect(await view()).toEqual([
      ['skill', 'computer-use', 'computer-use', 'available', null],
      [
        'app',
        'desktop',
        'macOS 桌面',
        'unsupported',
        '没有找到 Emperor Computer Helper',
      ],
      ['app', 'embedded-browser', '内置浏览器', 'available', null],
      [
        'app',
        'external-browser',
        'Chrome/Edge 连接',
        'needs_connection',
        '请在扩展中完成配对并连接标签页',
      ],
    ])

    // A driver switched off in Settings, then the built-in browser gone.
    await api.computerUse.setDriverEnabled({
      driver: 'external-browser',
      enabled: false,
    })
    port.browser.available = false
    const after = await view()
    expect(after[2]).toEqual([
      'app',
      'embedded-browser',
      '内置浏览器',
      'needs_connection',
      expect.any(String),
    ])
    expect(after[3]).toEqual([
      'app',
      'external-browser',
      'Chrome/Edge 连接',
      'disabled',
      '已在「设置 › 电脑操作」里关闭',
    ])
  })

  it('cannot be uninstalled', async () => {
    const { api } = await cuApi()
    await expect(api.plugins.uninstall(REF)).rejects.toMatchObject({
      code: 'plugin_managed_uninstall_denied',
    })
    expect(row(api).uninstallable).toBe(false)
  })
})
