// browser_* tools through the real stack (CoreApi → registry → gate →
// tools → kernel → fake driver), driven by a scripted model that reads refs
// out of the observations it receives.
import { afterEach, describe, expect, it } from 'vitest'
import {
  eventOf,
  makeApi,
  pendingInteractionId,
  waitFor,
  type ApiFixture,
} from '../../../api/test-helpers'
import type { GenerateOptions, StreamChunk } from '../../../llm/types'
import { replyChunks, testRoute, type ScriptedReply } from '../../testing'
import { FakeComputerUsePort } from '../testing/fake-port'

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function setup(
  replies: ScriptedReply[],
  options: { vision?: boolean; mode?: 'unrestricted' | 'scoped' } = {},
) {
  const port = new FakeComputerUsePort()
  const fixture = await makeApi({
    replies,
    extra: {
      computerUsePort: port,
      computerUseSettings: () => ({
        enabled: true,
        authorizationMode: options.mode ?? 'unrestricted',
      }),
    },
  })
  fixtures.push(fixture)
  if (options.vision === true)
    fixture.api.host.llm.setRoutes([testRoute({ vision: true })], 'test-route')
  const id = String(fixture.api.sessions.create({ title: 'GUI' }).id)
  return { ...fixture, id, port }
}

type Block = {
  type: string
  text?: string
  content?: Block[]
  attachment?: unknown
}

/** Blocks of the last tool result the model received. */
function lastResult(request: GenerateOptions): Block[] {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const content = (request.messages[index]?.content ?? []) as Block[]
    const result = content.find((block) => block.type === 'tool-result')
    if (result !== undefined) return result.content ?? []
  }
  return []
}

function summary(request: GenerateOptions): Record<string, unknown> {
  const text =
    lastResult(request).find((block) => block.type === 'text')?.text ?? '{}'
  return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
}

/** Find the ref of an element by name in the untrusted observation text. */
function refIn(request: GenerateOptions, name: string): string {
  const envelope = lastResult(request)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  const decoded = envelope.includes('content_begin')
    ? (JSON.parse(
        envelope.split('content_begin\n')[1]!.split('\ncontent_end')[0]!,
      ) as string)
    : envelope
  const line = decoded.split('\n').find((row) => row.includes(`"${name}"`))
  if (line === undefined)
    throw new Error(`no element "${name}" in:\n${decoded}`)
  return line.split(' ')[0]!
}

const call = (name: string, args: unknown): ScriptedReply => ({
  tools: [{ name, args }],
})
const replyErrors: unknown[] = []
afterEach(() => {
  const errors = replyErrors.splice(0)
  if (errors.length > 0) throw errors[0]
})

const then =
  (
    body: (request: GenerateOptions) => ScriptedReply | StreamChunk[],
  ): ScriptedReply =>
  (request) => {
    try {
      const reply = body(request)
      return Array.isArray(reply)
        ? reply
        : replyChunks(reply as Parameters<typeof replyChunks>[0])
    } catch (error) {
      replyErrors.push(error)
      return replyChunks({ text: 'reply failed' })
    }
  }

