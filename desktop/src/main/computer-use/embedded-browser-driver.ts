/**
 * The built-in browser driver (spec 00 §7.3): Agent tabs from
 * `BrowserSessionManager`, controlled over CDP. Observation is the semantic
 * snapshot; actions resolve refs of the current revision only, scroll into
 * view, hit-test before any pointer event, and call `hooks.dispatched()`
 * right before the first side effect. No arbitrary JavaScript and no raw CDP
 * is ever exposed.
 */

import { randomUUID } from 'node:crypto'
import { stat as fsStat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  ActHooks,
  ActOutcome,
  ActRequest,
  BrowserDriver,
  BrowserProfileSpec,
  CredentialFillRequest,
  DownloadRequest,
  DriverEvent,
  DriverEventListener,
  DriverObservation,
  NavigationPolicy,
  ObserveRequest,
  SitePermissionPolicy,
  ScreenshotCapture,
  ScreenshotRequest,
  TargetCloseReason,
  TargetSnapshot,
  UploadRequest,
  WaitOutcome,
  WaitRequest,
} from '@emperor/core/host-capabilities'
import { UiError } from '@emperor/core/host-capabilities'
import type {
  DownloadRecord,
  DriverCapability,
  UploadRecord,
  CredentialFillOutcome,
  UiAction,
  UiElement,
} from '@emperor/core/runtime-contract'
import {
  BrowserSessionManager,
  type AgentTab,
  type ElectronFactory,
} from './browser-session-manager'
import { IsolatedWorlds } from './cdp/isolated'
import { DownloadInbox } from './download-inbox'
import type { CredentialVault } from './credential-vault'
import {
  assertTypable,
  clickTarget,
  fillTarget,
  pressKey,
  scrollIn,
  selectOption,
  strokeFor,
  typeText,
  type RendererPage,
} from './cdp/renderer-actions'
import { CdpSession, type DebuggerLike } from './cdp/session'
import {
  mapRole,
  takeSnapshot,
  type AxNode,
  type RefTarget,
} from './cdp/snapshot'

const KEPT_REVISIONS = 3
const SETTLE_MS = 150

export interface ImageCodec {
  /** PNG bytes → size, and a JPEG copy scaled so the long edge fits. */
  jpegCopy(
    png: Uint8Array,
    maxEdge: number,
  ): { jpeg: Uint8Array; width: number; height: number }
  size(png: Uint8Array): { width: number; height: number }
}

interface Stored {
  readonly all: readonly UiElement[]
  readonly title: string
  readonly url: string
  readonly viewport: { width: number; height: number; scale: number }
  readonly textExcerpt?: string
  readonly redactions: number
  readonly notes: readonly string[]
  readonly focus: boolean
}

interface Runtime {
  readonly tab: AgentTab
  cdp: CdpSession | null
  worlds: IsolatedWorlds | null
  mainFrameId: string | null
  /** Cross-origin (OOPIF) root frame id → CDP child session (E-B3). */
  readonly oopifs: Map<string, string>
  /** Every frame inside an OOPIF → its session (from the last snapshot). */
  frameSessions: ReadonlyMap<string, string>
  readonly refs: Map<number, Map<string, RefTarget>>
  readonly stored: Map<number, Stored>
  readonly notes: string[]
  inflight: number
  lastNetwork: number
  detached: boolean
  credentialVisible: boolean
}

export interface EmbeddedBrowserDriverOptions {
  readonly electron: ElectronFactory
  readonly images: ImageCodec
  readonly platform: DriverCapability['platform']
  /** `~/.emperor/browser/profiles` (persistent profiles). */
  readonly profilesRoot?: string
  /** `~/.emperor/browser/downloads` (download inbox). */
  readonly downloadsRoot?: string
  /** Main-only. The model and Core pass only a handle. */
  readonly credentials?: CredentialVault
  /** Stop renderer preview before a secret is inserted; resume on document navigation. */
  credentialVisibility?(targetId: string, visible: boolean): void
  /**
   * The host's own file dialog for uploads (the user picks; absolute paths
   * or null when cancelled). Absent: uploads are unavailable.
   */
  pickFiles?(request: {
    title: string
    multiple: boolean
    accept: string
  }): Promise<string[] | null>
  /** File sizes for the upload summary (tests inject a fake). */
  statFile?(path: string): Promise<{ size: number; isFile: boolean }>
}

export class EmbeddedBrowserDriver implements BrowserDriver {
  readonly driver = 'embedded-browser' as const
  readonly manager: BrowserSessionManager
  private policy: NavigationPolicy | null = null
  private permissions: SitePermissionPolicy | null = null
  private readonly listeners = new Set<DriverEventListener>()
  private readonly runtimes = new Map<string, Runtime>()
  readonly downloads: DownloadInbox | null

