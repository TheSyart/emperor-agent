/**
 * Computer Use contract types (spec 00 §5): targets, grants, observations,
 * actions, waits and the read-only views the renderer shows. Browser-safe —
 * no Node imports — so the view types can travel through the runtime
 * contract.
 */

export type DriverKind = 'embedded-browser' | 'external-browser' | 'desktop'
export type TargetKind = 'embedded-tab' | 'external-tab' | 'desktop-window'
export type HostPlatform = 'macos' | 'windows' | 'linux'

/** Action classes used by grants and the preset matrix (§6.3). */
export type UiActionClass =
  'observe' | 'interact' | 'navigate' | 'transfer' | 'high-impact'

export const UI_ACTION_CLASSES: readonly UiActionClass[] = [
  'observe',
  'interact',
  'navigate',
  'transfer',
  'high-impact',
]

export interface UiTargetRef {
  readonly ownerSessionId: string
  /** Unguessable; minted by the driver, never chosen by a model or page. */
  readonly targetId: string
  readonly kind: TargetKind
  readonly driver: DriverKind
  /** Bumped on rebuild, cross-document navigation, rebind or restart. */
  readonly generation: number
}

export type UiGrantScope = 'once' | 'task' | 'session' | 'timed'

/**
 * Keyboard input a desktop action sends, shown on its grant card. Never a
 * secret: credentials go through the credential-fill path, and secure fields
 * refuse typed text.
 */
export type GrantDisplayInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: string }

export type UiTargetScope =
  | {
      readonly kind: 'browser'
      readonly profileId: string
      /** Exact origins (`https://example.com`); no implicit subdomains. */
      readonly origins: readonly string[]
    }
  | {
      readonly kind: 'desktop'
      readonly appId: string
      readonly windowRef?: string
    }

export interface UiGrant {
  readonly grantId: string
  /** `session:<id>` | `subagent:<id>` | `scheduler:<jobId>` | `mcp-client:<id>` */
  readonly subject: string
  readonly ownerSessionId?: string
  readonly driver: DriverKind
  readonly targetScope: UiTargetScope
  readonly allowedActions: readonly UiActionClass[]
  readonly scope: UiGrantScope
  readonly createdAt: string
  readonly expiresAt?: string
  /** `task` grants: the task (root session + turn) they belong to. */
  readonly taskId?: string
  /** `once` grants: the single tool call they cover. */
  readonly callId?: string
  readonly backgroundAllowed: boolean
  /** An explicit subagent subset; source revision must still be live. */
  readonly delegatedFrom?: {
    readonly grantId: string
    readonly revision: number
  }
  /** Bumped on narrowing or revocation; stale tickets stop matching. */
  readonly revision: number
}

/** Unified role vocabulary across drivers (§5.2). */
export type UiRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'searchbox'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'menu'
  | 'menuitem'
  | 'tab'
  | 'slider'
  | 'table'
  | 'row'
  | 'cell'
  | 'image'
  | 'heading'
  | 'text'
  | 'window'
  | 'dialog'
  | 'group'
  | 'other'

export const UI_ROLES: readonly UiRole[] = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menu',
  'menuitem',
  'tab',
  'slider',
  'table',
  'row',
  'cell',
  'image',
  'heading',
  'text',
  'window',
  'dialog',
  'group',
  'other',
]

export interface UiBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface UiElement {
  /** `r<revision>.<n>`; valid only for that revision. */
  readonly ref: string
  readonly role: UiRole
  /** Raw platform role, for debugging. */
  readonly nativeRole?: string
  readonly name?: string
  /** Sensitive values are masked at extraction time. */
  readonly value?: string
  readonly states?: readonly string[]
  /** Target coordinates (§5.3). */
  readonly bounds?: UiBounds
  readonly actions: readonly string[]
  readonly frameId?: string
  /**
   * Origin of a frame that differs from the page's (a cross-origin iframe).
   * Grants for actions on this element are checked against it.
   */
  readonly frameOrigin?: string
  /**
   * `<input type>` of a web text box (`password`, `email`…), when known.
   * Lets credential fills be checked before any card.
   */
  readonly inputType?: string
  readonly depth?: number
}

