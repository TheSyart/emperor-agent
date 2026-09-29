import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionLogStore } from '../../../session-log/store'
import { GrantStore } from '../grants/store'
import type { UiCallerIdentity } from '../identity'
import { UiActionPolicy } from '../policy'
import type {
  BrowserDriver,
  ComputerUseHostPort,
  ExternalAttachedTarget,
  TargetSnapshot,
} from '../port'
import { defaultHighImpactClassifier } from '../risk'
import { ComputerUseService, type OpContext } from '../service/service'
import { GUI_TOOL_CATALOG } from './catalog'
import { createExternalTools } from './external-tools'
import type { ToolRuntime } from './runtime'

const ORIGIN = 'https://example.com'
const identity: UiCallerIdentity = {
  subject: 'session:external-test',
  kind: 'session',
  ownerSessionId: 'external-test',
  callerSessionId: 'external-test',
  taskId: 'external-test:1',
  turn: 1,
  background: false,
  canAsk: true,
  fullAccess: true,
}

function kit() {
  const log = new SessionLogStore({ root: '/tmp/unused', persist: false })
  log.create({ id: identity.ownerSessionId })
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-external-')), 'grants'),
  })
  const policy = new UiActionPolicy({ grants })
  const candidate: ExternalAttachedTarget = {
    targetId: 'external-target-1',
    profileId: 'pair-1',
    tabId: 7,
    windowId: 2,
    origin: ORIGIN,
    generation: 5,
    revision: 0,
    claimedBy: null,
  }
  let attached: ExternalAttachedTarget = candidate
  let changedOrigin = false
  let closed = false
  const driver = {
    driver: 'external-browser',
    listAttached: () => [attached],
    claimAttachedTarget: async (
      _targetId: string,
      ownerSessionId: string,
    ): Promise<TargetSnapshot> => {
      attached = { ...attached, claimedBy: ownerSessionId }
      return {
        targetId: candidate.targetId,
        kind: 'external-tab',
        driver: 'external-browser',
        generation: candidate.generation,
        revision: 0,
        url: changedOrigin ? 'https://evil.example' : candidate.origin,
        title: 'Attached Chrome tab',
        loading: false,
        profileId: candidate.profileId,
      }
    },
    close: async () => {
      closed = true
    },
    subscribe: () => () => undefined,
    setNavigationPolicy: () => undefined,
  } as unknown as BrowserDriver
  const port = {
    platform: 'macos',
    embeddedBrowser: () => null,
    externalBrowser: () => driver,
    desktop: () => null,
    capabilities: async () => [],
    indicateControl: () => undefined,
  } satisfies ComputerUseHostPort
  const service = new ComputerUseService({
    port,
    grants,
    policy,
    sessionFor: (id) => log.get(id),
    saveImage: () => ({
      attachmentId: 'unused',
      mediaType: 'image/png',
      bytes: 0,
    }),
    cancelGrantCards: () => undefined,
    settings: () => ({ enabled: true }),
  })
  const ctx: OpContext = {
    identity,
    callId: 'attach-1',
    toolName: 'external_tab_attach',
    signal: new AbortController().signal,
    ticket: { kind: 'auto', actionClass: 'observe' },
    vision: false,
  }
  return {
    service,
    ctx,
    log,
    setChangedOrigin: () => {
      changedOrigin = true
    },
    get closed() {
      return closed
    },
  }
}

describe('external tab attachment', () => {
  it('keeps external tools and gate catalog in sync', () => {
    expect(
      createExternalTools({} as ToolRuntime)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(
      Object.keys(GUI_TOOL_CATALOG)
        .filter((name) => name.startsWith('external_'))
        .sort(),
    )
  })

  it('classifies the user attached tab by pairing and exact origin, then registers only that target', async () => {
    const k = kit()
    const classified = GUI_TOOL_CATALOG.external_tab_attach!.classify!({
      args: { targetId: 'external-target-1' },
      identity,
      service: k.service,
      highImpact: defaultHighImpactClassifier,
      callId: 'attach-1',
      toolName: 'external_tab_attach',
    })
    expect(classified.requirement).toMatchObject({
      driver: 'external-browser',
      profileId: 'pair-1',
      origin: ORIGIN,
      actionClass: 'observe',
    })
    const record = await k.service.attachExternal(k.ctx, 'external-target-1')
    expect(record).toMatchObject({
      targetId: 'external-target-1',
      ownerSessionId: 'external-test',
      generation: 5,
    })
    expect(k.service.listTargets('external-test')).toHaveLength(1)
    expect(() =>
      k.service.externalCandidate('different-task', 'external-target-1'),
    ).toThrow()
    expect(
      k.log.get('external-test')!.events.map((event) => event.type),
    ).toContain('ui/target-opened')
  })

  it('refuses a tab that changed origin between listing and claim', async () => {
    const k = kit()
    k.setChangedOrigin()
    await expect(
      k.service.attachExternal(k.ctx, 'external-target-1'),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(k.closed).toBe(true)
    expect(k.service.listTargets('external-test')).toHaveLength(0)
  })
})
