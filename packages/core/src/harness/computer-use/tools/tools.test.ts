import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TextBlock } from '../../../llm/types'
import { SessionLogStore } from '../../../session-log/store'
import type { Agent } from '../../agent/agent'
import { PendingInteractions } from '../../host/interactions'
import {
  normalizeToolReturn,
  type ToolDefinition,
  type ToolRunContext,
} from '../../tools/definition'
import { DEFAULT_MAX_INLINE_BYTES as SPILL_THRESHOLD_BYTES } from '../../tools/spill'
import { UiError } from '../errors'
import { createComputerUseGate, type GateDeps } from '../gate'
import { GrantAskService } from '../grants/ask'
import { GrantStore } from '../grants/store'
import type { UiCallerIdentity } from '../identity'
import { UiActionPolicy } from '../policy'
import { defaultHighImpactClassifier } from '../risk'
import { ComputerUseService } from '../service/service'
import { FakeComputerUsePort } from '../testing/fake-port'
import { GUI_TOOL_CATALOG } from './catalog'
import {
  MAX_RESULT_BYTES,
  renderElement,
  uiErrorResult,
  uiResult,
} from './result'
import type { ToolRuntime } from './runtime'
import { createUiTools } from './ui-tools'

describe('GUI tool results', () => {
  it('stays under the cap and below the spill threshold', () => {
    expect(MAX_RESULT_BYTES).toBeLessThan(SPILL_THRESHOLD_BYTES)
    const result = normalizeToolReturn(
      uiResult({
        tool: 'browser_observe',
        summary: { revision: 3 },
        untrusted: {
          kind: 'browser',
          locator: 'https://example.com/',
          transport: 'cdp',
          content: 'x'.repeat(200_000),
        },
        meta: { targetId: 't' },
      }),
    )
    const bytes = result.content
      .filter((block): block is TextBlock => block.type === 'text')
      .reduce((sum, block) => sum + Buffer.byteLength(block.text), 0)
    expect(bytes).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    const envelope = (result.content[1] as TextBlock).text
    expect(envelope).toContain('trust: untrusted_external')
    expect(envelope).toContain('source_kind: browser')
    expect(envelope).toContain('truncated: true')
    expect(JSON.parse((result.content[0] as TextBlock).text)).toEqual({
      status: 'ok',
      tool: 'browser_observe',
      revision: 3,
    })
    expect(result.meta).toEqual({
      computerUse: { v: 1, tool: 'browser_observe', targetId: 't' },
    })
  })

  it('adds an image block only when one is given', () => {
    const plain = normalizeToolReturn(
      uiResult({ tool: 't', summary: {}, meta: {} }),
    )
    expect(plain.content.map((block) => block.type)).toEqual(['text'])
    const withImage = normalizeToolReturn(
      uiResult({
        tool: 't',
        summary: {},
        image: { attachmentId: 'att_1', mediaType: 'image/jpeg', bytes: 10 },
        meta: {},
      }),
    )
    expect(withImage.content.map((block) => block.type)).toEqual([
      'text',
      'image',
    ])
  })

  it('returns structured errors', () => {
    const result = normalizeToolReturn(
      uiErrorResult('browser_click', new UiError('STALE_ELEMENT', 'old ref')),
    )
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content[0] as TextBlock).text)).toMatchObject({
      status: 'error',
      code: 'STALE_ELEMENT',
      retryable: true,
    })
  })

  it('renders elements compactly', () => {
    expect(
      renderElement({
        ref: 'r3.4',
        role: 'button',
        name: '  Submit\n order ',
        states: ['disabled'],
        actions: ['press'],
      }),
    ).toBe('r3.4 button "Submit order" [disabled] actions=press')
  })

  it('keeps the newest end of a value the helper cut from the top', () => {
    const scrollback = `…${'old output\n'.repeat(200)}% echo done\ndone\n% `
    const line = renderElement({
      ref: 'r2.10',
      role: 'textbox',
      value: scrollback,
      actions: [],
    })
    expect(line).toMatch(/value="….*% echo done done %"$/)
    expect(line.length).toBeLessThan(900)
    expect(
      renderElement({
        ref: 'r1',
        role: 'textbox',
        value: 'x'.repeat(300),
        actions: [],
      }),
    ).toBe(`r1 textbox value="${'x'.repeat(200)}…"`)
  })
})

