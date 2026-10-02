/** Adapts authenticated extension tabs to the Core BrowserDriver contract. */
import type {
  ActHooks,
  ActOutcome,
  ActRequest,
  BrowserDriver,
  BrowserProfileSpec,
  DriverEvent,
  DriverEventListener,
  DriverObservation,
  NavigationPolicy,
  ObserveRequest,
  ScreenshotCapture,
  ScreenshotRequest,
  TargetCloseReason,
  TargetSnapshot,
  WaitOutcome,
  WaitRequest,
  ExternalHistoryEntry,
  ExternalSiteDecider,
  ExternalSiteVerdict,
} from '@emperor/core/host-capabilities'
import { UiError, isExecutableDownload } from '@emperor/core/host-capabilities'
import type {
  DriverCapability,
  UiElement,
  UiRole,
} from '@emperor/core/runtime-contract'
import { NmBridgeServer, type NmBridgeEvent } from './nm-bridge'
import type { NmAgentEvent } from './nm-bridge-agent'
import {
  externalDownloadId,
  type ExternalDownloadLog,
  type ExternalDownloadState,
} from './external-downloads'
import { isExactHttpOrigin } from './web-origin'

const ROLES = new Set<string>([
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
])

export interface ExternalAttachedTab {
  readonly targetId: string
  readonly profileId: string
  readonly tabId: number
  readonly windowId: number
  readonly origin: string
  readonly generation: number
  readonly revision: number
  readonly claimedBy: string | null
}

interface TabState extends ExternalAttachedTab {
  origin: string
  generation: number
  revision: number
  claimedBy: string | null
  paused: boolean
  elements: Map<string, UiElement>
  /** The page moved to a site that needs the user's approval (RV-09). */
  pendingOrigin: string | null
}

/** A download the extension holds until Emperor decides (RV-09). */
interface HeldDownload {
  readonly pairingId: string
  /** The browser's own id. */
  readonly browserId: number
  readonly targetId: string
  readonly filename: string
  /** Origin of the file ('' when the browser did not say). */
  readonly fileOrigin: string
  readonly pageOrigin: string
  readonly browser: 'chrome' | 'edge'
  readonly timer: ReturnType<typeof setTimeout>
  decided: boolean
}

export interface ExternalBrowserDriverOptions {
  /** 下载历史记录 › Emperor 的下载 (RV-09). */
  readonly downloads?: Pick<ExternalDownloadLog, 'record'>
  now?(): number
}

