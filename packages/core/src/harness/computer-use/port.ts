/**
 * Host port for Computer Use (spec 00 §4.4). Core defines these pure
 * interfaces; the Electron main process (embedded browser, external browser
 * bridge) and the platform helpers implement them. Hosts without a port
 * (CLI, ACP) register no GUI tools.
 *
 * Drivers never decide policy: the kernel (`ComputerUseService`) checks
 * grants, leases and revisions first, and drivers re-check target identity
 * right before dispatch (defense in depth).
 */

import type {
  ControlIndicatorState,
  DownloadRecord,
  DriverCapability,
  ElementRef,
  DriverKind,
  HistoryDirection,
  HostPlatform,
  PermissionStatus,
  TargetKind,
  UiAction,
  UiElement,
  UiViewport,
  UploadRecord,
  WaitCondition,
  CredentialField,
  CredentialBinding,
  CredentialFillOutcome,
  CredentialHandle,
} from './types'
import type { SitePermissionKind } from './types'

export type BrowserProfileSpec =
  | { readonly kind: 'temporary' }
  | { readonly kind: 'persistent'; readonly profileId: string }

/** Live facts about one target, as the driver sees them. */
export interface TargetSnapshot {
  readonly targetId: string
  readonly kind: TargetKind
  readonly driver: DriverKind
  readonly generation: number
  readonly revision: number
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly profileId: string
  /** Desktop targets: app identity (bundle id, executable, AUMID). */
  readonly appId?: string
  /** Bound desktop window identity; never inferred from title. */
  readonly windowRef?: string
}

export interface ObserveBudget {
  readonly maxElements: number
  readonly maxTextBytes: number
  readonly maxDepth: number
  readonly timeoutMs: number
}

export interface ObserveQuery {
  readonly role?: string
  readonly nameContains?: string
  readonly frameId?: string
  readonly visibleOnly?: boolean
}

export interface ObserveRequest {
  readonly targetId: string
  readonly generation: number
  readonly budget: ObserveBudget
  readonly query?: ObserveQuery
  readonly diffFrom?: number
  readonly cursor?: string
  readonly includeText: boolean
}

/** A driver observation; the kernel adds the owning {@link UiTargetRef}. */
export interface DriverObservation {
  readonly generation: number
  readonly revision: number
  readonly title: string
  readonly urlOrApp: string
  readonly focus: boolean
  readonly frameOrWindowId: string
  readonly viewport: UiViewport
  readonly elements: readonly UiElement[]
  readonly removed?: readonly string[]
  readonly textExcerpt?: string
  readonly diffFrom?: number
  readonly truncated: boolean
  readonly cursor?: string
  readonly redactions: number
  readonly notes?: readonly string[]
}

export interface ScreenshotRequest {
  readonly targetId: string
  readonly generation: number
  /** Also produce a JPEG copy for a vision-capable model. */
  readonly modelCopy: boolean
  /** Long-edge cap for the model copy (§8.5). */
  readonly modelMaxEdge: number
}

export interface ScreenshotCapture {
  /** Identifies the capture for later point conversion (§5.3). */
  readonly screenshotId: string
  readonly generation: number
  readonly revision: number
  /** Audit copy for the user (full resolution). */
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  /** Screenshot pixels per target unit. */
  readonly scale: number
  readonly model?: {
    readonly jpeg: Uint8Array
    readonly width: number
    readonly height: number
  }
}

export interface ActRequest {
  readonly operationId: string
  readonly targetId: string
  readonly generation: number
  readonly expectedRevision: number
  readonly action: UiAction
  readonly deadlineMs: number
  /**
   * Desktop: the user let this window come forward during this task, so an
   * action that needs the front may bring it forward itself.
   */
  readonly bringForward?: boolean
}

export interface ActHooks {
  /**
   * Called synchronously right before the first side-effecting command. The
   * kernel journals `ui/action-dispatched` here, so a failure afterwards is
   * `OUTCOME_UNKNOWN`, never a silent retry (§5.7).
   */
  dispatched(): void
}

export interface ActOutcome {
  readonly outcome: 'observed' | 'no-effect'
  readonly afterRevision: number
  readonly url?: string
  readonly title?: string
  /** Short, bounded evidence of what changed (not page text). */
  readonly changes?: readonly string[]
  readonly warnings?: readonly string[]
}

export interface WaitRequest {
  readonly targetId: string
  readonly generation: number
  readonly condition: WaitCondition
  readonly timeoutMs: number
}

export interface WaitOutcome {
  readonly satisfied: boolean
  readonly revision: number
  readonly url?: string
  readonly detail?: string
}

export interface DownloadRequest {
  readonly operationId: string
  readonly targetId: string
  readonly generation: number
  readonly expectedRevision: number
  /** Click this element (a download link or button) … */
  readonly ref?: ElementRef
  /** … or fetch this http(s) URL in the tab's profile. */
  readonly url?: string
  /** Inbox bucket; the driver keeps it under its own downloads root. */
  readonly taskId: string
  /** The conversation the file belongs to ("移到工作区" uses its workspace). */
  readonly ownerSessionId?: string
  readonly maxBytes: number
  readonly timeoutMs: number
}

