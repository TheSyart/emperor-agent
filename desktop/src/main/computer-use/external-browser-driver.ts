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
} from '@emperor/core/host-capabilities'
import { UiError } from '@emperor/core/host-capabilities'
import type {
  DriverCapability,
  UiElement,
  UiRole,
} from '@emperor/core/runtime-contract'
import { NmBridgeServer, type NmBridgeEvent } from './nm-bridge'
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
  revision: number
  claimedBy: string | null
  paused: boolean
  elements: Map<string, UiElement>
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

export class ExternalBrowserDriver implements BrowserDriver {
  readonly driver = 'external-browser' as const
  private readonly tabs = new Map<string, TabState>()
  private readonly listeners = new Set<DriverEventListener>()
  private readonly unsubscribeBridge: () => void
  private navigationPolicy: NavigationPolicy | null = null

  constructor(
    private readonly bridge: NmBridgeServer,
    private readonly platform: DriverCapability['platform'] = 'macos',
  ) {
    this.unsubscribeBridge = bridge.subscribe((event) => this.onBridge(event))
  }

  dispose(): void {
    this.unsubscribeBridge()
    this.tabs.clear()
    this.listeners.clear()
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
      })
      return
    }
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
    }
  }

  capability(): DriverCapability {
    const blocked = this.bridge.unavailableReason
    const available = blocked === null && this.bridge.readyPairings().length > 0
    return {
      driver: 'external-browser',
      platform: this.platform,
      stage: available ? 'experimental' : 'unavailable',
      label: 'Chrome/Edge 连接',
      enabled: true,
      available,
      actions: ['click', 'fill'],
      missing: [
        '外部浏览器新建标签页',
        '主框架以外的语义操作',
        '截图与坐标操作',
        '滚动、键盘快捷键和站点导航',
        '凭据代填、上传与下载',
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

  async open(
    _request: {
      profile: BrowserProfileSpec
      url: string
      ownerSessionId: string
    },
    _signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    throw new UiError(
      'CAPABILITY_DISABLED',
      'Connect an existing tab in the extension, then attach it explicitly',
    )
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
    if (request.expectedRevision !== tab.revision)
      throw new UiError('STALE_ELEMENT', 'observe the external tab again')
    const action = request.action
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