function kit(identity: Partial<UiCallerIdentity> = {}) {
  const store = new SessionLogStore({ root: '/tmp/unused', persist: false })
  const session = store.create({ id: 's1' })
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-tools-')), 'computer-use'),
  })
  const policy = new UiActionPolicy({ grants })
  const pending = new PendingInteractions()
  const ask = new GrantAskService()
  ask.setAnswerer(pending.grantAnswerer)
  const port = new FakeComputerUsePort()
  const service = new ComputerUseService({
    port,
    grants,
    policy,
    sessionFor: (id) => store.get(id),
    saveImage: () => ({ attachmentId: 'a', mediaType: 'image/png', bytes: 1 }),
    cancelGrantCards: () => undefined,
    settings: () => ({ enabled: true }),
  })
  const who: UiCallerIdentity = {
    subject: 'session:s1',
    kind: 'session',
    ownerSessionId: 's1',
    callerSessionId: 's1',
    taskId: 's1:1',
    turn: 1,
    background: false,
    canAsk: true,
    fullAccess: false,
    ...identity,
  }
  const gateDeps: GateDeps = {
    service,
    policy,
    grants,
    ask,
    identity: () => who,
    planActive: () => false,
    rootSession: () => session,
    highImpact: defaultHighImpactClassifier,
    now: () => new Date(),
  }
  const runtime: ToolRuntime = {
    service,
    gate: gateDeps,
    identity: () => who,
    vision: () => false,
    isDirectChild: (parent, child) => parent === 's1' && child === 'c1',
  }
  const gate = createComputerUseGate(gateDeps)
  const tools = new Map(createUiTools(runtime).map((tool) => [tool.name, tool]))
  const agent = { id: 's1', session } as unknown as Agent
  let n = 0
  async function run(name: string, args: Record<string, unknown> = {}) {
    const tool = tools.get(name) as ToolDefinition<unknown>
    const callId = `call-${++n}`
    const parsed = tool.parse(args)
    const signal = new AbortController().signal
    const decision = await gate({
      callId,
      name,
      arguments: parsed,
      agent,
      signal,
    })
    if (decision?.kind === 'deny') return { denied: decision.reason }
    const context: ToolRunContext = {
      callId,
      name,
      arguments: parsed,
      agent,
      signal,
      deferContext: () => undefined,
      concludeTurn: () => undefined,
    }
    const result = normalizeToolReturn(await tool.execute(parsed, context))
    return {
      result,
      json: JSON.parse((result.content[0] as TextBlock).text) as Record<
        string,
        unknown
      >,
    }
  }
  return { run, service, pending, grants, port, session }
}

