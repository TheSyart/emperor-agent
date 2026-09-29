// Read-only GUI tools through the real stack (CoreApi → registry → gate →
// tools → kernel → fake port): browser_profile_list, and ui_get_capabilities
// against computerUse.status (both must read the same live capabilities).
import { afterEach, describe, expect, it } from 'vitest'
import { eventOf, makeApi, type ApiFixture } from '../../../api/test-helpers'
import type { GenerateOptions } from '../../../llm/types'
import type { ComputerUseSettings } from '../service/service'
import { replyChunks, type ScriptedReply } from '../../testing'
import { FakeComputerUsePort } from '../testing/fake-port'
import type { DriverCapability } from '../types'

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

type Block = { type: string; text?: string; content?: Block[] }

/** The JSON summary of the last tool result the model received. */
function summary(request: GenerateOptions): Record<string, unknown> {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const content = (request.messages[index]?.content ?? []) as Block[]
    const result = content.find((block) => block.type === 'tool-result')
    if (result === undefined) continue
    const text =
      (result.content ?? []).find((block) => block.type === 'text')?.text ??
      '{}'
    return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
  }
  return {}
}

/** A turn that calls `tool` and hands its summary to `seen`. */
function turn(
  tool: string,
  args: unknown,
  seen: Array<Record<string, unknown>>,
): ScriptedReply[] {
  return [
    { tools: [{ name: tool, args }] },
    (request) => {
      seen.push(summary(request))
      return replyChunks({ text: `${tool} done` })
    },
  ]
}

async function setup(
  replies: ScriptedReply[],
  settings: { current: ComputerUseSettings },
) {
  const port = new FakeComputerUsePort()
  const fixture = await makeApi({
    replies,
    extra: {
      computerUsePort: port,
      computerUseSettings: () => settings.current,
    },
  })
  fixtures.push(fixture)
  const id = String(fixture.api.sessions.create({ title: 'GUI' }).id)
  return { ...fixture, id, port }
}

describe('browser_profile_list', () => {
  it('lists the temporary and persistent profiles with open tabs, without a grant card', async () => {
    const settings = {
      current: {
        enabled: true,
        authorizationMode: 'scoped',
      } as ComputerUseSettings,
    }
    const seen: Array<Record<string, unknown>> = []
    let profileId = ''
    const { api, events, id } = await setup(
      [
        ...turn('browser_profile_list', {}, seen),
        (_request) =>
          replyChunks({
            tools: [
              {
                name: 'browser_open',
                args: { url: 'https://fixture.test/form', profile: profileId },
              },
            ],
          }),
        ...turn('browser_profile_list', {}, seen),
      ],
      settings,
    )
    const { profile } = await api.computerUse.manageProfile({
      action: 'create',
      name: '邮箱',
    })
    profileId = profile!.profileId

    // Scoped mode: an info tool never asks.
    await api.chat.submit({ content: 'which profiles?', sessionId: id })
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(seen[0]).toEqual({
      status: 'ok',
      tool: 'browser_profile_list',
      profiles: [
        {
          profileId: 'temporary',
          name: '临时',
          kind: 'temporary',
          openTabs: 0,
        },
        { profileId, name: '邮箱', kind: 'persistent', openTabs: 0 },
      ],
    })

    // Open a tab in the profile (unrestricted: no card), then list again.
    settings.current = { enabled: true, authorizationMode: 'unrestricted' }
    await api.chat.submit({ content: 'use the mail profile', sessionId: id })
    const profiles = seen[1]!.profiles as Array<Record<string, unknown>>
    expect(seen[1]!.status).toBe('ok')
    expect(profiles).toEqual([
      expect.objectContaining({ profileId: 'temporary', openTabs: 0 }),
      expect.objectContaining({
        profileId,
        kind: 'persistent',
        openTabs: 1,
        lastUsedAt: expect.any(String),
      }),
    ])
    // The tool reads the same view the settings page does.
    expect(
      api.host.computerUse!.service.listProfiles().map((item) => ({
        profileId: item.profileId,
        openTabs: item.openTargets,
      })),
    ).toEqual(
      profiles.map((item) => ({
        profileId: item.profileId,
        openTabs: item.openTabs,
      })),
    )
    const results = api.host
      .sessionLog(id)!
      .events.filter(
        (event) =>
          event.type === 'tool/result' &&
          JSON.stringify(event.data).includes('browser_profile_list'),
      )
    expect(results).toHaveLength(2)
  })
})

describe('ui_get_capabilities and computerUse.status', () => {
  /** What ui_get_capabilities shows of one status driver. */
  const shown = (driver: DriverCapability) => ({
    driver: driver.driver,
    stage: driver.stage,
    label: driver.label,
    available: driver.available,
    actions: driver.actions,
    missing: driver.missing,
    ...(driver.reason === undefined ? {} : { reason: driver.reason }),
  })

  it('report the same drivers, availability and stop state from one source', async () => {
    const settings = { current: { enabled: true } as ComputerUseSettings }
    const seen: Array<Record<string, unknown>> = []
    const { api, id, port } = await setup(
      [
        ...turn('ui_get_capabilities', {}, seen),
        ...turn('ui_get_capabilities', {}, seen),
        ...turn('ui_get_capabilities', {}, seen),
        ...turn('ui_get_capabilities', {}, seen),
      ],
      settings,
    )
    const statuses: unknown[] = []
    const compare = async () => {
      await api.chat.submit({ content: 'what can you do?', sessionId: id })
      const status = await api.computerUse.status()
      statuses.push(status)
      const tool = seen.at(-1)!
      expect(tool.status).toBe('ok')
      expect(tool.platform).toBe(status.platform)
      expect(tool.stopped).toBe(status.stopped)
      expect(tool.drivers).toEqual(status.drivers.map(shown))
      return status.drivers.find((item) => item.driver === 'embedded-browser')!
    }

    // 1. Everything on.
    expect(await compare()).toMatchObject({ enabled: true, available: true })

    // 2. The driver itself becomes unavailable: both read the live port.
    port.browser.available = false
    expect(await compare()).toMatchObject({ enabled: true, available: false })
    port.browser.available = true

    // 3. The user switches the driver off.
    settings.current = {
      enabled: true,
      drivers: { 'embedded-browser': false },
    }
    expect(await compare()).toMatchObject({ enabled: false, available: false })
    settings.current = { enabled: true }

    // 4. Emergency stop: unavailable with the same reason in both.
    await api.computerUse.stop()
    expect(await compare()).toMatchObject({
      enabled: true,
      available: false,
      reason: 'emergency stop is engaged',
    })
    expect(seen.at(-1)!.stopped).toBe(true)
    expect(statuses).toHaveLength(4)
  })
})