export interface CredentialFillRequest {
  readonly operationId: string
  readonly targetId: string
  readonly generation: number
  readonly expectedRevision: number
  readonly ref: ElementRef
  readonly handleId: string
  readonly field: CredentialField
  /** The binding the kernel matched; the driver re-checks the live page. */
  readonly origin: string
}

export interface DesktopCredentialFillRequest {
  readonly operationId: string
  readonly targetId: string
  readonly generation: number
  readonly expectedRevision: number
  readonly ref: ElementRef
  readonly handleId: string
  readonly field: CredentialField
  readonly binding: Extract<CredentialBinding, { kind: 'app' }>
}

/**
 * The host's credential vault (spec 00 §6.4). Only handles cross into Core;
 * the driver asks the vault for a secret in the main process at the moment
 * it writes it.
 */
export interface CredentialVaultPort {
  list(): CredentialHandle[]
  /** Unlock required first (optional master password). */
  readonly locked: boolean
  /** System encryption can protect secrets (false: never decrypt or fill). */
  readonly available?: boolean
}

export interface UploadRequest {
  readonly operationId: string
  readonly targetId: string
  readonly generation: number
  readonly expectedRevision: number
  /** The page's file input. */
  readonly ref: ElementRef
  /** Shown in the host's file picker title. */
  readonly origin: string | null
}

export type TargetCloseReason =
  'user' | 'agent' | 'lost' | 'revoked' | 'shutdown'

export interface NavigationRequest {
  readonly targetId: string
  readonly url: string
  readonly frame: 'main' | 'sub'
  /** `agent` for tool navigation, `page` for navigation the page started. */
  readonly initiator: 'agent' | 'page'
  /** Owning root session (lets the kernel judge a tab still being opened). */
  readonly ownerSessionId?: string
  /** Browser profile of the tab (grants are per profile). */
  readonly profileId?: string
}

export interface SitePermissionRequest {
  readonly targetId: string
  /** Origin of the requesting frame. */
  readonly origin: string
  readonly kind: SitePermissionKind
}

/** Synchronous site-permission verdict supplied by the kernel. */
export type SitePermissionPolicy = (request: SitePermissionRequest) => boolean

/** Synchronous navigation verdict supplied by the kernel. */
export type NavigationPolicy = (request: NavigationRequest) => 'allow' | 'block'

export type DriverEvent =
  | {
      readonly type: 'changed'
      readonly targetId: string
      readonly revision: number
    }
  | {
      readonly type: 'navigated'
      readonly targetId: string
      readonly url: string
      readonly generation: number
      readonly revision: number
      readonly sameDocument: boolean
    }
  | {
      readonly type: 'title'
      readonly targetId: string
      readonly title: string
    }
  | {
      readonly type: 'lost'
      readonly targetId: string
      readonly reason: string
    }
  | {
      readonly type: 'detached'
      readonly targetId: string
      readonly reason: string
    }
  | {
      readonly type: 'navigation-blocked'
      readonly targetId: string
      readonly url: string
    }
  | {
      readonly type: 'popup-blocked'
      readonly targetId: string
      readonly url: string
    }
  | {
      /** A download the Agent did not start through browser_download. */
      readonly type: 'download-blocked'
      readonly targetId: string
      readonly url: string
    }
  | {
      /** The page opened a window; the driver opened it as a new tab. */
      readonly type: 'popup-opened'
      readonly targetId: string
      readonly popup: TargetSnapshot
    }
  | { readonly type: 'user-input'; readonly targetId: string }

export type DriverEventListener = (event: DriverEvent) => void