export interface UiViewport {
  readonly width: number
  readonly height: number
  readonly scale: number
}

export interface UiObservation {
  readonly target: UiTargetRef
  readonly revision: number
  readonly observedAt: string
  readonly title: string
  readonly urlOrApp: string
  readonly focus: boolean
  readonly frameOrWindowId: string
  readonly viewport: UiViewport
  readonly elements: readonly UiElement[]
  /** Refs present in the base revision but gone now (diff observations). */
  readonly removed?: readonly string[]
  readonly textExcerpt?: string
  readonly screenshot?: {
    readonly attachmentId: string
    readonly screenshotId: string
    readonly width: number
    readonly height: number
  }
  /** Set when this is a diff against that base revision. */
  readonly diffFrom?: number
  readonly truncated: boolean
  /** Continue reading the same revision. */
  readonly cursor?: string
  /** Number of masked fields, so the user knows something was withheld. */
  readonly redactions: number
  /** Driver notes (e.g. "cross-origin frame not expanded", diff fallback). */
  readonly notes?: readonly string[]
}

export type ElementRef = string

/** Screenshot pixel coordinates — the only coordinates a model may use. */
export interface PointRef {
  readonly screenshotId: string
  readonly x: number
  readonly y: number
}

export type MouseButton = 'left' | 'right' | 'middle'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'
export type HistoryDirection = 'back' | 'forward' | 'reload'

export type UiAction =
  | {
      readonly kind: 'click'
      readonly ref: ElementRef
      readonly button?: MouseButton
      readonly count?: 1 | 2
    }
  | {
      readonly kind: 'clickPoint'
      readonly point: PointRef
      readonly button?: MouseButton
      readonly count?: 1 | 2
    }
  /** Non-secret; lands in the session log through the tool arguments. */
  | { readonly kind: 'fill'; readonly ref: ElementRef; readonly text: string }
  /**
   * Inserted at the end of a field's text without replacing it, so a
   * document keeps its formatting. Desktop only.
   */
  | {
      readonly kind: 'appendText'
      readonly ref: ElementRef
      readonly text: string
    }
  /** Typed character by character; a newline may submit. */
  | {
      readonly kind: 'typeText'
      readonly text: string
      readonly ref?: ElementRef
    }
  /** e.g. `Enter`, `Meta+C`, `Control+Shift+Tab`. */
  | { readonly kind: 'press'; readonly key: string; readonly ref?: ElementRef }
  | {
      readonly kind: 'select'
      readonly ref: ElementRef
      readonly option: string
    }
  | {
      readonly kind: 'scroll'
      readonly ref?: ElementRef
      readonly direction: ScrollDirection
      readonly amount: number
      readonly unit: 'page' | 'line'
    }
  | {
      readonly kind: 'drag'
      readonly from: ElementRef | PointRef
      readonly to: ElementRef | PointRef
    }
  /** Only an action name listed for that element in the observation. */
  | {
      readonly kind: 'secondary'
      readonly ref: ElementRef
      readonly action: string
    }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'history'; readonly direction: HistoryDirection }
  /** Desktop: run a menu-bar command by its titles, e.g. ["View", "Zoom In"]. */
  | { readonly kind: 'menu'; readonly path: string[] }
  /** Desktop: bring the bound window's app to the front (asked each time). */
  | { readonly kind: 'activate' }

export type UiActionKind = UiAction['kind']

export interface UiOperationEnvelope {
  /** Only for status queries about the same operation; never a replay key. */
  readonly operationId: string
  readonly callId: string
  readonly target: UiTargetRef
  readonly grantId: string
  readonly expectedRevision: number
  readonly deadlineMs: number
  readonly action: UiAction
}

