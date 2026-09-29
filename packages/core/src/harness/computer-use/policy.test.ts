import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GrantStore } from './grants/store'
import type { UiCallerIdentity } from './identity'
import { UiActionPolicy, type UiRequirement } from './policy'
import type { UiActionClass } from './types'

function setup() {
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-policy-')), 'computer-use'),
  })
  const policy = new UiActionPolicy({
    grants,
    now: () => new Date('2026-09-24T00:00:00.000Z'),
  })
  return { grants, policy }
}

const who = (over: Partial<UiCallerIdentity> = {}): UiCallerIdentity => ({
  subject: 'session:s1',
  kind: 'session',
  ownerSessionId: 's1',
  callerSessionId: 's1',
  taskId: 's1:1',
  turn: 1,
  background: false,
  canAsk: true,
  fullAccess: false,
  ...over,
})

const need = (over: Partial<UiRequirement> = {}): UiRequirement => ({
  driver: 'embedded-browser',
  actionClass: 'interact',
  profileId: 'temporary',
  origin: 'https://example.com/path',
  callId: 'call-1',
  ...over,
})

const CLASSES: UiActionClass[] = [
  'observe',
  'interact',
  'navigate',
  'transfer',
  'high-impact',
]

describe('UiActionPolicy preset matrix (D1)', () => {
  it.each(
    CLASSES.flatMap((actionClass) =>
      [false, true].map((fullAccess) => [actionClass, fullAccess] as const),
    ),
  )('%s with fullAccess=%s', (actionClass, fullAccess) => {
    const { policy } = setup()
    const verdict = policy.evaluate(who({ fullAccess }), need({ actionClass }))
    const auto =
      fullAccess &&
      (actionClass === 'observe' ||
        actionClass === 'interact' ||
        actionClass === 'navigate' ||
        actionClass === 'transfer')
    expect(verdict.kind).toBe(auto ? 'allow' : 'ask')
    if (verdict.kind === 'allow') expect(verdict.via).toBe('auto')
  })

  it('still asks for high-impact under full access', () => {
    const { policy } = setup()
    expect(
      policy.evaluate(who({ fullAccess: true }), need({ highImpact: true }))
        .kind,
    ).toBe('ask')
  })

  it('auto-approves background work under full access too', () => {
    const { policy } = setup()
    const verdict = policy.evaluate(
      who({ fullAccess: true, background: true, kind: 'scheduler' }),
      need(),
    )
    expect(verdict).toMatchObject({ kind: 'allow', via: 'auto' })
  })

  it('auto-approves ordinary transfer and high-risk app input in computer-use full mode', () => {
    const { policy } = setup()
    expect(
      policy.evaluate(
        who({ fullAccess: true }),
        need({ actionClass: 'transfer' }),
      ),
    ).toMatchObject({ kind: 'allow', via: 'auto' })
    expect(
      policy.evaluate(
        who({ fullAccess: true }),
        need({
          driver: 'desktop',
          origin: undefined,
          profileId: undefined,
          appId: 'com.apple.Terminal',
          highRiskApp: true,
        }),
      ),
    ).toMatchObject({ kind: 'allow', via: 'auto' })
  })

  it('still asks every time for credential fill and payment', () => {
    const { policy } = setup()
    expect(
      policy.evaluate(
        who({ fullAccess: true }),
        need({ confirmEachTime: true }),
      ).kind,
    ).toBe('ask')
    expect(
      policy.evaluate(who({ fullAccess: true }), need({ highImpact: true }))
        .kind,
    ).toBe('ask')
  })

  it('does not reuse a broad stored grant for a high-impact action', () => {
    const { grants, policy } = setup()
    grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://example.com'],
      },
      allowedActions: ['high-impact'],
      scope: 'task',
      taskId: 's1:1',
      backgroundAllowed: false,
    })
    expect(
      policy.evaluate(who({ fullAccess: true }), need({ highImpact: true }))
        .kind,
    ).toBe('ask')
  })
})