  constructor(private readonly options: EmbeddedBrowserDriverOptions) {
    this.downloads =
      options.downloadsRoot === undefined
        ? null
        : new DownloadInbox({
            root: options.downloadsRoot,
            indexPath: join(options.downloadsRoot, '.index.json'),
          })
    this.manager = new BrowserSessionManager({
      ...(this.downloads === null ? {} : { downloads: this.downloads }),
      electron: options.electron,
      policy: () => this.policy,
      sitePermission: () => this.permissions,
      emit: (event) => this.forward(event),
      ...(options.profilesRoot === undefined
        ? {}
        : { profilesRoot: options.profilesRoot }),
      onPopup: (opener, popup) => {
        this.runtimes.set(popup.targetId, this.newRuntime(popup))
        this.emit({
          type: 'popup-opened',
          targetId: opener.targetId,
          popup: this.snapshotOf(popup),
        })
      },
    })
  }

  capability(): DriverCapability {
    return {
      driver: 'embedded-browser',
      platform: this.options.platform,
      stage: 'experimental',
      label: '内置浏览器（基础）',
      enabled: true,
      available: true,
      actions: [
        'click',
        'fill',
        'typeText',
        'press',
        'select',
        'scroll',
        'navigate',
        'history',
      ],
      missing: [
        '跨源 iframe 内文本输入与接管',
        ...(this.options.credentials?.available ? [] : ['凭据代填']),
        '截图坐标操作（需要能看图的模型）',
      ],
    }
  }

  setNavigationPolicy(policy: NavigationPolicy): void {
    this.policy = policy
  }

