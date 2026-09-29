/**
 * `ComputerUseService` — the single execution kernel (spec 00 §4.2). Every
 * GUI entry point calls its typed commands; drivers are never reachable from
 * a model, a page, the renderer or MCP directly.
 *
 * Before anything reaches a driver the service re-checks what the gate
 * decided (defense in depth): the gate ticket exists, its grant is still
 * valid at the same revision, the caller owns the target, the target is
 * live and not paused / taken over / stopped, the generation still matches
 * and the per-task budget is not spent. Then it journals `prepared`, takes
 * the per-target lock, and lets the driver report `dispatched` right before
 * the first side effect. A failure after dispatch is `OUTCOME_UNKNOWN` and is
 * never retried automatically.
 */

import type { Session } from '../../../session-log/session'
import type { SessionEventMap } from '../../../session-log/types'
import { asUiError, UiError } from '../errors'
import { redactAction, type TargetClosedReason } from '../events'
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
  UiGrant,
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
import { highRiskMacApp, protectedMacApp } from '../protected-apps'
import {
  TargetRegistry,
  targetOrigin,
  targetRef,
  targetView,
  type TargetRecord,
} from './registry'

export interface ComputerUseSettings {
  /** The user's master switch. */
  readonly enabled: boolean
  /** Missing in older host implementations; defaults to unrestricted. */
  readonly authorizationMode?: 'unrestricted' | 'scoped'
  /** Per-driver switches; missing means on. */
  readonly drivers?: Partial<Record<DriverKind, boolean>>
  /**
   * The user's own additions (01 §4.4, §5.2): more protected apps (never
   * controlled), high-risk apps (confirmed each time in scoped mode) and
   * sensitive apps (structure only: no values, no screenshots).
   */
  readonly appLists?: Partial<Record<AppListKind, readonly string[]>>
  /** Inbox retention in days; 0 keeps downloads (default 30). */
  readonly downloadRetentionDays?: number
}

export type AppListKind = 'protected' | 'highRisk' | 'sensitive'

export interface KillSwitchStatus {
  readonly accelerator: string
  readonly registered: boolean
  readonly error?: string
}

