import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  eventOf,
  makeApi,
  waitFor,
  type ApiFixture,
} from '../../api/test-helpers'
import { replyChunks } from '../testing'
import { COMPUTER_USE_CONFIG_FILE, ComputerUseConfigStore } from './config'
import { computerUseStateDir } from './install'
import { FakeComputerUsePort } from './testing/fake-port'
import { GUI_TOOL_CATALOG, isGuiToolName } from './tools/catalog'

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
    expect(await core.computerUse.stop()).toMatchObject({ stopped: false })
    expect(core.computerUse.revokeGrant('nope')).toEqual({ revoked: false })
  })

  it('stops, resumes and revokes through CoreApi and emits changes', async () => {
    const { api: core, events } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const status = await core.computerUse.status()
    expect(status).toMatchObject({
      supported: true,
      enabled: true,
      platform: 'macos',
      stopped: false,
      drivers: [{ driver: 'embedded-browser', enabled: true, available: true }],
    })
    const grant = core.host.computerUse!.grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://example.com'],
      },
      allowedActions: ['observe'],
      scope: 'session',
      backgroundAllowed: false,
    })
    expect(core.computerUse.listGrants().map((item) => item.grantId)).toEqual([
      grant.grantId,
    ])
    const stopped = await core.computerUse.stop()
    expect(stopped.stopped).toBe(true)
    expect(stopped.drivers[0]).toMatchObject({ available: false })
    const resumed = await core.computerUse.resume()
    expect(resumed.stopped).toBe(false)
    expect(core.computerUse.revokeGrant(grant.grantId)).toEqual({
      revoked: true,
    })
    expect(core.computerUse.listGrants()).toEqual([])
    const reasons = events
      .filter((event) => event.event === 'computer_use_changed')
      .map((event) => event.reason)
    expect(reasons).toEqual(expect.arrayContaining(['grants', 'kill-switch']))
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
    const payload = (await core.diagnostics.get()) as unknown as {
      computerUse: Record<string, unknown>
    }
    expect(payload.computerUse).toMatchObject({
      supported: true,
      enabled: true,
      stopped: false,
      targets: 0,
      grants: 1,
      drivers: [{ driver: 'embedded-browser', available: true }],
    })
    // Counts only: no origin, URL or grant detail leaves the machine.
    expect(JSON.stringify(payload)).not.toContain('secret-origin')
    const { api: bare } = await api()
    expect(
      ((await bare.diagnostics.get()) as unknown as { computerUse: unknown })
        .computerUse,
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
      authorizationMode: 'unrestricted',
      appLists: { protected: [], highRisk: [], sensitive: [] },
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
      authorizationMode: 'unrestricted',
      appLists: { protected: [], highRisk: [], sensitive: [] },
      downloadRetentionDays: 30,
    })
    store.update({ authorizationMode: 'scoped' })
    expect(new ComputerUseConfigStore(root).get().authorizationMode).toBe(
      'scoped',
    )
    writeFileSync(
      path,
      '{"schemaVersion":1,"enabled":true,"drivers":{"desktop":false}}',
    )
    // An older file without lists or retention reads with the defaults.
    expect(new ComputerUseConfigStore(root).get()).toEqual({
      enabled: true,
      drivers: { desktop: false },
      authorizationMode: 'unrestricted',
      appLists: { protected: [], highRisk: [], sensitive: [] },
      downloadRetentionDays: 30,
    })
    store.update({ downloadRetentionDays: 7 })
    expect(new ComputerUseConfigStore(root).get().downloadRetentionDays).toBe(7)
    writeFileSync(path, '{"schemaVersion":1,"enabled":"yes"}')
    expect(new ComputerUseConfigStore(root).get().enabled).toBe(false)
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
    expect((await core.computerUse.status()).authorizationMode).toBe(
      'unrestricted',
    )

    expect(
      (await core.computerUse.setAuthorizationMode('scoped')).authorizationMode,
    ).toBe('scoped')
    expect(
      new ComputerUseConfigStore(computerUseStateDir(stateRoot)).get()
        .authorizationMode,
    ).toBe('scoped')

    expect((await core.computerUse.setEnabled(true)).enabled).toBe(true)
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
    expect((await again.computerUse.status()).authorizationMode).toBe('scoped')

    expect((await core.computerUse.setEnabled(false)).enabled).toBe(false)
    expect(guiTools(core.host.tools.names())).toEqual([])
    expect(changes).toEqual([true, false])
    expect(
      events.filter(
        (event) =>
          event.event === 'computer_use_changed' && event.reason === 'state',
      ),
    ).toHaveLength(3)
  })

  it('switches one driver, keeps its tools and persists the stop shortcut', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-driver-'))
    const stateRoot = join(root, 'home')
    const shortcuts: Array<string | null> = []
    const port = new FakeComputerUsePort()
    const { api: core } = await api({
      root,
      stateRoot,
      extra: {
        computerUsePort: port,
        computerUseKillSwitchChanged: (accelerator: string | null) =>
          shortcuts.push(accelerator),
      },
    })
    await core.computerUse.setEnabled(true)
    const view = await core.computerUse.setDriverEnabled({
      driver: 'embedded-browser',
      enabled: false,
    })
    const embedded = view.drivers.find(
      (driver) => driver.driver === 'embedded-browser',
    )
    expect(embedded).toMatchObject({ enabled: false, available: false })
    // Spec 00 §8.4: the tools stay; calls answer CAPABILITY_DISABLED.
    expect(guiTools(core.host.tools.names())).toHaveLength(GUI_TOOLS)
    expect(
      new ComputerUseConfigStore(computerUseStateDir(stateRoot)).get().drivers,
    ).toEqual({ 'embedded-browser': false })
    await core.computerUse.setDriverEnabled({
      driver: 'embedded-browser',
      enabled: true,
    })

    await core.computerUse.setKillSwitch({ accelerator: 'Control+Shift+K' })
    expect(core.host.computerUseKillSwitchAccelerator()).toBe('Control+Shift+K')
    await core.computerUse.setKillSwitch({ accelerator: null })
    expect(core.host.computerUseKillSwitchAccelerator()).toBeUndefined()
    expect(shortcuts).toEqual(['Control+Shift+K', null])
  })

  it('narrows a grant and revokes it once nothing is left', async () => {
    const { api: core } = await api({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const grant = core.host.computerUse!.grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://a.test', 'https://b.test'],
      },
      allowedActions: ['observe', 'interact', 'navigate'],
      scope: 'session',
      backgroundAllowed: false,
    })
    expect(
      core.computerUse.narrowGrant({
        grantId: grant.grantId,
        allowedActions: ['observe'],
        origins: ['https://a.test'],
      }),
    ).toEqual({ found: true, revoked: false })
    expect(core.computerUse.listGrants()[0]).toMatchObject({
      allowedActions: ['observe'],
      targetScope: { origins: ['https://a.test'] },
    })
    expect(
      core.computerUse.narrowGrant({ grantId: grant.grantId, origins: [] }),
    ).toEqual({ found: true, revoked: true })
    expect(core.computerUse.listGrants()).toEqual([])
    expect(
      core.computerUse.narrowGrant({ grantId: 'nope', origins: [] }),
    ).toEqual({ found: false, revoked: false })
  })

  it('switches off while a grant card is pending, refusing the card', async () => {
    let refused = ''
    const { api: core, events } = await api({
      replies: [
        {
          tools: [
            {
              name: 'browser_open',
              args: { url: 'https://fixture.test/form' },
            },
          ],
        },
        (request) => {
          const messages = request.messages
          refused = JSON.stringify(messages[messages.length - 1]?.content ?? '')
          return replyChunks({ text: 'stopped' })
        },
      ],
      extra: { computerUsePort: new FakeComputerUsePort() },
    })
    await core.computerUse.setAuthorizationMode('scoped')
    await core.computerUse.setEnabled(true)
    const id = String(core.sessions.create({ title: 'GUI' }).id)
    const submitted = core.chat.submit({ content: 'go', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    // Pending cards block ordinary mutations, but never switching off.
    await expect(core.computerUse.setEnabled(true)).rejects.toThrow()
    await core.computerUse.setEnabled(false)
    expect((await submitted).content).toBe('stopped')
    expect(refused).toContain('PERMISSION_DENIED')
    expect((await core.computerUse.status()).targets).toEqual([])
  })

  it('lets the user pause, take over and close a target through CoreApi', async () => {
    const { api: core } = await api({
      replies: [
        {
          tools: [
            {
              name: 'browser_open',
              args: { url: 'https://fixture.test/form' },
            },
          ],
        },
        { text: 'opened' },
      ],
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const id = String(core.sessions.create({ title: 'GUI' }).id)
    core.control.setPermissionMode('danger-full-access', id)
    await core.chat.submit({ content: 'open it', sessionId: id })
    const [target] = (await core.computerUse.status()).targets
    const targetId = target!.targetId
    expect(
      await core.computerUse.controlTarget({ targetId, action: 'pause' }),
    ).toMatchObject({ control: 'paused' })
    expect(
      await core.computerUse.controlTarget({ targetId, action: 'takeover' }),
    ).toMatchObject({ control: 'user-takeover' })
    expect(
      await core.computerUse.controlTarget({ targetId, action: 'handback' }),
    ).toMatchObject({ control: 'agent' })
    expect(
      await core.computerUse.controlTarget({ targetId, action: 'close' }),
    ).toMatchObject({ state: 'closed' })
    expect(
      await core.computerUse.controlTarget({ targetId, action: 'resume' }),
    ).toBeNull()
  })
})

describe('computer use browser profiles', () => {
  it('opens a tab in a persistent profile and asks per profile', async () => {
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
                args: { url: 'https://fixture.test/form', profile: profileId },
              },
            ],
          })
        },
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
        computerUseSettings: () => ({
          enabled: true,
          authorizationMode: 'scoped',
        }),
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
      grant: { option_id: 'session' },
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

  it('shows a corrupt grants file as stopped until the user resumes', async () => {
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
    const stopped = await core.computerUse.status()
    expect(stopped).toMatchObject({
      stopped: true,
      stopReason: 'corrupt-store',
    })
    await core.computerUse.resume()
    const resumed = await core.computerUse.status()
    expect(resumed.stopped).toBe(false)
    expect(resumed.stopReason).toBeUndefined()
  })

  it('clears and deletes a profile: closes its tabs, wipes it, revokes its grants', async () => {
    const port = new FakeComputerUsePort()
    const { api: core } = await api({
      extra: {
        computerUsePort: port,
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    const { profile } = await core.computerUse.manageProfile({
      action: 'create',
      name: '购物',
    })
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
      core.computerUse.manageProfile({ action: 'clear', profileId }),
    ).resolves.toEqual({ revokedGrants: 1 })
    expect(port.browser.clearedProfiles).toEqual([{ profileId, remove: false }])
    expect(core.computerUse.listGrants()).toHaveLength(1)
    await core.computerUse.manageProfile({ action: 'delete', profileId })
    expect(port.browser.clearedProfiles.at(-1)).toEqual({
      profileId,
      remove: true,
    })
    expect(core.computerUse.listProfiles().map((item) => item.kind)).toEqual([
      'temporary',
    ])
    await expect(
      core.computerUse.manageProfile({ action: 'delete', profileId }),
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
    const { profile } = await core.computerUse.manageProfile({
      action: 'create',
      name: '银行',
    })
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
      core.computerUse.manageProfile({ action: 'delete', profileId }),
    ).rejects.toThrow(/disk busy/)
    expect(core.computerUse.listGrants()).toEqual([])
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
      core.computerUse.setSitePermission({
        profileId: 'temporary',
        origin: 'https://meet.test',
        kind: 'camera',
        allow: true,
      }).permissions,
    ).toHaveLength(1)
    expect(ask('camera')).toBe(true)
    expect(ask('microphone')).toBe(false)
    core.computerUse.setSitePermission({
      profileId: 'temporary',
      origin: 'https://meet.test',
      kind: 'camera',
      allow: false,
    })
    expect(ask('camera')).toBe(false)
    expect(() =>
      core.computerUse.setSitePermission({
        profileId: 'p_000000000000',
        origin: 'https://meet.test',
        kind: 'camera',
        allow: true,
      }),
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
    const { profile } = await first.api.computerUse.manageProfile({
      action: 'create',
      name: '邮箱',
    })
    const id = String(first.api.sessions.create({ title: 'GUI' }).id)
    first.api.control.setPermissionMode('danger-full-access', id)
    await first.api.chat.submit({
      content: `use ${profile!.profileId}`,
      sessionId: id,
    })
    const beforeRestart = await first.api.computerUse.status()
    expect(beforeRestart.targets).toHaveLength(2)
    const oldTargetId = beforeRestart.targets.find((target) =>
      target.url.includes('mail.test'),
    )!.targetId
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
    const reopened = (await second.api.computerUse.status()).targets
    expect(reopened).toHaveLength(1)
    expect(reopened[0]!.targetId).not.toBe(oldTargetId)
  })
})