describe('ui_* tools', () => {
  it('delegates only a bounded parent grant to a direct child and invalidates it when source narrows', async () => {
    const k = kit()
    const source = k.grants.issue({
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
      backgroundAllowed: true,
    })
    const rejected = await k.run('ui_delegate_grant', {
      grantId: source.grantId,
      childId: 'c2',
      actions: ['observe'],
    })
    expect(rejected.json).toMatchObject({
      status: 'error',
      code: 'PERMISSION_DENIED',
    })
    const expanded = await k.run('ui_delegate_grant', {
      grantId: source.grantId,
      childId: 'c1',
      actions: ['observe'],
      origins: ['https://evil.test'],
    })
    expect(expanded.json).toMatchObject({
      status: 'error',
      code: 'PERMISSION_DENIED',
    })
    const allowed = await k.run('ui_delegate_grant', {
      grantId: source.grantId,
      childId: 'c1',
      actions: ['observe'],
      origins: ['https://a.test'],
    })
    expect(allowed.json).toMatchObject({
      status: 'ok',
      childId: 'c1',
      actions: ['observe'],
    })
    const childGrant = k.grants.get(String(allowed.json?.grantId))!
    expect(childGrant).toMatchObject({
      subject: 'subagent:c1',
      scope: 'task',
      taskId: 's1:1',
      backgroundAllowed: true,
      targetScope: { kind: 'browser', origins: ['https://a.test'] },
      delegatedFrom: { grantId: source.grantId, revision: source.revision },
    })
    k.grants.narrow(source.grantId, { allowedActions: ['observe'] })
    expect(k.grants.get(childGrant.grantId)).toBeUndefined()
    expect(
      k.session.events.some((event) => event.type === 'ui/grant-delegated'),
    ).toBe(true)
  })

  it('ends a delegated grant when the parent grant is revoked', async () => {
    const k = kit()
    const source = k.grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://a.test'],
      },
      allowedActions: ['observe', 'interact'],
      scope: 'session',
      backgroundAllowed: true,
    })
    const allowed = await k.run('ui_delegate_grant', {
      grantId: source.grantId,
      childId: 'c1',
      actions: ['observe'],
      origins: ['https://a.test'],
    })
    const childId = String(allowed.json?.grantId)
    expect(k.grants.get(childId)).toBeDefined()
    k.grants.revoke(source.grantId, 'user')
    expect(k.grants.get(childId)).toBeUndefined()
  })

  it('covers exactly the catalog entries for ui_*', () => {
    const k = kit()
    void k
    const names = createUiTools({} as ToolRuntime)
      .map((tool) => tool.name)
      .sort()
    expect(names).toEqual(
      Object.keys(GUI_TOOL_CATALOG)
        .filter((name) => name.startsWith('ui_'))
        .sort(),
    )
  })

  it('reports capabilities and the preset’s auto-approval', async () => {
    const restricted = await kit().run('ui_get_capabilities')
    expect(restricted.json).toMatchObject({
      status: 'ok',
      platform: 'macos',
      stopped: false,
      autoApproved: [],
      alwaysConfirmed: ['credential-fill', 'high-impact'],
      drivers: [{ driver: 'embedded-browser', available: true }],
    })
    const full = await kit({ fullAccess: true }).run('ui_get_capabilities')
    expect(full.json?.autoApproved).toEqual([
      'observe',
      'interact',
      'navigate',
      'transfer',
    ])
  })

  it('lists targets with titles inside the untrusted envelope', async () => {
    const k = kit({ fullAccess: true })
    await k.service.open(
      {
        identity: {
          subject: 'session:s1',
          kind: 'session',
          ownerSessionId: 's1',
          callerSessionId: 's1',
          taskId: 's1:1',
          background: false,
          canAsk: true,
          fullAccess: true,
        },
        callId: 'open',
        toolName: 'browser_open',
        signal: new AbortController().signal,
        ticket: { kind: 'auto', actionClass: 'navigate' },
        vision: false,
      },
      { url: 'https://fixture.test/form' },
    )
    const listed = await k.run('ui_list_targets')
    expect(listed.json).toMatchObject({
      count: 1,
      targets: [{ current: true }],
    })
    expect(JSON.stringify(listed.json)).not.toContain('Fixture form')
    expect((listed.result!.content[1] as TextBlock).text).toContain(
      'Fixture form',
    )
  })

  it('requests control up front and returns the grant', async () => {
    const k = kit()
    const pending = k.run('ui_request_control', {
      origins: ['https://Example.com/path', 'https://example.com'],
      actions: ['observe', 'interact'],
      reason: 'fill the signup form',
    })
    await new Promise((resolve) => setImmediate(resolve))
    const card = k.pending.forSession('s1')[0]!
    const requested = k.session.events.at(-1)!
    expect(requested).toMatchObject({
      type: 'ui/grant-requested',
      data: {
        targetScope: { origins: ['https://example.com'] },
        allowedScopes: ['task', 'session', 'timed'],
        reason: 'fill the signup form',
      },
    })
    k.pending.answer(card, { grant: { option_id: 'task' } })
    const done = await pending
    expect(done.json).toMatchObject({
      granted: 'task',
      origins: ['https://example.com'],
    })
    const again = await k.run('ui_request_control', {
      origins: ['https://example.com'],
      actions: ['observe'],
    })
    expect(again.json).toMatchObject({
      granted: 'task',
      note: expect.stringContaining('already'),
    })
  })

  it('short-circuits under full access', async () => {
    const done = await kit({ fullAccess: true }).run('ui_request_control', {
      origins: ['https://example.com'],
      actions: ['navigate'],
    })
    expect(done.json).toMatchObject({ granted: 'auto' })
  })

  it('reports unknown operations and grants as structured errors', async () => {
    const k = kit()
    const status = await k.run('ui_action_status', { operationId: 'op_nope' })
    expect(status.result?.isError).toBe(true)
    expect(status.json).toMatchObject({ code: 'INVALID_REQUEST' })
    const release = await k.run('ui_release_control', { grantId: 'grant_nope' })
    expect(release.json).toMatchObject({ code: 'INVALID_REQUEST' })
    const cancel = await k.run('ui_cancel_action', { operationId: 'op_nope' })
    expect(cancel.json).toMatchObject({ cancelled: false })
  })

  it('rejects argument shapes the schema does not allow', () => {
    const tool = createUiTools({} as ToolRuntime).find(
      (item) => item.name === 'ui_release_control',
    )!
    expect(() => tool.parse({ targetId: 'a', grantId: 'b' })).toThrow(
      /exactly one/,
    )
    expect(() => tool.parse({})).toThrow(/exactly one/)
  })
})