export type ComputerUseChange =
  | 'state'
  | 'targets'
  | 'grants'
  | 'kill-switch'
  | 'profiles'
  | 'site-permissions'

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
  /** Dismiss pending grant cards (emergency stop / session end). */
  cancelGrantCards(sessionId?: string): void
  settings(): ComputerUseSettings
  /** Persistent browser profiles (absent: only the temporary profile). */
  readonly profiles?: BrowserProfileStore
  /** User-allowed site permissions (absent: every request is denied). */
  readonly sitePermissions?: SitePermissionStore
  /** Persistent-profile tabs to offer back after a restart. */
  readonly restorable?: RestorableTabStore
  killSwitch?(): KillSwitchStatus
  onChanged?(reason: ComputerUseChange, sessionId?: string): void
  now?(): Date
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
  private readonly foregroundConsent = new Set<string>()
  private readonly activatedThisTask = new Map<string, Set<string>>()
  private readonly desktopCandidates = new Map<
    string,
    { window: DesktopWindowInfo; seenAt: number }
  >()
  private readonly subscribed = new Set<TargetDriver>()
  private readonly unsubscribers: Array<() => void> = []
  private stoppedAt: string | undefined
  private closed = false

  constructor(private readonly deps: ComputerUseServiceDeps) {
    this.journal = new OperationJournal((sessionId, type, data) =>
      this.append(sessionId, type, data),
    )
    // A persisted emergency stop, or a grants file found corrupt (quarantined,
    // nothing matches): either way the user sees "stopped" and resumes.
    const suspension = deps.grants.suspended
    if (suspension !== null) this.stoppedAt = suspension.at
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
        stopped: this.stoppedAt !== undefined,
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

  get stopped(): boolean {
    return this.stoppedAt !== undefined
  }

  private userAppList(kind: AppListKind): readonly string[] {
    return this.deps.settings().appLists?.[kind] ?? []
  }

  /** Built-in protection list (01 §4.4) plus the user's additions. */
  isProtectedApp(appId: string): boolean {
    return (
      this.platform === 'macos' &&
      (protectedMacApp(appId) || this.userAppList('protected').includes(appId))
    )
  }

  /** Terminals and script runners, built in plus the user's additions. */
  isHighRiskApp(appId: string): boolean {
    return (
      this.platform === 'macos' &&
      (highRiskMacApp(appId) || this.userAppList('highRisk').includes(appId))
    )
  }

  /** User-marked apps whose values and pixels are never read (01 §5.2). */
  isSensitiveApp(appId: string): boolean {
    return this.userAppList('sensitive').includes(appId)
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
    if (this.stopped)
      throw new UiError('PERMISSION_DENIED', 'computer use is stopped')
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
    if (this.stopped)
      throw new UiError('PERMISSION_DENIED', 'computer use is stopped')
    // The helper hides the built-in list; the user's additions too.
    return (await this.desktopDriver().listApps(signal)).filter(
      (app) => !this.isProtectedApp(app.appId),
    )
  }

  async listDesktopWindows(
    identity: UiCallerIdentity,
    appId: string | undefined,
    signal: AbortSignal,
  ): Promise<DesktopWindowInfo[]> {
    if (this.stopped)
      throw new UiError('PERMISSION_DENIED', 'computer use is stopped')
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
    }
  }

  /**
   * A page asked for a device or browser permission. Allowed only when the
   * user allowed that kind for that origin in the target's profile; a
   * refusal is noted for the Agent (once per origin and kind).
   */
  sitePermissionVerdict(request: SitePermissionRequest): boolean {
    const record = this.registry.get(request.targetId)
    if (record === undefined || this.stopped) return false
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
          `${request.origin.slice(0, 200)} asked for ${request.kind} access and was denied; only the user can allow it (Settings › 电脑操作 › 站点权限)`,
        )
      }
    }
    return allowed
  }

  async capabilities(): Promise<DriverCapability[]> {
    const port = this.deps.port
    if (port === null) return []
    const settings = this.deps.settings()
    const live = await port.capabilities()
    return live.map((capability) => {
      const enabled =
        settings.enabled && settings.drivers?.[capability.driver] !== false
      // Say why the model cannot use a driver the port could offer.
      const reason = this.stopped
        ? 'emergency stop is engaged'
        : !settings.enabled
          ? 'computer use is turned off in Settings'
          : !enabled
            ? 'the user switched this driver off in Settings'
            : capability.reason
      return {
        ...capability,
        enabled,
        available: capability.available && enabled && !this.stopped,
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
    if (record.state === 'closed' || record.state === 'lost') return undefined
    return record
  }

  private resolve(identity: UiCallerIdentity, targetId?: string): TargetRecord {
    const record = this.lookup(identity, targetId)
    if (record !== undefined) return record
    throw new UiError(
      'INVALID_REQUEST',
      targetId === undefined
        ? 'no open target; open one first'
        : `unknown target ${targetId}`,
      { hint: 'List targets or open a new one.' },
    )
  }

  private assertActionable(record: TargetRecord): void {
    if (this.stopped)
      throw new UiError(
        'PERMISSION_DENIED',
        'computer use is stopped; the user must resume it',
        {
          reason: 'emergency-stop',
        },
      )
    switch (record.control) {
      case 'user-takeover':
        throw new UiError(
          'USER_TAKEOVER',
          'the user has taken over this target',
        )
      case 'paused':
        throw new UiError('TARGET_BUSY', 'this target is paused', {
          reason: 'paused',
        })
      case 'stopped':
        throw new UiError('PERMISSION_DENIED', 'computer use is stopped', {
          reason: 'emergency-stop',
        })
      default:
        break
    }
    if (record.state === 'recovering' || record.state === 'paused')
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'the driver lost this target; it must be recovered',
      )
  }

  listTargets(ownerSessionId?: string): UiTargetView[] {
    return this.registry.live(ownerSessionId).map(targetView)
  }

  select(identity: UiCallerIdentity, targetId: string): TargetRecord {
    const record = this.resolve(identity, targetId)
    this.registry.select(identity.ownerSessionId, targetId)
    return record
  }

  // -------------------------------------------------------------------------
  // Ticket re-validation

  private revalidate(ctx: OpContext, record: TargetRecord | undefined): void {
    const ticket = ctx.ticket
    if (ticket.kind === 'control') return
    if (this.stopped)
      throw new UiError('PERMISSION_DENIED', 'computer use is stopped', {
        reason: 'emergency-stop',
      })
    if (ticket.kind === 'auto') {
      if (
        (this.deps.settings().authorizationMode ?? 'unrestricted') !==
        'unrestricted'
      )
        throw new UiError(
          'PERMISSION_REQUIRED',
          'the preset changed; ask again',
          {
            reason: 'preset-changed',
          },
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
    if (this.stopped)
      throw new UiError('PERMISSION_DENIED', 'computer use is stopped', {
        reason: 'emergency-stop',
      })
    this.revalidate(ctx, undefined)
    if (
      ctx.ticket.requirement?.driver !== 'desktop' ||
      ctx.ticket.requirement.appId !== candidate.appId ||
      ctx.ticket.requirement.windowRef !== windowRef
    )
      throw new UiError('PERMISSION_DENIED', 'window authorization changed')
    if (
      this.registry.live(ctx.identity.ownerSessionId).length >=
        COMPUTER_USE_BUDGET.targetsPerSession ||
      this.registry.live().length >= COMPUTER_USE_BUDGET.targetsTotal
    )
      throw new UiError('BUDGET_EXCEEDED', 'too many open targets')
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
    if (
      this.registry.live(ctx.identity.ownerSessionId).length >=
        COMPUTER_USE_BUDGET.targetsPerSession ||
      this.registry.live().length >= COMPUTER_USE_BUDGET.targetsTotal
    )
      throw new UiError('BUDGET_EXCEEDED', 'too many open targets')
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

  async open(
    ctx: OpContext,
    input: {
      url: string
      profile?: BrowserProfileSpec
      driver?: 'embedded-browser'
    },
  ): Promise<TargetRecord> {
    const driver = this.browserDriver(input.driver ?? 'embedded-browser')
    if (this.stopped)
      throw new UiError('PERMISSION_DENIED', 'computer use is stopped', {
        reason: 'emergency-stop',
      })
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
    const owned = this.registry.live(ctx.identity.ownerSessionId).length
    if (owned >= COMPUTER_USE_BUDGET.targetsPerSession)
      throw new UiError(
        'BUDGET_EXCEEDED',
        'too many open targets in this session; close one first',
      )
    if (this.registry.live().length >= COMPUTER_USE_BUDGET.targetsTotal)
      throw new UiError(
        'BUDGET_EXCEEDED',
        'too many open targets; close one first',
      )
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
    // 01 §5.2: a user-marked sensitive app is observed as structure only.
    const sensitive =
      record.driver === 'desktop' &&
      record.appId !== undefined &&
      this.isSensitiveApp(record.appId)
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
            includeText: !sensitive && input.includeText !== false,
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
    let elements = observation.elements
    let redactions = observation.redactions
    if (sensitive) {
      elements = observation.elements.map((element) => {
        if (element.value === undefined) return element
        redactions += 1
        const { value: _hidden, ...rest } = element
        return rest
      })
      notes.push(
        'the user marked this app as sensitive: only its structure is read, never field values or screenshots',
      )
    }
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
      ...(observation.textExcerpt === undefined || sensitive
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
    if (
      record.driver === 'desktop' &&
      record.appId !== undefined &&
      this.isSensitiveApp(record.appId)
    )
      throw new UiError(
        'CAPABILITY_DISABLED',
        'the user marked this app as sensitive; screenshots are not taken',
        { reason: 'sensitive-app' },
      )
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
    if (action.kind === 'activate') this.noteActivation(ctx, record)
    // An action that needs the front brings the window forward itself when
    // the user allows that: in continuous-allow mode (including a
    // high-impact action they just confirmed), or after they agreed for
    // this task. A card that took the focus away in between no longer
    // leaves it refused.
    const bringForward =
      record.driver === 'desktop' &&
      action.kind !== 'activate' &&
      (ctx.identity.fullAccess ||
        this.hasForegroundConsent(ctx.identity.ownerSessionId, record.targetId))
    if (bringForward)
      this.noteActivated(ctx.identity.ownerSessionId, record.targetId)
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
          : 'system credential encryption is unavailable, so saved credentials cannot be used',
        vault === null ? undefined : { reason: 'vault-encryption-unavailable' },
      )
    if (vault.locked)
      throw new UiError(
        'PERMISSION_REQUIRED',
        'the credential vault is locked',
        {
          reason: 'vault-locked',
          hint: 'Ask the user to unlock it in Settings › 电脑操作 › 凭据.',
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
          hint: 'Ask the user to unlock it in Settings › 电脑操作 › 凭据.',
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
    const record = this.resolve(ctx.identity, input.targetId)
    await this.closeTarget(record, 'agent')
    return record
  }

  /** Close one target through its driver and record the fact. */
  async closeTarget(
    record: TargetRecord,
    reason: TargetClosedReason,
  ): Promise<void> {
    if (record.state === 'closed' || record.state === 'lost') return
    this.registry.end(record.targetId, 'closed')
    try {
      const port = this.deps.port
      const driver =
        port === null
          ? null
          : record.driver === 'embedded-browser'
            ? port.embeddedBrowser()
            : record.driver === 'external-browser'
              ? port.externalBrowser()
              : port.desktop()
      await driver?.close(record.targetId, reason)
    } catch {
      // the target is closed from the kernel's point of view either way
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
    const live = this.registry.live()
    const open = (profileId: string): number =>
      live.filter((record) => record.profileId === profileId).length
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
        .live()
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
    for (const record of this.registry.live())
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
  // User control (UI operations; they only ever narrow capability)

  /**
   * The UI went away (renderer crash or reload, 00 §12): pause every target
   * the Agent is driving so nothing changes unseen. The panes list them as
   * paused; the user resumes or ends each one. Returns how many paused.
   */
  pauseForUiDisconnect(): number {
    let paused = 0
    for (const record of this.registry.live()) {
      if (record.control !== 'agent') continue
      this.note(
        record.targetId,
        'the app window reloaded; the user must resume this target before you continue',
      )
      this.setControl(record, 'paused')
      paused += 1
    }
    return paused
  }

  async controlTarget(
    targetId: string,
    action: 'pause' | 'resume' | 'takeover' | 'handback' | 'close',
  ): Promise<UiTargetView | undefined> {
    const record = this.registry.get(targetId)
    if (
      record === undefined ||
      record.state === 'closed' ||
      record.state === 'lost'
    )
      return undefined
    if (action === 'close') {
      await this.closeTarget(record, 'user')
      return targetView(record)
    }
    const next: ControlState =
      action === 'pause'
        ? 'paused'
        : action === 'takeover'
          ? 'user-takeover'
          : this.stopped
            ? 'stopped'
            : 'agent'
    // The user resuming a target the driver lost contact with: the driver
    // reconnects on the next command (with a new generation).
    if (next === 'agent' && record.state === 'recovering')
      record.state = 'attached'
    this.setControl(record, next)
    return targetView(record)
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
   * under screen sharing; "Stop Sharing" there comes back as a takeover.
   * Paused, taken-over and stopped targets and sensitive apps have none; the
   * helper also refuses a window that received a credential.
   */
  private syncCapture(record: TargetRecord): void {
    if (record.driver !== 'desktop') return
    const driver = this.deps.port?.desktop()
    if (driver?.setCapture === undefined) return
    const active =
      record.control === 'agent' &&
      this.stoppedAt === undefined &&
      record.state !== 'closed' &&
      record.state !== 'lost' &&
      (record.appId === undefined || !this.isSensitiveApp(record.appId))
    driver
      .setCapture(
        { targetId: record.targetId, generation: record.generation },
        active,
      )
      .catch(() => undefined)
  }

  /**
   * Emergency stop (§6.6): cancel in-flight actions, pause every target,
   * suspend every grant (persisted), dismiss pending grant cards and release
   * any held keys. Nothing runs again until the user resumes.
   */
  async emergencyStop(): Promise<void> {
    if (this.stoppedAt === undefined) this.stoppedAt = this.now().toISOString()
    this.desktopCandidates.clear()
    this.deps.grants.suspend('kill-switch')
    for (const op of this.journal.inFlight()) op.controller.abort()
    for (const record of this.registry.live()) {
      if (record.control !== 'stopped')
        record.controlBeforeStop = record.control
      this.setControl(record, 'stopped')
    }
    this.deps.cancelGrantCards()
    try {
      await this.deps.port?.desktop()?.releaseAll()
    } catch {
      // best effort; the helper also releases on disconnect
    }
    this.changed('kill-switch')
  }

  resume(): void {
    if (this.stoppedAt === undefined && this.deps.grants.suspended === null)
      return
    this.stoppedAt = undefined
    this.deps.grants.resume()
    for (const record of this.registry.live()) {
      if (record.control === 'stopped') {
        const previous = record.controlBeforeStop ?? 'agent'
        record.controlBeforeStop = undefined
        this.setControl(record, previous === 'stopped' ? 'agent' : previous)
      }
    }
    this.changed('kill-switch')
  }

  revokeGrant(grantId: string): boolean {
    const grant = this.deps.grants.revoke(grantId, 'user')
    if (grant === undefined) return false
    if (grant.ownerSessionId !== undefined)
      this.append(grant.ownerSessionId, 'ui/grant-revoked', {
        grantId,
        by: 'user',
      })
    this.changed('grants', grant.ownerSessionId)
    return true
  }

  /** The user already let the Agent bring this window forward this task. */
  hasForegroundConsent(ownerSessionId: string, targetId: string): boolean {
    return this.foregroundConsent.has(`${ownerSessionId}|${targetId}`)
  }

  private noteActivation(ctx: OpContext, record: TargetRecord): void {
    const owner = ctx.identity.ownerSessionId
    // The user's answer on a card, or their continuous-allow mode.
    if (ctx.ticket.kind === 'grant' || ctx.ticket.kind === 'auto')
      this.foregroundConsent.add(`${owner}|${record.targetId}`)
    this.noteActivated(owner, record.targetId)
  }

  /** Its front goes back to the user's app when the task ends. */
  private noteActivated(owner: string, targetId: string): void {
    const activated = this.activatedThisTask.get(owner) ?? new Set<string>()
    activated.add(targetId)
    this.activatedThisTask.set(owner, activated)
  }

  /** Hand the front back to where the user was, for windows activated this task. */
  private restoreFront(ownerSessionId: string): void {
    const activated = this.activatedThisTask.get(ownerSessionId)
    this.activatedThisTask.delete(ownerSessionId)
    for (const key of [...this.foregroundConsent])
      if (key.startsWith(`${ownerSessionId}|`))
        this.foregroundConsent.delete(key)
    const driver = this.deps.port?.desktop()
    if (activated === undefined || driver?.restoreFront === undefined) return
    for (const targetId of activated) {
      const record = this.registry.get(targetId)
      if (
        record === undefined ||
        record.state === 'closed' ||
        record.state === 'lost'
      )
        continue
      driver
        .restoreFront({ targetId, generation: record.generation })
        .catch(() => undefined)
    }
  }

  /** Once / task grants end with the turn that asked for them. */
  endTask(ownerSessionId: string): void {
    this.restoreFront(ownerSessionId)
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
   * refusal), cancel in-flight actions and close every live target.
   */
  async closeAll(reason: TargetClosedReason): Promise<void> {
    this.deps.cancelGrantCards()
    for (const op of this.journal.inFlight()) op.controller.abort()
    for (const record of this.registry.live())
      await this.closeTarget(record, reason)
  }

  /** A driver was switched off: cancel its actions and end its targets. */
  async closeDriver(
    driver: DriverKind,
    reason: TargetClosedReason,
  ): Promise<void> {
    const records = this.registry
      .live()
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
  narrowGrant(
    grantId: string,
    change: {
      allowedActions?: readonly UiActionClass[]
      origins?: readonly string[]
    },
  ): UiGrant | undefined {
    const before = this.deps.grants.list().find((g) => g.grantId === grantId)
    if (before === undefined) return undefined
    const after = this.deps.grants.narrow(grantId, change)
    if (after === undefined) {
      if (before.ownerSessionId !== undefined)
        this.append(before.ownerSessionId, 'ui/grant-revoked', {
          grantId,
          by: 'user',
        })
    }
    this.changed('grants', before.ownerSessionId)
    return after
  }

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
        .live()
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
    for (const record of this.registry.live(sessionId))
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
    for (const record of this.registry.live())
      await this.closeTarget(record, 'shutdown')
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.subscribed.clear()
  }

  statusView(): ComputerUseStatusView {
    const settings = this.deps.settings()
    return {
      supported: this.deps.port !== null,
      enabled: settings.enabled,
      authorizationMode: settings.authorizationMode ?? 'unrestricted',
      platform: this.platform,
      stopped: this.stopped,
      ...(this.stoppedAt === undefined ? {} : { stoppedAt: this.stoppedAt }),
      ...(this.deps.screenshots === undefined
        ? {}
        : { screenshots: this.deps.screenshots.usage() }),
      downloadRetentionDays: settings.downloadRetentionDays ?? 30,
      appLists: {
        protected: [...this.userAppList('protected')],
        highRisk: [...this.userAppList('highRisk')],
        sensitive: [...this.userAppList('sensitive')],
      },
      ...(this.stopped && this.deps.grants.suspended?.by === 'corrupt-store'
        ? { stopReason: 'corrupt-store' as const }
        : {}),
      drivers: [],
      targets: this.listTargets(),
      grants: this.deps.grants.list().map((grant) => ({
        grantId: grant.grantId,
        subject: grant.subject,
        ...(grant.ownerSessionId === undefined
          ? {}
          : { ownerSessionId: grant.ownerSessionId }),
        driver: grant.driver,
        targetScope: grant.targetScope,
        allowedActions: grant.allowedActions,
        scope: grant.scope,
        createdAt: grant.createdAt,
        ...(grant.expiresAt === undefined
          ? {}
          : { expiresAt: grant.expiresAt }),
        backgroundAllowed: grant.backgroundAllowed,
      })),
      killSwitch: this.deps.killSwitch?.() ?? {
        accelerator: '',
        registered: false,
      },
    }
  }

  async status(): Promise<ComputerUseStatusView> {
    const view = this.statusView()
    let drivers: DriverCapability[] = []
    try {
      drivers = await this.capabilities()
    } catch {
      drivers = []
    }
    return { ...view, drivers }
  }

  // -------------------------------------------------------------------------
  // Page-initiated navigation and driver events

  /**
   * Synchronous verdict for navigations the driver sees. Sub-frames only get
   * the scheme check (done by the driver); a main-frame move to an origin the
   * owner holds no navigate grant for is blocked unless the owner runs full
   * access (D1). The model sees the block in its next observation and can
   * ask through `browser_navigate`.
   */
  navigationVerdict(request: NavigationRequest): 'allow' | 'block' {
    if (this.stopped) return 'block'
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
      if (identity === undefined) return 'block'
      return (this.deps.settings().authorizationMode ?? 'unrestricted') ===
        'unrestricted' ||
        this.navigationCovered(
          identity,
          'embedded-browser',
          request.profileId ?? TEMPORARY_PROFILE,
          origin,
        )
        ? 'allow'
        : 'block'
    }
    if (record.control !== 'agent')
      return request.initiator === 'agent' ? 'block' : 'allow'
    if (targetOrigin(record) === origin) return 'allow'
    const identity = this.lastIdentity.get(record.ownerSessionId)
    if (identity === undefined) return 'block'
    if (
      (this.deps.settings().authorizationMode ?? 'unrestricted') ===
      'unrestricted'
    )
      return 'allow'
    if (
      this.navigationCovered(identity, record.driver, record.profileId, origin)
    )
      return 'allow'
    this.note(
      record.targetId,
      `navigation to ${origin} was blocked: it needs permission (use browser_navigate to ask)`,
    )
    return 'block'
  }

  private navigationCovered(
    identity: UiCallerIdentity,
    driver: DriverKind,
    profileId: string,
    origin: string,
  ): boolean {
    return this.deps.grants
      .list()
      .some((grant) =>
        grantCovers(
          grant,
          { driver, actionClass: 'navigate', profileId, origin, callId: '' },
          identity,
          this.now(),
        ),
      )
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
    if (
      this.stopped ||
      this.registry.live(owner).length >=
        COMPUTER_USE_BUDGET.targetsPerSession ||
      this.registry.live().length >= COMPUTER_USE_BUDGET.targetsTotal
    ) {
      void driver?.close(popup.targetId, 'agent').catch(() => undefined)
      this.note(
        opener.targetId,
        `a popup to ${popup.url.slice(0, 300)} was closed: ${this.stopped ? 'computer use is stopped' : 'too many open tabs'}`,
      )
      return
    }
    const record = this.registry.add(owner, popup, this.now())
    this.registry.select(owner, opener.targetId)
    // A popup the page opened while the user held the opener (paused or
    // taken over) was never judged against the Agent's grants: it stays
    // with the user until they hand it back.
    if (opener.control !== 'agent') {
      record.control = opener.control
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
        : `the page opened ${popup.url.slice(0, 300)} in a new tab ${record.targetId} while the user held this tab; it stays with the user until they hand it back`,
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
        record.state = 'recovering'
        this.note(
          record.targetId,
          `the driver detached (${event.reason}); the target needs recovery`,
        )
        this.setControl(record, 'paused')
        break
      case 'navigation-blocked':
        this.note(
          record.targetId,
          `navigation to ${event.url.slice(0, 300)} was blocked`,
        )
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
      case 'user-input':
        if (record.control === 'agent') this.setControl(record, 'user-takeover')
        break
    }
  }
}