/** Operations shared by every driver kind. */
export interface TargetDriver {
  readonly driver: DriverKind
  capability(): DriverCapability
  snapshot(targetId: string): TargetSnapshot | null
  list(): TargetSnapshot[]
  close(targetId: string, reason: TargetCloseReason): Promise<void>
  observe(
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<DriverObservation>
  screenshot(
    request: ScreenshotRequest,
    signal: AbortSignal,
  ): Promise<ScreenshotCapture>
  act(
    request: ActRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<ActOutcome>
  wait(request: WaitRequest, signal: AbortSignal): Promise<WaitOutcome>
  /** Paused targets reject every action until resumed. */
  setPaused(targetId: string, paused: boolean): void
  subscribe(listener: DriverEventListener): () => void
}

export interface BrowserDriver extends TargetDriver {
  readonly driver: 'embedded-browser' | 'external-browser'
  open(
    request: {
      readonly profile: BrowserProfileSpec
      readonly url: string
      readonly ownerSessionId: string
    },
    signal: AbortSignal,
  ): Promise<TargetSnapshot>
  /** URL a history move would land on, so the gate can check its origin first. */
  historyTarget(targetId: string, direction: HistoryDirection): string | null
  setNavigationPolicy(policy: NavigationPolicy): void
  /** Camera, location, … for this target's profile and origin (§7.4). */
  setSitePermissionPolicy?(policy: SitePermissionPolicy): void
  /**
   * Wipe a persistent profile's storage (cookies, caches, local data); with
   * `remove` also delete its directory. The kernel closes its tabs first.
   */
  clearProfile?(
    profileId: string,
    options: { readonly remove: boolean },
  ): Promise<void>
  /**
   * Save one download into the Agent's inbox (spec 00 §7.5). Only downloads
   * started through this call are accepted; executables and oversized files
   * are refused. `hooks.dispatched()` marks the click or fetch.
   */
  download?(
    request: DownloadRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<DownloadRecord>
  /**
   * Let the user pick files in the host's own file dialog and put them into
   * a page's file input (spec 00 §7.5). Neither the model nor the page ever
   * names a local path; only file names come back.
   */
  upload?(
    request: UploadRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<UploadRecord>
  /** Fill one vault field into a page field (main-frame fields only). */
  fillCredential?(
    request: CredentialFillRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<CredentialFillOutcome>
  /** Only tabs the user explicitly attached in the external extension. */
  listAttached?(): readonly ExternalAttachedTarget[]
  /** Revalidate extension identity before assigning one attached tab to a task. */
  claimAttachedTarget?(
    targetId: string,
    ownerSessionId: string,
    signal: AbortSignal,
  ): Promise<TargetSnapshot>
}

export interface ExternalAttachedTarget {
  readonly targetId: string
  readonly profileId: string
  readonly tabId: number
  readonly windowId: number
  readonly origin: string
  readonly generation: number
  readonly revision: number
  readonly claimedBy: string | null
}

export interface DesktopAppInfo {
  readonly appId: string
  readonly name: string
  readonly pid: number
  readonly frontmost: boolean
  readonly hidden: boolean
}

export interface DesktopWindowInfo {
  readonly windowRef: string
  readonly appId: string
  readonly appName: string
  readonly pid: number
  readonly title: string
  readonly minimized: boolean
  readonly main: boolean
  readonly bounds?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

/** One entry of an app's menu bar or of one of its menus. */
export interface DesktopMenuItem {
  readonly title: string
  readonly enabled: boolean
  /** Opens a further menu; list it by adding its title to the path. */
  readonly submenu: boolean
  readonly shortcut?: string
}

export interface DesktopMenuListing {
  readonly items: readonly DesktopMenuItem[]
  readonly truncated: boolean
}

/** Native desktop driver backed by a platform helper (M3+). */
export interface NativeDesktopDriver extends TargetDriver {
  readonly driver: 'desktop'
  listApps(signal: AbortSignal): Promise<DesktopAppInfo[]>
  listWindows(
    filter: { readonly appId?: string },
    signal: AbortSignal,
  ): Promise<DesktopWindowInfo[]>
  bind(
    request: { readonly windowRef: string; readonly ownerSessionId: string },
    signal: AbortSignal,
  ): Promise<TargetSnapshot>
  fillCredential?(
    request: DesktopCredentialFillRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<CredentialFillOutcome>
  permissions(): Promise<Readonly<Record<string, PermissionStatus>>>
  /**
   * Keep or drop the low-rate capture stream that makes macOS badge the
   * window as shared (E-M16). Resolves whether a stream runs afterwards.
   */
  setCapture?(
    target: { readonly targetId: string; readonly generation: number },
    active: boolean,
  ): Promise<boolean>
  /**
   * At the task's end, give the front back to the app that had it before the
   * first activation, if the bound app still holds it. Resolves whether it did.
   */
  restoreFront?(target: {
    readonly targetId: string
    readonly generation: number
  }): Promise<boolean>
  /** The bound app's menu bar (empty path) or one of its menus; no side effect. */
  menu?(
    request: {
      readonly targetId: string
      readonly generation: number
      readonly path: readonly string[]
    },
    signal: AbortSignal,
  ): Promise<DesktopMenuListing>
  /** Release every held key and mouse button (§12). */
  releaseAll(): Promise<void>
}

export interface ComputerUseHostPort {
  readonly platform: HostPlatform
  embeddedBrowser(): BrowserDriver | null
  /** Null until a browser extension is paired. */
  externalBrowser(): BrowserDriver | null
  /** Null while the helper is unavailable. */
  desktop(): NativeDesktopDriver | null
  /** Live capability negotiation, one entry per driver kind. */
  capabilities(): Promise<DriverCapability[]>
  /** Drive the on-screen "being controlled" indicator (§6.6). */
  indicateControl(state: ControlIndicatorState): void
  /** The credential vault; null where none is available. */
  credentials?(): CredentialVaultPort | null
}
