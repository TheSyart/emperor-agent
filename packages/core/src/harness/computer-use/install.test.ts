import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  eventOf,
  makeApi,
  pendingInteractionId,
  waitFor,
  type ApiFixture,
} from '../../api/test-helpers'
import type { GenerateOptions } from '../../llm/types'
import { replyChunks, type ScriptedReply } from '../testing'
import { COMPUTER_USE_CONFIG_FILE, ComputerUseConfigStore } from './config'
import { computerUseStateDir } from './install'
import { FakeComputerUsePort } from './testing/fake-port'
import { GUI_TOOL_CATALOG, isGuiToolName } from './tools/catalog'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

/** The renderer shows no session (KRN-01 view scope). */
const VIEW = { sessionId: null }

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function api(extra: Parameters<typeof makeApi>[0] = {}) {
  const fixture = await makeApi(extra)
  fixtures.push(fixture)
  return fixture
}

function promptText(core: ApiFixture['api']): string {
  return core.host.prompt
    .assemble({})
    .sections.map((section) => section.text)
    .join('\n')
}

const GUI_TOOLS = Object.keys(GUI_TOOL_CATALOG).length

function guiTools(names: string[]): string[] {
  return names.filter(isGuiToolName).sort()
}

describe('computer use host wiring', () => {
  it('offers no GUI tools and no kernel on a host without a port', async () => {
    const { api: core } = await api()
    expect(core.host.computerUse).toBeNull()
    expect(guiTools(core.host.tools.names())).toEqual([])
  })

  it('registers every cataloged GUI tool only while the master switch is on', async () => {
    let enabled = true
    const { api: core } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled }),
      },
    })
    const installed = core.host.computerUse!
    expect(installed).not.toBeNull()
    const registered = guiTools(core.host.tools.names())
    // The catalog and the registered tools never drift apart.
    expect(registered).toEqual(Object.keys(GUI_TOOL_CATALOG).sort())
    expect(promptText(core)).toContain(
      'Computer use (ui_*, browser_*, external_*, desktop_* tools)',
    )

    enabled = false
    installed.setEnabled(false)
    expect(guiTools(core.host.tools.names())).toEqual([])
    expect(promptText(core)).not.toContain('Computer use (ui_*')
    installed.setEnabled(true)
    expect(guiTools(core.host.tools.names())).toHaveLength(GUI_TOOLS)
  })

  it('reports an unsupported status on hosts without a port', async () => {
    const { api: core } = await api()
    expect(await core.computerUse.status()).toMatchObject({
      supported: false,
      enabled: false,
      drivers: [],
    })
  })

  it('reports the status through CoreApi', async () => {
    const { api: core } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    expect(await core.computerUse.status()).toMatchObject({
      supported: true,
      enabled: true,
      platform: 'macos',
      drivers: [{ driver: 'embedded-browser', enabled: true, available: true }],
    })
  })

  it('has no manual control, per-item mode, grant list, emergency stop or app list operations', async () => {
    const { api: core } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    for (const name of [
      'controlTarget',
      'setAuthorizationMode',
      'listGrants',
      'revokeGrant',
      'narrowGrant',
      'stop',
      'resume',
      'setKillSwitch',
      'setAppLists',
    ])
      expect(core.computerUse).not.toHaveProperty(name)
    const status = await core.computerUse.status()
    for (const field of [
      'authorizationMode',
      'stopped',
      'stopReason',
      'killSwitch',
      'appLists',
    ])
      expect(status).not.toHaveProperty(field)
  })

  it('reports a URL-free computer use summary in diagnostics', async () => {
    const { api: core } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    core.host.computerUse!.grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://secret-origin.test'],
      },
      allowedActions: ['observe'],
      scope: 'session',
      backgroundAllowed: false,
    })
    const payload = (await core.diagnostics.get(VIEW)) as unknown as {
      computerUse: Record<string, unknown>
    }
    expect(payload.computerUse).toMatchObject({
      supported: true,
      enabled: true,
      targets: 0,
      drivers: [{ driver: 'embedded-browser', available: true }],
    })
    expect(payload.computerUse).not.toHaveProperty('grants')
    expect(payload.computerUse).not.toHaveProperty('killSwitch')
    // Counts only: no origin, URL or grant detail leaves the machine.
    expect(JSON.stringify(payload)).not.toContain('secret-origin')
    const { api: bare } = await api()
    expect(
      (
        (await bare.diagnostics.get(VIEW)) as unknown as {
          computerUse: unknown
        }
      ).computerUse,
    ).toMatchObject({ supported: false, enabled: false })
  })

  it('installs the gate even while the tools are off', async () => {
    const { api: core } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: false }),
      },
    })
    expect(guiTools(core.host.tools.names())).toEqual([])
    expect(core.host.tools.preExecute.length).toBeGreaterThanOrEqual(2)
  })
})

