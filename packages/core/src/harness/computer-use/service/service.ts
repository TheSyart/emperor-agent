/**
 * `ComputerUseService` — the single execution kernel (spec 00 §4.2). Every
 * GUI entry point calls its typed commands; drivers are never reachable from
 * a model, a page, the renderer or MCP directly.
 *
 * Before anything reaches a driver the service re-checks what the gate
 * decided (defense in depth): the gate ticket exists, its grant is still
 * valid at the same revision, the caller owns the target, the target is
 * live and not paused, the generation still matches
 * and the per-task budget is not spent. Then it journals `prepared`, takes
 * the per-target lock, and lets the driver report `dispatched` right before
 * the first side effect. A failure after dispatch is `OUTCOME_UNKNOWN` and is
 * never retried automatically.
 */

import type { Session } from '../../../session-log/session'
import type { SessionEventMap } from '../../../session-log/types'
import { asUiError, UiError } from '../errors'
import {
  redactAction,
  type TargetClosedReason,
  type TaskReleaseReason,
} from '../events'
import type { GrantStore } from '../grants/store'
import { grantCovers, normalizeOrigin } from '../grants/match'
import type { UiCallerIdentity } from '../identity'
import type { UiActionPolicy, UiRequirement } from '../policy'
import type {
  ActOutcome,
  BrowserDriver,
  BrowserProfileSpec,
  ComputerUseHostPort,
  DesktopAppInfo,
  DesktopMenuListing,
  DesktopWindowInfo,
  DriverEvent,
  ExternalAttachedTarget,
  NavigationRequest,
  ObserveQuery,
  SitePermissionRequest,
  TargetDriver,
  TargetSnapshot,
  WaitOutcome,
} from '../port'
import { DEFAULT_OBSERVE_BUDGET } from '../schemas'
import type {
  BrowserProfileView,
  CredentialBinding,
  CredentialField,
  CredentialFillOutcome,
  CredentialHandle,
  DownloadRecord,
  UploadRecord,
  ComputerUseStatusView,
  ControlState,
  DriverCapability,
  DriverKind,
  RedactedUiAction,
  UiAction,
  UiActionClass,
  UiObservation,
  UiTargetView,
  WaitCondition,
} from '../types'
import {
  OperationJournal,
  statusFromLog,
  statusOf,
  type OperationRecord,
  type OperationStatus,
  type UiEventType,
} from './journal'
import type { BrowserProfileStore } from '../profiles'
import type { RestorableTab, RestorableTabStore } from '../restorable'
import type { ScreenshotLedger } from '../screenshots'
import type {
  SitePermission,
  SitePermissionKind,
  SitePermissionStore,
} from '../site-permissions'
import { KeyedMutex } from './mutex'
import { protectedMacApp } from '../protected-apps'
import { isExecutableDownload } from '../downloads'
import {
  DEFAULT_EXTERNAL_BROWSER_SETTINGS,
  externalSiteDecision,
  externalSiteError,
  stricterDecision,
  type ExternalBrowserSettings,
  type ExternalBrowserSettingsPatch,
  type ExternalSiteDecision,
  type ExternalSiteKind,
  type ExternalSiteRuleStore,
} from '../external-site-rules'
import type { ExternalDriverEvent, ExternalHistoryEntry } from '../port'
import {
  TargetRegistry,
  isLive,
  targetOrigin,
  targetRef,
  targetView,
  type TargetRecord,
} from './registry'

export interface ComputerUseSettings {
  /**
   * The user's master switch. While it is on the AI drives continuously;
   * only high-impact actions and credential fills ask (2026-09-29).
   */
  readonly enabled: boolean
  /** A saved per-item mode switched computer use off (Settings explains). */
  readonly scopedRetired?: true
  /** Per-driver switches; missing means on. */
  readonly drivers?: Partial<Record<DriverKind, boolean>>
  /** Inbox retention in days; 0 keeps downloads (default 30). */
  readonly downloadRetentionDays?: number
  /**
   * Apps the user had kept from Emperor with the retired protected list
   * (2026-10-01); Settings shows them once, then they are forgotten.
   */
  readonly retiredProtectedApps?: readonly string[]
}

export type ComputerUseChange =
  'state' | 'targets' | 'grants' | 'profiles' | 'site-permissions'

export interface SavedImage {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
}

export interface ComputerUseServiceDeps {
  readonly port: ComputerUseHostPort | null
  readonly grants: GrantStore
  readonly policy: UiActionPolicy
  /** Session logs by id (root owners and calling agents). */
  sessionFor(sessionId: string): Session | undefined
  saveImage(
    bytes: Uint8Array,
    mediaType: 'image/png' | 'image/jpeg',
    name: string,
  ): SavedImage
  /** Delete a saved screenshot attachment (quota / user clear). */
  deleteImage?(attachmentId: string): void
  /** Screenshot quota ledger (spec 00 §8.5). */
  readonly screenshots?: ScreenshotLedger
  /** Dismiss pending grant cards (switch-off / session end). */
  cancelGrantCards(sessionId?: string): void
  settings(): ComputerUseSettings
  /** Persistent browser profiles (absent: only the temporary profile). */
  readonly profiles?: BrowserProfileStore
  /** User-allowed site permissions (absent: every request is denied). */
  readonly sitePermissions?: SitePermissionStore
  /** Persistent-profile tabs to offer back after a restart. */
  readonly restorable?: RestorableTabStore
  onChanged?(reason: ComputerUseChange, sessionId?: string): void
  now?(): Date
  /** Chrome/Edge 智能体权限 and 浏览器权限 (absent: the defaults). */
  readonly externalSites?: ExternalSiteRuleStore
  /**
   * Ask the user about something a Chrome/Edge page did by itself (moved to
   * a site that needs approval, started a download): one card in the
   * owner's conversation. Resolves whether the user allowed it; absent or
   * failing: refused.
   */
  confirmExternal?(request: ExternalConfirmation): Promise<boolean>
}

/** A card about a Chrome/Edge page, outside any tool call (RV-09). */
export interface ExternalConfirmation {
  /** Who last drove the owner's targets (the card goes to its root). */
  readonly identity: UiCallerIdentity
  /** The browser connection (pairing) of the tab. */
  readonly profileId: string
  /** The site in question (normalized origin). */
  readonly origin: string
  readonly actionClass: 'navigate' | 'transfer'
  readonly display: { readonly url: string; readonly title: string }
}

/** What the gate decided for one call; the service re-validates it. */
export interface GateTicket {
  readonly kind: 'grant' | 'auto' | 'control'
  readonly grantId?: string
  readonly grantRevision?: number
  readonly actionClass?: UiActionClass
  readonly requirement?: UiRequirement
  readonly targetId?: string
  readonly generation?: number
}

export interface OpContext {
  readonly identity: UiCallerIdentity
  readonly callId: string
  readonly toolName: string
  readonly signal: AbortSignal
  readonly ticket: GateTicket
  /** The active model route can see images. */
  readonly vision: boolean
}

export interface ScreenshotResult {
  readonly target: TargetRecord
  readonly screenshotId: string
  readonly audit: SavedImage & {
    readonly width: number
    readonly height: number
  }
  readonly model?: SavedImage & {
    readonly width: number
    readonly height: number
  }
}

export interface ActResult {
  readonly target: TargetRecord
  readonly operationId: string
  readonly beforeRevision: number
  readonly outcome: ActOutcome
  readonly autoApproved: boolean
}

export interface WaitResult {
  readonly target: TargetRecord
  readonly operationId: string
  readonly outcome: WaitOutcome
}

export const COMPUTER_USE_BUDGET = {
  targetsPerSession: 4,
  targetsTotal: 8,
  operationsPerTask: 300,
  actDeadlineMs: 15_000,
  openDeadlineMs: 30_000,
  /** One download: size cap and how long to wait for it (spec 00 §7.5). */
  downloadMaxBytes: 200 * 1024 * 1024,
  downloadTimeoutMs: 110_000,
} as const

/** What the end of a task released (2026-09-29 §3.3). */
export interface TaskReleaseSummary {
  readonly released: readonly string[]
  readonly failed: readonly {
    readonly targetId: string
    readonly error: string
  }[]
}

/** How long the release waits for one driver step (it never hangs a task). */
const RELEASE_STEP_MS = 10_000
/** How long the release waits for an aborted action to leave its target. */
const RELEASE_DRAIN_MS = 5_000

export interface CredentialFillResult {
  readonly target: TargetRecord
  readonly operationId: string
  readonly handle: CredentialHandle
  readonly outcome: CredentialFillOutcome
}

export interface UploadResult {
  readonly target: TargetRecord
  readonly operationId: string
  readonly upload: UploadRecord
}

export interface DownloadResult {
  readonly target: TargetRecord
  readonly operationId: string
  readonly download: DownloadRecord
}

const TEMPORARY_PROFILE = 'temporary'
const ABORTED = 'computer use operation aborted'

function mergeSignals(...signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals)
}

/** `r12.37` → 12; anything else → undefined. */
export function refRevision(ref: string | undefined): number | undefined {
  const match = ref === undefined ? null : /^r(\d+)\.\d+$/.exec(ref)
  return match === null ? undefined : Number(match[1])
}

function actionRefRevision(action: UiAction): number | undefined {
  switch (action.kind) {
    case 'click':
    case 'fill':
    case 'appendText':
    case 'select':
    case 'secondary':
      return refRevision(action.ref)
    case 'typeText':
    case 'press':
    case 'scroll':
      return refRevision(action.ref)
    case 'drag':
      return typeof action.from === 'string'
        ? refRevision(action.from)
        : undefined
    default:
      return undefined
  }
}

export class ComputerUseService {
  readonly registry = new TargetRegistry()
  readonly journal: OperationJournal
  private readonly mutex = new KeyedMutex()
  private readonly tickets = new Map<string, GateTicket>()
  private readonly operationsByTask = new Map<string, number>()
  private readonly lastIdentity = new Map<string, UiCallerIdentity>()
  private readonly notes = new Map<string, string[]>()
  private readonly permissionNotes = new Set<string>()
  /**
   * `${ownerSessionId}|${targetId}` the user let the Agent bring forward for
   * the rest of the task, and the targets activated this task (their front is
   * handed back when the task ends).
   */
  /** Targets paused while the app window reloads (they resume with it). */
  private readonly uiPaused = new Set<string>()
  private readonly activatedThisTask = new Map<string, Set<string>>()
  private readonly desktopCandidates = new Map<
    string,
    { window: DesktopWindowInfo; seenAt: number }
  >()
  private readonly subscribed = new Set<TargetDriver>()
  private readonly unsubscribers: Array<() => void> = []
  /** Task releases in progress, by owner (a second call joins the first). */
  private readonly releases = new Map<string, Promise<TaskReleaseSummary>>()
  /**
   * Chrome/Edge tabs a page took to a blocked site, or to one the user did
   * not approve: why they were disconnected (bounded), and per owner the
   * latest one for a call without a targetId (said once).
   */
  private readonly externalGone = new Map<
    string,
    { origin: string; why: 'blocked' | 'denied' }
  >()
  private readonly externalGoneByOwner = new Map<string, string>()
  private closed = false

  constructor(private readonly deps: ComputerUseServiceDeps) {
    this.journal = new OperationJournal((sessionId, type, data) =>
      this.append(sessionId, type, data),
    )
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  // -------------------------------------------------------------------------
  // Session log plumbing

  private append<T extends UiEventType>(
    sessionId: string,
    type: T,
    data: SessionEventMap[T],
  ): void {
    const session = this.deps.sessionFor(sessionId)
    if (session === undefined) return
    const write = session.append as (type: string, data: unknown) => void
    try {
      write.call(session, type, data)
    } catch {
      // Re-entrant publication: retry once the current append has settled.
      queueMicrotask(() => {
        try {
          const later = this.deps.sessionFor(sessionId)
          if (later !== undefined)
            (later.append as (type: string, data: unknown) => void).call(
              later,
              type,
              data,
            )
        } catch {
          // the session went away; the in-memory state still holds
        }
      })
    }
  }

  private changed(reason: ComputerUseChange, sessionId?: string): void {
    try {
      this.deps.onChanged?.(reason, sessionId)
    } catch {
      // observers must not break the kernel
    }
    this.indicate()
  }

  private indicate(): void {
    const port = this.deps.port
    if (port === null) return
    const targets = this.registry.live().map((record) => ({
      targetId: record.targetId,
      title: record.title,
      driver: record.driver,
      state: record.control,
    }))
    try {
      port.indicateControl({
        active: targets.some((target) => target.state === 'agent'),
        targets,
      })
    } catch {
      // indicator failures never block control
    }
  }

  // -------------------------------------------------------------------------
  // Gate tickets

  private ticketKey(agentId: string, callId: string): string {
    return `${agentId}\u0000${callId}`
  }

  issueTicket(agentId: string, callId: string, ticket: GateTicket): void {
    this.tickets.set(this.ticketKey(agentId, callId), ticket)
    if (this.tickets.size > 1_000) {
      const oldest = this.tickets.keys().next().value
      if (oldest !== undefined) this.tickets.delete(oldest)
    }
  }

  /** The gate's decision for this call; absent means the gate was bypassed. */
  takeTicket(agentId: string, callId: string): GateTicket {
    const key = this.ticketKey(agentId, callId)
    const ticket = this.tickets.get(key)
    this.tickets.delete(key)
    if (ticket === undefined)
      throw new UiError(
        'PERMISSION_DENIED',
        'this call was not authorized by the computer use gate',
        { reason: 'gate-bypassed' },
      )
    return ticket
  }

  dropTicket(agentId: string, callId: string): void {
    this.tickets.delete(this.ticketKey(agentId, callId))
  }

  // -------------------------------------------------------------------------
  // Drivers

  get platform(): ComputerUseHostPort['platform'] | null {
    return this.deps.port?.platform ?? null
  }

  /**
   * The system-protected apps (01 §4.4): Emperor itself, the system's
   * password and authorization dialogs, Keychain Access, Passwords, System
   * Settings and the login window. Every other app is operable.
   */
  isProtectedApp(appId: string): boolean {
    return this.platform === 'macos' && protectedMacApp(appId)
  }

  private assertEnabled(driver: DriverKind): void {
    if (this.closed)
      throw new UiError('CAPABILITY_DISABLED', 'computer use is shutting down')
    const settings = this.deps.settings()
    if (!settings.enabled)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'computer use is turned off in Settings',
      )
    if (settings.drivers?.[driver] === false)
      throw new UiError(
        'CAPABILITY_DISABLED',
        `the ${driver} driver is turned off in Settings`,
      )
  }

