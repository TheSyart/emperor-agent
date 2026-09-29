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

  it('reports capabilities and what runs without asking', async () => {
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

  it('has no tool to request control up front or delegate grants', () => {
    const names = createUiTools({} as ToolRuntime).map((tool) => tool.name)
    expect(names).not.toContain('ui_request_control')
    expect(names).not.toContain('ui_delegate_grant')
  })

  it('reports unknown operations and targets as structured errors', async () => {
    const k = kit()
    const status = await k.run('ui_action_status', { operationId: 'op_nope' })
    expect(status.result?.isError).toBe(true)
    expect(status.json).toMatchObject({ code: 'INVALID_REQUEST' })
    const release = await k.run('ui_release_control', {
      targetId: 'tab_00000000-0000-4000-8000-000000000000',
    })
    expect(release.result?.isError).toBe(true)
    const cancel = await k.run('ui_cancel_action', { operationId: 'op_nope' })
    expect(cancel.json).toMatchObject({ cancelled: false })
  })

  it('rejects argument shapes the schema does not allow', () => {
    const tool = createUiTools({} as ToolRuntime).find(
      (item) => item.name === 'ui_release_control',
    )!
    // Only a target can be released; grants are not the model's to drop.
    expect(() => tool.parse({ grantId: 'grant_1' })).toThrow()
    expect(() => tool.parse({})).toThrow()
  })
})