/** How long a held download waits for a verdict before it is refused. */
const DOWNLOAD_DECISION_MS = 10 * 60_000
const DECISION_RANK: Readonly<Record<ExternalSiteVerdict, number>> = {
  allow: 0,
  ask: 1,
  block: 2,
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function toElements(value: unknown, revision: number): UiElement[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new UiError('DRIVER_UNAVAILABLE', 'invalid extension observation')
  const seenRefs = new Set<string>()
  return value.map((raw) => {
    if (
      !object(raw) ||
      typeof raw.ref !== 'string' ||
      !new RegExp(`^r${revision}\\.\\d+$`).test(raw.ref) ||
      typeof raw.role !== 'string' ||
      !ROLES.has(raw.role) ||
      !Array.isArray(raw.actions)
    )
      throw new UiError('DRIVER_UNAVAILABLE', 'invalid extension element')
    if (seenRefs.has(raw.ref))
      throw new UiError('DRIVER_UNAVAILABLE', 'duplicate extension element ref')
    seenRefs.add(raw.ref)
    const actions = raw.actions.filter(
      (action): action is string => action === 'click' || action === 'fill',
    )
    if (actions.length !== raw.actions.length)
      throw new UiError('DRIVER_UNAVAILABLE', 'invalid extension actions')
    const box = raw.bounds
    const bounds =
      object(box) &&
      ['x', 'y', 'width', 'height'].every(
        (key) => typeof box[key] === 'number' && Number.isFinite(box[key]),
      )
        ? {
            x: box.x as number,
            y: box.y as number,
            width: box.width as number,
            height: box.height as number,
          }
        : undefined
    return {
      ref: raw.ref,
      role: raw.role as UiRole,
      ...(typeof raw.name === 'string' ? { name: raw.name.slice(0, 200) } : {}),
      ...(Array.isArray(raw.states)
        ? {
            states: raw.states
              .filter((state): state is string => typeof state === 'string')
              .slice(0, 8),
          }
        : {}),
      ...(bounds ? { bounds } : {}),
      actions,
    }
  })
}

/** One history row from the extension, or null when it is not a web page. */
function historyEntry(raw: unknown): ExternalHistoryEntry | null {
  if (
    !object(raw) ||
    typeof raw.url !== 'string' ||
    raw.url.length > 2_048 ||
    typeof raw.title !== 'string' ||
    typeof raw.lastVisitTime !== 'number' ||
    !Number.isFinite(raw.lastVisitTime) ||
    raw.lastVisitTime < 0
  )
    return null
  try {
    const protocol = new URL(raw.url).protocol
    if (protocol !== 'http:' && protocol !== 'https:') return null
  } catch {
    return null
  }
  return {
    url: raw.url,
    title: raw.title.slice(0, 200),
    lastVisitTime: Math.round(raw.lastVisitTime),
    visitCount: safeInteger(raw.visitCount) ? raw.visitCount : 0,
  }
}

/** A bridge failure as the kernel's error vocabulary. */
function bridgeError(error: unknown, message: string): UiError {
  const code = (error as Error | undefined)?.name
  if (code === 'PERMISSION_REQUIRED')
    return new UiError(
      'PERMISSION_REQUIRED',
      'the extension may not read this site yet; the user allows all sites in the extension',
      { reason: 'site-access' },
    )
  if (code === 'INVALID_ARGUMENT')
    return new UiError('INVALID_REQUEST', 'only http(s) URLs can be opened')
  if (code === 'OUTCOME_UNKNOWN')
    return new UiError(
      'OUTCOME_UNKNOWN',
      'the tab may have opened; list the tabs before retrying',
    )
  return new UiError('DRIVER_UNAVAILABLE', message, { cause: error })
}

export class ExternalBrowserDriver implements BrowserDriver {
  readonly driver = 'external-browser' as const
  private readonly tabs = new Map<string, TabState>()
  private readonly listeners = new Set<DriverEventListener>()
  private readonly unsubscribeBridge: () => void
  private navigationPolicy: NavigationPolicy | null = null
  private siteDecider: ExternalSiteDecider | null = null
  /** When each pairing's worker last connected (newest opens new tabs). */
  private readonly readyOrder = new Map<string, number>()
  private readySequence = 0
  private readonly held = new Map<string, HeldDownload>()
  private readonly heldIds = new Map<string, string>()
  private readonly downloadLog: Pick<ExternalDownloadLog, 'record'> | null
  private readonly now: () => number

  constructor(
    private readonly bridge: NmBridgeServer,
    private readonly platform: DriverCapability['platform'] = 'macos',
    options: ExternalBrowserDriverOptions = {},
  ) {
    this.downloadLog = options.downloads ?? null
    this.now = options.now ?? (() => Date.now())
    this.unsubscribeBridge = bridge.subscribe((event) => this.onBridge(event))
  }

  dispose(): void {
    this.unsubscribeBridge()
    this.tabs.clear()
    this.listeners.clear()
    for (const held of this.held.values()) clearTimeout(held.timer)
    this.held.clear()
    this.heldIds.clear()
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* listeners cannot alter the driver */
      }
    }
  }

  private drop(targetId: string, reason: string): void {
    if (!this.tabs.delete(targetId)) return
    this.emit({ type: 'lost', targetId, reason })
  }

  private onBridge(event: NmBridgeEvent): void {
    if (event.type === 'target-attached') {
      if (!isExactHttpOrigin(event.origin)) return
      // The extension chooses target IDs. A different authenticated pairing
      // must not retire an existing lease by announcing the same UUID.
      const current = this.tabs.get(event.targetId)
      if (current && current.profileId !== event.pairingId) return
      // Duplicate or delayed attachments must not release a newer lease.
      // The extension's generation increases when it reattaches a tab, but
      // events can arrive after a replacement has already been published.
      if (
        [...this.tabs.values()].some(
          (tab) =>
            (tab.targetId === event.targetId ||
              (tab.profileId === event.pairingId &&
                tab.tabId === event.tabId)) &&
            event.generation <= tab.generation,
        )
      )
        return
      // Chrome may reuse a numeric tab ID after a tab closes. A fresh target
      // for that slot must invalidate the old Core lease even if a lost event
      // did not arrive before this attachment.
      for (const tab of [...this.tabs.values()])
        if (
          tab.targetId === event.targetId ||
          (tab.profileId === event.pairingId && tab.tabId === event.tabId)
        )
          this.drop(tab.targetId, 'reattached')
      this.tabs.set(event.targetId, {
        targetId: event.targetId,
        profileId: event.pairingId,
        tabId: event.tabId,
        windowId: event.windowId,
        origin: event.origin,
        generation: event.generation,
        revision: 0,
        claimedBy: null,
        paused: false,
        elements: new Map(),
        pendingOrigin: null,
      })
      return
    }
    if (this.onAgentEvent(event)) return
    if (event.type === 'target-lost') {
      const tab = this.tabs.get(event.targetId)
      if (
        tab?.profileId === event.pairingId &&
        tab.generation === event.generation
      )
        this.drop(event.targetId, event.reason)
      return
    }
    if (
      event.type === 'disconnected' ||
      event.type === 'revoked' ||
      event.type === 'ready'
    ) {
      for (const tab of [...this.tabs.values()])
        if (tab.profileId === event.pairingId)
          this.drop(tab.targetId, event.type)
      // The extension refuses what it held when the connection ends.
      for (const [id, held] of [...this.held])
        if (held.pairingId === event.pairingId) this.forgetDownload(id)
      if (event.type === 'ready')
        this.readyOrder.set(event.pairingId, ++this.readySequence)
      else this.readyOrder.delete(event.pairingId)
    }
  }

  capability(): DriverCapability {
    const blocked = this.bridge.unavailableReason
    const available = blocked === null && this.bridge.readyPairings().length > 0
    return {
      driver: 'external-browser',
      platform: this.platform,
      // What the driver is; `available` says whether it can act now.
      stage: 'experimental',
      label: 'Chrome/Edge 连接',
      enabled: true,
      available,
      actions: ['click', 'fill', 'navigate'],
      missing: [
        '主框架以外的语义操作',
        '截图与坐标操作',
        '滚动和键盘快捷键',
        '凭据代填与上传',
        '下载进 Emperor 收件箱（下载留在浏览器自己的下载文件夹）',
      ],
      ...(blocked !== null
        ? {
            reason: blocked.includes('already in use')
              ? '另一个 Emperor 正在使用 Chrome/Edge 连接；退出它后本应用会自动恢复'
              : `Chrome/Edge 连接不可用：${blocked}`,
          }
        : !available
          ? { reason: '请在扩展中完成配对并连接标签页' }
          : {}),
    }
  }

  /** Only tabs explicitly attached in the popup and reported over an authenticated bridge. */
  listAttached(): ReadonlyArray<ExternalAttachedTab> {
    return [...this.tabs.values()].map(
      ({
        targetId,
        profileId,
        tabId,
        windowId,
        origin,
        generation,
        revision,
        claimedBy,
      }) => ({
        targetId,
        profileId,
        tabId,
        windowId,
        origin,
        generation,
        revision,
        claimedBy,
      }),
    )
  }

  async claimAttachedTarget(
    targetId: string,
    ownerSessionId: string,
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    if (signal.aborted)
      throw new UiError('TIMEOUT_NO_EFFECT', 'attachment cancelled')
    const tab = this.tabs.get(targetId)
    if (!tab)
      throw new UiError('STALE_TARGET', 'attached tab is no longer available')
    if (tab.claimedBy && tab.claimedBy !== ownerSessionId)
      throw new UiError('TARGET_BUSY', 'tab belongs to another task')
    const live = await this.bridge.request(
      tab.profileId,
      'target.list',
      {},
      5_000,
      signal,
    )
    if (
      !object(live) ||
      !Array.isArray(live.targets) ||
      !live.targets.some(
        (item) =>
          object(item) &&
          item.targetId === tab.targetId &&
          item.generation === tab.generation &&
          item.tabId === tab.tabId &&
          item.windowId === tab.windowId &&
          item.origin === tab.origin,
      )
    ) {
      this.drop(targetId, 'extension-target-mismatch')
      throw new UiError(
        'STALE_TARGET',
        'extension target changed; connect the tab again',
      )
    }
    if (this.tabs.get(targetId) !== tab)
      throw new UiError('STALE_TARGET', 'tab disconnected during attachment')
    tab.claimedBy = ownerSessionId
    return this.snapshotOf(tab)
  }

  snapshot(targetId: string): TargetSnapshot | null {
    const tab = this.tabs.get(targetId)
    return tab ? this.snapshotOf(tab) : null
  }

  list(): TargetSnapshot[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.claimedBy !== null)
      .map((tab) => this.snapshotOf(tab))
  }

  private snapshotOf(tab: TabState): TargetSnapshot {
    return {
      targetId: tab.targetId,
      kind: 'external-tab',
      driver: 'external-browser',
      generation: tab.generation,
      revision: tab.revision,
      url: tab.origin,
      title: `Chrome/Edge ${tab.origin}`,
      loading: false,
      profileId: tab.profileId,
    }
  }

  /**
   * Open `url` in a new background tab of the connected browser (its tab
   * group 「Emperor」), already this task's (RV-09). The kernel applied the
   * 浏览 rule; a page that lands on another site is judged here.
   */
  async open(
    request: {
      profile: BrowserProfileSpec
      url: string
      ownerSessionId: string
    },
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    const profileId =
      request.profile.kind === 'persistent'
        ? request.profile.profileId
        : this.openProfile()
    if (profileId === null || !this.bridge.readyPairings().includes(profileId))
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'no Chrome or Edge is connected',
        {
          reason: 'not-connected',
        },
      )
    let requested: string
    try {
      requested = new URL(request.url).origin
    } catch {
      throw new UiError('INVALID_REQUEST', 'only http(s) URLs can be opened')
    }
    let response: unknown
    try {
      response = await this.bridge.request(
        profileId,
        'tab.open',
        { url: request.url },
        45_000,
        signal,
      )
    } catch (error) {
      throw bridgeError(error, 'the browser could not open the tab')
    }
    if (
      !object(response) ||
      typeof response.targetId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(response.targetId) ||
      !safeInteger(response.tabId) ||
      !safeInteger(response.windowId) ||
      !safeInteger(response.generation) ||
      response.generation < 1 ||
      !isExactHttpOrigin(response.origin)
    )
      throw new UiError('DRIVER_UNAVAILABLE', 'invalid extension response')
    for (const tab of [...this.tabs.values()])
      if (
        tab.targetId === response.targetId ||
        (tab.profileId === profileId && tab.tabId === response.tabId)
      )
        this.drop(tab.targetId, 'reattached')
    const tab: TabState = {
      targetId: response.targetId,
      profileId,
      tabId: response.tabId,
      windowId: response.windowId,
      origin: response.origin,
      generation: response.generation,
      revision: 0,
      claimedBy: request.ownerSessionId,
      paused: false,
      elements: new Map(),
      pendingOrigin: null,
    }
    this.tabs.set(tab.targetId, tab)
    if (tab.origin !== requested) {
      const verdict = this.decide(tab.origin, 'browse')
      if (verdict !== 'allow') {
        await this.detach(tab, 'released')
        throw verdict === 'block'
          ? new UiError(
              'PERMISSION_DENIED',
              `the page went on to ${tab.origin}, which the user blocked for Emperor`,
              { reason: 'site-blocked' },
            )
          : new UiError(
              'PERMISSION_REQUIRED',
              `the page went on to ${tab.origin}, which needs the user's approval; open that site with external_tab_open to ask`,
              { reason: 'site-needs-approval' },
            )
      }
    }
    return this.snapshotOf(tab)
  }

  /** The connection a new tab opens in: the browser connected last. */
  openProfile(): string | null {
    const ready = this.bridge.readyPairings()
    return (
      [...ready].sort(
        (a, b) => (this.readyOrder.get(b) ?? 0) - (this.readyOrder.get(a) ?? 0),
      )[0] ?? null
    )
  }

  setSiteDecider(decider: ExternalSiteDecider): void {
    this.siteDecider = decider
  }

  private decide(
    url: string,
    kind: 'browse' | 'download',
  ): ExternalSiteVerdict {
    return (
      this.siteDecider?.(url, kind) ?? (kind === 'browse' ? 'allow' : 'ask')
    )
  }

  /** Tell the extension to let the tab go, and forget it. */
  private async detach(tab: TabState, reason: string): Promise<void> {
    try {
      await this.bridge.request(
        tab.profileId,
        'target.detach',
        { targetId: tab.targetId, generation: tab.generation },
        5_000,
      )
    } catch {
      // the extension drops it on its own when the page is gone
    } finally {
      this.drop(tab.targetId, reason)
    }
  }

  /** The target carries on in its tab's new page under a new generation. */
  private followed(tab: TabState, origin: string, generation: number): void {
    tab.origin = origin
    tab.generation = generation
    tab.pendingOrigin = null
    tab.elements.clear()
    this.emit({
      type: 'navigated',
      targetId: tab.targetId,
      url: origin,
      generation,
      revision: tab.revision,
      sameDocument: false,
    })
  }

  private async follow(tab: TabState, origin: string): Promise<void> {
    const generation = tab.generation
    try {
      const response = await this.bridge.request(
        tab.profileId,
        'target.follow',
        { targetId: tab.targetId, generation, origin },
        15_000,
      )
      if (this.tabs.get(tab.targetId) !== tab || tab.generation !== generation)
        return
      if (
        !object(response) ||
        response.origin !== origin ||
        !safeInteger(response.generation) ||
        response.generation <= generation
      )
        throw new Error('invalid extension response')
      this.followed(tab, origin, response.generation)
    } catch (error) {
      // The page moved again: the extension reports that move next.
      if ((error as Error | undefined)?.name === 'STALE_TARGET') return
      if (this.tabs.get(tab.targetId) === tab && tab.generation === generation)
        this.drop(tab.targetId, 'navigation-failed')
    }
  }

  /**
   * A target's page moved (by itself, or the Agent's navigation landed on
   * another site): follow it, disconnect it from a blocked site, or let a
   * task's tab wait for the user's approval. A tab nobody holds follows a
   * site that asks; the next claim asks instead.
   */
  private onPageMoved(tab: TabState, origin: string): void {
    const verdict = this.decide(origin, 'browse')
    if (verdict === 'block') {
      this.emit({
        type: 'navigation-blocked',
        targetId: tab.targetId,
        url: origin,
      })
      void this.detach(tab, 'site-blocked')
      return
    }
    if (verdict === 'ask' && origin !== tab.origin && tab.claimedBy !== null) {
      tab.pendingOrigin = origin
      this.emit({
        type: 'navigation-pending',
        targetId: tab.targetId,
        url: origin,
      })
      return
    }
    void this.follow(tab, origin)
  }

  resolveNavigation(targetId: string, allow: boolean): void {
    const tab = this.tabs.get(targetId)
    if (!tab || tab.pendingOrigin === null) return
    const origin = tab.pendingOrigin
    tab.pendingOrigin = null
    if (allow) void this.follow(tab, origin)
    else void this.detach(tab, 'site-denied')
  }

  /** The Agent's own browsing (RV-09); true when `event` was one of it. */
  private onAgentEvent(event: NmBridgeEvent): boolean {
    const agent = event as NmAgentEvent
    if (agent.type === 'target-navigated') {
      const tab = this.tabs.get(agent.targetId)
      if (
        tab?.profileId === agent.pairingId &&
        tab.generation === agent.generation
      )
        this.onPageMoved(tab, agent.origin)
      return true
    }
    if (agent.type === 'download-pending') {
      this.onDownloadPending(agent)
      return true
    }
    if (agent.type === 'download-done') {
      this.onDownloadDone(agent)
      return true
    }
    return false
  }

  private onDownloadPending(
    event: Extract<NmAgentEvent, { type: 'download-pending' }>,
  ): void {
    const tab = this.tabs.get(event.targetId)
    if (!tab || tab.profileId !== event.pairingId) {
      void this.bridge
        .request(
          event.pairingId,
          'download.resolve',
          { downloadId: event.downloadId, allow: false },
          5_000,
        )
        .catch(() => undefined)
      return
    }
    const id = externalDownloadId()
    const timer = setTimeout(
      () => this.resolveDownload(id, { allow: false, reason: 'denied' }),
      DOWNLOAD_DECISION_MS,
    )
    timer.unref?.()
    this.held.set(id, {
      pairingId: event.pairingId,
      browserId: event.downloadId,
      targetId: tab.targetId,
      filename: event.filename,
      fileOrigin: event.origin,
      pageOrigin: tab.origin,
      browser: event.browser,
      timer,
      decided: false,
    })
    this.heldIds.set(`${event.pairingId}:${event.downloadId}`, id)
    if (this.held.size > 100) {
      const oldest = this.held.keys().next().value
      if (oldest !== undefined) this.forgetDownload(oldest)
    }
    if (tab.claimedBy === null) {
      // No task to ask for: only what the rules allow outright.
      const page = this.decide(tab.origin, 'download')
      const file =
        event.origin === '' ? 'allow' : this.decide(event.origin, 'download')
      const verdict = DECISION_RANK[page] >= DECISION_RANK[file] ? page : file
      const executable = isExecutableDownload(event.filename, event.mimeType)
      this.resolveDownload(
        id,
        verdict === 'allow' && !executable
          ? { allow: true }
          : {
              allow: false,
              reason: executable
                ? 'executable'
                : verdict === 'block'
                  ? 'blocked'
                  : 'denied',
            },
      )
      return
    }
    this.emit({
      type: 'download-requested',
      targetId: tab.targetId,
      downloadId: id,
      url: event.origin,
      filename: event.filename,
      ...(event.mimeType === '' ? {} : { mimeType: event.mimeType }),
      bytes: event.bytes,
    })
  }

  resolveDownload(
    downloadId: string,
    verdict: { readonly allow: boolean; readonly reason?: string },
  ): void {
    const held = this.held.get(downloadId)
    if (!held || held.decided) return
    held.decided = true
    clearTimeout(held.timer)
    void this.bridge
      .request(
        held.pairingId,
        'download.resolve',
        { downloadId: held.browserId, allow: verdict.allow },
        5_000,
      )
      .catch(() => undefined)
    if (verdict.allow) return
    this.recordDownload(downloadId, held, 'refused', 0, verdict.reason)
    this.forgetDownload(downloadId)
  }

  private onDownloadDone(
    event: Extract<NmAgentEvent, { type: 'download-done' }>,
  ): void {
    const id = this.heldIds.get(`${event.pairingId}:${event.downloadId}`)
    const held = id === undefined ? undefined : this.held.get(id)
    if (id === undefined || !held?.decided) return
    this.forgetDownload(id)
    const state = event.state === 'complete' ? 'completed' : 'interrupted'
    const filename = event.filename || held.filename
    this.recordDownload(id, held, state, event.bytes, undefined, filename)
    this.emit({
      type: 'download-finished',
      targetId: held.targetId,
      downloadId: id,
      state,
      filename,
      bytes: event.bytes,
      url: held.fileOrigin,
    })
  }

  private recordDownload(
    id: string,
    held: HeldDownload,
    state: ExternalDownloadState,
    bytes: number,
    reason?: string,
    name = held.filename,
  ): void {
    try {
      this.downloadLog?.record({
        id,
        name,
        origin: held.fileOrigin || held.pageOrigin,
        browser: held.browser,
        state,
        ...(reason === undefined ? {} : { reason }),
        bytes,
        time: this.now(),
      })
    } catch {
      // the history is a convenience; the browser has its own
    }
  }

  private forgetDownload(id: string): void {
    const held = this.held.get(id)
    if (!held) return
    clearTimeout(held.timer)
    this.held.delete(id)
    this.heldIds.delete(`${held.pairingId}:${held.browserId}`)
  }

  historyTarget(): null {
    return null
  }
  setNavigationPolicy(policy: NavigationPolicy): void {
    this.navigationPolicy = policy
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private current(targetId: string, generation: number): TabState {
    const tab = this.tabs.get(targetId)
    if (!tab || tab.generation !== generation || !tab.claimedBy)
      throw new UiError('STALE_TARGET', 'external tab is no longer attached')
    return tab
  }

  /**
   * The task ended (2026-09-29 §3.3): the tab stays attached in the
   * extension and paired; only this task's claim ends, so the next task can
   * attach it again without the user connecting it anew. Its refs go stale.
   */
  async release(targetId: string): Promise<void> {
    const tab = this.tabs.get(targetId)
    if (!tab) return
    tab.claimedBy = null
    tab.elements.clear()
    tab.revision += 1
  }

  async close(targetId: string, _reason: TargetCloseReason): Promise<void> {
    const tab = this.tabs.get(targetId)
    if (!tab) return
    try {
      await this.bridge.request(
        tab.profileId,
        'target.detach',
        { targetId, generation: tab.generation },
        5_000,
      )
    } finally {
      this.drop(targetId, 'released')
    }
  }

  async observe(
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<DriverObservation> {
    const tab = this.current(request.targetId, request.generation)
    this.assertNotWaiting(tab)
    const response = await this.bridge.request(
      tab.profileId,
      'target.observe',
      {
        targetId: tab.targetId,
        generation: tab.generation,
        budget: { maxElements: Math.min(request.budget.maxElements, 200) },
      },
      request.budget.timeoutMs,
      signal,
    )
    if (
      !object(response) ||
      response.targetId !== tab.targetId ||
      response.generation !== tab.generation ||
      !safeInteger(response.revision) ||
      response.revision <= tab.revision ||
      response.origin !== tab.origin ||
      !object(response.viewport) ||
      !positiveFinite(response.viewport.width) ||
      !positiveFinite(response.viewport.height) ||
      !positiveFinite(response.viewport.scale)
    )
      throw new UiError('DRIVER_UNAVAILABLE', 'invalid extension observation')
    if (this.tabs.get(tab.targetId) !== tab)
      throw new UiError('STALE_TARGET', 'tab disconnected during observation')
    const elements = toElements(response.elements, response.revision)
    tab.revision = response.revision
    tab.elements = new Map(elements.map((element) => [element.ref, element]))
    this.emit({
      type: 'changed',
      targetId: tab.targetId,
      revision: tab.revision,
    })
    const query = request.query
    const selected = query
      ? elements.filter(
          (element) =>
            (!query.role || element.role === query.role) &&
            (!query.nameContains ||
              element.name?.includes(query.nameContains)) &&
            (!query.frameId || query.frameId === 'main'),
        )
      : elements
    return {
      generation: tab.generation,
      revision: tab.revision,
      title: `Chrome/Edge ${tab.origin}`,
      urlOrApp: tab.origin,
      focus: false,
      frameOrWindowId: `${tab.windowId}:${tab.tabId}`,
      viewport: {
        width: response.viewport.width,
        height: response.viewport.height,
        scale: response.viewport.scale,
      },
      elements: selected,
      truncated: response.truncated === true,
      redactions: safeInteger(response.redactions) ? response.redactions : 0,
      notes: [
        '主框架语义元素；输入框值和网页正文未读取',
        ...(request.diffFrom !== undefined
          ? ['扩展不支持 diff，返回完整快照']
          : []),
      ],
    }
  }

  async screenshot(
    _request: ScreenshotRequest,
    _signal: AbortSignal,
  ): Promise<ScreenshotCapture> {
    throw new UiError(
      'CAPABILITY_DISABLED',
      'external browser screenshot is not available',
    )
  }

  async act(
    request: ActRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<ActOutcome> {
    const tab = this.current(request.targetId, request.generation)
    if (tab.paused) throw new UiError('TARGET_BUSY', 'external tab is paused')
    this.assertNotWaiting(tab)
    const action = request.action
    if (action.kind === 'navigate')
      return await this.navigate(tab, action.url, request, hooks, signal)
    if (request.expectedRevision !== tab.revision)
      throw new UiError('STALE_ELEMENT', 'observe the external tab again')
    if (action.kind !== 'click' && action.kind !== 'fill')
      throw new UiError(
        'CAPABILITY_DISABLED',
        'action is not available in the external browser',
      )
    const element = tab.elements.get(action.ref)
    if (!element || !element.actions.includes(action.kind))
      throw new UiError(
        'STALE_ELEMENT',
        'element is not actionable in the current observation',
      )
    if (action.kind === 'fill' && action.text.length > 16_384)
      throw new UiError('INVALID_REQUEST', 'input is too long')
    // This is the first possible side effect: record dispatch before sending.
    hooks.dispatched()
    try {
      await this.bridge.request(
        tab.profileId,
        'target.act',
        {
          targetId: tab.targetId,
          generation: tab.generation,
          expectedRevision: request.expectedRevision,
          action,
        },
        request.deadlineMs,
        signal,
      )
      if (this.tabs.get(tab.targetId) !== tab) throw new Error('target changed')
      const after = await this.observe(
        {
          targetId: tab.targetId,
          generation: tab.generation,
          budget: {
            maxElements: 200,
            maxTextBytes: 0,
            maxDepth: 8,
            timeoutMs: Math.min(request.deadlineMs, 3_000),
          },
          includeText: false,
        },
        signal,
      )
      return {
        outcome: 'observed',
        afterRevision: after.revision,
        url: tab.origin,
        changes: ['action sent and target observed again'],
      }
    } catch {
      throw new UiError(
        'OUTCOME_UNKNOWN',
        'external action may have run; observe the tab before retrying',
      )
    }
  }

  /**
   * 历史记录 (RV-10): search every connected browser; newest first, one row
   * per address (its latest visit). One browser failing is not an error;
   * all of them failing is.
   */
  async searchHistory(
    request: {
      readonly query: string
      readonly startTime: number
      readonly maxResults: number
    },
    signal: AbortSignal,
  ): Promise<ExternalHistoryEntry[]> {
    const pairings = this.bridge.readyPairings()
    if (pairings.length === 0)
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'no Chrome or Edge is connected',
        {
          reason: 'not-connected',
        },
      )
    const answers = await Promise.allSettled(
      pairings.map((pairing) =>
        this.bridge.request(
          pairing,
          'history.search',
          {
            text: request.query,
            startTime: request.startTime,
            maxResults: request.maxResults,
          },
          15_000,
          signal,
        ),
      ),
    )
    if (answers.every((answer) => answer.status === 'rejected'))
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'the browser did not answer the history search',
      )
    const byUrl = new Map<string, ExternalHistoryEntry>()
    for (const answer of answers) {
      if (
        answer.status !== 'fulfilled' ||
        !object(answer.value) ||
        !Array.isArray(answer.value.items)
      )
        continue
      for (const raw of answer.value.items.slice(0, 200)) {
        const entry = historyEntry(raw)
        if (entry === null) continue
        const known = byUrl.get(entry.url)
        if (known === undefined || entry.lastVisitTime > known.lastVisitTime)
          byUrl.set(entry.url, entry)
      }
    }
    return [...byUrl.values()]
      .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
      .slice(0, request.maxResults)
  }

  private assertNotWaiting(tab: TabState): void {
    if (tab.pendingOrigin !== null)
      throw new UiError(
        'TARGET_BUSY',
        `the page went to ${tab.pendingOrigin}; it waits for the user to approve that site`,
        { reason: 'site-needs-approval' },
      )
  }

  /** Go to `url` in this tab; the kernel applied the 浏览 rule (RV-09). */
  private async navigate(
    tab: TabState,
    url: string,
    request: ActRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<ActOutcome> {
    let destination: string
    try {
      destination = new URL(url).origin
    } catch {
      throw new UiError('INVALID_REQUEST', 'only http(s) URLs can be opened')
    }
    if (!isExactHttpOrigin(destination))
      throw new UiError('INVALID_REQUEST', 'only http(s) URLs can be opened')
    hooks.dispatched()
    let response: unknown
    try {
      response = await this.bridge.request(
        tab.profileId,
        'target.navigate',
        { targetId: tab.targetId, generation: tab.generation, url },
        Math.max(request.deadlineMs, 30_000),
        signal,
      )
    } catch {
      throw new UiError(
        'OUTCOME_UNKNOWN',
        'the navigation may have happened; observe the tab before retrying',
      )
    }
    if (
      this.tabs.get(tab.targetId) !== tab ||
      !object(response) ||
      !isExactHttpOrigin(response.origin)
    )
      throw new UiError(
        'OUTCOME_UNKNOWN',
        'the tab changed during navigation; observe it again',
      )
    if (response.pending === true) {
      // Redirected elsewhere: judged like a page that moved by itself.
      this.onPageMoved(tab, response.origin)
      return {
        outcome: 'observed',
        afterRevision: tab.revision,
        url: response.origin,
        changes: [`the page went on to ${response.origin}`],
      }
    }
    if (
      !safeInteger(response.generation) ||
      response.generation <= tab.generation
    )
      throw new UiError('OUTCOME_UNKNOWN', 'invalid extension response')
    this.followed(tab, response.origin, response.generation)
    return {
      outcome: 'observed',
      afterRevision: tab.revision,
      url: tab.origin,
      changes: [`went to ${tab.origin}`],
    }
  }

  async wait(request: WaitRequest, signal: AbortSignal): Promise<WaitOutcome> {
    if (request.condition.kind !== 'element')
      throw new UiError(
        'CAPABILITY_DISABLED',
        'this external browser wait condition is unavailable',
      )
    this.current(request.targetId, request.generation)
    const deadline = Date.now() + request.timeoutMs
    const timedOut = (): WaitOutcome => {
      const tab = this.current(request.targetId, request.generation)
      return { satisfied: false, revision: tab.revision, url: tab.origin }
    }
    for (;;) {
      if (signal.aborted)
        throw new UiError('TIMEOUT_NO_EFFECT', 'wait cancelled')
      const remaining = deadline - Date.now()
      if (remaining <= 0) return timedOut()
      const attempt = new AbortController()
      const cancelAttempt = () => attempt.abort()
      signal.addEventListener('abort', cancelAttempt, { once: true })
      if (signal.aborted) attempt.abort()
      const timer = setTimeout(cancelAttempt, remaining)
      let observation: DriverObservation
      try {
        observation = await this.observe(
          {
            targetId: request.targetId,
            generation: request.generation,
            budget: {
              maxElements: 200,
              maxTextBytes: 0,
              maxDepth: 8,
              timeoutMs: Math.min(remaining, 3_000),
            },
            includeText: false,
          },
          attempt.signal,
        )
      } catch (error) {
        if (signal.aborted)
          throw new UiError('TIMEOUT_NO_EFFECT', 'wait cancelled')
        if (Date.now() >= deadline) return timedOut()
        throw error
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancelAttempt)
      }
      if (Date.now() >= deadline) return timedOut()
      const condition = request.condition
      const matches = observation.elements.filter(
        (element) =>
          (!condition.role || element.role === condition.role) &&
          (!condition.name || element.name?.includes(condition.name)),
      )
      const satisfied =
        condition.state === 'absent'
          ? matches.length === 0
          : condition.state === 'enabled'
            ? matches.some((item) => !item.states?.includes('disabled'))
            : matches.length > 0
      if (satisfied)
        return {
          satisfied: true,
          revision: observation.revision,
          url: observation.urlOrApp,
        }
      if (Date.now() >= deadline) return timedOut()
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, deadline - Date.now())),
      )
    }
  }

  setPaused(targetId: string, paused: boolean): void {
    const tab = this.tabs.get(targetId)
    if (tab) tab.paused = paused
  }
}