  private driverOf(kind: DriverKind): TargetDriver {
    this.assertEnabled(kind)
    const port = this.deps.port
    const driver =
      port === null
        ? null
        : kind === 'embedded-browser'
          ? port.embeddedBrowser()
          : kind === 'external-browser'
            ? port.externalBrowser()
            : port.desktop()
    if (driver === null)
      throw new UiError(
        'CAPABILITY_DISABLED',
        `the ${kind} driver is not available on this host`,
      )
    this.watch(driver)
    return driver
  }

  browserDriver(
    kind: 'embedded-browser' | 'external-browser' = 'embedded-browser',
  ): BrowserDriver {
    return this.driverOf(kind) as BrowserDriver
  }

  private desktopDriver() {
    return this.driverOf('desktop') as NonNullable<
      ReturnType<ComputerUseHostPort['desktop']>
    >
  }

  listExternalTabs(ownerSessionId: string): readonly ExternalAttachedTarget[] {
    const driver = this.browserDriver('external-browser')
    if (driver.listAttached === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'external browser attachment is unavailable',
      )
    return driver
      .listAttached()
      .filter(
        (tab) => tab.claimedBy === null || tab.claimedBy === ownerSessionId,
      )
  }

  externalCandidate(
    ownerSessionId: string,
    targetId: string,
  ): ExternalAttachedTarget {
    const candidate = this.listExternalTabs(ownerSessionId).find(
      (tab) => tab.targetId === targetId,
    )
    if (candidate === undefined)
      throw new UiError(
        'STALE_TARGET',
        'external tab is no longer attached; reconnect it in the extension',
      )
    if (candidate.claimedBy !== null)
      throw new UiError(
        'TARGET_BUSY',
        'external tab already belongs to this task',
      )
    if (normalizeOrigin(candidate.origin) !== candidate.origin)
      throw new UiError('INVALID_REQUEST', 'external tab has no valid origin')
    return candidate
  }

  async listDesktopApps(signal: AbortSignal): Promise<DesktopAppInfo[]> {
    // The helper hides the system-protected apps; filter here as well.
    return (await this.desktopDriver().listApps(signal)).filter(
      (app) => !this.isProtectedApp(app.appId),
    )
  }

  async listDesktopWindows(
    identity: UiCallerIdentity,
    appId: string | undefined,
    signal: AbortSignal,
  ): Promise<DesktopWindowInfo[]> {
    const all = await this.desktopDriver().listWindows(
      appId === undefined ? {} : { appId },
      signal,
    )
    const seenAt = this.now().getTime()
    // Protected windows stay known (a guessed ref is refused as protected,
    // not as stale) but are never shown to the model.
    for (const window of all)
      this.desktopCandidates.set(
        `${identity.ownerSessionId}|${window.windowRef}`,
        { window, seenAt },
      )
    if (this.desktopCandidates.size > 500) {
      for (const [key, value] of this.desktopCandidates)
        if (seenAt - value.seenAt > 30_000) this.desktopCandidates.delete(key)
    }
    return all.filter((window) => !this.isProtectedApp(window.appId))
  }

  desktopCandidate(
    identity: UiCallerIdentity,
    windowRef: string,
  ): DesktopWindowInfo {
    const item = this.desktopCandidates.get(
      `${identity.ownerSessionId}|${windowRef}`,
    )
    if (item === undefined || this.now().getTime() - item.seenAt > 30_000)
      throw new UiError(
        'STALE_TARGET',
        'window list is stale; call desktop_list_windows again',
      )
    if (this.isProtectedApp(item.window.appId))
      throw new UiError('TARGET_FORBIDDEN', 'this app is protected')
    return item.window
  }

  private sameDesktopWindowIdentity(
    before: DesktopWindowInfo,
    after: DesktopWindowInfo,
  ): boolean {
    const a = before.bounds
    const b = after.bounds
    return (
      before.windowRef === after.windowRef &&
      before.appId === after.appId &&
      before.pid === after.pid &&
      before.title === after.title &&
      (a === undefined
        ? b === undefined
        : b !== undefined &&
          a.x === b.x &&
          a.y === b.y &&
          a.width === b.width &&
          a.height === b.height)
    )
  }

  private watch(driver: TargetDriver): void {
    if (this.subscribed.has(driver)) return
    this.subscribed.add(driver)
    this.unsubscribers.push(
      driver.subscribe((event) => this.onDriverEvent(event)),
    )
    if (driver.driver !== 'desktop') {
      const browser = driver as BrowserDriver
      browser.setNavigationPolicy((request) => this.navigationVerdict(request))
      browser.setSitePermissionPolicy?.((request) =>
        this.sitePermissionVerdict(request),
      )
      browser.setSiteDecider?.((url, kind) =>
        this.externalSiteDecision(url, kind),
      )
    }
  }

  /**
   * A page asked for a device or browser permission. Allowed only when the
   * user allowed that kind for that origin in the target's profile; a
   * refusal is noted for the Agent (once per origin and kind).
   */
  sitePermissionVerdict(request: SitePermissionRequest): boolean {
    const record = this.registry.get(request.targetId)
    if (record === undefined) return false
    const allowed =
      this.deps.sitePermissions?.allowed(
        record.profileId,
        request.origin,
        request.kind,
      ) === true
    if (!allowed) {
      const key = `${request.targetId}|${request.origin}|${request.kind}`
      if (!this.permissionNotes.has(key)) {
        this.permissionNotes.add(key)
        if (this.permissionNotes.size > 256) this.permissionNotes.clear()
        this.note(
          record.targetId,
          `${request.origin.slice(0, 200)} asked for ${request.kind} access and was denied; only the user can allow it (Settings › 浏览器 › 网站设置)`,
        )
      }
    }
    return allowed
  }

  async capabilities(
    options: { readonly connect?: boolean } = {},
  ): Promise<DriverCapability[]> {
    const port = this.deps.port
    if (port === null) return []
    const settings = this.deps.settings()
    const live = await port.capabilities(options)
    return live.map((capability) => {
      const enabled =
        settings.enabled && settings.drivers?.[capability.driver] !== false
      // Say why the model cannot use a driver the port could offer; a
      // driver this machine lacks keeps the port's own reason.
      const reason =
        capability.stage === 'unavailable'
          ? capability.reason
          : !settings.enabled
            ? 'computer use is turned off in Settings'
            : !enabled
              ? 'the user switched this driver off in Settings'
              : capability.reason
      return {
        ...capability,
        enabled,
        available: capability.available && enabled,
        ...(reason === undefined ? {} : { reason }),
      }
    })
  }

  // -------------------------------------------------------------------------
  // Targets

  /** Target lookup without throwing (for the gate's classification). */
  lookup(
    identity: UiCallerIdentity,
    targetId?: string,
  ): TargetRecord | undefined {
    const record =
      targetId === undefined
        ? this.registry.currentFor(identity.ownerSessionId)
        : this.registry.get(targetId)
    if (record === undefined) return undefined
    if (record.ownerSessionId !== identity.ownerSessionId) return undefined
    if (!isLive(record) || record.releasing === true) return undefined
    return record
  }

  /**
   * A target of this owner that the end of an earlier task released (or is
   * releasing): its handle is stale. Without a targetId: the current one.
   */
  releasedTarget(
    identity: UiCallerIdentity,
    targetId?: string,
  ): TargetRecord | undefined {
    const record =
      targetId === undefined
        ? this.registry.lastCurrent(identity.ownerSessionId)
        : this.registry.get(targetId)
    if (record?.ownerSessionId !== identity.ownerSessionId) return undefined
    return record.state === 'released' || record.releasing === true
      ? record
      : undefined
  }

  /**
   * The error for a released handle: it says what to call to get the window
   * or tab again, and never that it was closed (it was not).
   */
  releasedError(record: TargetRecord): UiError {
    const what = record.driver === 'desktop' ? 'window' : 'tab'
    return new UiError(
      'STALE_TARGET',
      `this ${what} was released when the last task ended; it is still open`,
      {
        reason: 'released-at-task-end',
        hint:
          record.driver === 'desktop'
            ? 'Call desktop_list_windows, then desktop_bind the window again.'
            : record.driver === 'external-browser'
              ? 'Call external_tab_list, then external_tab_attach the tab again.'
              : 'Call browser_tab_list, then browser_tab_select the tab to take it back.',
      },
    )
  }

  private resolve(identity: UiCallerIdentity, targetId?: string): TargetRecord {
    const record = this.lookup(identity, targetId)
    if (record !== undefined) return record
    const released = this.releasedTarget(identity, targetId)
    if (released !== undefined) throw this.releasedError(released)
    const gone = this.externalGoneError(identity, targetId)
    if (gone !== undefined) throw gone
    throw new UiError(
      'INVALID_REQUEST',
      targetId === undefined
        ? 'no open target; open one first'
        : `unknown target ${targetId}`,
      { hint: 'List targets or open a new one.' },
    )
  }

  private assertActionable(record: TargetRecord): void {
    switch (record.control) {
      case 'paused':
        throw new UiError(
          'TARGET_BUSY',
          'the app window is reloading; actions on this target resume by themselves once it is back',
          { reason: 'ui-reloading' },
        )
      default:
        break
    }
    // The driver lost contact: this action reconnects it (with a new
    // generation, so earlier refs are stale and the model observes again).
    if (record.state === 'recovering') {
      record.state = 'attached'
      this.changed('targets', record.ownerSessionId)
    }
  }

  /** Live targets, and released ones whose release failed (they say so). */
  listTargets(ownerSessionId?: string): UiTargetView[] {
    return this.registry
      .all()
      .filter(
        (record) =>
          (ownerSessionId === undefined ||
            record.ownerSessionId === ownerSessionId) &&
          (isLive(record) ||
            (record.state === 'released' && record.releaseError !== undefined)),
      )
      .map((record) => this.view(record))
  }

  /**
   * The browser tabs of this owner: live ones, and built-in tabs released at
   * the end of an earlier task (browser_tab_select takes one back).
   */
  listTabs(ownerSessionId: string): UiTargetView[] {
    return this.registry
      .held(ownerSessionId)
      .filter((record) => record.driver !== 'desktop')
      .map((record) => this.view(record))
  }

  private view(record: TargetRecord): UiTargetView {
    return targetView(record)
  }

  /**
   * Stamp the Agent's operation on a target; the conversation preview stacks
   * the latest on top, so a change of the latest target is announced.
   */
  private touch(targetId: string): void {
    const record = this.registry.get(targetId)
    if (record === undefined) return
    const latest = this.registry
      .live(record.ownerSessionId)
      .reduce<TargetRecord | undefined>(
        (best, item) =>
          best === undefined || item.lastActiveAt > best.lastActiveAt
            ? item
            : best,
        undefined,
      )
    record.lastActiveAt = this.now().toISOString()
    if (latest !== undefined && latest !== record)
      this.changed('targets', record.ownerSessionId)
  }

  /**
   * Make one of the owner's tabs current. A built-in tab released at the end
   * of an earlier task is taken back: refs from before are stale (observe it
   * again). A released window or external tab is bound or attached anew.
   */
  async select(
    identity: UiCallerIdentity,
    targetId: string,
  ): Promise<TargetRecord> {
    await this.releases.get(identity.ownerSessionId)
    const released = this.releasedTarget(identity, targetId)
    if (released !== undefined) return this.takeBack(identity, released)
    const record = this.resolve(identity, targetId)
    this.registry.select(identity.ownerSessionId, targetId)
    return record
  }