describe('computer use master switch', () => {
  it('stores the switch off by default, 0600, and reads a corrupt file as off', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-config-'))
    const store = new ComputerUseConfigStore(root)
    expect(store.get()).toEqual({
      enabled: false,
      drivers: {},
      downloadRetentionDays: 30,
    })
    store.update({ enabled: true, drivers: { 'embedded-browser': true } })
    const path = join(root, COMPUTER_USE_CONFIG_FILE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      enabled: true,
    })
    expect(new ComputerUseConfigStore(root).get()).toEqual({
      enabled: true,
      drivers: { 'embedded-browser': true },
      downloadRetentionDays: 30,
    })
    writeFileSync(
      path,
      '{"schemaVersion":1,"enabled":true,"drivers":{"desktop":false}}',
    )
    // An older file without retention reads with the default.
    expect(new ComputerUseConfigStore(root).get()).toEqual({
      enabled: true,
      drivers: { desktop: false },
      downloadRetentionDays: 30,
    })
    store.update({ downloadRetentionDays: 7 })
    expect(new ComputerUseConfigStore(root).get().downloadRetentionDays).toBe(7)
    writeFileSync(path, '{"schemaVersion":1,"enabled":"yes"}')
    expect(new ComputerUseConfigStore(root).get().enabled).toBe(false)
  })

  it('drops the retired app lists and stop shortcut once, never quarantining the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-lists-'))
    const path = join(root, COMPUTER_USE_CONFIG_FILE)
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        drivers: { desktop: true },
        downloadRetentionDays: 7,
        killSwitchAccelerator: 'Control+Alt+Command+.',
        appLists: {
          protected: ['com.example.Bank', 'com.example.Bank'],
          highRisk: ['com.googlecode.iterm2'],
          sensitive: ['com.1password.1password'],
        },
      }),
    )
    const store = new ComputerUseConfigStore(root)
    expect(store.get()).toEqual({
      enabled: true,
      drivers: { desktop: true },
      downloadRetentionDays: 7,
    })
    // Written back once without the retired fields; nothing quarantined.
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).not.toHaveProperty('appLists')
    expect(saved).not.toHaveProperty('killSwitchAccelerator')
    expect(readdirSync(root).some((name) => name.includes('corrupt'))).toBe(
      false,
    )
    // The apps the user kept from Emperor are remembered for one notice.
    expect(store.retiredProtectedApps()).toEqual(['com.example.Bank'])
    expect(new ComputerUseConfigStore(root).retiredProtectedApps()).toEqual([
      'com.example.Bank',
    ])
    store.acknowledgeRetiredProtectedApps()
    expect(store.retiredProtectedApps()).toEqual([])
    expect(new ComputerUseConfigStore(root).retiredProtectedApps()).toEqual([])

    // Malformed leftovers are dropped too, never a reason to switch off.
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        killSwitchAccelerator: 42,
        appLists: { protected: 'x', extra: [1] },
      }),
    )
    const messy = new ComputerUseConfigStore(root)
    expect(messy.get().enabled).toBe(true)
    expect(messy.retiredProtectedApps()).toEqual([])
    expect(readdirSync(root).some((name) => name.includes('corrupt'))).toBe(
      false,
    )
  })

  it('switches a saved per-item mode off once, with a notice until the user switches on', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-scoped-'))
    const path = join(root, COMPUTER_USE_CONFIG_FILE)
    mkdirSync(root, { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        authorizationMode: 'scoped',
        drivers: { desktop: true },
      }),
    )
    const store = new ComputerUseConfigStore(root)
    expect(store.get()).toMatchObject({
      enabled: false,
      scopedRetired: true,
      drivers: { desktop: true },
    })
    // Written back at once without the retired field.
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).toMatchObject({ enabled: false, scopedRetired: true })
    expect(saved).not.toHaveProperty('authorizationMode')
    expect(new ComputerUseConfigStore(root).get().enabled).toBe(false)
    // An unrestricted file only loses the field.
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        authorizationMode: 'unrestricted',
      }),
    )
    const unrestricted = new ComputerUseConfigStore(root).get()
    expect(unrestricted.enabled).toBe(true)
    expect(unrestricted.scopedRetired).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty(
      'authorizationMode',
    )
    // Switching on is the confirmation: the notice goes away.
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, enabled: false, scopedRetired: true }),
    )
    const again = new ComputerUseConfigStore(root)
    expect(again.update({ drivers: { desktop: false } }).scopedRetired).toBe(
      true,
    )
    expect(again.update({ enabled: true }).scopedRetired).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty(
      'scopedRetired',
    )
  })

  it('persists the switch through CoreApi and adds or removes the tools', async () => {
    const changes: boolean[] = []
    const {
      api: core,
      events,
      stateRoot,
      root,
    } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseEnabledChanged: (enabled: boolean) => changes.push(enabled),
      },
    })
    expect(guiTools(core.host.tools.names())).toEqual([])
    expect((await core.computerUse.status()).enabled).toBe(false)

    expect((await core.computerUse.setEnabled(true, VIEW)).enabled).toBe(true)
    expect(guiTools(core.host.tools.names())).toHaveLength(GUI_TOOLS)
    expect(
      new ComputerUseConfigStore(computerUseStateDir(stateRoot)).get().enabled,
    ).toBe(true)

    // A fresh host on the same state root starts with the switch on.
    const { api: again } = await api({
      root,
      stateRoot,
      extra: { computerUsePort: new FakeComputerUsePort() },
    })
    expect(guiTools(again.host.tools.names())).toHaveLength(GUI_TOOLS)

    expect((await core.computerUse.setEnabled(false, VIEW)).enabled).toBe(false)
    expect(guiTools(core.host.tools.names())).toEqual([])
    expect(changes).toEqual([true, false])
    expect(
      events.filter(
        (event) =>
          event.event === 'computer_use_changed' && event.reason === 'state',
      ),
    ).toHaveLength(2)
  })

  it('switches one driver and keeps its tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-driver-'))
    const stateRoot = join(root, 'home')
    const port = new FakeComputerUsePort()
    const { api: core } = await api({
      root,
      stateRoot,
      extra: { computerUsePort: port },
    })
    await core.computerUse.setEnabled(true, VIEW)
    const view = await core.computerUse.setDriverEnabled(
      {
        driver: 'embedded-browser',
        enabled: false,
      },
      VIEW,
    )
    const embedded = view.drivers.find(
      (driver) => driver.driver === 'embedded-browser',
    )
    expect(embedded).toMatchObject({ enabled: false, available: false })
    // Spec 00 §8.4: the tools stay; calls answer CAPABILITY_DISABLED.
    expect(guiTools(core.host.tools.names())).toHaveLength(GUI_TOOLS)
    expect(
      new ComputerUseConfigStore(computerUseStateDir(stateRoot)).get().drivers,
    ).toEqual({ 'embedded-browser': false })
    await core.computerUse.setDriverEnabled(
      {
        driver: 'embedded-browser',
        enabled: true,
      },
      VIEW,
    )
    expect(
      new ComputerUseConfigStore(computerUseStateDir(stateRoot)).get().drivers,
    ).toEqual({ 'embedded-browser': true })
  })

  it('switches off while a grant card is pending, refusing the card', async () => {
    let refused = ''
    const { api: core, events } = await api({
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
        // High-impact: a card is still asked for, one action at a time.
        { tools: [{ name: 'browser_click', args: { ref: 'r1.1' } }] },
        (request) => {
          const messages = request.messages
          refused = JSON.stringify(messages[messages.length - 1]?.content ?? '')
          return replyChunks({ text: 'stopped' })
        },
      ],
      extra: { computerUsePort: new FakeComputerUsePort() },
    })
    await core.computerUse.setEnabled(true, VIEW)
    const id = String(core.sessions.create({ title: 'GUI' }).id)
    const submitted = core.chat.submit({ content: 'go', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    // A card pending in the chat shown gates no setting (FIX-10); switching
    // off refuses the card.
    const shown = { sessionId: id }
    await expect(
      core.computerUse.setEnabled(true, shown),
    ).resolves.toMatchObject({ enabled: true })
    await core.computerUse.setEnabled(false, shown)
    expect((await submitted).content).toBe('stopped')
    expect(refused).toContain('PERMISSION_DENIED')
    expect((await core.computerUse.status()).targets).toEqual([])
  })
})

