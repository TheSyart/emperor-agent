import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionLogStore } from '../../session-log/store'
import type { Agent } from '../agent/agent'
import { PendingInteractions } from '../host/interactions'
import type { ToolCallInfo } from '../tools/registry'
import {
  createComputerUseGate,
  createPlanModeGuard,
  createTicketCleanup,
  type GateDeps,
} from './gate'
import { GrantAskService } from './grants/ask'
import { GrantStore } from './grants/store'
import type { UiCallerIdentity } from './identity'
import { UiActionPolicy } from './policy'
import { defaultHighImpactClassifier } from './risk'
import { ComputerUseService } from './service/service'
import { FakeComputerUsePort } from './testing/fake-port'

function setup(initial: Partial<UiCallerIdentity> = {}) {
  const store = new SessionLogStore({ root: '/tmp/unused', persist: false })
  const session = store.create({ id: 's1' })
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-gate-')), 'computer-use'),
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
    cancelGrantCards: (sessionId) => pending.cancelGrants(sessionId),
    settings: () => ({ enabled: true }),
  })
  const state = {
    identity: {
      subject: 'session:s1',
      kind: 'session',
      ownerSessionId: 's1',
      callerSessionId: 's1',
      taskId: 's1:1',
      turn: 1,
      background: false,
      canAsk: true,
      fullAccess: false,
      ...initial,
    } as UiCallerIdentity,
    plan: false,
  }
  const deps: GateDeps = {
    service,
    policy,
    grants,
    ask,
    identity: () => state.identity,
    planActive: () => state.plan,
    rootSession: () => session,
    highImpact: defaultHighImpactClassifier,
    now: () => new Date(),
  }
  const gate = createComputerUseGate(deps)
  const agent = { id: 's1', session } as unknown as Agent
  let n = 0
  const call = (
    name: string,
    args: Record<string, unknown> = {},
  ): ToolCallInfo => ({
    callId: `call-${++n}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
  return {
    store,
    session,
    grants,
    policy,
    pending,
    service,
    port,
    state,
    deps,
    gate,
    call,
    agent,
  }
}

type Kit = ReturnType<typeof setup>

async function openAuto(k: Kit, path = '/form') {
  const was = k.state.identity
  k.state.identity = { ...was, fullAccess: true }
  const call = k.call('browser_open', { url: k.port.browser.url(path) })
  expect(await k.gate(call)).toEqual({ kind: 'allow' })
  const ticket = k.service.takeTicket('s1', call.callId)
  const record = await k.service.open(
    {
      identity: k.state.identity,
      callId: call.callId,
      toolName: 'browser_open',
      signal: call.signal,
      ticket,
      vision: false,
    },
    { url: k.port.browser.url(path) },
  )
  k.state.identity = was
  return record
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('computerUseGate', () => {
  it('ignores non-GUI tools and refuses unknown GUI tools', async () => {
    const k = setup()
    expect(await k.gate(k.call('bash'))).toBeUndefined()
    expect(await k.gate(k.call('mcp_playwright_browser_click'))).toBeUndefined()
    const unknown = await k.gate(k.call('browser_eval'))
    expect(unknown).toMatchObject({ kind: 'deny' })
    expect((unknown as { reason: string }).reason).toMatch(
      /CAPABILITY_DISABLED/,
    )
  })

  it('allows info and control tools with a control ticket', async () => {
    const k = setup()
    const call = k.call('ui_list_targets')
    expect(await k.gate(call)).toEqual({ kind: 'allow' })
    expect(k.service.takeTicket('s1', call.callId)).toEqual({ kind: 'control' })
  })

  it('auto-approves under full access (D1) and records an auto ticket', async () => {
    const k = setup({ fullAccess: true })
    const call = k.call('browser_open', { url: 'https://fixture.test/form' })
    expect(await k.gate(call)).toEqual({ kind: 'allow' })
    expect(k.service.takeTicket('s1', call.callId)).toMatchObject({
      kind: 'auto',
      actionClass: 'navigate',
    })
    expect(k.pending.hasPending('s1')).toBe(false)
  })

  it('asks in restricted presets, then reuses the grant without asking again', async () => {
    const k = setup()
    const open = k.call('browser_open', { url: 'https://fixture.test/form' })
    const decision = k.gate(open)
    await tick()
    const [card] = k.pending.forSession('s1')
    expect(card).toMatch(/^grant_/)
    k.pending.answer(card!, { grant: { option_id: 'session' } })
    expect(await decision).toEqual({ kind: 'allow' })
    const ticket = k.service.takeTicket('s1', open.callId)
    expect(ticket).toMatchObject({ kind: 'grant', grantRevision: 1 })
    expect(k.grants.get(ticket.grantId!)?.allowedActions).toEqual([
      'observe',
      'interact',
      'navigate',
    ])
    await k.service.open(
      {
        identity: k.state.identity,
        callId: open.callId,
        toolName: 'browser_open',
        signal: open.signal,
        ticket,
        vision: false,
      },
      { url: 'https://fixture.test/form' },
    )
    const observe = k.call('browser_observe')
    expect(await k.gate(observe)).toEqual({ kind: 'allow' })
    expect(k.pending.hasPending('s1')).toBe(false)
  })

  it('remembers a refusal for the rest of the task', async () => {
    const k = setup()
    const first = k.gate(
      k.call('browser_open', { url: 'https://fixture.test/form' }),
    )
    await tick()
    k.pending.answer(k.pending.forSession('s1')[0]!, {
      grant: { option_id: 'deny' },
    })
    const denied = await first
    expect((denied as { reason: string }).reason).toMatch(
      /PERMISSION_DENIED.*user-denied/,
    )
    const again = await k.gate(
      k.call('browser_open', { url: 'https://fixture.test/other' }),
    )
    expect((again as { reason: string }).reason).toMatch(/denied-earlier/)
    expect(k.pending.hasPending('s1')).toBe(false)
  })

  it('always asks once for a high-impact click, even under full access', async () => {
    const k = setup({ fullAccess: true })
    await openAuto(k, '/checkout')
    const observation = await k.service.observe(
      {
        identity: k.state.identity,
        callId: 'obs',
        toolName: 'browser_observe',
        signal: new AbortController().signal,
        ticket: { kind: 'auto', actionClass: 'observe' },
        vision: false,
      },
      {},
    )
    const pay = observation.elements.find(
      (element) => element.name === 'Pay now',
    )!
    const decision = k.gate(k.call('browser_click', { ref: pay.ref }))
    await tick()
    const card = k.pending.forSession('s1')[0]!
    const requested = k.session.events.at(-1)!
    expect(requested).toMatchObject({
      type: 'ui/grant-requested',
      data: {
        actions: ['high-impact'],
        allowedScopes: ['once'],
        highImpact: true,
      },
    })
    k.pending.answer(card, { grant: { option_id: 'once' } })
    expect(await decision).toEqual({ kind: 'allow' })

    const other = observation.elements.find(
      (element) => element.name === '删除账户',
    )!
    const second = k.gate(k.call('browser_click', { ref: other.ref }))
    await tick()
    expect(k.pending.hasPending('s1')).toBe(true)
    k.pending.cancelGrants()
    expect((await second) as { kind: string }).toMatchObject({ kind: 'deny' })
  })

  it('refuses mutating tools in plan mode but lets observation through', async () => {
    const k = setup({ fullAccess: true })
    await openAuto(k)
    k.state.plan = true
    const click = await k.gate(k.call('browser_click', { ref: 'r1.1' }))
    expect((click as { reason: string }).reason).toMatch(
      /PLAN_MODE_ACTION_DENIED/,
    )
    expect(await k.gate(k.call('browser_observe'))).toEqual({ kind: 'allow' })
    const guard = createPlanModeGuard(() => true)
    expect(guard(k.call('browser_fill', { ref: 'r1.1', text: 'x' }))).toMatch(
      /PLAN_MODE_ACTION_DENIED/,
    )
    expect(guard(k.call('browser_observe'))).toBeUndefined()
    expect(guard(k.call('bash'))).toBeUndefined()
  })

  it('refuses target tools without an open target and while stopped', async () => {
    const k = setup({ fullAccess: true })
    const none = await k.gate(k.call('browser_observe'))
    expect((none as { reason: string }).reason).toMatch(/INVALID_REQUEST/)
    await k.service.emergencyStop()
    const stopped = await k.gate(
      k.call('browser_open', { url: 'https://fixture.test/form' }),
    )
    expect((stopped as { reason: string }).reason).toMatch(/emergency-stop/)
    expect(await k.gate(k.call('ui_list_targets'))).toEqual({ kind: 'allow' })
  })

  it('never lets a subagent open a card', async () => {
    const k = setup({ kind: 'subagent', subject: 'subagent:c1', canAsk: false })
    const decision = await k.gate(
      k.call('browser_open', { url: 'https://fixture.test/form' }),
    )
    expect((decision as { reason: string }).reason).toMatch(
      /subagent-cannot-ask/,
    )
    expect(k.pending.hasPending('s1')).toBe(false)
  })

  it('rejects non-web URLs before asking', async () => {
    const k = setup()
    const decision = await k.gate(
      k.call('browser_open', { url: 'file:///etc/passwd' }),
    )
    expect((decision as { reason: string }).reason).toMatch(/non-web-url/)
    expect(k.pending.hasPending('s1')).toBe(false)
  })

  it('drops unused tickets after the result', async () => {
    const k = setup()
    const call = k.call('ui_list_targets')
    await k.gate(call)
    createTicketCleanup(k.service)(call, { isError: false, content: [] })
    expect(() => k.service.takeTicket('s1', call.callId)).toThrow(
      /not authorized/,
    )
  })
})
