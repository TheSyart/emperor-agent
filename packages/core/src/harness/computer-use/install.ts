/**
 * Wire Computer Use into a harness host: the kernel service, grant store,
 * policy, grant cards, the gate / Plan guard / ticket cleanup, and — while
 * the user's master switch is on — the GUI tools and their prompt section.
 * Hosts without a port (CLI, ACP) never call this.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Session } from '../../session-log/session'
import type { Agent } from '../agent/agent'
import type { PendingInteractions } from '../host/interactions'
import type { SystemPromptAssembler } from '../prompt/assembler'
import type { ToolDefinition } from '../tools/definition'
import type { ToolRegistry } from '../tools/registry'
import {
  createComputerUseGate,
  createPlanModeGuard,
  createTicketCleanup,
  type GateDeps,
} from './gate'
import { GrantAskService } from './grants/ask'
import { BrowserProfileStore } from './profiles'
import { RestorableTabStore } from './restorable'
import { SitePermissionStore } from './site-permissions'
import { GrantStore } from './grants/store'
import { resolveIdentity } from './identity'
import { UiActionPolicy } from './policy'
import type { ComputerUseHostPort } from './port'
import { installComputerUsePromptSection } from './prompt'
import { ScreenshotLedger } from './screenshots'
import { defaultHighImpactClassifier, type HighImpactClassifier } from './risk'
import {
  ComputerUseService,
  type ComputerUseChange,
  type ComputerUseSettings,
  type ExternalConfirmation,
} from './service/service'
import type { ToolRuntime } from './tools/runtime'
import { createUiTools } from './tools/ui-tools'
import { ExternalSiteRuleStore } from './external-site-rules'
import type { UiTargetScope } from './types'

/**
 * Chrome/Edge cards outside a tool call (RV-09): a page that moved to a
 * site needing approval, or a download, shows the usual grant card (「本次」
 * or 拒绝) in the owner's conversation. A caller that cannot ask, or a
 * conversation that is gone, reads as a refusal. An accepted card leaves a
 * `once` grant bound to no tool call; it ends with the task.
 */
export function createExternalConfirmation(deps: {
  readonly ask: GrantAskService
  readonly grants: GrantStore
  sessionFor(sessionId: string): Session | undefined
}): (request: ExternalConfirmation) => Promise<boolean> {
  return async (request) => {
    const { identity } = request
    const session = deps.sessionFor(identity.ownerSessionId)
    if (session === undefined || !identity.canAsk) return false
    const targetScope: UiTargetScope = {
      kind: 'browser',
      profileId: request.profileId,
      origins: [request.origin],
    }
    const actions = [request.actionClass]
    const outcome = await deps.ask.request(
      {
        session,
        subject: identity.subject,
        driver: 'external-browser',
        targetScope,
        actions,
        allowedScopes: ['once'],
        display: request.display,
        background: false,
      },
      () =>
        deps.grants.issue({
          subject: identity.subject,
          ownerSessionId: identity.ownerSessionId,
          driver: 'external-browser',
          targetScope,
          allowedActions: actions,
          scope: 'once',
          backgroundAllowed: true,
          callId: `external-${randomUUID()}`,
        }),
    )
    return outcome.grant !== undefined
  }
}

export interface AttachmentSaver {
  save(input: { raw: Uint8Array; name: string; mime: string }): {
    id: string
    size: number
    mime: string
  }
  /** Delete one (screenshot quota / user clear). */
  remove?(attachmentId: string): number
}

export interface InstallComputerUseOptions {
  readonly port: ComputerUseHostPort
  readonly tools: ToolRegistry
  readonly prompt: SystemPromptAssembler
  readonly pending: PendingInteractions
  /** `~/.emperor/computer-use` */
  readonly stateDir: string
  /** `~/.emperor/browser` (persistent profiles); absent: temporary only. */
  readonly profilesDir?: string
  readonly attachments: AttachmentSaver
  sessionFor(sessionId: string): Session | undefined
  rootOf(agent: Agent): Agent
  planActive(agent: Agent): boolean
  routeVision(agent: Agent): boolean
  settings(): ComputerUseSettings
  onChanged?(reason: ComputerUseChange, sessionId?: string): void
  readonly highImpact?: HighImpactClassifier
  /** Driver tool families beyond `ui_*` (browser, desktop). */
  readonly toolFamilies?: ReadonlyArray<
    (runtime: ToolRuntime) => ToolDefinition[]
  >
  now?(): Date
}

export interface InstalledComputerUse {
  readonly service: ComputerUseService
  readonly grants: GrantStore
  readonly policy: UiActionPolicy
  readonly ask: GrantAskService
  readonly runtime: ToolRuntime
  /** Register or remove the GUI tools (master switch). */
  setEnabled(enabled: boolean): void
  readonly enabled: boolean
  dispose(): Promise<void>
}

function remove<T>(list: T[], item: T): void {
  const index = list.indexOf(item)
  if (index >= 0) list.splice(index, 1)
}