  setSitePermissionPolicy(policy: SitePermissionPolicy): void {
    this.permissions = policy
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // listeners must not break the driver
      }
    }
  }

  private forward(event: DriverEvent): void {
    const runtime = this.runtimes.get(event.targetId)
    if (runtime !== undefined) {
      if (event.type === 'navigated' && !event.sameDocument) {
        runtime.worlds?.reset()
        runtime.credentialVisible = false
        this.options.credentialVisibility?.(event.targetId, false)
      }
      if (event.type === 'popup-blocked')
        runtime.notes.push(`a popup to ${event.url.slice(0, 200)} was blocked`)
      if (event.type === 'lost') this.dropRuntime(event.targetId)
    }
    this.emit(event)
  }

  // -------------------------------------------------------------------------

  snapshot(targetId: string): TargetSnapshot | null {
    const tab = this.manager.get(targetId)
    return tab === undefined ? null : this.snapshotOf(tab)
  }

  list(): TargetSnapshot[] {
    return this.manager.list().map((tab) => this.snapshotOf(tab))
  }

  private snapshotOf(tab: AgentTab): TargetSnapshot {
    const url = tab.contents.isDestroyed() ? '' : tab.contents.getURL()
    return {
      targetId: tab.targetId,
      kind: 'embedded-tab',
      driver: 'embedded-browser',
      generation: tab.generation,
      revision: tab.revision,
      url,
      title: tab.contents.isDestroyed()
        ? tab.title
        : tab.contents.getTitle() || tab.title,
      loading: tab.loading,
      profileId: tab.profileId,
    }
  }

  async open(
    request: {
      profile: BrowserProfileSpec
      url: string
      ownerSessionId: string
    },
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    const tab = await this.manager.open({
      ownerSessionId: request.ownerSessionId,
      url: request.url,
      ...(request.profile.kind === 'persistent'
        ? { profileId: request.profile.profileId }
        : {}),
      signal,
    })
    const runtime = this.newRuntime(tab)
    this.runtimes.set(tab.targetId, runtime)
    if (tab.lastError !== undefined)
      runtime.notes.push(`the page failed to load: ${tab.lastError}`)
    await this.connect(runtime)
    return this.snapshotOf(tab)
  }

  private newRuntime(tab: AgentTab): Runtime {
    return {
      tab,
      cdp: null,
      worlds: null,
      mainFrameId: null,
      oopifs: new Map(),
      frameSessions: new Map(),
      refs: new Map(),
      stored: new Map(),
      notes: [],
      inflight: 0,
      lastNetwork: Date.now(),
      detached: false,
      credentialVisible: false,
    }
  }

  async close(targetId: string, _reason: TargetCloseReason): Promise<void> {
    this.dropRuntime(targetId)
    await this.manager.close(targetId)
  }

  async download(
    request: DownloadRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<DownloadRecord> {
    const runtime = this.runtimeFor(request.targetId, request.generation)
    if (runtime.tab.paused)
      throw new UiError('TARGET_BUSY', 'the tab is paused', {
        reason: 'paused',
      })
    const inbox = this.downloads
    if (inbox === null)
      throw new UiError('CAPABILITY_DISABLED', 'downloads are not available')
    if (request.url !== undefined && !/^https?:\/\//i.test(request.url))
      throw new UiError(
        'INVALID_REQUEST',
        'only http(s) URLs can be downloaded',
      )
    const cdp = await this.connect(runtime)
    this.manager.touch(runtime.tab.targetId)
    return await inbox.receive(
      runtime.tab.targetId,
      {
        taskId: request.taskId,
        ...(request.ownerSessionId === undefined
          ? {}
          : { ownerSessionId: request.ownerSessionId }),
        maxBytes: request.maxBytes,
        timeoutMs: request.timeoutMs,
      },
      async () => {
        if (request.ref !== undefined) {
          await this.click(
            runtime,
            cdp,
            { kind: 'click', ref: request.ref },
            request.expectedRevision,
            hooks,
            signal,
          )
          return
        }
        hooks.dispatched()
        runtime.tab.contents.downloadURL(request.url!)
      },
      signal,
    )
  }

  async upload(
    request: UploadRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<UploadRecord> {
    const runtime = this.runtimeFor(request.targetId, request.generation)
    if (runtime.tab.paused)
      throw new UiError('TARGET_BUSY', 'the tab is paused', {
        reason: 'paused',
      })
    const pick = this.options.pickFiles
    if (pick === undefined)
      throw new UiError('CAPABILITY_DISABLED', 'uploads are not available')
    const cdp = await this.connect(runtime)
    const target = this.resolve(runtime, request.ref, request.expectedRevision)
    const input = await runtime.worlds!.callOnElement<{
      isFile: boolean
      multiple: boolean
      accept: string
      disabled: boolean
    }>(target.frameId, target.backendNodeId, 'fileInputState', [], signal)
    if (!input.isFile)
      throw new UiError('INVALID_REQUEST', `${request.ref} is not a file input`)
    if (input.disabled)
      throw new UiError('INVALID_REQUEST', `${request.ref} is disabled`)
    const picked = await pick({
      title: `选择要上传到 ${request.origin ?? '网页'} 的文件`,
      multiple: input.multiple,
      accept: input.accept,
    })
    if (picked === null || picked.length === 0)
      return { state: 'cancelled', files: [], bytes: 0 }
    const files = picked.slice(0, input.multiple ? 20 : 1)
    const stat =
      this.options.statFile ??
      (async (path: string) => {
        const info = await fsStat(path)
        return { size: info.size, isFile: info.isFile() }
      })
    let bytes = 0
    for (const file of files) {
      const info = await stat(file)
      if (!info.isFile)
        throw new UiError('INVALID_REQUEST', 'only files can be uploaded')
      bytes += info.size
    }
    if (this.runtimes.get(request.targetId) !== runtime || runtime.tab.closed)
      throw new UiError(
        'STALE_TARGET',
        'the tab closed while the file dialog was open',
      )
    hooks.dispatched()
    await cdp.send(
      'DOM.setFileInputFiles',
      { files, backendNodeId: target.backendNodeId },
      { signal },
    )
    return {
      state: 'attached',
      files: files.map((file) => basename(file)),
      bytes,
    }
  }

  async fillCredential(
    request: CredentialFillRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<CredentialFillOutcome> {
    const vault = this.options.credentials
    if (!vault?.available)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'the credential vault is unavailable',
      )
    if (vault.locked)
      throw new UiError(
        'PERMISSION_REQUIRED',
        'the credential vault is locked',
        { reason: 'vault-locked' },
      )
    const runtime = this.runtimeFor(request.targetId, request.generation)
    if (runtime.tab.paused)
      throw new UiError('TARGET_BUSY', 'the tab is paused', {
        reason: 'paused',
      })
    const target = this.resolve(runtime, request.ref, request.expectedRevision)
    assertTypable(target)
    const liveOrigin = (): string | null => {
      try {
        return new URL(runtime.tab.contents.getURL()).origin
      } catch {
        return null
      }
    }
    if (liveOrigin() !== request.origin)
      throw new UiError('PERMISSION_DENIED', 'credential binding mismatch', {
        reason: 'credential-binding-mismatch',
      })
    const cdp = await this.connect(runtime)
    const frame = await runtime.worlds!.callInFrame<{ url: string }>(
      target.frameId,
      'documentState',
      [],
      signal,
    )
    if (new URL(frame.url).origin !== request.origin)
      throw new UiError(
        'PERMISSION_DENIED',
        'credential frame binding mismatch',
        { reason: 'credential-binding-mismatch' },
      )
    const state = await runtime.worlds!.callOnElement<{
      tag: string
      type: string
      autocomplete: string
      editable: boolean
      disabled: boolean
      readOnly: boolean
      hasValue: boolean
    }>(target.frameId, target.backendNodeId, 'fieldState', [], signal)
    const matching =
      state.tag === 'input' &&
      (request.field === 'password'
        ? state.type === 'password'
        : request.field === 'username'
          ? ['', 'text', 'email'].includes(state.type)
          : ['', 'text', 'tel', 'number'].includes(state.type))
    if (!matching || !state.editable || state.disabled || state.readOnly)
      throw new UiError(
        'INVALID_REQUEST',
        'credential field type does not match the saved field',
      )
    await runtime.worlds!.callOnElement(
      target.frameId,
      target.backendNodeId,
      'focusAndSelectAll',
      [],
      signal,
    )
    // Recheck after the async focus; a page can navigate between observation
    // and dispatch. No secret is decrypted before all checks pass.
    this.resolve(runtime, request.ref, request.expectedRevision)
    if (liveOrigin() !== request.origin)
      throw new UiError('PERMISSION_DENIED', 'credential binding mismatch', {
        reason: 'credential-binding-mismatch',
      })
    const focusedFrame = await runtime.worlds!.callInFrame<{ url: string }>(
      target.frameId,
      'documentState',
      [],
      signal,
    )
    if (new URL(focusedFrame.url).origin !== request.origin)
      throw new UiError(
        'PERMISSION_DENIED',
        'credential frame binding mismatch',
        { reason: 'credential-binding-mismatch' },
      )
    this.resolve(runtime, request.ref, request.expectedRevision)
    const secret = vault.secret(request.handleId, request.field, request.origin)
    // Page script can turn even a password field into visible text. Mark the
    // document sensitive before dispatch; an uncertain insertion stays hidden.
    runtime.credentialVisible = true
    this.options.credentialVisibility?.(request.targetId, true)
    hooks.dispatched()
    try {
      await cdp.send('Input.insertText', { text: secret }, { signal })
    } catch {
      // CDP errors can contain command params. Never attach their cause.
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'credential fill failed; check the field before retrying',
      )
    }
    const after = await runtime.worlds!.callOnElement<{ hasValue: boolean }>(
      target.frameId,
      target.backendNodeId,
      'fieldState',
      [],
      signal,
    )
    this.manager.touch(runtime.tab.targetId)
    return { filled: after.hasValue, bindingMatched: request.origin }
  }

  async clearProfile(
    profileId: string,
    options: { readonly remove: boolean },
  ): Promise<void> {
    for (const tab of this.manager.list())
      if (tab.profileId === profileId) this.dropRuntime(tab.targetId)
    await this.manager.clearProfile(profileId, { remove: options.remove })
  }

  /** The main window closed: end every Agent tab, keep the driver usable. */
  async closeAll(): Promise<void> {
    for (const targetId of [...this.runtimes.keys()]) this.dropRuntime(targetId)
    await this.manager.closeAll()
  }

  async shutdown(): Promise<void> {
    for (const targetId of [...this.runtimes.keys()]) this.dropRuntime(targetId)
    await this.manager.shutdown()
  }

  setPaused(targetId: string, paused: boolean): void {
    this.manager.setPaused(targetId, paused)
  }

  historyTarget(
    targetId: string,
    direction: 'back' | 'forward' | 'reload',
  ): string | null {
    return this.manager.historyTarget(targetId, direction)
  }

  private dropRuntime(targetId: string): void {
    const runtime = this.runtimes.get(targetId)
    if (runtime === undefined) return
    this.runtimes.delete(targetId)
    this.options.credentialVisibility?.(targetId, false)
    runtime.cdp?.detach()
    runtime.cdp = null
  }

  /** Attach CDP and enable the domains the driver uses. */
  private async connect(runtime: Runtime): Promise<CdpSession> {
    if (runtime.cdp?.attached === true) return runtime.cdp
    const tab = runtime.tab
    if (tab.contents.isDestroyed())
      throw new UiError('STALE_TARGET', 'the tab is gone')
    if (runtime.detached) {
      // Re-attaching after DevTools or a detach: old refs no longer apply.
      tab.generation += 1
      tab.revision += 1
      runtime.refs.clear()
      runtime.stored.clear()
    }
    const cdp = new CdpSession(
      tab.contents.debugger as unknown as DebuggerLike,
      (reason) => {
        runtime.detached = true
        runtime.cdp = null
        this.emit({ type: 'detached', targetId: tab.targetId, reason })
      },
    )
    cdp.attach()
    runtime.detached = false
    runtime.cdp = cdp
    runtime.oopifs.clear()
    runtime.frameSessions = new Map()
    runtime.worlds = new IsolatedWorlds(
      cdp,
      (frameId) =>
        runtime.oopifs.get(frameId) ?? runtime.frameSessions.get(frameId),
    )
    cdp.subscribe((method, params, sessionId) =>
      this.onCdpEvent(runtime, method, params, sessionId),
    )
    await cdp.send('Page.enable')
    await cdp.send('DOM.enable')
    await cdp.send('Accessibility.enable')
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    // Cross-origin iframes run in other processes: attach to each as a child
    // session (flatten) so they can be observed and clicked (E-B3).
    await cdp
      .send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => undefined)
    const { frameTree } = await cdp.send<{
      frameTree: { frame: { id: string } }
    }>('Page.getFrameTree')
    runtime.mainFrameId = frameTree.frame.id
    return cdp
  }

  /** Enable the domains a cross-origin frame's child session needs. */
  private attachFrame(runtime: Runtime, sessionId: string): void {
    const cdp = runtime.cdp
    if (cdp === null) return
    const send = (method: string, params: object = {}) =>
      cdp
        .send(method, params, { sessionId, timeoutMs: 5_000 })
        .catch(() => undefined)
    void Promise.all([
      send('Page.enable'),
      send('DOM.enable'),
      send('Accessibility.enable'),
      send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }),
    ])
  }

  private onCdpEvent(
    runtime: Runtime,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const child = sessionId !== undefined && sessionId !== ''
    switch (method) {
      case 'Target.attachedToTarget': {
        const info = params.targetInfo as
          { targetId?: string; type?: string } | undefined
        const attached =
          typeof params.sessionId === 'string' ? params.sessionId : undefined
        if (
          info?.type === 'iframe' &&
          info.targetId !== undefined &&
          attached !== undefined
        ) {
          runtime.oopifs.set(info.targetId, attached)
          this.attachFrame(runtime, attached)
        }
        return
      }
      case 'Target.detachedFromTarget': {
        const detached = params.sessionId
        for (const [frameId, session] of runtime.oopifs)
          if (session === detached) runtime.oopifs.delete(frameId)
        return
      }
      default:
        break
    }
    if (child && method === 'Page.javascriptDialogOpening') {
      runtime.notes.push(
        `a frame showed a ${String(params.type ?? 'alert')} dialog; it was dismissed`,
      )
      void runtime.cdp
        ?.send(
          'Page.handleJavaScriptDialog',
          { accept: params.type === 'alert' },
          { sessionId },
        )
        .catch(() => undefined)
      return
    }
    if (child) return
    switch (method) {
      case 'Network.requestWillBeSent':
        runtime.inflight += 1
        runtime.lastNetwork = Date.now()
        break
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        runtime.inflight = Math.max(0, runtime.inflight - 1)
        runtime.lastNetwork = Date.now()
        break
      case 'Page.frameNavigated': {
        const frame = params.frame as
          { id?: string; parentId?: string } | undefined
        if (frame?.parentId === undefined && frame?.id !== undefined) {
          runtime.mainFrameId = frame.id
          runtime.inflight = 0
        }
        break
      }
      case 'Page.javascriptDialogOpening': {
        const type = String(params.type ?? 'alert')
        const message = String(params.message ?? '').slice(0, 200)
        runtime.notes.push(
          `the page showed a ${type} dialog (${JSON.stringify(message)}); it was ${type === 'alert' || type === 'beforeunload' ? 'accepted' : 'dismissed'}`,
        )
        void runtime.cdp
          ?.send('Page.handleJavaScriptDialog', {
            accept: type === 'alert' || type === 'beforeunload',
          })
          .catch(() => undefined)
        break
      }
      default:
        break
    }
  }

  private runtimeFor(targetId: string, generation?: number): Runtime {
    const runtime = this.runtimes.get(targetId)
    const tab = this.manager.get(targetId)
    if (runtime === undefined || tab === undefined)
      throw new UiError('STALE_TARGET', `target ${targetId} is gone`)
    if (generation !== undefined && generation !== tab.generation)
      throw new UiError(
        'STALE_TARGET',
        'the page navigated since the request was made',
      )
    return runtime
  }

  // -------------------------------------------------------------------------
  // Observation

  async observe(
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<DriverObservation> {
    const runtime = this.runtimeFor(request.targetId, request.generation)
    const tab = runtime.tab
    const cdp = await this.connect(runtime)
    this.manager.touch(tab.targetId)
    let revision: number
    let stored: Stored
    let offset = 0
    if (request.cursor !== undefined) {
      const match = /^c(\d+):(\d+)$/.exec(request.cursor)
      const kept =
        match === null ? undefined : runtime.stored.get(Number(match[1]))
      if (
        match === null ||
        kept === undefined ||
        Number(match[1]) !== tab.revision
      )
        throw new UiError(
          'STALE_TARGET',
          'the cursor belongs to an older revision; observe again',
        )
      revision = Number(match[1])
      offset = Number(match[2])
      stored = kept
    } else {
      tab.revision += 1
      revision = tab.revision
      const result = await takeSnapshot(cdp, runtime.worlds!, {
        revision,
        maxElements: request.budget.maxElements,
        maxTextBytes: request.budget.maxTextBytes,
        maxDepth: request.budget.maxDepth,
        timeoutMs: request.budget.timeoutMs,
        includeText: request.includeText,
        ...(request.query === undefined ? {} : { query: request.query }),
        oopifs: runtime.oopifs,
        maskValues: runtime.credentialVisible,
        signal,
      })
      runtime.frameSessions = result.frameSessions
      stored = {
        all: result.all,
        title: result.title,
        url: result.url,
        viewport: result.viewport,
        ...(result.textExcerpt === undefined
          ? {}
          : { textExcerpt: result.textExcerpt }),
        redactions: result.redactions,
        notes: runtime.credentialVisible
          ? [
              ...result.notes,
              'field values stay hidden after a credential fill until the page navigates',
            ]
          : result.notes,
        focus: result.focus,
      }
      runtime.refs.set(revision, new Map(result.refs))
      runtime.stored.set(revision, stored)
      for (const old of [...runtime.refs.keys()])
        if (old <= revision - KEPT_REVISIONS) {
          runtime.refs.delete(old)
          runtime.stored.delete(old)
        }
    }
    let elements = stored.all.slice(offset, offset + request.budget.maxElements)
    const truncated = offset + request.budget.maxElements < stored.all.length
    const notes = [...stored.notes, ...runtime.notes.splice(0)]
    let diffFrom: number | undefined
    let removed: string[] | undefined
    if (request.diffFrom !== undefined && request.cursor === undefined) {
      const base = runtime.stored.get(request.diffFrom)
      const baseRefs = runtime.refs.get(request.diffFrom)
      const currentRefs = runtime.refs.get(revision)
      if (
        base === undefined ||
        baseRefs === undefined ||
        currentRefs === undefined
      ) {
        notes.push('diff base no longer kept; full snapshot returned')
      } else {
        diffFrom = request.diffFrom
        const signature = (
          element: UiElement,
          refs: ReadonlyMap<string, RefTarget>,
        ): string =>
          `${refs.get(element.ref)?.backendNodeId}|${element.role}|${element.name ?? ''}|${element.value ?? ''}|${(element.states ?? []).join(',')}`
        const before = new Map(
          base.all.map((element) => [
            baseRefs.get(element.ref)?.backendNodeId,
            signature(element, baseRefs),
          ]),
        )
        const now = new Set(
          stored.all.map(
            (element) => currentRefs.get(element.ref)?.backendNodeId,
          ),
        )
        elements = elements.filter(
          (element) =>
            before.get(currentRefs.get(element.ref)?.backendNodeId) !==
            signature(element, currentRefs),
        )
        removed = base.all
          .filter(
            (element) => !now.has(baseRefs.get(element.ref)?.backendNodeId),
          )
          .map((element) => element.ref)
      }
    }
    return {
      generation: tab.generation,
      revision,
      title: stored.title,
      urlOrApp: stored.url,
      focus: stored.focus,
      frameOrWindowId: runtime.mainFrameId ?? 'main',
      viewport: stored.viewport,
      elements,
      ...(removed === undefined ? {} : { removed }),
      ...(offset === 0 && stored.textExcerpt !== undefined
        ? { textExcerpt: stored.textExcerpt }
        : {}),
      ...(diffFrom === undefined ? {} : { diffFrom }),
      truncated,
      ...(truncated
        ? { cursor: `c${revision}:${offset + request.budget.maxElements}` }
        : {}),
      redactions: stored.redactions,
      ...(notes.length === 0 ? {} : { notes: [...new Set(notes)] }),
    }
  }

  async screenshot(
    request: ScreenshotRequest,
    signal: AbortSignal,
  ): Promise<ScreenshotCapture> {
    const runtime = this.runtimeFor(request.targetId, request.generation)
    if (runtime.credentialVisible)
      throw new UiError(
        'CAPABILITY_DISABLED',
        'screenshots are paused after credential fill until navigation',
        {
          reason: 'credential-visible',
        },
      )
    const cdp = await this.connect(runtime)
    this.manager.touch(runtime.tab.targetId)
    const shot = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      { signal, timeoutMs: 15_000 },
    )
    const png = Uint8Array.from(Buffer.from(shot.data, 'base64'))
    const size = this.options.images.size(png)
    const stored = runtime.stored.get(runtime.tab.revision)
    const cssWidth = stored?.viewport.width || size.width
    return {
      screenshotId: `shot_${randomUUID().slice(0, 12)}`,
      generation: runtime.tab.generation,
      revision: runtime.tab.revision,
      png,
      width: size.width,
      height: size.height,
      scale: cssWidth > 0 ? size.width / cssWidth : 1,
      ...(request.modelCopy
        ? { model: this.options.images.jpegCopy(png, request.modelMaxEdge) }
        : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Actions

  private resolve(
    runtime: Runtime,
    ref: string,
    expectedRevision: number,
  ): RefTarget {
    const revision = Number(/^r(\d+)\./.exec(ref)?.[1] ?? -1)
    if (
      revision !== runtime.tab.revision ||
      expectedRevision !== runtime.tab.revision
    )
      throw new UiError(
        'STALE_ELEMENT',
        `${ref} is from revision ${revision}; the current revision is ${runtime.tab.revision}`,
      )
    const target = runtime.refs.get(revision)?.get(ref)
    if (target === undefined)
      throw new UiError(
        'STALE_ELEMENT',
        `${ref} is not in the last observation`,
      )
    return target
  }

  async act(
    request: ActRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<ActOutcome> {
    const runtime = this.runtimeFor(request.targetId, request.generation)
    if (runtime.tab.paused)
      throw new UiError('TARGET_BUSY', 'the tab is paused', {
        reason: 'paused',
      })
    const cdp = await this.connect(runtime)
    this.manager.touch(runtime.tab.targetId)
    const action = request.action
    switch (action.kind) {
      case 'click':
        return await this.click(
          runtime,
          cdp,
          action,
          request.expectedRevision,
          hooks,
          signal,
        )
      case 'fill': {
        const target = this.resolve(
          runtime,
          action.ref,
          request.expectedRevision,
        )
        const { changes, warnings } = await fillTarget(
          this.page(runtime, cdp),
          target,
          action.ref,
          action.text,
          hooks,
          signal,
        )
        return this.outcome(runtime, changes, warnings)
      }
      case 'typeText': {
        const target =
          action.ref === undefined
            ? undefined
            : this.resolve(runtime, action.ref, request.expectedRevision)
        return this.outcome(
          runtime,
          await typeText(
            this.page(runtime, cdp),
            target,
            action.text,
            hooks,
            signal,
          ),
        )
      }
      case 'press': {
        const stroke = strokeFor(action.key)
        const target =
          action.ref === undefined
            ? undefined
            : this.resolve(runtime, action.ref, request.expectedRevision)
        return this.outcome(
          runtime,
          await pressKey(
            this.page(runtime, cdp),
            target,
            stroke,
            action.key,
            hooks,
            signal,
          ),
        )
      }
      case 'select': {
        const target = this.resolve(
          runtime,
          action.ref,
          request.expectedRevision,
        )
        return this.outcome(
          runtime,
          await selectOption(
            this.page(runtime, cdp),
            target,
            action.ref,
            action.option,
            hooks,
            signal,
          ),
        )
      }
      case 'scroll': {
        const target =
          action.ref === undefined
            ? undefined
            : this.resolve(runtime, action.ref, request.expectedRevision)
        const moved = await scrollIn(
          this.page(runtime, cdp),
          target,
          action,
          hooks,
          signal,
        )
        return moved
          ? this.outcome(runtime, [`scrolled ${action.direction}`])
          : {
              outcome: 'no-effect',
              afterRevision: runtime.tab.revision,
              warnings: ['nothing scrolled (already at the edge?)'],
            }
      }
      case 'navigate': {
        hooks.dispatched()
        await this.manager
          .navigate(runtime.tab.targetId, action.url, signal)
          .catch((error: unknown) => {
            if (
              error instanceof UiError &&
              error.code === 'PERMISSION_REQUIRED'
            )
              throw error
            runtime.notes.push(
              `the page failed to load: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
        return this.outcome(
          runtime,
          [`navigated to ${action.url.slice(0, 200)}`],
          [],
          0,
        )
      }
      case 'history': {
        const destination = this.manager.historyTarget(
          runtime.tab.targetId,
          action.direction,
        )
        if (destination === null)
          return {
            outcome: 'no-effect',
            afterRevision: runtime.tab.revision,
            warnings: [`nothing to go ${action.direction} to`],
          }
        hooks.dispatched()
        await this.manager.history(runtime.tab.targetId, action.direction)
        await this.waitForLoad(runtime, signal)
        return this.outcome(
          runtime,
          [`${action.direction} → ${destination.slice(0, 200)}`],
          [],
          0,
        )
      }
      default:
        throw new UiError(
          'CAPABILITY_DISABLED',
          `${action.kind} is not available in the built-in browser yet`,
        )
    }
  }

  private async click(
    runtime: Runtime,
    cdp: CdpSession,
    action: Extract<UiAction, { kind: 'click' }>,
    expectedRevision: number,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<ActOutcome> {
    const target = this.resolve(runtime, action.ref, expectedRevision)
    const changes = await clickTarget(
      this.page(runtime, cdp),
      target,
      action.ref,
      {
        ...(action.button === undefined ? {} : { button: action.button }),
        ...(action.count === undefined ? {} : { count: action.count }),
      },
      hooks,
      signal,
    )
    return this.outcome(runtime, changes)
  }

  /** The tab's page as the shared renderer actions see it. */
  private page(runtime: Runtime, cdp: CdpSession): RendererPage {
    return {
      cdp,
      worlds: runtime.worlds!,
      mainFrameId: runtime.mainFrameId,
      crossOriginFrames: runtime.oopifs.size > 0,
    }
  }

  private async outcome(
    runtime: Runtime,
    changes: string[],
    warnings: string[] = [],
    settleMs = SETTLE_MS,
  ): Promise<ActOutcome> {
    if (settleMs > 0)
      await new Promise((resolve) => setTimeout(resolve, settleMs))
    const tab = runtime.tab
    return {
      outcome: 'observed',
      afterRevision: tab.revision,
      ...(tab.contents.isDestroyed()
        ? {}
        : { url: tab.contents.getURL(), title: tab.contents.getTitle() }),
      changes,
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  private async waitForLoad(
    runtime: Runtime,
    signal: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    await new Promise((resolve) => setTimeout(resolve, 50))
    while (runtime.tab.loading && Date.now() < deadline && !signal.aborted)
      await new Promise((resolve) => setTimeout(resolve, 50))
  }

  // -------------------------------------------------------------------------
  // Waits

  async wait(request: WaitRequest, signal: AbortSignal): Promise<WaitOutcome> {
    const runtime = this.runtimeFor(request.targetId)
    const tab = runtime.tab
    const deadline = Date.now() + request.timeoutMs
    const condition = request.condition
    this.manager.touch(tab.targetId)
    for (;;) {
      if (signal.aborted) throw new UiError('TIMEOUT_NO_EFFECT', 'aborted')
      if (this.manager.get(tab.targetId) === undefined)
        throw new UiError('STALE_TARGET', 'the tab closed while waiting')
      let satisfied = false
      try {
        satisfied = await this.check(runtime, request, signal)
      } catch (error) {
        if (error instanceof UiError && error.code !== 'DRIVER_UNAVAILABLE')
          throw error
      }
      if (satisfied)
        return {
          satisfied: true,
          revision: tab.revision,
          url: tab.contents.getURL(),
        }
      if (Date.now() >= deadline)
        return {
          satisfied: false,
          revision: tab.revision,
          url: tab.contents.getURL(),
          detail: `${condition.kind} condition not met within ${request.timeoutMs}ms`,
        }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  private async check(
    runtime: Runtime,
    request: WaitRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    const condition = request.condition
    const tab = runtime.tab
    switch (condition.kind) {
      case 'navigation':
        return (
          tab.generation !== request.generation &&
          !tab.loading &&
          (condition.urlMatches === undefined ||
            tab.contents.getURL().includes(condition.urlMatches))
        )
      case 'idle':
        return (
          !tab.loading &&
          runtime.inflight === 0 &&
          Date.now() - runtime.lastNetwork >= condition.quietMs
        )
      case 'text': {
        if (tab.loading) return false
        await this.connect(runtime)
        return (
          (await runtime.worlds!.callInFrame<boolean>(
            runtime.mainFrameId ?? '',
            'hasText',
            [condition.contains],
            signal,
          )) === true
        )
      }
      case 'element': {
        const cdp = await this.connect(runtime)
        const { nodes } = await cdp.send<{ nodes: AxNode[] }>(
          'Accessibility.getFullAXTree',
          {},
          { signal },
        )
        const needle = condition.name?.toLowerCase()
        const found = nodes.find((node) => {
          if (node.ignored) return false
          const props = new Map<string, unknown>()
          for (const prop of node.properties ?? [])
            props.set(prop.name, prop.value?.value)
          const role = mapRole(String(node.role?.value ?? ''), props)
          const name = String(node.name?.value ?? '').toLowerCase()
          return (
            (condition.role === undefined || role === condition.role) &&
            (needle === undefined || name.includes(needle))
          )
        })
        if (condition.state === 'absent') return found === undefined
        if (found === undefined) return false
        if (condition.state === 'enabled')
          return !(found.properties ?? []).some(
            (prop) => prop.name === 'disabled' && prop.value?.value === true,
          )
        return true
      }
      case 'window':
        throw new UiError(
          'INVALID_REQUEST',
          'window conditions apply to desktop targets only',
        )
    }
  }
}