  private takeBack(
    identity: UiCallerIdentity,
    record: TargetRecord,
  ): TargetRecord {
    if (record.driver !== 'embedded-browser' || record.releasing === true)
      throw this.releasedError(record)
    const snapshot = this.browserDriver('embedded-browser').snapshot(
      record.targetId,
    )
    if (snapshot === null) {
      this.registry.end(record.targetId, 'lost')
      this.changed('targets', record.ownerSessionId)
      throw new UiError('STALE_TARGET', 'the tab is gone', {
        hint: 'Call browser_tab_list, or open a new tab.',
      })
    }
    record.generation = snapshot.generation
    record.revision = snapshot.revision
    record.url = snapshot.url
    record.title = snapshot.title
    record.state = 'attached'
    record.control = 'agent'
    delete record.releaseError
    record.lastActiveAt = this.now().toISOString()
    this.registry.select(record.ownerSessionId, record.targetId)
    this.lastIdentity.set(record.ownerSessionId, identity)
    const origin = targetOrigin(record)
    this.append(record.ownerSessionId, 'ui/target-opened', {
      targetId: record.targetId,
      kind: record.kind,
      driver: record.driver,
      generation: record.generation,
      profileId: record.profileId,
      ...(record.title === '' ? {} : { title: record.title.slice(0, 200) }),
      ...(origin === null ? {} : { origin }),
    })
    this.append(record.ownerSessionId, 'ui/control-state', {
      targetId: record.targetId,
      state: 'agent',
    })
    this.changed('targets', record.ownerSessionId)
    return record
  }

