import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { UiGrant } from '../types'
import {
  findCoveringGrant,
  grantCovers,
  normalizeOrigin,
  type GrantRequirement,
} from './match'
import { GRANTS_FILE, GrantStore, type GrantIssueInput } from './store'

function root(): string {
  return join(mkdtempSync(join(tmpdir(), 'cu-grants-')), 'computer-use')
}

function clock(start = '2026-09-24T00:00:00.000Z') {
  let now = new Date(start)
  return {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms)
    },
  }
}

let counter = 0
const ids = () => `grant_${++counter}`

const browserGrant = (
  over: Partial<GrantIssueInput> = {},
): GrantIssueInput => ({
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
  ...over,
})

const caller = {
  subject: 'session:s1',
  ownerSessionId: 's1',
  taskId: 's1:3',
  background: false,
}

const need = (over: Partial<GrantRequirement> = {}): GrantRequirement => ({
  driver: 'embedded-browser',
  actionClass: 'interact',
  profileId: 'temporary',
  origin: 'https://example.com',
  callId: 'call-1',
  ...over,
})

describe('GrantStore', () => {
  it('persists session and timed grants with 0600 / 0700 and keeps once/task in memory', () => {
    const dir = root()
    const store = new GrantStore({ root: dir, idFactory: ids })
    store.issue(browserGrant())
    store.issue(
      browserGrant({ scope: 'timed', expiresAt: '2099-01-01T00:00:00.000Z' }),
    )
    store.issue(browserGrant({ scope: 'task', taskId: 's1:3' }))
    store.issue(browserGrant({ scope: 'once', callId: 'call-9' }))
    expect(store.list()).toHaveLength(4)

    const file = join(dir, GRANTS_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      grants: UiGrant[]
    }
    expect(onDisk.grants.map((grant) => grant.scope).sort()).toEqual([
      'session',
      'timed',
    ])

    const reloaded = new GrantStore({ root: dir })
    expect(
      reloaded
        .list()
        .map((grant) => grant.scope)
        .sort(),
    ).toEqual(['session', 'timed'])
  })

  it('drops expired grants on load and on listing', () => {
    const dir = root()
    const time = clock()
    const store = new GrantStore({ root: dir, now: time.now, idFactory: ids })
    const timed = store.issue(
      browserGrant({ scope: 'timed', expiresAt: '2026-09-24T00:15:00.000Z' }),
    )
    const changes: string[] = []
    store.onChange((change) =>
      changes.push(`${change.kind}:${change.cause ?? ''}`),
    )
    time.advance(16 * 60_000)
    expect(store.get(timed.grantId)).toBeUndefined()
    expect(store.list()).toEqual([])
    expect(changes).toEqual(['revoked:expiry'])
    expect(new GrantStore({ root: dir, now: time.now }).list()).toEqual([])
  })

  it('quarantines a corrupt file and comes up suspended (fail closed)', () => {
    const dir = root()
    new GrantStore({ root: dir }).issue(browserGrant())
    writeFileSync(join(dir, GRANTS_FILE), '{ not json')
    const store = new GrantStore({ root: dir })
    expect(store.list()).toEqual([])
    expect(store.suspended?.by).toBe('corrupt-store')
    expect(readdirSync(dir).some((name) => name.includes('corrupt'))).toBe(true)
    store.resume()
    expect(new GrantStore({ root: dir }).suspended).toBeNull()
  })

  it('drops individually invalid entries instead of widening them', () => {
    const dir = root()
    const store = new GrantStore({ root: dir, idFactory: ids })
    const good = store.issue(browserGrant())
    const document = JSON.parse(
      readFileSync(join(dir, GRANTS_FILE), 'utf8'),
    ) as {
      grants: unknown[]
    }
    document.grants.push({
      ...good,
      grantId: 'evil',
      allowedActions: ['everything'],
    })
    writeFileSync(join(dir, GRANTS_FILE), JSON.stringify(document))
    expect(
      new GrantStore({ root: dir }).list().map((grant) => grant.grantId),
    ).toEqual([good.grantId])
  })

  it('bumps the revision on narrowing and revokes when nothing is left', () => {
    const store = new GrantStore({ root: root(), idFactory: ids })
    const grant = store.issue(
      browserGrant({
        allowedActions: ['observe', 'interact', 'navigate'],
        targetScope: {
          kind: 'browser',
          profileId: 'temporary',
          origins: ['https://a.test', 'https://b.test'],
        },
      }),
    )
    const narrowed = store.narrow(grant.grantId, {
      allowedActions: ['observe'],
      origins: ['https://a.test'],
    })!
    expect(narrowed.revision).toBe(2)
    expect(narrowed.allowedActions).toEqual(['observe'])
    expect(narrowed.targetScope).toMatchObject({ origins: ['https://a.test'] })
    expect(
      store.narrow(grant.grantId, { allowedActions: ['interact'] }),
    ).toBeUndefined()
    expect(store.get(grant.grantId)).toBeUndefined()
  })

  it('persists the emergency-stop suspension across restarts', () => {
    const dir = root()
    const store = new GrantStore({ root: dir })
    store.suspend('kill-switch')
    expect(new GrantStore({ root: dir }).suspended?.by).toBe('kill-switch')
  })

  it('revokes by predicate', () => {
    const store = new GrantStore({ root: root(), idFactory: ids })
    store.issue(browserGrant({ ownerSessionId: 's1' }))
    store.issue(browserGrant({ ownerSessionId: 's2', subject: 'session:s2' }))
    const revoked = store.revokeWhere(
      (grant) => grant.ownerSessionId === 's1',
      'session-end',
    )
    expect(revoked).toHaveLength(1)
    expect(store.list().map((grant) => grant.ownerSessionId)).toEqual(['s2'])
  })
})