/** Condition-based waits (§5.5); never a fixed delay. */
export type WaitCondition =
  | { readonly kind: 'navigation'; readonly urlMatches?: string }
  | {
      readonly kind: 'element'
      readonly role?: UiRole
      readonly name?: string
      readonly state: 'present' | 'absent' | 'enabled'
    }
  | { readonly kind: 'text'; readonly contains: string }
  | { readonly kind: 'idle'; readonly quietMs: number }
  | {
      readonly kind: 'window'
      readonly title?: string
      readonly state: 'present' | 'absent'
    }

/** Target lifecycle (§5.7). `closed` and `lost` are terminal. */
export type TargetState =
  'created' | 'attached' | 'paused' | 'recovering' | 'closed' | 'lost'

/** Who is steering a target right now (§6.6). */
export type ControlState = 'agent' | 'paused' | 'user-takeover' | 'stopped'

/** Action lifecycle (§5.7). */
export type OperationState =
  | 'prepared'
  | 'dispatched'
  | 'observed'
  | 'no-effect'
  | 'unknown'
  | 'cancelled'
  | 'denied'

export type ActionOutcome =
  'observed' | 'no-effect' | 'unknown' | 'cancelled' | 'denied'

/** Operation kinds journaled in `ui/action-prepared`, beyond {@link UiAction}. */
export type RedactedUiAction =
  | Exclude<
      UiAction,
      { kind: 'fill' } | { kind: 'appendText' } | { kind: 'typeText' }
    >
  | {
      readonly kind: 'fill' | 'appendText'
      readonly ref: ElementRef
      readonly textLength: number
      readonly textSha256: string
    }
  | {
      readonly kind: 'typeText'
      readonly ref?: ElementRef
      readonly textLength: number
      readonly textSha256: string
    }
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'close' }
  | { readonly kind: 'observe' }
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'wait'; readonly condition: WaitCondition['kind'] }
  | {
      readonly kind: 'fillCredential'
      readonly ref: ElementRef
      readonly handleId: string
      readonly field: CredentialField
    }
  | {
      readonly kind: 'download'
      readonly ref?: ElementRef
      readonly url?: string
    }
  | {
      readonly kind: 'upload'
      readonly ref: ElementRef
      readonly files: number
    }

export type CredentialField = 'username' | 'password' | 'totp'

/** Delivery stage shown to the user and to the model (§3.3). */
export type DriverStage = 'available' | 'experimental' | 'unavailable'

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'stale'

export interface DriverCapability {
  readonly driver: DriverKind
  readonly platform: HostPlatform
  readonly stage: DriverStage
  /** User-facing stage label, e.g. 「内置浏览器（基础）」. */
  readonly label: string
  /** The user switched this driver on. */
  readonly enabled: boolean
  /** The driver can run right now (helper up, permissions granted…). */
  readonly available: boolean
  readonly actions: readonly UiActionKind[]
  /** Capabilities of the full design this driver does not provide yet. */
  readonly missing: readonly string[]
  readonly permissions?: Readonly<Record<string, PermissionStatus>>
  readonly reason?: string
}

export interface ControlIndicatorTarget {
  readonly targetId: string
  readonly title: string
  readonly driver: DriverKind
  readonly state: ControlState
}

/** What the on-screen control indicator should show (§6.6). */
export interface ControlIndicatorState {
  readonly active: boolean
  readonly stopped: boolean
  readonly targets: readonly ControlIndicatorTarget[]
}

// ---------------------------------------------------------------------------
// Views for the renderer (CoreApi `computerUse.*`).

export interface UiTargetView {
  readonly targetId: string
  readonly ownerSessionId: string
  readonly kind: TargetKind
  readonly driver: DriverKind
  readonly generation: number
  readonly revision: number
  readonly state: TargetState
  readonly control: ControlState
  readonly title: string
  readonly url: string
  readonly origin: string | null
  readonly profileId: string
  readonly openedAt: string
  readonly lastScreenshot?: {
    readonly attachmentId: string
    readonly width: number
    readonly height: number
  }
}