describe('UiActionPolicy rules', () => {
  it('refuses protected targets whatever the preset', () => {
    const { policy } = setup()
    const verdict = policy.evaluate(
      who({ fullAccess: true }),
      need({ protectedReason: 'emperor-self' }),
    )
    expect(verdict.kind).toBe('deny')
    if (verdict.kind === 'deny') {
      expect(verdict.error.code).toBe('TARGET_FORBIDDEN')
      expect(verdict.error.reason).toBe('emperor-self')
    }
  })

  it('refuses everything while suspended, even with full access', () => {
    const { grants, policy } = setup()
    grants.suspend('kill-switch')
    const verdict = policy.evaluate(who({ fullAccess: true }), need())
    expect(verdict).toMatchObject({
      kind: 'deny',
      error: { code: 'PERMISSION_DENIED', reason: 'emergency-stop' },
    })
  })

  it('allows through a covering grant', () => {
    const { grants, policy } = setup()
    const grant = grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://example.com'],
      },
      allowedActions: ['observe', 'interact'],
      scope: 'session',
      backgroundAllowed: false,
    })
    expect(policy.evaluate(who(), need())).toEqual({
      kind: 'allow',
      via: 'grant',
      grant,
    })
    // A new origin is not covered: the card appears (§6.7).
    expect(
      policy.evaluate(
        who(),
        need({ actionClass: 'navigate', origin: 'https://evil.test/x' }),
      ).kind,
    ).toBe('ask')
  })

  it('never lets a subagent ask', () => {
    const { policy } = setup()
    const verdict = policy.evaluate(
      who({ kind: 'subagent', subject: 'subagent:c1', canAsk: false }),
      need(),
    )
    expect(verdict).toMatchObject({
      kind: 'deny',
      error: { code: 'PERMISSION_REQUIRED', reason: 'subagent-cannot-ask' },
    })
  })

  it('does not retry around a refusal within the task', () => {
    const { policy } = setup()
    policy.rememberDenial(who(), need())
    expect(policy.evaluate(who(), need())).toMatchObject({
      kind: 'deny',
      error: { reason: 'denied-earlier' },
    })
    // Same origin, same class: another path through the page is refused too.
    expect(
      policy.evaluate(who(), need({ origin: 'https://example.com/other' }))
        .kind,
    ).toBe('deny')
    // The next task starts fresh.
    expect(policy.evaluate(who({ taskId: 's1:2' }), need()).kind).toBe('ask')
  })

  it('keeps a refused credential fill from blocking ordinary actions', () => {
    const { policy } = setup()
    const credential = need({
      confirmEachTime: true,
      toolName: 'browser_fill_credential',
    })
    policy.rememberDenial(who(), credential)
    expect(policy.evaluate(who(), credential)).toMatchObject({
      kind: 'deny',
      error: { reason: 'denied-earlier' },
    })
    // Clicking or typing on the same site still asks normally.
    expect(policy.evaluate(who(), need()).kind).toBe('ask')
    expect(policy.evaluate(who({ fullAccess: true }), need()).kind).toBe(
      'allow',
    )
  })

  it('honors a task refusal after unrestricted mode is enabled', () => {
    const { policy } = setup()
    policy.rememberDenial(who(), need())
    expect(policy.evaluate(who({ fullAccess: true }), need())).toMatchObject({
      kind: 'deny',
      error: { code: 'PERMISSION_DENIED', reason: 'denied-earlier' },
    })
  })

  it('plans cards by risk: scopes, actions and background', () => {
    const { policy } = setup()
    const plain = policy.evaluate(who({ background: true }), need())
    expect(plain).toEqual({
      kind: 'ask',
      plan: {
        targetScope: {
          kind: 'browser',
          profileId: 'temporary',
          origins: ['https://example.com'],
        },
        actions: ['interact', 'observe'],
        allowedScopes: ['once', 'task', 'session', 'timed'],
        background: true,
      },
    })
    const risky = policy.evaluate(who(), need({ highImpact: true }))
    expect(risky).toMatchObject({
      kind: 'ask',
      plan: { actions: ['high-impact'], allowedScopes: ['once'] },
    })
    const transfer = policy.evaluate(who(), need({ actionClass: 'transfer' }))
    expect(transfer).toMatchObject({
      plan: { actions: ['transfer'], allowedScopes: ['once'] },
    })
    const open = policy.evaluate(
      who(),
      need({ actionClass: 'navigate', askActions: ['interact', 'navigate'] }),
    )
    expect(open).toMatchObject({
      plan: { actions: ['interact', 'navigate', 'observe'] },
    })
    const terminal = policy.evaluate(
      who(),
      need({
        driver: 'desktop',
        origin: undefined,
        profileId: undefined,
        appId: 'com.apple.Terminal',
        highRiskApp: true,
      }),
    )
    expect(terminal).toMatchObject({
      plan: {
        targetScope: { kind: 'desktop', appId: 'com.apple.Terminal' },
        allowedScopes: ['once', 'task'],
      },
    })
  })

  it('refuses a browser action without a usable origin', () => {
    const { policy } = setup()
    expect(
      policy.evaluate(who(), need({ origin: 'file:///etc/passwd' })),
    ).toMatchObject({ kind: 'deny', error: { code: 'INVALID_REQUEST' } })
  })
})