describe('grant matching', () => {
  const now = new Date('2026-09-24T00:00:00.000Z')
  const grant = (over: Partial<UiGrant> = {}): UiGrant => ({
    ...browserGrant(),
    grantId: 'g',
    createdAt: now.toISOString(),
    revision: 1,
    ...over,
  })

  it('normalizes origins and refuses non-http schemes', () => {
    expect(normalizeOrigin('https://Example.com:443/path?q')).toBe(
      'https://example.com',
    )
    expect(normalizeOrigin('http://192.168.1.4:8080/x')).toBe(
      'http://192.168.1.4:8080',
    )
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
  })

  it.each([
    ['same subject, origin and class', {}, {}, {}, true],
    ['other subject', { subject: 'session:s2' }, {}, {}, false],
    ['other driver', { driver: 'desktop' as const }, {}, {}, false],
    ['class not allowed', {}, { actionClass: 'navigate' as const }, {}, false],
    [
      'subdomain is not the origin',
      {},
      { origin: 'https://www.example.com' },
      {},
      false,
    ],
    ['different port', {}, { origin: 'https://example.com:8443' }, {}, false],
    ['other profile', {}, { profileId: 'work' }, {}, false],
    ['expired', { expiresAt: '2026-09-23T23:59:59.000Z' }, {}, {}, false],
    ['background without consent', {}, {}, { background: true }, false],
    [
      'background with consent',
      { backgroundAllowed: true },
      {},
      { background: true },
      true,
    ],
    ['other session', { ownerSessionId: 's9' }, {}, {}, false],
    [
      'task grant, same task',
      { scope: 'task' as const, taskId: 's1:3' },
      {},
      {},
      true,
    ],
    [
      'task grant, next task',
      { scope: 'task' as const, taskId: 's1:2' },
      {},
      {},
      false,
    ],
    [
      'once grant, its call',
      { scope: 'once' as const, callId: 'call-1' },
      {},
      {},
      true,
    ],
    [
      'once grant, another call',
      { scope: 'once' as const, callId: 'call-2' },
      {},
      {},
      false,
    ],
    [
      'high-impact needs once',
      { allowedActions: ['interact', 'high-impact'] as const },
      { highImpact: true },
      {},
      false,
    ],
    [
      'high-impact once grant',
      {
        scope: 'once' as const,
        callId: 'call-1',
        allowedActions: ['high-impact'] as const,
      },
      { highImpact: true },
      {},
      true,
    ],
    [
      'transfer needs once',
      { allowedActions: ['transfer'] as const },
      { actionClass: 'transfer' as const },
      {},
      false,
    ],
  ])('%s', (_label, grantOver, needOver, callerOver, expected) => {
    expect(
      grantCovers(
        grant(grantOver as Partial<UiGrant>),
        need(needOver),
        { ...caller, ...callerOver },
        now,
      ),
    ).toBe(expected)
  })

  it('matches desktop grants by app and optional window', () => {
    const desktop = grant({
      driver: 'desktop',
      targetScope: { kind: 'desktop', appId: 'com.apple.TextEdit' },
    })
    const base = need({
      driver: 'desktop',
      origin: undefined,
      profileId: undefined,
    })
    expect(
      grantCovers(
        desktop,
        { ...base, appId: 'com.apple.TextEdit' },
        caller,
        now,
      ),
    ).toBe(true)
    expect(
      grantCovers(desktop, { ...base, appId: 'com.apple.Notes' }, caller, now),
    ).toBe(false)
    const pinned = grant({
      driver: 'desktop',
      targetScope: {
        kind: 'desktop',
        appId: 'com.apple.TextEdit',
        windowRef: 'w1',
      },
    })
    expect(
      grantCovers(
        pinned,
        { ...base, appId: 'com.apple.TextEdit', windowRef: 'w2' },
        caller,
        now,
      ),
    ).toBe(false)
    const risky = { ...base, appId: 'com.apple.TextEdit', highRiskApp: true }
    expect(grantCovers(desktop, risky, caller, now)).toBe(false)
    expect(
      grantCovers(
        { ...desktop, scope: 'task', taskId: 's1:3' },
        risky,
        caller,
        now,
      ),
    ).toBe(true)
  })

  it('prefers the narrowest covering grant', () => {
    const found = findCoveringGrant(
      [
        grant({ grantId: 'session' }),
        grant({ grantId: 'task', scope: 'task', taskId: 's1:3' }),
      ],
      need(),
      caller,
      now,
    )
    expect(found?.grantId).toBe('task')
  })
})