describe('browser_* tools end to end', () => {
  it('opens, observes, fills and submits with unrestricted GUI mode and workspace Shell', async () => {
    const seen: Array<Record<string, unknown>> = []
    let observationText = ''
    const { api, events, id } = await setup([
      call('browser_open', { url: 'https://fixture.test/form' }),
      then((request) => {
        seen.push(summary(request))
        return call('browser_observe', {})
      }),
      then((request) => {
        seen.push(summary(request))
        observationText = JSON.stringify(lastResult(request))
        return call('browser_fill', {
          ref: refIn(request, 'Name'),
          text: '张三',
        })
      }),
      then((request) => {
        seen.push(summary(request))
        return call('browser_observe', { diff: true })
      }),
      then((request) => {
        seen.push(summary(request))
        // A diff lists only what changed: the filled field, not Submit.
        expect(refIn(request, 'Name')).toMatch(/^r\d+\.\d+$/)
        expect(() => refIn(request, 'Submit')).toThrow()
        return call('browser_observe', {})
      }),
      then((request) =>
        call('browser_click', { ref: refIn(request, 'Submit') }),
      ),
      then((request) => {
        seen.push(summary(request))
        return call('browser_screenshot', {})
      }),
      then((request) => {
        seen.push(summary(request))
        expect(
          lastResult(request).some((block) => block.type === 'image'),
        ).toBe(false)
        return { text: 'done' }
      }),
    ])
    expect(
      (await api.chat.submit({ content: 'sign up', sessionId: id })).content,
    ).toBe('done')
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(seen.map((item) => [item.tool, item.status])).toEqual([
      ['browser_open', 'ok'],
      ['browser_observe', 'ok'],
      ['browser_fill', 'ok'],
      ['browser_observe', 'ok'],
      ['browser_click', 'ok'],
      ['browser_screenshot', 'ok'],
    ])
    expect(seen[3]).toMatchObject({ diffFrom: expect.any(Number) })
    expect(seen[4]).toMatchObject({
      url: 'https://fixture.test/done',
      outcome: 'observed',
    })
    expect(seen[5]).toMatchObject({ sentToModel: false })
    // Page text only ever reaches the model inside the untrusted envelope.
    expect(observationText).toContain('trust: untrusted_external')
    const log = api.host.sessionLog(id)!.events
    expect(log.some((event) => event.type === 'ui/auto-approved')).toBe(true)
    const prepared = log.filter((event) => event.type === 'ui/action-prepared')
    expect(JSON.stringify(prepared)).not.toContain('张三')
    const toolResult = log.find(
      (event) =>
        event.type === 'tool/result' &&
        JSON.stringify(event.data).includes('"tool":"browser_screenshot"'),
    )
    expect(JSON.stringify(toolResult)).toMatch(
      /"screenshot":\{"attachmentId":"att_/,
    )
  })

  it('asks once in restricted presets, then asks again for a new origin', async () => {
    let refused = ''
    const { api, events, id } = await setup(
      [
        call('browser_open', { url: 'https://fixture.test/form' }),
        call('browser_observe', {}),
        call('browser_navigate', { url: 'https://other.test/' }),
        then((request) => {
          // A gate denial reaches the model as one structured text line.
          refused = lastResult(request)
            .map((block) => block.text ?? '')
            .join('')
          return { text: 'stopped' }
        }),
      ],
      { mode: 'scoped' },
    )
    const submitted = api.chat.submit({ content: 'go', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    await api.control.answerInteraction(
      pendingInteractionId(events, 'ask_request'),
      {
        grant: { option_id: 'session' },
      },
    )
    await waitFor(
      () =>
        events.filter((event) => event.event === 'ask_request').length === 2,
    )
    const second = events.filter((event) => event.event === 'ask_request')[1]!
    const interaction = second.interaction as {
      id: string
      meta: { grant: Record<string, unknown> }
    }
    expect(interaction.meta.grant).toMatchObject({
      target_scope: { origins: ['https://other.test'] },
      display: { url: 'https://other.test/' },
    })
    await api.control.answerInteraction(interaction.id, {
      grant: { option_id: 'deny' },
    })
    expect((await submitted).content).toBe('stopped')
    expect(refused).toMatch(
      /computer-use PERMISSION_DENIED: the user refused this action \(retryable: false; reason: user-denied/,
    )
  })

  it('asks for the frame origin before acting inside a cross-origin frame', async () => {
    const { api, events, id } = await setup(
      [
        call('browser_open', { url: 'https://fixture.test/embedded-pay' }),
        call('browser_observe', {}),
        then((request) =>
          call('browser_click', { ref: refIn(request, 'Apply coupon') }),
        ),
        then((request) => {
          expect(summary(request)).toMatchObject({ outcome: 'observed' })
          return call('browser_observe', {})
        }),
        then((request) =>
          call('browser_click', { ref: refIn(request, 'Continue with card') }),
        ),
        then((request) => {
          expect(summary(request)).toMatchObject({ outcome: 'observed' })
          return { text: 'done' }
        }),
      ],
      { mode: 'scoped' },
    )
    const submitted = api.chat.submit({ content: 'pay', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    await api.control.answerInteraction(
      pendingInteractionId(events, 'ask_request'),
      { grant: { option_id: 'session' } },
    )
    // The session grant for the shop covers the shop's own button but not
    // the payment frame of another site.
    await waitFor(
      () =>
        events.filter((event) => event.event === 'ask_request').length === 2,
    )
    const second = events.filter((event) => event.event === 'ask_request')[1]!
    const card = second.interaction as {
      id: string
      meta: { grant: Record<string, unknown> }
    }
    expect(card.meta.grant).toMatchObject({
      target_scope: { origins: ['https://other.test'] },
      display: {
        url: 'https://other.test',
        embeddedIn: 'https://fixture.test/embedded-pay',
      },
    })
    await api.control.answerInteraction(card.id, {
      grant: { option_id: 'once' },
    })
    expect((await submitted).content).toBe('done')
  })

  it('shows no card when a user hook already refused the call', async () => {
    let refused = ''
    const { api, events, id } = await setup(
      [
        call('browser_open', { url: 'https://fixture.test/form' }),
        then((request) => {
          refused = lastResult(request)
            .map((block) => block.text ?? '')
            .join('')
          return { text: 'blocked' }
        }),
      ],
      { mode: 'scoped' },
    )
    await api.hooks.saveConfig(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'browser_open',
              hooks: [
                {
                  type: 'command',
                  command: 'echo "no browsing today" >&2; exit 2',
                },
              ],
            },
          ],
        },
      }),
    )
    expect(
      (await api.chat.submit({ content: 'go', sessionId: id })).content,
    ).toBe('blocked')
    expect(refused).toContain('no browsing today')
    expect(eventOf(events, 'ask_request')).toBeUndefined()
  })

  it('always confirms a high-impact click, even under full access', async () => {
    const { api, events, id } = await setup([
      call('browser_open', { url: 'https://fixture.test/checkout' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_click', { ref: refIn(request, 'Pay now') }),
      ),
      then((request) => {
        expect(summary(request)).toMatchObject({ outcome: 'observed' })
        return { text: 'paid' }
      }),
    ])
    api.control.setPermissionMode('danger-full-access', id)
    const submitted = api.chat.submit({ content: 'pay', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const card = eventOf(events, 'ask_request')!.interaction as {
      id: string
      meta: { grant: Record<string, unknown> }
    }
    expect(card.meta.grant).toMatchObject({
      high_impact: true,
      allowed_scopes: ['once'],
      actions: ['high-impact'],
    })
    await api.control.answerInteraction(card.id, {
      grant: { option_id: 'once' },
    })
    expect((await submitted).content).toBe('paid')
  })

  it('navigates back into a granted origin from a page outside it', async () => {
    // Regression: a navigation's ticket is bound to its destination; the
    // page it leaves may be outside the grant.
    const outcomes: unknown[] = []
    const { api, id } = await setup([
      call('browser_open', { url: 'https://fixture.test/form' }),
      call('browser_navigate', { url: 'https://other.test/' }),
      then((request) => {
        outcomes.push(summary(request))
        return call('browser_navigate', {
          url: 'https://fixture.test/checkout',
        })
      }),
      then((request) => {
        outcomes.push(summary(request))
        return { text: 'back' }
      }),
    ])
    api.host.computerUse!.grants.issue({
      subject: `session:${id}`,
      ownerSessionId: id,
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://fixture.test'],
      },
      allowedActions: ['observe', 'interact', 'navigate'],
      scope: 'session',
      backgroundAllowed: false,
    })
    api.control.setPermissionMode('danger-full-access', id)
    expect(
      (await api.chat.submit({ content: 'go', sessionId: id })).content,
    ).toBe('back')
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'ok' }),
      expect.objectContaining({ status: 'ok' }),
    ])
  })

  it('adopts a popup the page opens as a new tab of the same task', async () => {
    let tabs: Record<string, unknown> | undefined
    let notes = ''
    const { api, id } = await setup([
      call('browser_open', { url: 'https://fixture.test/popup' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_click', { ref: refIn(request, 'Open window') }),
      ),
      call('browser_tab_list', {}),
      then((request) => {
        tabs = summary(request)
        return call('browser_observe', {})
      }),
      then((request) => {
        notes = lastResult(request)
          .map((block) => block.text ?? '')
          .join('\n')
        return { text: 'ok' }
      }),
    ])
    api.control.setPermissionMode('danger-full-access', id)
    await api.chat.submit({ content: 'open the window', sessionId: id })
    const list = (tabs?.tabs ?? []) as Array<{ url: string; current: boolean }>
    expect(list).toHaveLength(2)
    expect(list.find((tab) => tab.url.endsWith('/popup'))?.current).toBe(true)
    expect(list.some((tab) => tab.url.endsWith('/done'))).toBe(true)
    expect(notes).toContain('in a new tab')
    const status = await api.computerUse.status()
    expect(
      status.targets.filter((target) => target.ownerSessionId === id),
    ).toHaveLength(2)
  })

  it('keeps a popup opened during user takeover with the user', async () => {
    const { api, events, id, port } = await setup(
      [
        call('browser_open', { url: 'https://fixture.test/form' }),
        { text: 'opened' },
      ],
      { mode: 'scoped' },
    )
    const submitted = api.chat.submit({ content: 'open', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    await api.control.answerInteraction(
      pendingInteractionId(events, 'ask_request'),
      { grant: { option_id: 'session' } },
    )
    await submitted
    const opener = (await api.computerUse.status()).targets[0]!
    await api.computerUse.controlTarget({
      targetId: opener.targetId,
      action: 'takeover',
    })
    // The user clicks a link that opens another site in a new window.
    const popupId = port.browser.pageOpenPopup(
      opener.targetId,
      'https://other.test/',
    )
    expect(popupId).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const popup = (await api.computerUse.status()).targets.find(
      (target) => target.targetId === popupId,
    )!
    // Never judged against the Agent's grants: it stays with the user.
    expect(popup.control).toBe('user-takeover')
    expect(port.browser.snapshot(popupId!)).not.toBeNull()
  })

  it('automatically allows downloads but still refuses executable files', async () => {
    let first: Record<string, unknown> | undefined
    let second: Record<string, unknown> | undefined
    const { api, events, id, port } = await setup([
      call('browser_open', { url: 'https://fixture.test/files' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_download', { ref: refIn(request, 'Download report') }),
      ),
      then((request) => {
        first = summary(request)
        return call('browser_observe', {})
      }),
      then((request) =>
        call('browser_download', { ref: refIn(request, 'Download installer') }),
      ),
      then((request) => {
        second = summary(request)
        return { text: 'done' }
      }),
    ])
    const submitted = await api.chat.submit({
      content: 'get the report',
      sessionId: id,
    })
    expect(submitted.content).toBe('done')
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(first).toMatchObject({ state: 'completed', bytes: 42 })
    expect(second).toMatchObject({ state: 'refused' })
    expect(port.browser.downloads.map((item) => item.filename)).toEqual([
      'report.csv',
      'setup.dmg',
    ])
    const logged = api.host
      .agentFor(id)
      .session.events.filter((event) => event.type === 'ui/download')
    expect(
      logged.map((event) => (event.data as { state: string }).state),
    ).toEqual(['completed', 'refused'])
    // The audit record names the file's URL and the page that started it.
    expect(logged[0]!.data).toMatchObject({
      url: expect.stringMatching(/^https:\/\/fixture\.test\//),
      pageOrigin: 'https://fixture.test',
    })
  })

  it('uploads only what the user picks without a grant card', async () => {
    const results: Array<Record<string, unknown>> = []
    const { api, events, id, port } = await setup([
      call('browser_open', { url: 'https://fixture.test/upload' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_upload', { ref: refIn(request, 'Document') }),
      ),
      then((request) => {
        results.push(summary(request))
        port.browser.pickedFiles = null
        return call('browser_observe', {})
      }),
      then((request) =>
        call('browser_upload', { ref: refIn(request, 'Document') }),
      ),
      then((request) => {
        results.push(summary(request))
        return { text: 'done' }
      }),
    ])
    const submitted = await api.chat.submit({
      content: 'attach it',
      sessionId: id,
    })
    expect(submitted.content).toBe('done')
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(results).toEqual([
      expect.objectContaining({ state: 'attached', count: 1, bytes: 12 }),
      expect.objectContaining({ state: 'cancelled', count: 0 }),
    ])
    const logged = api.host
      .agentFor(id)
      .session.events.filter((event) => event.type === 'ui/upload')
    expect(logged.map((event) => event.data)).toEqual([
      expect.objectContaining({ files: ['notes.txt'], bytes: 12 }),
    ])
  })

  it('fills vault credentials by handle and never exposes the secret', async () => {
    let listed: Record<string, unknown> | undefined
    let observed = ''
    const { api, events, id, port } = await setup([
      call('ui_credential_list', { origin: 'https://fixture.test' }),
      then((request) => {
        listed = summary(request)
        return call('browser_open', { url: 'https://fixture.test/login' })
      }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_fill_credential', {
          ref: refIn(request, 'Username'),
          handleId: 'cred_000000000000000000000001',
          field: 'username',
        }),
      ),
      call('browser_observe', {}),
      then((request) =>
        call('browser_fill_credential', {
          ref: refIn(request, 'Password'),
          handleId: 'cred_000000000000000000000001',
          field: 'password',
        }),
      ),
      call('browser_observe', {}),
      then((request) => {
        observed = lastResult(request)
          .map((block) => block.text ?? '')
          .join('\n')
        return { text: 'signed in' }
      }),
    ])
    const submitted = api.chat.submit({ content: 'sign in', sessionId: id })
    for (const index of [1, 2]) {
      await waitFor(
        () =>
          events.filter((event) => event.event === 'ask_request').length ===
          index,
      )
      const card = events.filter((event) => event.event === 'ask_request')[
        index - 1
      ]!.interaction as {
        id: string
        meta: { grant: Record<string, unknown> }
      }
      expect(card.meta.grant).toMatchObject({ allowed_scopes: ['once'] })
      await api.control.answerInteraction(card.id, {
        grant: { option_id: 'once' },
      })
    }
    expect((await submitted).content).toBe('signed in')
    expect(listed).toMatchObject({
      count: 2,
      credentials: [
        {
          handleId: 'cred_000000000000000000000001',
          username: 'zhangsan',
          sites: ['https://fixture.test'],
          confirmEachTime: true,
        },
        { handleId: 'cred_000000000000000000000002', confirmEachTime: true },
      ],
    })
    expect(observed).toContain('[has content]')
    const log = JSON.stringify(api.host.agentFor(id).session.events)
    expect(log).not.toContain('hunter2-SECRET')
    expect(log).toContain('ui/credential-used')
    expect(port.browser.list()).toHaveLength(1)
    expect(
      events.filter((event) => event.event === 'ask_request'),
    ).toHaveLength(2)
  })

  it('refuses a credential on an unregistered origin before any card', async () => {
    let refusal = ''
    const { api, events, id } = await setup([
      call('browser_open', { url: 'https://other.test/login' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_fill_credential', {
          ref: refIn(request, 'Password'),
          handleId: 'cred_000000000000000000000001',
          field: 'password',
        }),
      ),
      then((request) => {
        refusal = lastResult(request)
          .map((block) => block.text ?? '')
          .join('')
        return { text: 'stopped' }
      }),
    ])
    expect(
      (await api.chat.submit({ content: 'log in', sessionId: id })).content,
    ).toBe('stopped')
    expect(refusal).toMatch(/PERMISSION_DENIED.*credential-binding-mismatch/)
    // The binding is rejected before any credential card.
    expect(
      events.filter((event) => event.event === 'ask_request'),
    ).toHaveLength(0)
  })

  it('refuses a credential for the wrong kind of field before any card', async () => {
    let refusal = ''
    const { api, events, id } = await setup(
      [
        call('browser_open', { url: 'https://fixture.test/login' }),
        call('browser_observe', {}),
        then((request) =>
          call('browser_fill_credential', {
            ref: refIn(request, 'Username'),
            handleId: 'cred_000000000000000000000001',
            field: 'password',
          }),
        ),
        then((request) => {
          refusal = lastResult(request)
            .map((block) => block.text ?? '')
            .join('')
          return { text: 'stopped' }
        }),
      ],
      { mode: 'scoped' },
    )
    const submitted = api.chat.submit({ content: 'log in', sessionId: id })
    // The page itself still needs the ordinary grant card.
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    await api.control.answerInteraction(
      pendingInteractionId(events, 'ask_request'),
      { grant: { option_id: 'session' } },
    )
    expect((await submitted).content).toBe('stopped')
    expect(refusal).toMatch(/INVALID_REQUEST.*credential-field-type/)
    // Only the site card was shown, never a credential card.
    expect(
      events.filter((event) => event.event === 'ask_request'),
    ).toHaveLength(1)
  })

  it('refuses a credential before any card when encryption is unavailable', async () => {
    let refusal = ''
    const { api, events, id, port } = await setup([
      call('browser_open', { url: 'https://fixture.test/login' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_fill_credential', {
          ref: refIn(request, 'Password'),
          handleId: 'cred_000000000000000000000001',
          field: 'password',
        }),
      ),
      then((request) => {
        refusal = lastResult(request)
          .map((block) => block.text ?? '')
          .join('')
        return { text: 'stopped' }
      }),
    ])
    port.vault.available = false
    expect(
      (await api.chat.submit({ content: 'log in', sessionId: id })).content,
    ).toBe('stopped')
    expect(refusal).toMatch(/CAPABILITY_DISABLED.*vault-encryption-unavailable/)
    expect(
      events.filter((event) => event.event === 'ask_request'),
    ).toHaveLength(0)
  })

  it('asks every time for confirm-each-time entries, even under full access', async () => {
    const { api, events, id, port } = await setup([
      call('browser_open', { url: 'https://fixture.test/login' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_fill_credential', {
          ref: refIn(request, 'Password'),
          handleId: 'cred_000000000000000000000002',
          field: 'password',
        }),
      ),
      then(() => {
        port.vault.locked = true
        return call('browser_observe', {})
      }),
      then((request) =>
        call('browser_fill_credential', {
          ref: refIn(request, 'Password'),
          handleId: 'cred_000000000000000000000002',
          field: 'password',
        }),
      ),
      then((request) => {
        expect(
          lastResult(request)
            .map((block) => block.text ?? '')
            .join(''),
        ).toMatch(/vault-locked/)
        return { text: 'done' }
      }),
    ])
    api.control.setPermissionMode('danger-full-access', id)
    const submitted = api.chat.submit({ content: 'bank', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const card = eventOf(events, 'ask_request')!.interaction as {
      id: string
      meta: { grant: Record<string, unknown> }
    }
    expect(card.meta.grant).toMatchObject({ allowed_scopes: ['once'] })
    await api.control.answerInteraction(card.id, {
      grant: { option_id: 'once' },
    })
    expect((await submitted).content).toBe('done')
    // Locked: refused before a second card is shown.
    expect(
      events.filter((event) => event.event === 'ask_request'),
    ).toHaveLength(1)
    expect(JSON.stringify(api.host.agentFor(id).session.events)).not.toContain(
      'bank-SECRET',
    )
  })

  it('refuses to type into secret fields', async () => {
    let refusal: Record<string, unknown> | undefined
    const { api, id } = await setup([
      call('browser_open', { url: 'https://fixture.test/form' }),
      call('browser_observe', {}),
      then((request) =>
        call('browser_fill', {
          ref: refIn(request, 'Password'),
          text: 'hunter2',
        }),
      ),
      then((request) => {
        refusal = summary(request)
        return { text: 'ok' }
      }),
    ])
    api.control.setPermissionMode('danger-full-access', id)
    await api.chat.submit({ content: 'log in', sessionId: id })
    expect(refusal).toMatchObject({
      status: 'error',
      code: 'PERMISSION_DENIED',
      reason: 'secret-field',
    })
  })

  it('sends the screenshot to a vision route as an image block', async () => {
    let blocks: Block[] = []
    const { api, id } = await setup(
      [
        call('browser_open', { url: 'https://fixture.test/form' }),
        call('browser_screenshot', {}),
        then((request) => {
          blocks = lastResult(request)
          return { text: 'seen' }
        }),
      ],
      { vision: true },
    )
    api.control.setPermissionMode('danger-full-access', id)
    await api.chat.submit({ content: 'look', sessionId: id })
    const json = JSON.parse(
      blocks.find((block) => block.type === 'text')!.text!,
    ) as {
      sentToModel: boolean
    }
    expect(json.sentToModel).toBe(true)
  })
})