export function installComputerUse(
  options: InstallComputerUseOptions,
): InstalledComputerUse {
  const now = options.now ?? (() => new Date())
  const grants = new GrantStore({ root: options.stateDir, now })
  const profiles =
    options.profilesDir === undefined
      ? undefined
      : new BrowserProfileStore(options.profilesDir, now)
  const sitePermissions =
    options.profilesDir === undefined
      ? undefined
      : new SitePermissionStore(options.profilesDir, now)
  const restorable =
    options.profilesDir === undefined
      ? undefined
      : new RestorableTabStore(options.profilesDir, now)
  const policy = new UiActionPolicy({ grants, now })
  const ask = new GrantAskService()
  ask.setAnswerer(options.pending.grantAnswerer)
  const externalSites = new ExternalSiteRuleStore(options.stateDir)
  const confirmExternal = createExternalConfirmation({
    ask,
    grants,
    sessionFor: options.sessionFor,
  })
  const service = new ComputerUseService({
    port: options.port,
    grants,
    policy,
    sessionFor: options.sessionFor,
    saveImage: (bytes, mediaType, name) => {
      const ref = options.attachments.save({
        raw: bytes,
        name,
        mime: mediaType,
      })
      return { attachmentId: ref.id, mediaType: ref.mime, bytes: ref.size }
    },
    deleteImage: (attachmentId) => {
      options.attachments.remove?.(attachmentId)
    },
    screenshots: new ScreenshotLedger(options.stateDir, undefined, now),
    cancelGrantCards: (sessionId) => {
      options.pending.cancelGrants(sessionId)
    },
    settings: options.settings,
    ...(profiles === undefined ? {} : { profiles }),
    ...(sitePermissions === undefined ? {} : { sitePermissions }),
    ...(restorable === undefined ? {} : { restorable }),
    ...(options.onChanged === undefined
      ? {}
      : { onChanged: options.onChanged }),
    now,
    externalSites,
    confirmExternal,
  })
  const identity = (agent: Agent | undefined) =>
    resolveIdentity(agent, {
      rootOf: options.rootOf,
      enabled: () => options.settings().enabled,
    })
  const gateDeps: GateDeps = {
    service,
    policy,
    grants,
    ask,
    identity,
    planActive: options.planActive,
    rootSession: (agent) => options.rootOf(agent).session,
    highImpact: options.highImpact ?? defaultHighImpactClassifier,
    now,
  }
  const runtime: ToolRuntime = {
    service,
    gate: gateDeps,
    identity,
    vision: options.routeVision,
  }

  const gate = createComputerUseGate(gateDeps)
  const guard = createPlanModeGuard(options.planActive)
  const cleanup = createTicketCleanup(service)
  options.tools.preExecute.push(gate)
  options.tools.guards.push(guard)
  options.tools.observers.push(cleanup)
  // Removed 2026-09-29 (the AI drives continuously): a call from an older
  // conversation, or from a model that remembers them, says why.
  const retired = [
    options.tools.retire(
      'ui_request_control',
      'nothing needs asking up front any more; while computer use is on, ordinary actions run directly and only high-impact actions and credential fills show a confirmation card',
    ),
    options.tools.retire(
      'ui_delegate_grant',
      'there is nothing to delegate; subagents act on ordinary targets while computer use is on and report high-impact actions or credential fills back to their parent',
    ),
  ]
  grants.onChange((change) => {
    if (
      change.kind === 'issued' ||
      change.kind === 'revoked' ||
      change.kind === 'narrowed'
    )
      options.onChanged?.('grants', change.grant?.ownerSessionId)
  })

  let registrations: Array<() => void> = []
  // 历史记录 「从不」 (RV-10): the history tool is not offered at all.
  const visibilityOf = (name: string) =>
    name === 'external_history_search'
      ? {
          visible: () => service.externalBrowserSettings().history !== 'never',
        }
      : {}
  const register = (): void => {
    if (registrations.length > 0) return
    const definitions = [
      ...createUiTools(runtime),
      ...(options.toolFamilies ?? []).flatMap((family) => family(runtime)),
    ]
    registrations = [
      ...definitions.map((definition) =>
        options.tools.register(definition, visibilityOf(definition.name)),
      ),
      installComputerUsePromptSection(options.prompt),
    ]
  }
  const unregister = (): void => {
    for (const dispose of registrations.splice(0)) dispose()
  }
  if (options.settings().enabled) register()

  return {
    service,
    grants,
    policy,
    ask,
    runtime,
    setEnabled(enabled) {
      if (enabled) register()
      else unregister()
    },
    get enabled() {
      return registrations.length > 0
    },
    async dispose() {
      unregister()
      remove(options.tools.preExecute, gate)
      remove(options.tools.guards, guard)
      remove(options.tools.observers, cleanup)
      for (const restore of retired) restore()
      ask.setAnswerer(undefined)
      await service.shutdown()
    },
  }
}

/** `<stateRoot>/computer-use` */
export function computerUseStateDir(stateRoot: string): string {
  return join(stateRoot, 'computer-use')
}

/** `~/.emperor/browser`: persistent profiles and their metadata. */
export function browserStateDir(stateRoot: string): string {
  return join(stateRoot, 'browser')
}