describe('computer use browser profiles', () => {
  it('opens a tab in a persistent profile and asks per profile for a high-impact action', async () => {
    const port = new FakeComputerUsePort()
    const { api: core, events } = await api({
      replies: [
        {
          tools: [
            {
              name: 'browser_profile_manage',
              args: { action: 'create', name: '工作' },
            },
          ],
        },
        (request) => {
          const text = JSON.stringify(
            request.messages[request.messages.length - 1]?.content ?? '',
          )
          const profileId = /p_[0-9a-f]{12}/.exec(text)?.[0] ?? 'missing'
          return replyChunks({
            tools: [
              {
                name: 'browser_open',
                args: {
                  url: 'https://fixture.test/checkout',
                  profile: profileId,
                },
              },
            ],
          })
        },
        { tools: [{ name: 'browser_observe' }] },
        // Opening ran without a card; paying asks, scoped to this profile.
        { tools: [{ name: 'browser_click', args: { ref: 'r1.1' } }] },
        {
          tools: [
            {
              name: 'browser_profile_manage',
              args: { action: 'delete', profileId: 'p_000000000000' },
            },
          ],
        },
        { text: 'done' },
      ],
      extra: {
        computerUsePort: port,
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const id = String(core.sessions.create({ title: 'GUI' }).id)
    const submitted = core.chat.submit({ content: 'go', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const card = eventOf(events, 'ask_request')!.interaction as {
      id: string
      meta: { grant: { target_scope: { profileId: string } } }
    }
    const [profile] = core.computerUse
      .listProfiles()
      .filter((item) => item.kind === 'persistent')
    expect(profile).toMatchObject({ name: '工作' })
    expect(card.meta.grant.target_scope.profileId).toBe(profile!.profileId)
    await core.control.answerInteraction(card.id, {
      grant: { option_id: 'once' },
    })
    expect((await submitted).content).toBe('done')
    const target = port.browser.list()[0]!
    expect(target.profileId).toBe(profile!.profileId)
    expect(
      core.computerUse
        .listProfiles()
        .find((item) => item.profileId === profile!.profileId),
    ).toMatchObject({ openTargets: 1, lastUsedAt: expect.any(String) })
    // The model cannot clear or delete: the refusal names the user path.
    const refusal = core.host
      .agentFor(id)
      .session.events.find(
        (event) =>
          event.type === 'tool/result' &&
          JSON.stringify(event.data).includes(
            'only the user can clear or delete',
          ),
      )
    expect(refusal).toBeDefined()
  })

  it('starts over a corrupt grants file with no grants, usable at once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-corrupt-'))
    const stateRoot = join(root, 'home')
    const dir = computerUseStateDir(stateRoot)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'grants.json'), '{ not json', { mode: 0o600 })
    const { api: core } = await api({
      root,
      stateRoot,
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const status = await core.computerUse.status()
    expect(status).toMatchObject({ enabled: true })
    expect(status.drivers[0]).toMatchObject({ available: true })
    expect(status).not.toHaveProperty('stopReason')
    expect(core.host.computerUse!.grants.list()).toEqual([])
    expect(readdirSync(dir).some((name) => name.includes('corrupt'))).toBe(true)
  })

  it('clears and deletes a profile: closes its tabs, wipes it, revokes its grants', async () => {
    const port = new FakeComputerUsePort()
    const { api: core } = await api({
      extra: {
        computerUsePort: port,
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const { profile } = await core.computerUse.manageProfile(
      {
        action: 'create',
        name: '购物',
      },
      VIEW,
    )
    const profileId = profile!.profileId
    const grants = core.host.computerUse!.grants
    grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId,
        origins: ['https://shop.test'],
      },
      allowedActions: ['observe'],
      scope: 'session',
      backgroundAllowed: false,
    })
    grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://shop.test'],
      },
      allowedActions: ['observe'],
      scope: 'session',
      backgroundAllowed: false,
    })
    await expect(
      core.computerUse.manageProfile({ action: 'clear', profileId }, VIEW),
    ).resolves.toEqual({ revokedGrants: 1 })
    expect(port.browser.clearedProfiles).toEqual([{ profileId, remove: false }])
    expect(core.host.computerUse!.grants.list()).toHaveLength(1)
    await core.computerUse.manageProfile({ action: 'delete', profileId }, VIEW)
    expect(port.browser.clearedProfiles.at(-1)).toEqual({
      profileId,
      remove: true,
    })
    expect(core.computerUse.listProfiles().map((item) => item.kind)).toEqual([
      'temporary',
    ])
    await expect(
      core.computerUse.manageProfile({ action: 'delete', profileId }, VIEW),
    ).rejects.toThrow(/no browser profile/)
  })

  it("still revokes a profile's grants when wiping its data fails", async () => {
    const port = new FakeComputerUsePort()
    const { api: core } = await api({
      extra: {
        computerUsePort: port,
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const { profile } = await core.computerUse.manageProfile(
      {
        action: 'create',
        name: '银行',
      },
      VIEW,
    )
    const profileId = profile!.profileId
    core.host.computerUse!.grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId,
        origins: ['https://bank.test'],
      },
      allowedActions: ['observe', 'interact'],
      scope: 'session',
      backgroundAllowed: false,
    })
    port.browser.clearProfile = async () => {
      throw new Error('disk busy')
    }
    await expect(
      core.computerUse.manageProfile({ action: 'delete', profileId }, VIEW),
    ).rejects.toThrow(/disk busy/)
    expect(core.host.computerUse!.grants.list()).toEqual([])
    // The profile is kept so the user can retry the wipe.
    expect(
      core.computerUse
        .listProfiles()
        .some((item) => 'profileId' in item && item.profileId === profileId),
    ).toBe(true)
  })
})