export interface UiGrantView {
  readonly grantId: string
  readonly subject: string
  readonly ownerSessionId?: string
  readonly driver: DriverKind
  readonly targetScope: UiTargetScope
  readonly allowedActions: readonly UiActionClass[]
  readonly scope: UiGrantScope
  readonly createdAt: string
  readonly expiresAt?: string
  readonly backgroundAllowed: boolean
}

export interface ComputerUseStatusView {
  /** A host port is present (desktop app). */
  readonly supported: boolean
  /** The user's master switch. */
  readonly enabled: boolean
  /** Persisted GUI authorization mode, independent of Shell permissions. */
  readonly authorizationMode?: 'unrestricted' | 'scoped'
  readonly platform: HostPlatform | null
  /** The emergency stop is engaged; all grants are suspended. */
  readonly stopped: boolean
  readonly stoppedAt?: string
  /**
   * Set when the stop was not the user's: the grants file was unreadable,
   * was quarantined, and every grant is suspended until the user resumes.
   */
  readonly stopReason?: 'corrupt-store'
  /** Saved screenshots counted against the quota (spec 00 §8.5). */
  readonly screenshots?: { readonly count: number; readonly bytes: number }
  /** Days a download stays in the inbox; 0 keeps it. */
  readonly downloadRetentionDays?: number
  /** The user's additions to the protected / high-risk / sensitive apps. */
  readonly appLists?: {
    readonly protected: readonly string[]
    readonly highRisk: readonly string[]
    readonly sensitive: readonly string[]
  }
  readonly drivers: readonly DriverCapability[]
  readonly targets: readonly UiTargetView[]
  readonly grants: readonly UiGrantView[]
  readonly killSwitch: {
    readonly accelerator: string
    readonly registered: boolean
    readonly error?: string
  }
}

/** A browser profile as the UI and tools see it (spec 00 §7.2). */
export interface BrowserProfileView {
  readonly profileId: string
  readonly name: string
  readonly kind: 'temporary' | 'persistent'
  readonly createdAt?: string
  readonly lastUsedAt?: string
  readonly openTargets: number
}

export type DownloadState =
  | 'completed'
  | 'refused'
  | 'too-large'
  | 'interrupted'
  | 'timed-out'
  | 'not-started'

/** Files the user picked for a page's file input (names only). */
export interface UploadRecord {
  readonly state: 'attached' | 'cancelled'
  readonly files: readonly string[]
  readonly bytes: number
}

/** One file in the Agent's download inbox (spec 00 §7.5). */
export interface DownloadRecord {
  readonly downloadId: string
  readonly state: DownloadState
  readonly filename: string
  readonly mimeType?: string
  readonly bytes: number
  readonly sha256?: string
  readonly url: string
  readonly origin: string | null
  /** Why a download did not complete, in plain words. */
  readonly reason?: string
}

/** Site permissions a user can allow per profile and origin (§7.4). */
export const SITE_PERMISSION_KINDS = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
  'fullscreen',
] as const

export type SitePermissionKind = (typeof SITE_PERMISSION_KINDS)[number]

export interface SitePermission {
  readonly profileId: string
  readonly origin: string
  readonly kind: SitePermissionKind
  readonly createdAt: string
  readonly expiresAt?: string
}

/** Where a vault entry may be filled (spec 00 §6.4): exact origins or apps. */
export type CredentialBinding =
  | { readonly kind: 'origin'; readonly origin: string }
  | {
      readonly kind: 'app'
      readonly bundleId: string
      readonly teamId?: string
      readonly path?: string
    }

/** What the model may know about a vault entry: never a secret. */
export interface CredentialHandle {
  readonly handleId: string
  readonly label: string
  readonly bindings: readonly CredentialBinding[]
  /** Present only when the entry lets the model see it. */
  readonly username?: string
  readonly fields: readonly CredentialField[]
  readonly fillMode: 'auto' | 'confirm'
}

export interface CredentialFillOutcome {
  /** Read back after writing: the field now has content. */
  readonly filled: boolean
  readonly bindingMatched: string
}