  /**
   * Budget room for one more target: released built-in tabs count (their
   * pages are open), so the oldest go first when a new target needs room.
   */
  private makeRoom(ownerSessionId: string): void {
    const over = (): boolean =>
      this.registry.held(ownerSessionId).length >=
        COMPUTER_USE_BUDGET.targetsPerSession ||
      this.registry.held().length >= COMPUTER_USE_BUDGET.targetsTotal
    while (over()) {
      const mine =
        this.registry.held(ownerSessionId).length >=
        COMPUTER_USE_BUDGET.targetsPerSession
      const victim = this.registry
        .released(mine ? ownerSessionId : undefined)
        .filter((record) => record.driver === 'embedded-browser')
        .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))[0]
      if (victim === undefined) return
      // Ends the record at once; the page closes behind it.
      void this.closeTarget(victim, 'agent')
    }
  }

  private assertRoom(ownerSessionId: string, message: string): void {
    this.makeRoom(ownerSessionId)
    if (
      this.registry.held(ownerSessionId).length >=
      COMPUTER_USE_BUDGET.targetsPerSession
    )
      throw new UiError(
        'BUDGET_EXCEEDED',
        `${message} in this session; close one first`,
      )
    if (this.registry.held().length >= COMPUTER_USE_BUDGET.targetsTotal)
      throw new UiError('BUDGET_EXCEEDED', `${message}; close one first`)
  }

  // -------------------------------------------------------------------------
  // Ticket re-validation

  private revalidate(ctx: OpContext, record: TargetRecord | undefined): void {
    const ticket = ctx.ticket
    if (ticket.kind === 'control') return
    if (ticket.kind === 'auto') {
      if (!this.deps.settings().enabled)
        throw new UiError(
          'CAPABILITY_DISABLED',
          'computer use was switched off',
          { reason: 'switched-off' },
        )
    } else {
      const grant =
        ticket.grantId === undefined
          ? undefined
          : this.deps.grants.get(ticket.grantId)
      if (grant === undefined || grant.revision !== ticket.grantRevision)
        throw new UiError(
          'PERMISSION_DENIED',
          'the grant was revoked or narrowed',
          {
            reason: 'grant-revoked',
          },
        )
      if (ticket.requirement !== undefined) {
        // Actions on the page re-check the page's current origin (it may
        // have moved since the gate looked); a navigation is bound to its
        // destination, which the ticket already names.
        const requirement =
          record === undefined ||
          ticket.requirement.origin === undefined ||
          ticket.requirement.actionClass === 'navigate' ||
          ticket.requirement.inFrame === true
            ? ticket.requirement
            : { ...ticket.requirement, origin: record.url }
        if (!grantCovers(grant, requirement, ctx.identity, this.now()))
          throw new UiError(
            'STALE_TARGET',
            'the target moved outside the granted scope',
            {
              reason: 'origin-changed',
            },
          )
      }
    }
    if (
      record !== undefined &&
      ticket.targetId === record.targetId &&
      ticket.generation !== undefined &&
      ticket.generation !== record.generation
    )
      throw new UiError(
        'STALE_TARGET',
        'the target navigated since permission was checked',
      )
  }

  private chargeBudget(identity: UiCallerIdentity): void {
    const used = this.operationsByTask.get(identity.taskId) ?? 0
    if (used >= COMPUTER_USE_BUDGET.operationsPerTask)
      throw new UiError(
        'BUDGET_EXCEEDED',
        'this task used its computer use budget',
      )
    this.operationsByTask.set(identity.taskId, used + 1)
    if (this.operationsByTask.size > 256) {
      const oldest = this.operationsByTask.keys().next().value
      if (oldest !== undefined) this.operationsByTask.delete(oldest)
    }
  }

  private prepare(
    ctx: OpContext,
    targetId: string,
    action: RedactedUiAction,
    expectedRevision: number,
  ): OperationRecord {
    return this.journal.prepare({
      callId: ctx.callId,
      targetId,
      callerSessionId: ctx.identity.callerSessionId,
      ownerSessionId: ctx.identity.ownerSessionId,
      action,
      expectedRevision,
      actionClass: ctx.ticket.actionClass ?? 'observe',
      ...(ctx.ticket.grantId === undefined
        ? {}
        : { grantId: ctx.ticket.grantId }),
      autoApproved: ctx.ticket.kind === 'auto',
    })
  }

  /** Run one driver call under the target lock with journal bookkeeping. */
  private async run<T>(
    ctx: OpContext,
    op: OperationRecord,
    lockKey: string,
    body: (signal: AbortSignal) => Promise<T>,
    settle: (value: T) => {
      afterRevision?: number
      outcome?: 'observed' | 'no-effect'
    },
  ): Promise<T> {
    const signal = mergeSignals(ctx.signal, op.controller.signal)
    let release: (() => void) | undefined
    try {
      release = await this.mutex.acquire(lockKey, signal)
      if (signal.aborted) throw new Error(ABORTED)
      this.touch(lockKey)
      const value = await body(signal)
      const detail = settle(value)
      this.journal.settle(op, detail.outcome ?? 'observed', {
        ...(detail.afterRevision === undefined
          ? {}
          : { afterRevision: detail.afterRevision }),
      })
      return value
    } catch (error) {
      if (op.state === 'dispatched') {
        this.journal.settle(op, 'unknown', { errorCode: 'OUTCOME_UNKNOWN' })
        // Keep a driver's own static reason and advice (which check could not
        // confirm the effect); the model needs it to decide whether to retry.
        const known =
          error instanceof UiError && error.code === 'OUTCOME_UNKNOWN'
            ? error
            : undefined
        throw new UiError(
          'OUTCOME_UNKNOWN',
          'the action may have happened but its result could not be confirmed',
          {
            cause: error,
            ...(known?.reason === undefined ? {} : { reason: known.reason }),
            ...(known === undefined ? {} : { hint: known.hint }),
          },
        )
      }
      if (signal.aborted) {
        this.journal.settle(op, 'cancelled', { errorCode: 'CANCELLED' })
        throw error instanceof UiError
          ? error
          : new UiError(
              'TIMEOUT_NO_EFFECT',
              'cancelled before anything was sent',
              {
                cause: error,
              },
            )
      }
      const uiError = asUiError(error)
      if (uiError.code === 'OUTCOME_UNKNOWN') {
        this.journal.settle(op, 'unknown', { errorCode: 'OUTCOME_UNKNOWN' })
        throw uiError
      }
      this.journal.settle(op, 'no-effect', { errorCode: uiError.code })
      throw uiError
    } finally {
      release?.()
    }
  }

  // -------------------------------------------------------------------------
  // Commands

  async bindDesktop(ctx: OpContext, windowRef: string): Promise<TargetRecord> {
    // The gate classified this exact candidate before showing a grant card.
    // That card may remain open longer than the 30-second list TTL, so retain
    // its original identity and check it against a fresh driver listing below.
    const candidate = this.desktopCandidates.get(
      `${ctx.identity.ownerSessionId}|${windowRef}`,
    )?.window
    if (candidate === undefined)
      throw new UiError(
        'STALE_TARGET',
        'window list is unavailable; list again',
      )
    if (this.isProtectedApp(candidate.appId))
      throw new UiError('TARGET_FORBIDDEN', 'this app is protected')
    const driver = this.desktopDriver()
    this.revalidate(ctx, undefined)
    if (
      ctx.ticket.requirement?.driver !== 'desktop' ||
      ctx.ticket.requirement.appId !== candidate.appId ||
      ctx.ticket.requirement.windowRef !== windowRef
    )
      throw new UiError('PERMISSION_DENIED', 'window authorization changed')
    await this.releases.get(ctx.identity.ownerSessionId)
    this.assertRoom(ctx.identity.ownerSessionId, 'too many open targets')
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    const op = this.prepare(
      ctx,
      'new',
      { kind: 'open', url: `app:${candidate.appId}` },
      0,
    )
    const snapshot = await this.run(
      ctx,
      op,
      `bind:${ctx.identity.ownerSessionId}`,
      async (signal) => {
        const current = await driver.listWindows(
          { appId: candidate.appId },
          signal,
        )
        if (
          current.filter((window) =>
            this.sameDesktopWindowIdentity(candidate, window),
          ).length !== 1
        )
          throw new UiError('STALE_TARGET', 'window identity changed')
        this.revalidate(ctx, undefined)
        this.journal.dispatched(op)
        return await driver.bind(
          { windowRef, ownerSessionId: ctx.identity.ownerSessionId },
          signal,
        )
      },
      (value) => ({ afterRevision: value.revision }),
    )
    if (
      snapshot.appId !== candidate.appId ||
      snapshot.kind !== 'desktop-window' ||
      snapshot.windowRef !== candidate.windowRef
    ) {
      await driver.close(snapshot.targetId, 'lost').catch(() => undefined)
      throw new UiError('STALE_TARGET', 'bound window identity changed')
    }
    const record = this.registry.add(
      ctx.identity.ownerSessionId,
      snapshot,
      this.now(),
    )
    this.append(ctx.identity.ownerSessionId, 'ui/target-opened', {
      targetId: record.targetId,
      kind: record.kind,
      driver: record.driver,
      generation: record.generation,
      profileId: record.profileId,
      title: record.title.slice(0, 200),
    })
    this.append(ctx.identity.ownerSessionId, 'ui/control-state', {
      targetId: record.targetId,
      state: 'agent',
    })
    this.syncCapture(record)
    this.changed('targets', ctx.identity.ownerSessionId)
    return record
  }

  async attachExternal(
    ctx: OpContext,
    targetId: string,
  ): Promise<TargetRecord> {
    const candidate = this.externalCandidate(
      ctx.identity.ownerSessionId,
      targetId,
    )
    const driver = this.browserDriver('external-browser')
    if (driver.claimAttachedTarget === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'external browser attachment is unavailable',
      )
    this.revalidate(ctx, undefined)
    await this.releases.get(ctx.identity.ownerSessionId)
    this.assertRoom(ctx.identity.ownerSessionId, 'too many open targets')
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    const op = this.prepare(
      ctx,
      'new',
      { kind: 'open', url: candidate.origin },
      0,
    )
    const snapshot = await this.run(
      ctx,
      op,
      `attach:${ctx.identity.ownerSessionId}`,
      async (signal) => {
        this.externalCandidate(ctx.identity.ownerSessionId, targetId)
        this.journal.dispatched(op)
        return await driver.claimAttachedTarget!(
          targetId,
          ctx.identity.ownerSessionId,
          signal,
        )
      },
      (value) => ({ afterRevision: value.revision }),
    )
    if (
      snapshot.targetId !== candidate.targetId ||
      snapshot.generation !== candidate.generation ||
      snapshot.profileId !== candidate.profileId ||
      normalizeOrigin(snapshot.url) !== candidate.origin ||
      snapshot.driver !== 'external-browser' ||
      snapshot.kind !== 'external-tab'
    ) {
      await driver.close(snapshot.targetId, 'lost').catch(() => undefined)
      throw new UiError(
        'STALE_TARGET',
        'external tab identity changed during attach',
      )
    }
    const record = this.registry.add(
      ctx.identity.ownerSessionId,
      snapshot,
      this.now(),
    )
    this.append(ctx.identity.ownerSessionId, 'ui/target-opened', {
      targetId: record.targetId,
      kind: record.kind,
      driver: record.driver,
      generation: record.generation,
      profileId: record.profileId,
      title: record.title.slice(0, 200),
    })
    this.append(ctx.identity.ownerSessionId, 'ui/control-state', {
      targetId: record.targetId,
      state: 'agent',
    })
    this.changed('targets', ctx.identity.ownerSessionId)
    return record
  }

  // -------------------------------------------------------------------------
  // Chrome/Edge 智能体权限 (PLAN-CAP-001 RV-09): the user's per-site rules
  // for browsing and downloads in their own browser.

  /** 浏览器权限 and 智能体权限 of Settings › 电脑操作 › Chrome 和 Edge. */
  externalBrowserSettings(): ExternalBrowserSettings {
    return this.deps.externalSites?.get() ?? DEFAULT_EXTERNAL_BROWSER_SETTINGS
  }

  /** Only the user changes them (CoreApi guards a change that widens). */
  setExternalBrowserSettings(
    patch: ExternalBrowserSettingsPatch,
  ): ExternalBrowserSettings {
    const store = this.deps.externalSites
    if (store === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'Chrome/Edge settings are not available on this host',
      )
    const next = store.update(patch)
    this.changed('state')
    return next
  }

  /** What the user's rules say about `url` in their own Chrome or Edge. */
  externalSiteDecision(
    url: string,
    kind: ExternalSiteKind,
  ): ExternalSiteDecision {
    return externalSiteDecision(this.externalBrowserSettings(), url, kind)
  }

  /** The connected browser a new Chrome/Edge tab opens in. */
  externalOpenProfile(): string {
    const profile =
      this.browserDriver('external-browser').openProfile?.() ?? null
    if (profile === null)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'no Chrome or Edge is connected to Emperor',
        {
          reason: 'not-connected',
          hint: 'Ask the user to open Chrome or Edge with the Emperor extension connected.',
        },
      )
    return profile
  }

  /**
   * The gate applied the 浏览 rule to this destination; check it again
   * right before the driver (a blocked site never, a site that asks only
   * with the user's card). Chrome/Edge tabs only go to a URL.
   */
  private assertExternalAction(ctx: OpContext, action: UiAction): void {
    if (action.kind === 'history')
      throw new UiError(
        'CAPABILITY_DISABLED',
        'a Chrome/Edge tab goes to a URL; back, forward and reload are not available',
        { hint: 'Call browser_navigate with the URL instead.' },
      )
    if (action.kind === 'navigate') this.assertExternalBrowse(ctx, action.url)
  }

  private assertExternalBrowse(ctx: OpContext, url: string): void {
    const decision = this.externalSiteDecision(url, 'browse')
    if (decision === 'block') throw externalSiteError(url)
    if (decision === 'ask' && ctx.ticket.kind !== 'grant')
      throw new UiError(
        'PERMISSION_REQUIRED',
        'the user wants to approve this site before Emperor opens it',
        { reason: 'site-needs-approval' },
      )
  }

  /**
   * Open `url` in a new tab of the user's Chrome or Edge (its tab group
   * 「Emperor」) and give the tab to this task.
   */
  async openExternal(
    ctx: OpContext,
    input: { url: string },
  ): Promise<TargetRecord> {
    const driver = this.browserDriver('external-browser')
    this.revalidate(ctx, undefined)
    this.assertExternalBrowse(ctx, input.url)
    const profileId = this.externalOpenProfile()
    await this.releases.get(ctx.identity.ownerSessionId)
    this.assertRoom(ctx.identity.ownerSessionId, 'too many open targets')
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    const op = this.prepare(ctx, 'new', { kind: 'open', url: input.url }, 0)
    const snapshot = await this.run(
      ctx,
      op,
      `open:${ctx.identity.ownerSessionId}`,
      async (signal) => {
        this.journal.dispatched(op)
        return await driver.open(
          {
            profile: { kind: 'persistent', profileId },
            url: input.url,
            ownerSessionId: ctx.identity.ownerSessionId,
          },
          signal,
        )
      },
      (value) => ({ afterRevision: value.revision }),
    )
    if (
      snapshot.driver !== 'external-browser' ||
      snapshot.kind !== 'external-tab'
    ) {
      await driver.close(snapshot.targetId, 'lost').catch(() => undefined)
      throw new UiError('STALE_TARGET', 'the new tab is not a Chrome/Edge tab')
    }
    const record = this.registry.add(
      ctx.identity.ownerSessionId,
      snapshot,
      this.now(),
    )
    const origin = targetOrigin(record)
    this.append(ctx.identity.ownerSessionId, 'ui/target-opened', {
      targetId: record.targetId,
      kind: record.kind,
      driver: record.driver,
      generation: record.generation,
      profileId: record.profileId,
      title: record.title.slice(0, 200),
      ...(origin === null ? {} : { origin }),
    })
    this.append(ctx.identity.ownerSessionId, 'ui/control-state', {
      targetId: record.targetId,
      state: 'agent',
    })
    this.changed('targets', ctx.identity.ownerSessionId)
    return record
  }

  /**
   * Why a Chrome/Edge tab is gone, when a page took it to a blocked site or
   * the user did not approve where it went. Without a targetId: the
   * owner's latest such tab, said once.
   */
  externalGoneError(
    identity: UiCallerIdentity,
    targetId?: string,
  ): UiError | undefined {
    let id = targetId
    if (id === undefined) {
      id = this.externalGoneByOwner.get(identity.ownerSessionId)
      this.externalGoneByOwner.delete(identity.ownerSessionId)
    }
    const gone = id === undefined ? undefined : this.externalGone.get(id)
    if (gone === undefined || id === undefined) return undefined
    if (this.registry.get(id)?.ownerSessionId !== identity.ownerSessionId)
      return undefined
    return gone.why === 'blocked'
      ? new UiError(
          'PERMISSION_DENIED',
          `the page went to ${gone.origin}, which the user blocked for Emperor; the tab was disconnected`,
          {
            reason: 'site-blocked',
            hint: 'Do not go there another way. Continue on an allowed site with external_tab_open, or tell the user.',
          },
        )
      : new UiError(
          'PERMISSION_DENIED',
          `the page went to ${gone.origin} and the user did not allow Emperor there; the tab was disconnected`,
          {
            reason: 'user-denied',
            hint: 'Do not go there another way; continue elsewhere or ask the user.',
          },
        )
  }

  private rememberExternalGone(
    record: TargetRecord,
    origin: string,
    why: 'blocked' | 'denied',
  ): void {
    this.externalGone.set(record.targetId, {
      origin: origin.slice(0, 300),
      why,
    })
    if (this.externalGone.size > 64) {
      const oldest = this.externalGone.keys().next().value
      if (oldest !== undefined) this.externalGone.delete(oldest)
    }
    this.externalGoneByOwner.set(record.ownerSessionId, record.targetId)
  }

  private async confirmExternal(
    request: ExternalConfirmation,
  ): Promise<boolean> {
    try {
      return (await this.deps.confirmExternal?.(request)) === true
    } catch {
      return false
    }
  }

  private externalDriver(): BrowserDriver | null {
    return this.portDriver('external-browser') as BrowserDriver | null
  }

  /**
   * The page moved by itself to a site that needs approval: the tab waits
   * until the user answers one card; a refusal disconnects it.
   */
  private async confirmExternalNavigation(
    record: TargetRecord,
    url: string,
  ): Promise<void> {
    const identity = this.lastIdentity.get(record.ownerSessionId)
    const allowed =
      identity !== undefined &&
      isLive(record) &&
      (await this.confirmExternal({
        identity,
        profileId: record.profileId,
        origin: url,
        actionClass: 'navigate',
        display: { url, title: '网页跳转到了需要你批准的网站' },
      }))
    if (!allowed) this.rememberExternalGone(record, url, 'denied')
    try {
      this.externalDriver()?.resolveNavigation?.(record.targetId, allowed)
    } catch {
      // the tab is disconnected either way
    }
  }

  /**
   * A download from a tab the Agent works in (RV-09): executables and
   * installers never (the inbox's rule), then the stricter 下载 rule of the
   * page and of the file's site; 需要批准 asks the user with one card.
   */
  private async decideExternalDownload(
    record: TargetRecord,
    event: Extract<ExternalDriverEvent, { type: 'download-requested' }>,
  ): Promise<void> {
    const name = event.filename.slice(0, 200)
    const pageOrigin = targetOrigin(record) ?? record.url
    const finish = (allow: boolean, reason?: string): void => {
      try {
        this.externalDriver()?.resolveDownload?.(event.downloadId, {
          allow,
          ...(reason === undefined ? {} : { reason }),
        })
      } catch {
        // the extension refuses a download it never hears about
      }
      if (allow) return
      this.append(record.ownerSessionId, 'ui/download', {
        operationId: `external:${event.downloadId}`,
        targetId: record.targetId,
        downloadId: event.downloadId,
        state: 'refused',
        filename: name,
        bytes: Math.max(0, event.bytes),
        ...(event.url === '' ? {} : { origin: event.url }),
        ...(event.mimeType === undefined
          ? {}
          : { mimeType: event.mimeType.slice(0, 200) }),
        pageOrigin,
      })
    }
    if (isExecutableDownload(event.filename, event.mimeType ?? '')) {
      finish(false, 'executable')
      this.note(
        record.targetId,
        `the download ${name} was refused: executable files and installers are never downloaded`,
      )
      return
    }
    const decision = stricterDecision(
      this.externalSiteDecision(pageOrigin, 'download'),
      event.url === ''
        ? 'allow'
        : this.externalSiteDecision(event.url, 'download'),
    )
    if (decision === 'allow') return finish(true)
    if (decision === 'block') {
      finish(false, 'blocked')
      this.note(
        record.targetId,
        `the download ${name} was refused: the user blocks downloads from this site for Emperor`,
      )
      return
    }
    const identity = this.lastIdentity.get(record.ownerSessionId)
    const site = event.url === '' ? pageOrigin : event.url
    const allowed =
      identity !== undefined &&
      (await this.confirmExternal({
        identity,
        profileId: record.profileId,
        origin: site,
        actionClass: 'transfer',
        display: { url: `${name} · ${site}`, title: `下载「${name}」` },
      }))
    if (allowed) return finish(true)
    finish(false, 'denied')
    this.note(
      record.targetId,
      `the download ${name} was refused: the user did not approve it`,
    )
  }

  /**
   * 历史记录 (RV-10): search the user's Chrome/Edge history as their setting
   * says — 从不 refuses (the tool is not offered either), 始终询问 needs this
   * call's own card (`grantId`), 始终允许 runs at once.
   */
  async searchExternalHistory(
    ctx: OpContext,
    input: {
      query: string
      days: number
      maxResults: number
      grantId?: string
    },
  ): Promise<readonly ExternalHistoryEntry[]> {
    const access = this.externalBrowserSettings().history
    if (access === 'never')
      throw new UiError(
        'CAPABILITY_DISABLED',
        'the user does not let Emperor read the browser history',
        {
          reason: 'history-off',
          hint: 'Do not look for it another way; ask the user if you need it.',
        },
      )
    if (access === 'ask') {
      const grant =
        input.grantId === undefined
          ? undefined
          : this.deps.grants.get(input.grantId)
      if (
        grant === undefined ||
        grant.scope !== 'once' ||
        grant.callId !== ctx.callId ||
        grant.subject !== ctx.identity.subject ||
        grant.driver !== 'external-browser' ||
        !grant.allowedActions.includes('observe')
      )
        throw new UiError(
          'PERMISSION_REQUIRED',
          'the user approves each search of the browser history',
          { reason: 'history-needs-approval' },
        )
    }
    const driver = this.browserDriver('external-browser')
    if (driver.searchHistory === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'this browser connection cannot search the history',
      )
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    return await driver.searchHistory(
      {
        query: input.query,
        startTime: this.now().getTime() - input.days * 86_400_000,
        maxResults: input.maxResults,
      },
      AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
    )
  }

  private externalDownloadFinished(
    record: TargetRecord,
    event: Extract<ExternalDriverEvent, { type: 'download-finished' }>,
  ): void {
    const name = event.filename.slice(0, 200)
    const pageOrigin = targetOrigin(record) ?? record.url
    this.append(record.ownerSessionId, 'ui/download', {
      operationId: `external:${event.downloadId}`,
      targetId: record.targetId,
      downloadId: event.downloadId,
      state: event.state,
      filename: name,
      bytes: Math.max(0, event.bytes),
      ...(event.url === '' ? {} : { origin: event.url }),
      pageOrigin,
    })
    this.note(
      record.targetId,
      event.state === 'completed'
        ? `the download ${name} finished in the browser's own download folder`
        : `the download ${name} was interrupted`,
    )
  }

  async open(
    ctx: OpContext,
    input: {
      url: string
      profile?: BrowserProfileSpec
      driver?: 'embedded-browser'
    },
  ): Promise<TargetRecord> {
    const driver = this.browserDriver(input.driver ?? 'embedded-browser')
    this.revalidate(ctx, undefined)
    const profile = input.profile ?? { kind: 'temporary' as const }
    if (
      profile.kind === 'persistent' &&
      this.deps.profiles?.get(profile.profileId) === undefined
    )
      throw new UiError(
        'INVALID_REQUEST',
        `there is no browser profile ${profile.profileId}; call browser_profile_list`,
      )
    await this.releases.get(ctx.identity.ownerSessionId)
    this.assertRoom(ctx.identity.ownerSessionId, 'too many open targets')
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    const op = this.prepare(ctx, 'new', { kind: 'open', url: input.url }, 0)
    const snapshot = await this.run(
      ctx,
      op,
      `open:${ctx.identity.ownerSessionId}`,
      async (signal) => {
        this.journal.dispatched(op)
        return await driver.open(
          {
            profile,
            url: input.url,
            ownerSessionId: ctx.identity.ownerSessionId,
          },
          signal,
        )
      },
      (value) => ({ afterRevision: value.revision }),
    )
    const record = this.registry.add(
      ctx.identity.ownerSessionId,
      snapshot,
      this.now(),
    )
    if (profile.kind === 'persistent') {
      this.deps.profiles?.touch(profile.profileId)
      this.deps.restorable?.forget(
        (tab) =>
          tab.ownerSessionId === ctx.identity.ownerSessionId &&
          tab.profileId === profile.profileId &&
          tab.url === input.url,
      )
    }
    const origin = targetOrigin(record)
    this.append(ctx.identity.ownerSessionId, 'ui/target-opened', {
      targetId: record.targetId,
      kind: record.kind,
      driver: record.driver,
      generation: record.generation,
      profileId: record.profileId,
      ...(record.title === '' ? {} : { title: record.title.slice(0, 200) }),
      ...(origin === null ? {} : { origin }),
    })
    this.append(ctx.identity.ownerSessionId, 'ui/control-state', {
      targetId: record.targetId,
      state: 'agent',
    })
    this.changed('targets', ctx.identity.ownerSessionId)
    return record
  }

  /** The bound app's menu bar, or the menu under `path` (desktop only). */
  async desktopMenu(
    ctx: OpContext,
    input: { targetId?: string; path: readonly string[] },
  ): Promise<{ target: TargetRecord; listing: DesktopMenuListing }> {
    const record = this.resolve(ctx.identity, input.targetId)
    if (record.driver !== 'desktop')
      throw new UiError('INVALID_REQUEST', 'menus belong to desktop targets')
    const driver = this.desktopDriver()
    if (driver.menu === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'this helper cannot read menus; restart it from Settings after updating',
      )
    this.assertActionable(record)
    this.revalidate(ctx, record)
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    const op = this.prepare(
      ctx,
      record.targetId,
      { kind: 'observe' },
      record.revision,
    )
    const listing = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.menu!(
          {
            targetId: record.targetId,
            generation: record.generation,
            path: input.path,
          },
          signal,
        ),
      () => ({ afterRevision: record.revision }),
    )
    return { target: record, listing }
  }

  async observe(
    ctx: OpContext,
    input: {
      targetId?: string
      query?: ObserveQuery
      diff?: boolean
      cursor?: string
      maxElements?: number
      maxDepth?: number
      includeText?: boolean
    },
  ): Promise<UiObservation> {
    const record = this.resolve(ctx.identity, input.targetId)
    const driver = this.driverOf(record.driver)
    this.assertActionable(record)
    this.revalidate(ctx, record)
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    const op = this.prepare(
      ctx,
      record.targetId,
      { kind: 'observe' },
      record.revision,
    )
    const baseRevision = record.revision
    const observation = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.observe(
          {
            targetId: record.targetId,
            generation: record.generation,
            budget: {
              ...DEFAULT_OBSERVE_BUDGET,
              ...(input.maxElements === undefined
                ? {}
                : { maxElements: input.maxElements }),
              ...(input.maxDepth === undefined
                ? {}
                : { maxDepth: input.maxDepth }),
            },
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.diff === true ? { diffFrom: baseRevision } : {}),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            includeText: input.includeText !== false,
          },
          signal,
        ),
      (value) => ({ afterRevision: value.revision }),
    )
    record.revision = observation.revision
    record.generation = observation.generation
    record.title = observation.title
    // Keep role + name per ref for the last few revisions (risk checks).
    for (const ref of [...record.elements.keys()])
      if ((refRevision(ref) ?? 0) <= observation.revision - 3)
        record.elements.delete(ref)
    for (const element of observation.elements)
      record.elements.set(element.ref, {
        role: element.role,
        name: element.name ?? '',
        ...(element.frameOrigin === undefined
          ? {}
          : { frameOrigin: element.frameOrigin }),
        ...(element.inputType === undefined
          ? {}
          : { inputType: element.inputType }),
      })
    if (observation.urlOrApp !== '' && record.driver !== 'desktop')
      record.url = observation.urlOrApp
    const pending = this.notes.get(record.targetId) ?? []
    this.notes.delete(record.targetId)
    const notes = [...(observation.notes ?? []), ...pending]
    const elements = observation.elements
    const redactions = observation.redactions
    return {
      target: targetRef(record),
      revision: observation.revision,
      observedAt: this.now().toISOString(),
      title: observation.title,
      urlOrApp: observation.urlOrApp,
      focus: observation.focus,
      frameOrWindowId: observation.frameOrWindowId,
      viewport: observation.viewport,
      elements,
      ...(observation.removed === undefined
        ? {}
        : { removed: observation.removed }),
      ...(observation.textExcerpt === undefined
        ? {}
        : { textExcerpt: observation.textExcerpt }),
      ...(observation.diffFrom === undefined
        ? {}
        : { diffFrom: observation.diffFrom }),
      truncated: observation.truncated,
      ...(observation.cursor === undefined
        ? {}
        : { cursor: observation.cursor }),
      redactions,
      ...(notes.length === 0 ? {} : { notes }),
    }
  }

  async screenshot(
    ctx: OpContext,
    input: { targetId?: string; modelMaxEdge?: number },
  ): Promise<ScreenshotResult> {
    const record = this.resolve(ctx.identity, input.targetId)
    const driver = this.driverOf(record.driver)
    this.assertActionable(record)
    this.revalidate(ctx, record)
    this.chargeBudget(ctx.identity)
    const op = this.prepare(
      ctx,
      record.targetId,
      { kind: 'screenshot' },
      record.revision,
    )
    const capture = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.screenshot(
          {
            targetId: record.targetId,
            generation: record.generation,
            modelCopy: ctx.vision,
            modelMaxEdge: input.modelMaxEdge ?? 1_600,
          },
          signal,
        ),
      (value) => ({ afterRevision: value.revision }),
    )
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const audit = this.deps.saveImage(
      capture.png,
      'image/png',
      `screenshot-${stamp}.png`,
    )
    const model =
      ctx.vision && capture.model !== undefined
        ? this.deps.saveImage(
            capture.model.jpeg,
            'image/jpeg',
            `screenshot-${stamp}-model.jpg`,
          )
        : undefined
    this.keepScreenshots(record.ownerSessionId, [audit, model])
    this.registry.addScreenshot(record, {
      screenshotId: capture.screenshotId,
      generation: capture.generation,
      revision: capture.revision,
      width: capture.width,
      height: capture.height,
      scale: capture.scale,
      attachmentId: audit.attachmentId,
      takenAt: this.now().toISOString(),
    })
    this.changed('targets', record.ownerSessionId)
    return {
      target: record,
      screenshotId: capture.screenshotId,
      audit: { ...audit, width: capture.width, height: capture.height },
      ...(model === undefined || capture.model === undefined
        ? {}
        : {
            model: {
              ...model,
              width: capture.model.width,
              height: capture.model.height,
            },
          }),
    }
  }

  /** Note saved screenshots and delete the oldest past the quota. */
  private keepScreenshots(
    sessionId: string,
    saved: ReadonlyArray<SavedImage | undefined>,
  ): void {
    const ledger = this.deps.screenshots
    if (ledger === undefined) return
    const evicted = ledger.record(
      sessionId,
      saved
        .filter((item): item is SavedImage => item !== undefined)
        .map((item) => ({
          attachmentId: item.attachmentId,
          bytes: item.bytes,
        })),
    )
    for (const attachmentId of evicted) this.deleteScreenshot(attachmentId)
  }

  private deleteScreenshot(attachmentId: string): void {
    try {
      this.deps.deleteImage?.(attachmentId)
    } catch {
      // best effort: the ledger no longer counts it either way
    }
    for (const record of this.registry.all()) {
      const index = record.screenshots.findIndex(
        (shot) => shot.attachmentId === attachmentId,
      )
      if (index >= 0) record.screenshots.splice(index, 1)
    }
  }

  /**
   * The user's one-click clear (spec 00 §8.5): delete the screenshots of
   * one conversation, or all of them. Replay shows them as cleared.
   */
  clearScreenshots(sessionId?: string): { removed: number; bytes: number } {
    const ledger = this.deps.screenshots
    if (ledger === undefined) return { removed: 0, bytes: 0 }
    const removed = ledger.clear(sessionId)
    for (const item of removed) this.deleteScreenshot(item.attachmentId)
    this.changed('targets', sessionId)
    return {
      removed: removed.length,
      bytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    }
  }

  async act(
    ctx: OpContext,
    input: { targetId?: string; action: UiAction; expectedRevision?: number },
  ): Promise<ActResult> {
    const record = this.resolve(ctx.identity, input.targetId)
    const driver = this.driverOf(record.driver)
    this.assertActionable(record)
    this.revalidate(ctx, record)
    const action = input.action
    if (record.driver === 'external-browser')
      this.assertExternalAction(ctx, action)
    if (
      (action.kind === 'clickPoint' || action.kind === 'drag') &&
      !ctx.vision
    ) {
      const usesPoint =
        action.kind === 'clickPoint' ||
        typeof action.from !== 'string' ||
        typeof action.to !== 'string'
      if (usesPoint)
        throw new UiError(
          'VISION_UNAVAILABLE',
          'screenshot coordinates need a model that can see images',
        )
    }
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    // The AI drives continuously: an action that needs the front brings the
    // window forward itself (also a high-impact action the user just
    // confirmed, whose card took the focus away). The front goes back to
    // where the user was when the task ends.
    if (record.driver === 'desktop')
      this.noteActivated(ctx.identity.ownerSessionId, record.targetId)
    const bringForward =
      record.driver === 'desktop' && action.kind !== 'activate'
    const expectedRevision =
      input.expectedRevision ?? actionRefRevision(action) ?? record.revision
    const beforeRevision = record.revision
    const op = this.prepare(
      ctx,
      record.targetId,
      redactAction(action),
      expectedRevision,
    )
    const outcome = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.act(
          {
            operationId: op.operationId,
            targetId: record.targetId,
            generation: record.generation,
            expectedRevision,
            action,
            deadlineMs: COMPUTER_USE_BUDGET.actDeadlineMs,
            ...(bringForward ? { bringForward: true } : {}),
          },
          { dispatched: () => this.journal.dispatched(op) },
          signal,
        ),
      (value) => ({
        afterRevision: value.afterRevision,
        outcome: value.outcome,
      }),
    )
    this.refresh(record, driver)
    return {
      target: record,
      operationId: op.operationId,
      beforeRevision,
      outcome,
      autoApproved: ctx.ticket.kind === 'auto',
    }
  }

  /**
   * Download one file into the inbox by clicking `ref` or fetching `url`
   * (transfer class: the gate asked the user for this exact call).
   */
  async download(
    ctx: OpContext,
    input: { targetId?: string; ref?: string; url?: string },
  ): Promise<DownloadResult> {
    if ((input.ref === undefined) === (input.url === undefined))
      throw new UiError('INVALID_REQUEST', 'give exactly one of ref or url')
    const record = this.resolve(ctx.identity, input.targetId)
    const driver = this.driverOf(record.driver) as BrowserDriver
    this.assertActionable(record)
    this.revalidate(ctx, record)
    if (driver.download === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'this browser cannot download files yet',
      )
    this.chargeBudget(ctx.identity)
    this.lastIdentity.set(ctx.identity.ownerSessionId, ctx.identity)
    const expectedRevision =
      (input.ref === undefined ? undefined : refRevision(input.ref)) ??
      record.revision
    const pageOrigin = targetOrigin(record)
    const op = this.prepare(
      ctx,
      record.targetId,
      {
        kind: 'download',
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(input.url === undefined ? {} : { url: input.url }),
      },
      expectedRevision,
    )
    const download = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.download!(
          {
            operationId: op.operationId,
            targetId: record.targetId,
            generation: record.generation,
            expectedRevision,
            ...(input.ref === undefined ? {} : { ref: input.ref }),
            ...(input.url === undefined ? {} : { url: input.url }),
            taskId: ctx.identity.taskId,
            ownerSessionId: record.ownerSessionId,
            maxBytes: COMPUTER_USE_BUDGET.downloadMaxBytes,
            timeoutMs: COMPUTER_USE_BUDGET.downloadTimeoutMs,
          },
          { dispatched: () => this.journal.dispatched(op) },
          signal,
        ),
      (value) => ({
        afterRevision: record.revision,
        outcome: value.state === 'completed' ? 'observed' : 'no-effect',
      }),
    )
    this.refresh(record, driver)
    this.append(record.ownerSessionId, 'ui/download', {
      operationId: op.operationId,
      targetId: record.targetId,
      downloadId: download.downloadId,
      state: download.state,
      filename: download.filename.slice(0, 200),
      bytes: download.bytes,
      ...(download.sha256 === undefined ? {} : { sha256: download.sha256 }),
      ...(download.origin === null ? {} : { origin: download.origin }),
      ...(download.url === '' ? {} : { url: download.url.slice(0, 2_048) }),
      ...(download.mimeType === undefined
        ? {}
        : { mimeType: download.mimeType.slice(0, 200) }),
      ...(pageOrigin === null ? {} : { pageOrigin }),
    })
    return { target: record, operationId: op.operationId, download }
  }

  // -------------------------------------------------------------------------
  // Credential vault (spec 00 §6.4): handles only; secrets stay in the host

  /** Handles the model may see; `origin` narrows to entries bound there. */
  listCredentials(filter: { origin?: string } = {}): CredentialHandle[] {
    const vault = this.deps.port?.credentials?.() ?? null
    if (vault === null) return []
    const origin =
      filter.origin === undefined ? undefined : normalizeOrigin(filter.origin)
    return vault
      .list()
      .filter(
        (handle) =>
          origin === undefined ||
          handle.bindings.some(
            (binding) =>
              binding.kind === 'origin' &&
              normalizeOrigin(binding.origin) === origin,
          ),
      )
  }

  /** Refuse early (before any card) while the vault is locked or absent. */
  assertVaultReady(): void {
    const vault = this.deps.port?.credentials?.() ?? null
    if (vault === null || vault.available === false)
      throw new UiError(
        'CAPABILITY_DISABLED',
        vault === null
          ? 'the credential vault is not available here'
          : "the credential vault's local key is missing or failed its checks, so saved credentials cannot be used; the user can clear the vault in Settings › 浏览器 › 密码管理器",
        vault === null ? undefined : { reason: 'vault-encryption-unavailable' },
      )
    if (vault.locked)
      throw new UiError(
        'PERMISSION_REQUIRED',
        'the credential vault is locked',
        {
          reason: 'vault-locked',
          hint: 'Ask the user to unlock it in Settings › 浏览器 › 密码管理器.',
        },
      )
  }

  credentialHandle(handleId: string): CredentialHandle | undefined {
    return this.deps.port
      ?.credentials?.()
      ?.list()
      .find((item) => item.handleId === handleId)
  }

  /**
   * The anti-phishing hard rule: the target's exact origin must be one of the
   * entry's bindings, whatever the preset or grants say.
   */
  credentialBinding(handle: CredentialHandle, record: TargetRecord): string {
    const origin = targetOrigin(record)
    const bound =
      origin === null
        ? undefined
        : handle.bindings.find(
            (binding) =>
              binding.kind === 'origin' &&
              normalizeOrigin(binding.origin) === origin,
          )
    if (bound === undefined || origin === null) {
      this.note(
        record.targetId,
        `the credential "${handle.label.slice(0, 80)}" is not bound to ${origin ?? 'this page'}; it was not filled`,
      )
      throw new UiError(
        'PERMISSION_DENIED',
        `this credential is not registered for ${origin ?? 'this page'}`,
        {
          reason: 'credential-binding-mismatch',
          hint: 'Check the address: credentials only fill on the exact sites the user registered.',
        },
      )
    }
    return origin
  }

  /** Main rechecks the bundle ID; the native helper also verifies Team ID or path. */
  desktopCredentialBinding(
    handle: CredentialHandle,
    record: TargetRecord,
  ): Extract<CredentialBinding, { kind: 'app' }> {
    const binding = handle.bindings.find(
      (item): item is Extract<CredentialBinding, { kind: 'app' }> =>
        item.kind === 'app' &&
        item.bundleId === record.appId &&
        (Boolean(item.teamId) || Boolean(item.path)),
    )
    if (binding !== undefined) return binding
    this.note(
      record.targetId,
      `the credential "${handle.label.slice(0, 80)}" is not bound to this app; it was not filled`,
    )
    throw new UiError(
      'PERMISSION_DENIED',
      'this credential is not registered for the target app',
      {
        reason: 'credential-binding-mismatch',
        hint: 'Register the app bundle ID and Team ID (or exact path for an unsigned app) in Settings.',
      },
    )
  }

  async fillDesktopCredential(
    ctx: OpContext,
    input: {
      targetId?: string
      ref: string
      handleId: string
      field: CredentialField
    },
  ): Promise<CredentialFillResult> {
    const record = this.resolve(ctx.identity, input.targetId)
    if (record.driver !== 'desktop' || record.appId === undefined)
      throw new UiError(
        'INVALID_REQUEST',
        'select a desktop window for this tool',
      )
    const driver = this.desktopDriver()
    this.assertActionable(record)
    this.revalidate(ctx, record)
    const vault = this.deps.port?.credentials?.() ?? null
    if (vault === null || driver.fillCredential === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'desktop credential fill is not available',
      )
    this.assertVaultReady()
    const handle = vault.list().find((item) => item.handleId === input.handleId)
    if (handle === undefined)
      throw new UiError(
        'INVALID_REQUEST',
        `there is no credential ${input.handleId}; call ui_credential_list`,
      )
    if (!handle.fields.includes(input.field))
      throw new UiError(
        'INVALID_REQUEST',
        `this credential has no ${input.field}`,
      )
    const binding = this.desktopCredentialBinding(handle, record)
    this.chargeBudget(ctx.identity)
    const expectedRevision = refRevision(input.ref) ?? record.revision
    const op = this.prepare(
      ctx,
      record.targetId,
      {
        kind: 'fillCredential',
        ref: input.ref,
        handleId: input.handleId,
        field: input.field,
      },
      expectedRevision,
    )
    const outcome = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.fillCredential!(
          {
            operationId: op.operationId,
            targetId: record.targetId,
            generation: record.generation,
            expectedRevision,
            ref: input.ref,
            handleId: input.handleId,
            field: input.field,
            binding,
          },
          { dispatched: () => this.journal.dispatched(op) },
          signal,
        ),
      (value) => ({
        afterRevision: record.revision,
        outcome: value.filled ? 'observed' : 'no-effect',
      }),
    )
    this.refresh(record, driver)
    // A window or page that received a secret stays out of previews.
    record.credentialFilledGeneration = record.generation
    this.changed('targets', record.ownerSessionId)
    this.append(record.ownerSessionId, 'ui/credential-used', {
      operationId: op.operationId,
      handleId: input.handleId,
      targetId: record.targetId,
      bindingMatched: binding.bundleId,
      field: input.field,
    })
    return { target: record, operationId: op.operationId, handle, outcome }
  }

  async fillCredential(
    ctx: OpContext,
    input: {
      targetId?: string
      ref: string
      handleId: string
      field: CredentialField
    },
  ): Promise<CredentialFillResult> {
    const record = this.resolve(ctx.identity, input.targetId)
    const driver = this.driverOf(record.driver) as BrowserDriver
    this.assertActionable(record)
    this.revalidate(ctx, record)
    const vault = this.deps.port?.credentials?.() ?? null
    if (vault === null || driver.fillCredential === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'the credential vault is not available here',
      )
    if (vault.locked)
      throw new UiError(
        'PERMISSION_REQUIRED',
        'the credential vault is locked',
        {
          reason: 'vault-locked',
          hint: 'Ask the user to unlock it in Settings › 浏览器 › 密码管理器.',
        },
      )
    const handle = vault.list().find((item) => item.handleId === input.handleId)
    if (handle === undefined)
      throw new UiError(
        'INVALID_REQUEST',
        `there is no credential ${input.handleId}; call ui_credential_list`,
      )
    if (!handle.fields.includes(input.field))
      throw new UiError(
        'INVALID_REQUEST',
        `this credential has no ${input.field}`,
      )
    const origin = this.credentialBinding(handle, record)
    this.chargeBudget(ctx.identity)
    const expectedRevision = refRevision(input.ref) ?? record.revision
    const op = this.prepare(
      ctx,
      record.targetId,
      {
        kind: 'fillCredential',
        ref: input.ref,
        handleId: input.handleId,
        field: input.field,
      },
      expectedRevision,
    )
    const outcome = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.fillCredential!(
          {
            operationId: op.operationId,
            targetId: record.targetId,
            generation: record.generation,
            expectedRevision,
            ref: input.ref,
            handleId: input.handleId,
            field: input.field,
            origin,
          },
          { dispatched: () => this.journal.dispatched(op) },
          signal,
        ),
      (value) => ({
        afterRevision: record.revision,
        outcome: value.filled ? 'observed' : 'no-effect',
      }),
    )
    this.refresh(record, driver)
    // A window or page that received a secret stays out of previews.
    record.credentialFilledGeneration = record.generation
    this.changed('targets', record.ownerSessionId)
    this.append(record.ownerSessionId, 'ui/credential-used', {
      operationId: op.operationId,
      handleId: input.handleId,
      targetId: record.targetId,
      bindingMatched: outcome.bindingMatched,
      field: input.field,
    })
    return { target: record, operationId: op.operationId, handle, outcome }
  }

  /**
   * Put files the user picks (in the host's file dialog) into a page's file
   * input. Transfer class: the gate asked the user for this exact call.
   */
  async upload(
    ctx: OpContext,
    input: { targetId?: string; ref: string },
  ): Promise<UploadResult> {
    const record = this.resolve(ctx.identity, input.targetId)
    const driver = this.driverOf(record.driver) as BrowserDriver
    this.assertActionable(record)
    this.revalidate(ctx, record)
    if (driver.upload === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'this browser cannot upload files yet',
      )
    this.chargeBudget(ctx.identity)
    const expectedRevision = refRevision(input.ref) ?? record.revision
    const op = this.prepare(
      ctx,
      record.targetId,
      { kind: 'upload', ref: input.ref, files: 0 },
      expectedRevision,
    )
    const upload = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.upload!(
          {
            operationId: op.operationId,
            targetId: record.targetId,
            generation: record.generation,
            expectedRevision,
            ref: input.ref,
            origin: targetOrigin(record),
          },
          { dispatched: () => this.journal.dispatched(op) },
          signal,
        ),
      (value) => ({
        afterRevision: record.revision,
        outcome: value.state === 'attached' ? 'observed' : 'no-effect',
      }),
    )
    this.refresh(record, driver)
    if (upload.state === 'attached')
      this.append(record.ownerSessionId, 'ui/upload', {
        operationId: op.operationId,
        targetId: record.targetId,
        files: upload.files.map((name) => name.slice(0, 200)).slice(0, 20),
        bytes: upload.bytes,
      })
    return { target: record, operationId: op.operationId, upload }
  }

  async wait(
    ctx: OpContext,
    input: { targetId?: string; condition: WaitCondition; timeoutMs: number },
  ): Promise<WaitResult> {
    const record = this.resolve(ctx.identity, input.targetId)
    const driver = this.driverOf(record.driver)
    this.assertActionable(record)
    this.revalidate(ctx, record)
    this.chargeBudget(ctx.identity)
    const op = this.prepare(
      ctx,
      record.targetId,
      { kind: 'wait', condition: input.condition.kind },
      record.revision,
    )
    const outcome = await this.run(
      ctx,
      op,
      record.targetId,
      async (signal) =>
        await driver.wait(
          {
            targetId: record.targetId,
            generation: record.generation,
            condition: input.condition,
            timeoutMs: input.timeoutMs,
          },
          signal,
        ),
      (value) => ({
        afterRevision: value.revision,
        outcome: value.satisfied ? 'observed' : 'no-effect',
      }),
    )
    this.refresh(record, driver)
    return { target: record, operationId: op.operationId, outcome }
  }

  async close(
    ctx: OpContext,
    input: { targetId?: string },
  ): Promise<TargetRecord> {
    // A built-in tab released at the end of an earlier task still has its
    // page: the Agent may close it without taking it back first.
    const released = this.releasedTarget(ctx.identity, input.targetId)
    const record =
      released?.driver === 'embedded-browser' && released.releasing !== true
        ? released
        : this.resolve(ctx.identity, input.targetId)
    await this.closeTarget(record, 'agent')
    return record
  }

  /** Close one target through its driver and record the fact. */
  async closeTarget(
    record: TargetRecord,
    reason: TargetClosedReason,
  ): Promise<void> {
    if (record.state === 'closed' || record.state === 'lost') return
    // A released window or external tab holds nothing of ours any more:
    // closing it must not unbind or detach what the user still has.
    const holding = isLive(record) || record.driver === 'embedded-browser'
    this.registry.end(record.targetId, 'closed')
    if (holding) {
      try {
        await this.portDriver(record.driver)?.close(record.targetId, reason)
      } catch {
        // the target is closed from the kernel's point of view either way
      }
    }
    for (const op of this.journal.inFlight())
      if (op.targetId === record.targetId) op.controller.abort()
    this.append(record.ownerSessionId, 'ui/target-closed', {
      targetId: record.targetId,
      reason,
    })
    this.registry.prune()
    this.changed('targets', record.ownerSessionId)
  }

  /** The port's driver of this kind, or null (never throws). */
  private portDriver(kind: DriverKind): TargetDriver | null {
    const port = this.deps.port
    if (port === null) return null
    return kind === 'embedded-browser'
      ? port.embeddedBrowser()
      : kind === 'external-browser'
        ? port.externalBrowser()
        : port.desktop()
  }

  private refresh(record: TargetRecord, driver: TargetDriver): void {
    const snapshot = driver.snapshot(record.targetId)
    if (snapshot === null) return
    record.generation = snapshot.generation
    record.revision = snapshot.revision
    record.url = snapshot.url
    record.title = snapshot.title
  }

  historyTarget(
    record: TargetRecord,
    direction: 'back' | 'forward' | 'reload',
  ): string | null {
    if (record.driver === 'desktop') return null
    try {
      return this.browserDriver(record.driver).historyTarget(
        record.targetId,
        direction,
      )
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Status and cancellation

  actionStatus(
    identity: UiCallerIdentity,
    query: { operationId?: string; callId?: string },
  ): OperationStatus | undefined {
    const record =
      query.operationId !== undefined
        ? this.journal.get(query.operationId)
        : query.callId !== undefined
          ? this.journal.forCall(query.callId)
          : undefined
    if (record !== undefined)
      return record.ownerSessionId === identity.ownerSessionId
        ? statusOf(record)
        : undefined
    for (const sessionId of new Set([
      identity.callerSessionId,
      identity.ownerSessionId,
    ])) {
      const session = this.deps.sessionFor(sessionId)
      if (session === undefined) continue
      const status = statusFromLog(session.events, query)
      if (status !== undefined) return status
    }
    return undefined
  }

  cancelAction(identity: UiCallerIdentity, operationId: string): boolean {
    const record = this.journal.get(operationId)
    if (
      record === undefined ||
      record.ownerSessionId !== identity.ownerSessionId
    )
      return false
    if (record.outcome !== undefined) return false
    record.controller.abort()
    return true
  }

  // -------------------------------------------------------------------------
  // Browser profiles (spec 00 §7.2)

  /** The temporary profile plus every persistent one, with open tab counts. */
  listProfiles(): BrowserProfileView[] {
    const held = this.registry.held()
    const open = (profileId: string): number =>
      held.filter((record) => record.profileId === profileId).length
    return [
      {
        profileId: TEMPORARY_PROFILE,
        name: '临时',
        kind: 'temporary',
        openTargets: open(TEMPORARY_PROFILE),
      },
      ...(this.deps.profiles?.list() ?? []).map((profile) => ({
        profileId: profile.profileId,
        name: profile.name,
        kind: 'persistent' as const,
        createdAt: profile.createdAt,
        ...(profile.lastUsedAt === undefined
          ? {}
          : { lastUsedAt: profile.lastUsedAt }),
        openTargets: open(profile.profileId),
      })),
    ]
  }

  createProfile(name: string): BrowserProfileView {
    const store = this.requireProfiles()
    const created = store.create(name)
    this.changed('profiles')
    return {
      profileId: created.profileId,
      name: created.name,
      kind: 'persistent',
      createdAt: created.createdAt,
      openTargets: 0,
    }
  }

  renameProfile(profileId: string, name: string): BrowserProfileView {
    const renamed = this.requireProfiles().rename(profileId, name)
    this.changed('profiles')
    return {
      profileId: renamed.profileId,
      name: renamed.name,
      kind: 'persistent',
      createdAt: renamed.createdAt,
      openTargets: this.registry
        .held()
        .filter((record) => record.profileId === profileId).length,
    }
  }

  /**
   * Wipe a persistent profile's browsing data (and, for `delete`, the
   * profile itself): close its tabs, let the driver clear storage and the
   * directory, then revoke every grant bound to it. User operation only.
   */
  async clearProfile(
    profileId: string,
    options: { remove: boolean },
  ): Promise<{ cleared: boolean; revokedGrants: number }> {
    const store = this.requireProfiles()
    if (store.get(profileId) === undefined)
      throw new UiError(
        'INVALID_REQUEST',
        `there is no browser profile ${profileId}`,
      )
    for (const record of this.registry.held())
      if (record.profileId === profileId)
        await this.closeTarget(record, 'revoked')
    // Narrowing first: the grants and site permissions go even when the
    // browser cannot wipe the data right now.
    const revoked = this.deps.grants.revokeWhere(
      (grant) =>
        grant.targetScope.kind === 'browser' &&
        grant.targetScope.profileId === profileId,
      'user',
    )
    for (const grant of revoked)
      if (grant.ownerSessionId !== undefined)
        this.append(grant.ownerSessionId, 'ui/grant-revoked', {
          grantId: grant.grantId,
          by: 'user',
        })
    this.deps.sitePermissions?.revoke({ profileId })
    this.deps.restorable?.forget((tab) => tab.profileId === profileId)
    if (revoked.length > 0) this.changed('grants')
    const driver = this.deps.port?.embeddedBrowser()
    if (driver?.clearProfile === undefined)
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'the built-in browser is not available to clear the profile',
      )
    await driver.clearProfile(profileId, { remove: options.remove })
    if (options.remove) store.remove(profileId)
    this.changed('profiles')
    return { cleared: true, revokedGrants: revoked.length }
  }

  listSitePermissions(): SitePermission[] {
    return this.deps.sitePermissions?.list() ?? []
  }

  /** User operation: allow one kind for one origin in one profile. */
  allowSitePermission(input: {
    profileId: string
    origin: string
    kind: SitePermissionKind
    minutes?: number
  }): SitePermission {
    const store = this.deps.sitePermissions
    if (store === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'site permissions are not available here',
      )
    if (
      input.profileId !== TEMPORARY_PROFILE &&
      this.deps.profiles?.get(input.profileId) === undefined
    )
      throw new UiError(
        'INVALID_REQUEST',
        `there is no browser profile ${input.profileId}`,
      )
    const allowed = store.allow(input)
    this.changed('site-permissions')
    return allowed
  }

  revokeSitePermission(filter: {
    profileId?: string
    origin?: string
    kind?: SitePermissionKind
  }): number {
    const removed = this.deps.sitePermissions?.revoke(filter) ?? 0
    if (removed > 0) this.changed('site-permissions')
    return removed
  }

  private requireProfiles(): BrowserProfileStore {
    const store = this.deps.profiles
    if (store === undefined)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'persistent browser profiles are not available here',
      )
    return store
  }

  // -------------------------------------------------------------------------
  // The app window (00 §12)

  /**
   * The UI went away (renderer crash or reload, 00 §12): pause every target
   * the Agent is driving so nothing changes unseen. Nobody resumes them by
   * hand any more (2026-09-29): they resume when the window is back
   * (`resumeAfterUiReconnect`). Returns how many paused.
   */
  pauseForUiDisconnect(): number {
    let paused = 0
    for (const record of this.registry.live()) {
      if (record.control !== 'agent') continue
      this.note(
        record.targetId,
        'the app window is reloading; actions on this target resume by themselves once it is back',
      )
      this.uiPaused.add(record.targetId)
      this.setControl(record, 'paused')
      paused += 1
    }
    return paused
  }

  /** The app window is back: the targets paused for it carry on. */
  resumeAfterUiReconnect(): number {
    let resumed = 0
    for (const targetId of [...this.uiPaused]) {
      this.uiPaused.delete(targetId)
      const record = this.registry.get(targetId)
      if (record === undefined || !isLive(record)) continue
      if (record.control !== 'paused') continue
      this.setControl(record, 'agent')
      resumed += 1
    }
    return resumed
  }

  private setControl(record: TargetRecord, state: ControlState): void {
    if (record.control === state) return
    record.control = state
    const paused = state !== 'agent'
    try {
      const port = this.deps.port
      const driver =
        record.driver === 'embedded-browser'
          ? port?.embeddedBrowser()
          : record.driver === 'external-browser'
            ? port?.externalBrowser()
            : port?.desktop()
      driver?.setPaused(record.targetId, paused)
    } catch {
      // pause is best effort at the driver; the kernel refuses actions anyway
    }
    if (paused)
      for (const op of this.journal.inFlight())
        if (op.targetId === record.targetId) op.controller.abort()
    this.append(record.ownerSessionId, 'ui/control-state', {
      targetId: record.targetId,
      state,
    })
    this.syncCapture(record)
    this.changed('state', record.ownerSessionId)
  }

  /**
   * E-M16: while the Agent controls a desktop window, the helper keeps a
   * low-rate capture stream on it, so macOS badges that window and lists it
   * under screen sharing. Paused targets have none; the helper also refuses
   * a window that received a credential. After
   * the user's "Stop Sharing" the stream stays off for this binding: the
   * Agent keeps working (observations and screenshots do not need it).
   */
  private syncCapture(record: TargetRecord): void {
    if (record.driver !== 'desktop') return
    const driver = this.deps.port?.desktop()
    if (driver?.setCapture === undefined) return
    const active =
      record.control === 'agent' &&
      record.sharingStopped !== true &&
      isLive(record) &&
      record.releasing !== true
    driver
      .setCapture(
        { targetId: record.targetId, generation: record.generation },
        active,
      )
      .catch(() => undefined)
  }

  /** Its front goes back to the user's app when the task ends. */
  private noteActivated(owner: string, targetId: string): void {
    const activated = this.activatedThisTask.get(owner) ?? new Set<string>()
    activated.add(targetId)
    this.activatedThisTask.set(owner, activated)
  }

  /**
   * The task ended (2026-09-29 §3.3): give every window and tab this owner
   * controls back, without closing any. Per target, asynchronously:
   * in-flight actions are aborted and waited for (a dispatched one settles
   * `unknown` and is never replayed); a desktop window's capture stream
   * stops, held input is released, the front goes back to where the user
   * was and the window is unbound; a built-in tab keeps its page (its refs
   * go stale; browser_tab_select takes it back); an external tab stays
   * attached in the extension, only unclaimed. Once / task grants end.
   *
   * The targets flip to `released` together once every step is done, then
   * one `computer_use_changed` lets the preview drop the whole group; a
   * target whose release failed says so (and a desktop failure restarts the
   * helper connection so no capture stream survives). A second call while
   * one runs joins it; afterwards it finds nothing left to release.
   */
  releaseTask(
    ownerSessionId: string,
    reason: TaskReleaseReason,
  ): Promise<TaskReleaseSummary> {
    const running = this.releases.get(ownerSessionId)
    if (running !== undefined) return running
    const release = this.releaseOwner(ownerSessionId, reason).finally(() => {
      if (this.releases.get(ownerSessionId) === release)
        this.releases.delete(ownerSessionId)
    })
    this.releases.set(ownerSessionId, release)
    return release
  }

  private async releaseEveryTask(reason: TaskReleaseReason): Promise<void> {
    const owners = new Set(
      this.registry.live().map((record) => record.ownerSessionId),
    )
    await Promise.all(
      [...owners].map((owner) => this.releaseTask(owner, reason)),
    )
  }

  private async releaseOwner(
    ownerSessionId: string,
    reason: TaskReleaseReason,
  ): Promise<TaskReleaseSummary> {
    // A target the Agent is releasing itself (ui_release_control) finishes there.
    const records = this.registry
      .live(ownerSessionId)
      .filter((record) => record.releasing !== true)
    const activated = this.activatedThisTask.get(ownerSessionId)
    this.activatedThisTask.delete(ownerSessionId)
    this.endTaskGrants(ownerSessionId)
    if (records.length === 0) return { released: [], failed: [] }
    const summary = await this.releaseRecords(
      ownerSessionId,
      records,
      reason,
      activated,
    )
    this.append(ownerSessionId, 'ui/task-released', {
      reason,
      released: summary.released.length,
      failed: summary.failed.length,
    })
    return summary
  }

  /**
   * The Agent is done with one window or tab before the task ends
   * (ui_release_control): the same release, for that target alone.
   */
  async releaseTarget(ctx: OpContext, targetId: string): Promise<TargetRecord> {
    const record = this.resolve(ctx.identity, targetId)
    const owner = record.ownerSessionId
    const activated = this.activatedThisTask.get(owner)
    const wasActivated = activated?.delete(record.targetId) === true
    const summary = await this.releaseRecords(
      owner,
      [record],
      'agent',
      wasActivated ? new Set([record.targetId]) : undefined,
    )
    const failure = summary.failed[0]
    if (failure !== undefined)
      throw new UiError('DRIVER_UNAVAILABLE', failure.error, {
        reason: 'release-failed',
      })
    return record
  }

  private async releaseRecords(
    ownerSessionId: string,
    records: readonly TargetRecord[],
    reason: TaskReleaseReason,
    activated: ReadonlySet<string> | undefined,
  ): Promise<TaskReleaseSummary> {
    for (const record of records) {
      record.releasing = true
      this.uiPaused.delete(record.targetId)
    }
    const ids = new Set(records.map((record) => record.targetId))
    for (const op of this.journal.inFlight())
      if (op.targetId !== undefined && ids.has(op.targetId))
        op.controller.abort()
    await Promise.all(records.map((record) => this.drain(record.targetId)))

    const errors = new Map<string, string>()
    const fail = (record: TargetRecord, error: unknown): void => {
      if (!errors.has(record.targetId))
        errors.set(record.targetId, releaseErrorText(error))
    }
    const windows = records.filter((record) => record.driver === 'desktop')
    const desktop = this.deps.port?.desktop() ?? null
    if (windows.length > 0 && desktop !== null) {
      // The badge first, then input; the front needs the window still bound.
      for (const record of windows)
        if (desktop.setCapture !== undefined)
          await withinStep(() =>
            desktop.setCapture!(
              { targetId: record.targetId, generation: record.generation },
              false,
            ),
          ).catch((error: unknown) => fail(record, error))
      await withinStep(() => desktop.releaseAll()).catch((error: unknown) => {
        for (const record of windows) fail(record, error)
      })
      for (const record of windows)
        if (
          activated?.has(record.targetId) === true &&
          desktop.restoreFront !== undefined
        )
          await withinStep(() =>
            desktop.restoreFront!({
              targetId: record.targetId,
              generation: record.generation,
            }),
          ).catch(() => undefined) // the front is a courtesy, not a release
      for (const record of windows)
        await withinStep(() =>
          desktop.release !== undefined
            ? desktop.release(record.targetId)
            : desktop.close(record.targetId, 'agent'),
        ).catch((error: unknown) => {
          if (!(error instanceof UiError && error.code === 'STALE_TARGET'))
            fail(record, error)
        })
    }
    for (const record of records) {
      if (record.driver === 'desktop') continue
      const driver = this.portDriver(record.driver)
      if (driver?.release === undefined) continue
      await withinStep(() => driver.release!(record.targetId)).catch(
        (error: unknown) => {
          if (!(error instanceof UiError && error.code === 'STALE_TARGET'))
            fail(record, error)
        },
      )
    }

    const released: string[] = []
    const failed: Array<{ targetId: string; error: string }> = []
    for (const record of records) {
      const error = errors.get(record.targetId)
      // Ended meanwhile (the window closed, the tab crashed): nothing to say.
      if (this.registry.release(record.targetId, error) === undefined) continue
      if (error === undefined) released.push(record.targetId)
      else failed.push({ targetId: record.targetId, error })
      this.append(ownerSessionId, 'ui/target-released', {
        targetId: record.targetId,
        reason,
        outcome: error === undefined ? 'released' : 'failed',
        ...(error === undefined ? {} : { error }),
      })
    }
    this.registry.prune()
    this.changed('targets', ownerSessionId)
    // A window we could not release may still be badged: the helper goes
    // (and every stream with it); its windows come back on the next bind.
    if (
      desktop?.resetConnection !== undefined &&
      windows.some((record) => errors.has(record.targetId))
    )
      await withinStep(() => desktop.resetConnection!('release failed')).catch(
        () => undefined,
      )
    return { released, failed }
  }

  /** Wait (bounded) until an aborted action has left the target's lock. */
  private async drain(targetId: string): Promise<void> {
    try {
      const release = await this.mutex.acquire(
        targetId,
        AbortSignal.timeout(RELEASE_DRAIN_MS),
      )
      release()
    } catch {
      // the action ignores its abort; release anyway (it cannot act again)
    }
  }

  /** Once / task grants end with the task that asked for them. */
  private endTaskGrants(ownerSessionId: string): void {
    const revoked = this.deps.grants.revokeWhere(
      (grant) =>
        grant.ownerSessionId === ownerSessionId &&
        (grant.scope === 'once' || grant.scope === 'task'),
      'task-end',
    )
    if (revoked.length > 0) this.changed('grants', ownerSessionId)
  }

  /**
   * Computer use switched off: dismiss pending grant cards (they read as a
   * refusal), cancel in-flight actions, release every task's targets
   * (§3.3), then close the built-in pages nobody can take back now.
   */
  async closeAll(reason: TargetClosedReason): Promise<void> {
    this.deps.cancelGrantCards()
    for (const op of this.journal.inFlight()) op.controller.abort()
    await this.releaseEveryTask('switched-off')
    for (const record of this.registry.held())
      await this.closeTarget(record, reason)
  }

  /** A driver was switched off: cancel its actions and end its targets. */
  async closeDriver(
    driver: DriverKind,
    reason: TargetClosedReason,
  ): Promise<void> {
    const records = this.registry
      .held()
      .filter((record) => record.driver === driver)
    const ids = new Set(records.map((record) => record.targetId))
    for (const op of this.journal.inFlight())
      if (op.targetId !== undefined && ids.has(op.targetId))
        op.controller.abort()
    for (const record of records) await this.closeTarget(record, reason)
  }

  /**
   * User narrowing of a grant (spec 00 §6.3): drop actions or origins;
   * nothing left revokes it. In-flight tickets of the old revision stop
   * matching.
   */
  /** Pages of this conversation's persistent profiles open before a restart. */
  restorableFor(ownerSessionId: string): RestorableTab[] {
    const known = new Set(
      this.deps.profiles?.list().map((item) => item.profileId) ?? [],
    )
    return (this.deps.restorable?.forOwner(ownerSessionId) ?? []).filter(
      (tab) => known.has(tab.profileId),
    )
  }

  /** Persist live persistent-profile tabs before the desktop closes its hidden views. */
  rememberRestorableTabs(): void {
    this.deps.restorable?.remember(
      this.registry
        .held()
        .filter(
          (record) =>
            record.profileId !== TEMPORARY_PROFILE &&
            record.driver === 'embedded-browser' &&
            /^https?:\/\//.test(record.url),
        )
        .map((record) => ({
          ownerSessionId: record.ownerSessionId,
          profileId: record.profileId,
          url: record.url,
          title: record.title,
        })),
    )
  }

  async onSessionDeleted(sessionId: string): Promise<void> {
    this.deps.restorable?.forget((tab) => tab.ownerSessionId === sessionId)
    for (const key of this.desktopCandidates.keys())
      if (key.startsWith(`${sessionId}|`)) this.desktopCandidates.delete(key)
    this.deps.cancelGrantCards(sessionId)
    await this.releaseTask(sessionId, 'session-deleted')
    // Nobody can take the conversation's pages back: they close.
    for (const record of this.registry.held(sessionId))
      await this.closeTarget(record, 'shutdown')
    this.deps.grants.revokeWhere(
      (grant) => grant.ownerSessionId === sessionId,
      'session-end',
    )
    this.lastIdentity.delete(sessionId)
    this.changed('grants', sessionId)
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.desktopCandidates.clear()
    // Persistent-profile pages can be reopened after the restart.
    this.rememberRestorableTabs()
    for (const op of this.journal.inFlight()) op.controller.abort()
    for (const record of this.registry.held())
      await this.closeTarget(record, 'shutdown')
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.subscribed.clear()
  }

  statusView(): ComputerUseStatusView {
    const settings = this.deps.settings()
    return {
      supported: this.deps.port !== null,
      enabled: settings.enabled,
      ...(settings.scopedRetired === true ? { scopedRetired: true } : {}),
      platform: this.platform,
      ...(this.deps.screenshots === undefined
        ? {}
        : { screenshots: this.deps.screenshots.usage() }),
      downloadRetentionDays: settings.downloadRetentionDays ?? 30,
      ...((settings.retiredProtectedApps?.length ?? 0) > 0
        ? { retiredProtectedApps: [...settings.retiredProtectedApps!] }
        : {}),
      drivers: [],
      targets: this.listTargets(),
    }
  }

  /**
   * Settings, the plugin page and every switch read this: it never asks the
   * host to start a helper (a launch can take seconds, or never connect).
   */
  async status(): Promise<ComputerUseStatusView> {
    const view = this.statusView()
    let drivers: DriverCapability[] = []
    try {
      drivers = await this.capabilities({ connect: false })
    } catch {
      drivers = []
    }
    return { ...view, drivers }
  }

  // -------------------------------------------------------------------------
  // Page-initiated navigation and driver events

  /**
   * Synchronous verdict for navigations the driver sees. Sub-frames only get
   * the scheme check (done by the driver). While computer use is on the AI
   * may follow a page to any origin (D1); a page of a tab nobody owns yet
   * cannot move.
   */
  navigationVerdict(request: NavigationRequest): 'allow' | 'block' {
    if (request.frame === 'sub') return 'allow'
    const origin = normalizeOrigin(request.url)
    if (origin === null) return 'block'
    const record = this.registry.get(request.targetId)
    if (record === undefined) {
      // A tab still being opened: its first load was authorized by the gate;
      // anything the page does before registration (redirects) is judged
      // against the opener's identity.
      if (request.initiator === 'agent') return 'allow'
      const identity =
        request.ownerSessionId === undefined
          ? undefined
          : this.lastIdentity.get(request.ownerSessionId)
      return identity === undefined ? 'block' : 'allow'
    }
    if (record.control !== 'agent')
      return request.initiator === 'agent' ? 'block' : 'allow'
    if (targetOrigin(record) === origin) return 'allow'
    return this.lastIdentity.has(record.ownerSessionId) ? 'allow' : 'block'
  }

  /**
   * A page opened a window and the driver turned it into a new tab of the
   * same profile (spec 00 §7.4): it belongs to the opener's owner, counts
   * against the tab budget, and the opener stays the current tab.
   */
  private adoptPopup(opener: TargetRecord, popup: TargetSnapshot): void {
    const owner = opener.ownerSessionId
    const driver =
      opener.driver === 'embedded-browser'
        ? this.deps.port?.embeddedBrowser()
        : this.deps.port?.externalBrowser()
    if (isLive(opener)) this.makeRoom(owner)
    if (
      !isLive(opener) ||
      opener.releasing === true ||
      this.registry.held(owner).length >=
        COMPUTER_USE_BUDGET.targetsPerSession ||
      this.registry.held().length >= COMPUTER_USE_BUDGET.targetsTotal
    ) {
      void driver?.close(popup.targetId, 'agent').catch(() => undefined)
      this.note(
        opener.targetId,
        `a popup to ${popup.url.slice(0, 300)} was closed: ${!isLive(opener) || opener.releasing === true ? 'its tab was released when the task ended' : 'too many open tabs'}`,
      )
      return
    }
    const record = this.registry.add(owner, popup, this.now())
    this.registry.select(owner, opener.targetId)
    // A popup opened while the opener is paused (the app window reloading)
    // shares that state, and resumes with it.
    if (opener.control !== 'agent') {
      record.control = opener.control
      if (this.uiPaused.has(opener.targetId)) this.uiPaused.add(record.targetId)
      try {
        driver?.setPaused(record.targetId, true)
      } catch {
        // the kernel refuses actions on a non-agent target anyway
      }
    }
    const origin = targetOrigin(record)
    this.append(owner, 'ui/target-opened', {
      targetId: record.targetId,
      kind: record.kind,
      driver: record.driver,
      generation: record.generation,
      profileId: record.profileId,
      ...(record.title === '' ? {} : { title: record.title.slice(0, 200) }),
      ...(origin === null ? {} : { origin }),
    })
    this.append(owner, 'ui/control-state', {
      targetId: record.targetId,
      state: record.control,
    })
    this.note(
      opener.targetId,
      record.control === 'agent'
        ? `the page opened ${popup.url.slice(0, 300)} in a new tab ${record.targetId}; use browser_tab_select to work in it`
        : `the page opened ${popup.url.slice(0, 300)} in a new tab ${record.targetId}; it waits with this tab until computer use can carry on`,
    )
    this.changed('targets', owner)
  }

  private note(targetId: string, text: string): void {
    const list = this.notes.get(targetId) ?? []
    if (list.length < 8) list.push(text)
    this.notes.set(targetId, list)
  }

  private onDriverEvent(event: DriverEvent): void {
    const record = this.registry.get(event.targetId)
    if (record === undefined) return
    queueMicrotask(() => this.applyDriverEvent(record, event))
  }

  private applyDriverEvent(record: TargetRecord, event: DriverEvent): void {
    if (record.state === 'closed' || record.state === 'lost') return
    switch (event.type) {
      case 'changed':
        record.revision = Math.max(record.revision, event.revision)
        break
      case 'navigated':
        record.url = event.url
        record.generation = event.generation
        record.revision = event.revision
        this.changed('targets', record.ownerSessionId)
        break
      case 'title':
        record.title = event.title
        this.changed('targets', record.ownerSessionId)
        break
      case 'lost':
        this.registry.end(record.targetId, 'lost')
        for (const op of this.journal.inFlight())
          if (op.targetId === record.targetId) op.controller.abort()
        this.append(record.ownerSessionId, 'ui/target-closed', {
          targetId: record.targetId,
          reason: 'lost',
        })
        this.changed('targets', record.ownerSessionId)
        break
      case 'detached':
        // A released target reconnects when it is taken back.
        if (record.state === 'released') break
        record.state = 'recovering'
        this.note(
          record.targetId,
          `the driver lost contact (${event.reason}); your next action on this target reconnects it, so observe it again first`,
        )
        for (const op of this.journal.inFlight())
          if (op.targetId === record.targetId) op.controller.abort()
        this.changed('targets', record.ownerSessionId)
        break
      case 'navigation-blocked':
        // Chrome/Edge: the page went to a blocked site; the tab is lost next.
        if (record.driver === 'external-browser')
          this.rememberExternalGone(record, event.url, 'blocked')
        this.note(
          record.targetId,
          `navigation to ${event.url.slice(0, 300)} was blocked`,
        )
        break
      case 'navigation-pending':
        void this.confirmExternalNavigation(record, event.url)
        break
      case 'download-requested':
        void this.decideExternalDownload(record, event)
        break
      case 'download-finished':
        this.externalDownloadFinished(record, event)
        break
      case 'popup-blocked':
        this.note(
          record.targetId,
          `a popup to ${event.url.slice(0, 300)} was blocked`,
        )
        break
      case 'popup-opened':
        this.adoptPopup(record, event.popup)
        break
      case 'download-blocked':
        this.note(
          record.targetId,
          `a download of ${event.url.slice(0, 300)} was blocked; use browser_download to save a file (the user confirms it)`,
        )
        break
      case 'sharing-stopped':
        // The user's "Stop Sharing" in the menu bar (2026-09-29): only the
        // picture stops. Control, grants and the task carry on unchanged.
        if (record.sharingStopped === true) break
        record.sharingStopped = true
        this.note(
          record.targetId,
          'the user stopped screen sharing for this window; keep working (observations and screenshots still work), only the live picture in the conversation is off',
        )
        this.changed('targets', record.ownerSessionId)
        break
    }
  }
}

function releaseErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 300) || 'release failed'
}

/**
 * One release step, bounded: a driver that throws or never answers fails
 * the step, never the whole release.
 */
async function withinStep<T>(step: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(step),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('the driver did not answer in time')),
          RELEASE_STEP_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
