// Chrome/Edge cards outside a tool call (PLAN-CAP-001 RV-09): a page that
// moved to a site needing approval, or a download, asks the user with the
// same grant card in the owner's conversation.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeApi, type ApiFixture } from '../../api/test-helpers'
import { SessionLogStore } from '../../session-log/store'
import { PendingInteractions } from '../host/interactions'
import { GrantAskService } from './grants/ask'
import { GrantStore } from './grants/store'
import type { UiCallerIdentity } from './identity'
import { createExternalConfirmation } from './install'
import { FakeComputerUsePort } from './testing/fake-port'

const identity: UiCallerIdentity = {
  subject: 'session:owner',
  kind: 'session',
  ownerSessionId: 'owner',
  callerSessionId: 'owner',
  taskId: 'owner:1',
  turn: 1,
  background: false,
  canAsk: true,
  fullAccess: true,
}

async function tick(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function setup() {
  const log = new SessionLogStore({ root: '/tmp/unused', persist: false })
  const session = log.create({ id: 'owner' })
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-confirm-')), 'computer-use'),
  })
  const pending = new PendingInteractions()
  const ask = new GrantAskService()
  ask.setAnswerer(pending.grantAnswerer)
  const confirm = createExternalConfirmation({
    ask,
    grants,
    sessionFor: (id) => log.get(id),
  })
  return { session, grants, pending, confirm }
}

describe('Chrome/Edge confirmation cards', () => {
  it('shows one card for this one thing and resolves with the answer', async () => {
    const k = setup()
    const answer = k.confirm({
      identity,
      profileId: 'pair-1',
      origin: 'https://pay.example',
      actionClass: 'navigate',
      display: {
        url: 'https://pay.example',
        title: '网页跳转到了需要你批准的网站',
      },
    })
    await tick()
    const [card] = k.pending.forSession('owner')
    expect(k.session.events.at(-1)).toMatchObject({
      type: 'ui/grant-requested',
      data: {
        driver: 'external-browser',
        targetScope: {
          kind: 'browser',
          profileId: 'pair-1',
          origins: ['https://pay.example'],
        },
        actions: ['navigate'],
        allowedScopes: ['once'],
        display: { url: 'https://pay.example' },
      },
    })
    k.pending.answer(card!, { grant: { option_id: 'once' } })
    expect(await answer).toBe(true)
    // The grant it leaves behind covers no tool call (and ends with the task).
    expect(k.grants.list()).toEqual([
      expect.objectContaining({ scope: 'once', ownerSessionId: 'owner' }),
    ])

    const refused = k.confirm({
      identity,
      profileId: 'pair-1',
      origin: 'https://files.example',
      actionClass: 'transfer',
      display: { url: 'report.pdf · https://files.example', title: '下载' },
    })
    await tick()
    k.pending.answer(k.pending.forSession('owner')[0]!, {
      grant: { option_id: 'deny' },
    })
    expect(await refused).toBe(false)
  })

  it('never asks for a caller that cannot ask, or without its conversation', async () => {
    const k = setup()
    expect(
      await k.confirm({
        identity: { ...identity, canAsk: false },
        profileId: 'pair-1',
        origin: 'https://pay.example',
        actionClass: 'navigate',
        display: { url: 'https://pay.example', title: '' },
      }),
    ).toBe(false)
    expect(
      await k.confirm({
        identity: { ...identity, ownerSessionId: 'gone' },
        profileId: 'pair-1',
        origin: 'https://pay.example',
        actionClass: 'navigate',
        display: { url: 'https://pay.example', title: '' },
      }),
    ).toBe(false)
    expect(k.pending.forSession('owner')).toEqual([])
  })
})

describe('Chrome/Edge settings through CoreApi', () => {
  const fixtures: ApiFixture[] = []
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.api.close()
  })

  async function api() {
    const fixture = await makeApi({
      extra: {
        computerUsePort: new FakeComputerUsePort(),
        computerUseSettings: () => ({ enabled: true }),
      },
    })
    fixtures.push(fixture)
    return fixture
  }

  it('stores them beside the other computer use state and reads them back', async () => {
    const { api: core, stateRoot } = await api()
    expect(core.computerUse.externalBrowserSettings()).toEqual({
      defaults: { browse: 'allow', download: 'ask' },
      sites: [],
      history: 'ask',
      siteTools: false,
      // RV-11: not offered by today's browsers.
      siteToolsAvailable: false,
      siteToolsReason: expect.stringContaining('实验开关'),
    })
    expect(() =>
      core.computerUse.setExternalBrowserSettings({ siteTools: true }),
    ).toThrow(/站点工具目前不可用/)
    const saved = core.computerUse.setExternalBrowserSettings({
      sites: [{ pattern: '*.Bank.example', browse: 'ask', download: 'block' }],
    })
    expect(saved.sites).toEqual([
      { pattern: '*.bank.example', browse: 'ask', download: 'block' },
    ])
    const { readFileSync } = await import('node:fs')
    expect(
      JSON.parse(
        readFileSync(
          join(stateRoot, 'computer-use', 'external-site-rules.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ sites: [{ pattern: '*.bank.example' }] })
  })

  it('guards a change that lets the Agent do more, never one that narrows', async () => {
    const { api: core } = await api()
    const id = String(core.sessions.create({ title: 'Chat' }).id)
    core.sessions.activate(id)
    core.control.setMode('plan', id)
    expect(() =>
      core.computerUse.setExternalBrowserSettings({
        defaults: { download: 'allow' },
      }),
    ).toThrow(/plan mode/)
    expect(
      core.computerUse.setExternalBrowserSettings({
        defaults: { browse: 'ask' },
        sites: [
          { pattern: 'evil.example', browse: 'block', download: 'block' },
        ],
        history: 'never',
      }),
    ).toMatchObject({ defaults: { browse: 'ask' }, history: 'never' })
    // Removing that block widens again.
    expect(() =>
      core.computerUse.setExternalBrowserSettings({ sites: [] }),
    ).toThrow(/plan mode/)
  })

  it('says what is wrong with a pattern in words the user reads', async () => {
    const { api: core } = await api()
    let caught: unknown
    try {
      core.computerUse.setExternalBrowserSettings({
        sites: [{ pattern: 'not a site', browse: 'allow', download: 'ask' }],
      })
    } catch (error) {
      caught = error
    }
    expect((caught as { toSafe(): unknown }).toSafe()).toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('不是有效的网站或模式'),
    })
  })
})