describe('computer use site permissions', () => {
  it('denies by default, notes the refusal once, and honours what the user allows', async () => {
    const port = new FakeComputerUsePort()
    const { api: core } = await api({
      extra: {
        computerUsePort: port,
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const service = core.host.computerUse!.service
    await service.status()
    const snapshot = await port.browser.open(
      {
        profile: { kind: 'temporary' },
        url: 'https://meet.test/',
        ownerSessionId: 's1',
      },
      new AbortController().signal,
    )
    ;(
      service as unknown as {
        registry: { add(o: string, s: unknown, n: Date): void }
      }
    ).registry.add('s1', snapshot, new Date())
    const ask = (kind: 'camera' | 'microphone') =>
      service.sitePermissionVerdict({
        targetId: snapshot.targetId,
        origin: 'https://meet.test',
        kind,
      })
    expect(ask('camera')).toBe(false)
    expect(ask('camera')).toBe(false)
    const notes = (
      service as unknown as { notes: Map<string, string[]> }
    ).notes.get(snapshot.targetId)
    expect(notes?.filter((note) => note.includes('camera'))).toHaveLength(1)
    expect(
      core.computerUse.setSitePermission(
        {
          profileId: 'temporary',
          origin: 'https://meet.test',
          kind: 'camera',
          allow: true,
        },
        VIEW,
      ).permissions,
    ).toHaveLength(1)
    expect(ask('camera')).toBe(true)
    expect(ask('microphone')).toBe(false)
    core.computerUse.setSitePermission(
      {
        profileId: 'temporary',
        origin: 'https://meet.test',
        kind: 'camera',
        allow: false,
      },
      VIEW,
    )
    expect(ask('camera')).toBe(false)
    expect(() =>
      core.computerUse.setSitePermission(
        {
          profileId: 'p_000000000000',
          origin: 'https://meet.test',
          kind: 'camera',
          allow: true,
        },
        VIEW,
      ),
    ).toThrow(/no browser profile/)
  })
})

type ResultBlock = { type: string; text?: string; content?: ResultBlock[] }

/** JSON summary of the last tool result the scripted model received. */
function lastSummary(request: {
  messages: Array<{ content?: unknown }>
}): Record<string, unknown> {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const content = (request.messages[index]?.content ?? []) as ResultBlock[]
    const result = Array.isArray(content)
      ? content.find((block) => block.type === 'tool-result')
      : undefined
    if (result === undefined) continue
    const text =
      (result.content ?? []).find((block) => block.type === 'text')?.text ??
      '{}'
    return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
  }
  return {}
}

describe('computer use restorable tabs', () => {
  it('offers persistent-profile tabs again after a restart, never temporary ones', async () => {
    const first = await makeApi({
      replies: [
        (request) => {
          const profileId =
            /p_[0-9a-f]{12}/.exec(JSON.stringify(request.messages))?.[0] ??
            'missing'
          return replyChunks({
            tools: [
              {
                name: 'browser_open',
                args: { url: 'https://mail.test/inbox', profile: profileId },
              },
              { name: 'browser_open', args: { url: 'https://news.test/' } },
            ],
          })
        },
        { text: 'opened' },
      ],
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const { profile } = await first.api.computerUse.manageProfile(
      {
        action: 'create',
        name: '邮箱',
      },
      VIEW,
    )
    const id = String(first.api.sessions.create({ title: 'GUI' }).id)
    first.api.control.setPermissionMode('danger-full-access', id)
    await first.api.chat.submit({
      content: `use ${profile!.profileId}`,
      sessionId: id,
    })
    // The task ended: both tabs are released, their pages kept.
    const firstService = first.api.host.computerUse!.service
    await vi.waitFor(
      () =>
        expect(firstService.listTabs(id).map((tab) => tab.state)).toEqual([
          'released',
          'released',
        ]),
      LOADED,
    )
    const oldTargetId = firstService
      .listTabs(id)
      .find((target) => target.url.includes('mail.test'))!.targetId
    // The desktop closes hidden Agent tabs with its main window before
    // CoreApi.close() runs; recovery hints must survive that order.
    first.api.host.computerUse!.service.rememberRestorableTabs()
    await first.api.host.computerUse!.service.closeAll('shutdown')
    await first.api.close()

    let listed: Record<string, unknown> | undefined
    const second = await api({
      root: first.root,
      stateRoot: first.stateRoot,
      replies: [
        { tools: [{ name: 'browser_tab_list', args: {} }] },
        (request) => {
          listed = lastSummary(request)
          return replyChunks({ text: 'listed' })
        },
        {
          tools: [
            {
              name: 'browser_open',
              args: {
                url: 'https://mail.test/inbox',
                profile: profile!.profileId,
              },
            },
          ],
        },
        { text: 'reopened' },
      ],
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    expect(second.api.host.computerUse!.service.restorableFor(id)).toEqual([
      expect.objectContaining({
        profileId: profile!.profileId,
        url: 'https://mail.test/inbox',
      }),
    ])
    await second.api.chat.submit({ content: 'what was open?', sessionId: id })
    expect(listed).toMatchObject({
      count: 0,
      restorable: [
        { profile: profile!.profileId, url: 'https://mail.test/inbox' },
      ],
    })
    second.api.control.setPermissionMode('danger-full-access', id)
    await second.api.chat.submit({
      content: 'reopen the saved page',
      sessionId: id,
    })
    const secondService = second.api.host.computerUse!.service
    await vi.waitFor(
      () => expect(secondService.listTabs(id)).toHaveLength(1),
      LOADED,
    )
    expect(secondService.listTabs(id)[0]!.targetId).not.toBe(oldTargetId)
  })
})

describe('computer use task end (CU-04)', () => {
  const OPEN = {
    tools: [
      { name: 'browser_open', args: { url: 'https://fixture.test/form' } },
    ],
  }

  async function started(replies: ScriptedReply[]) {
    const fixture = await api({
      replies,
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const id = String(fixture.api.sessions.create({ title: 'GUI' }).id)
    fixture.api.control.setPermissionMode('danger-full-access', id)
    return { ...fixture, id, service: fixture.api.host.computerUse!.service }
  }

  it('releases the tab when the turn ends, even after a question asked in plain text', async () => {
    const {
      api: core,
      id,
      service,
    } = await started([OPEN, { text: 'Which account should I use?' }])
    await core.chat.submit({ content: 'log in', sessionId: id })
    await waitFor(() => service.listTabs(id)[0]?.state === 'released')
    expect(service.listTargets(id)).toEqual([])
  })

  it('keeps the tab while ask_user_question waits for the answer', async () => {
    const {
      api: core,
      id,
      service,
      events,
    } = await started([
      OPEN,
      {
        tools: [
          {
            name: 'ask_user_question',
            args: {
              questions: [
                {
                  id: 'account',
                  question: 'Which account?',
                  options: [{ label: 'work' }, { label: 'home' }],
                },
              ],
            },
          },
        ],
      },
      { text: 'using work' },
    ])
    const submitted = core.chat.submit({ content: 'log in', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.listTargets(id)).toHaveLength(1)
    await core.control.answerInteraction(
      pendingInteractionId(events, 'ask_request'),
      { account: { choice: 'work', freeform: '' } },
    )
    await submitted
    await waitFor(() => service.listTabs(id)[0]?.state === 'released')
  })

  it('keeps the tab while a background subagent runs, and releases once it settles', async () => {
    let finishChild!: () => void
    const childMayFinish = new Promise<void>((resolve) => {
      finishChild = resolve
    })
    // The child's own prompt arrives as a user message (the root only has it
    // inside its tool call).
    const route = async (request: GenerateOptions) => {
      const child = request.messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('watch the page quietly'),
      )
      if (child) {
        await childMayFinish
        return replyChunks({ text: 'nothing changed' })
      }
      return replyChunks({ text: 'noted' })
    }
    const {
      api: core,
      id,
      service,
    } = await started([
      OPEN,
      {
        tools: [
          {
            name: 'subagent',
            args: {
              description: 'watch',
              prompt: 'watch the page quietly',
              run_in_background: true,
            },
          },
        ],
      },
      route,
      route,
      route,
    ])
    await core.chat.submit({ content: 'go', sessionId: id })
    // The root turn is over while the child still runs: the task goes on.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(service.listTargets(id)).toHaveLength(1)
    finishChild()
    await waitFor(() => service.listTabs(id)[0]?.state === 'released')
  })

  it('releases when the user stops the turn', async () => {
    const { api: core, id, service } = await started([OPEN, { hang: true }])
    const submitted = core.chat.submit({ content: 'go', sessionId: id })
    await waitFor(() => service.listTargets(id).length === 1)
    core.host.stop(id)
    await submitted.catch(() => undefined)
    await waitFor(() => service.listTabs(id)[0]?.state === 'released')
  })
})
