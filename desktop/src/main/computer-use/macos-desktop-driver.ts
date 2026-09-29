/** macOS desktop driver. The helper owns all TCC, AX and physical input access. */
import { execFile as nodeExecFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import type {
  ActHooks,
  ActOutcome,
  ActRequest,
  DesktopAppInfo,
  DesktopCredentialFillRequest,
  DesktopMenuListing,
  DesktopWindowInfo,
  DriverEventListener,
  DriverObservation,
  NativeDesktopDriver,
  ObserveRequest,
  ScreenshotCapture,
  ScreenshotRequest,
  TargetCloseReason,
  TargetSnapshot,
  WaitOutcome,
  WaitRequest,
} from '@emperor/core/host-capabilities'
import {
  looksSensitive,
  maskedValue,
  UiError,
} from '@emperor/core/host-capabilities'
import type {
  CredentialFillOutcome,
  DriverCapability,
  PermissionStatus,
} from '@emperor/core/runtime-contract'
import { protectedMacApp } from '../../../../packages/core/src/harness/computer-use/protected-apps'
import {
  UI_ROLES,
  type UiRole,
} from '../../../../packages/core/src/harness/computer-use/types'
import type { DesktopPreviewFrame } from './desktop-preview'
import type { DesktopPointer, PointerSignal } from './pointer-overlay-view'
import type {
  MacHelperPermission,
  MacHelperStatus,
} from '../../shared/ipc-contract'
import type { HelperClient } from './helper-client'
import type { CredentialVault } from './credential-vault'

const uiRoles = new Set<string>(UI_ROLES)
const execFile = promisify(nodeExecFile)
const HELPER_BUNDLE_ID = 'com.emperor.agent.desktop.computer-helper'

function normalizedRole(role: string): UiRole {
  return uiRoles.has(role) ? (role as UiRole) : 'other'
}

const TEXT_ROLES: ReadonlySet<UiRole> = new Set(['textbox', 'searchbox'])

/** 00 §12: at most three automatic restarts per rolling minute. */
const RESTART_WINDOW_MS = 60_000
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000] as const
/** Settings › 诊断 shows these; the Helper stays off until the user reconnects. */
export const HELPER_CRASH_LATCH_REASON =
  'Helper 在一分钟内崩溃超过 3 次，已停止自动重启'
export const HELPER_LAUNCH_LATCH_REASON =
  'Helper 在一分钟内启动失败超过 3 次，已停止自动重启'
const HELPER_RESTARTING_REASON = 'Helper 已断开，正在按退避策略重启'
const HELPER_OFFLINE_REASON = '无法连接 Emperor Computer Helper'

/** Timers for restart backoff. Injected by tests. */
export interface HelperClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: HelperClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The outermost `.app` bundle containing a path, or null. */
function appBundleOf(path: string): string | null {
  return /^(.*?\.app)(?:\/|$)/i.exec(path)?.[1] ?? null
}

/**
 * Executable paths of running processes by pid (`ps` prints the exec path
 * for the user's own processes). Unknown or exited pids are left out.
 */
async function psExecutablePaths(
  pids: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  if (pids.length === 0) return new Map()
  let stdout = ''
  try {
    ;({ stdout } = await execFile(
      '/bin/ps',
      ['-ww', '-o', 'pid=,comm=', '-p', pids.join(',')],
      { timeout: 3_000, encoding: 'utf8', maxBuffer: 1 << 20 },
    ))
  } catch (error) {
    // ps exits non-zero when a listed pid is gone; keep the rows it printed.
    const partial = (error as { stdout?: unknown }).stdout
    stdout = typeof partial === 'string' ? partial : ''
  }
  const paths = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\/.+)$/.exec(line)
    if (match) paths.set(Number(match[1]), match[2]!)
  }
  return paths
}

export interface MacosDesktopDriverOptions {
  connect(): Promise<HelperClient>
  previewBuild?: Promise<boolean>
  resetTcc?: (file: string, args: readonly string[]) => Promise<void>
  credentials?: Pick<
    CredentialVault,
    'available' | 'locked' | 'list' | 'secret'
  >
  /** Restart backoff clock. Defaults to real timers. */
  clock?: HelperClock
  /**
   * Emperor itself (00 §6.5). Defaults to this main process: `process.pid`
   * and the `.app` bundle containing `process.execPath`.
   */
  self?: { readonly pid: number; readonly executablePath: string }
  /** Executable path of each listed pid. Defaults to `ps`. */
  processPaths?: (
    pids: readonly number[],
  ) => Promise<ReadonlyMap<number, string>>
  /** The on-screen virtual pointer: where each action lands. */
  pointer?(signal: PointerSignal): void
}

/**
 * Actions that may hit-test and click through the real pointer path: the
 * virtual pointer steps aside while the helper checks the point.
 */
const POINTER_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'clickPoint',
  'drag',
  'scroll',
])

type ListedWindow = { readonly appId: string; readonly refused: boolean }

export class MacosDesktopDriver implements NativeDesktopDriver {
  readonly driver = 'desktop' as const
  private clientPromise: Promise<HelperClient> | null = null
  private client: HelperClient | null = null
  private latestPermissions: Readonly<Record<string, PermissionStatus>> | null =
    null
  private readonly targets = new Map<string, TargetSnapshot>()
  private readonly paused = new Set<string>()
  private readonly sensitive = new Set<string>()
  private readonly listeners = new Set<DriverEventListener>()
  /** Requests awaiting a reply, per connection; a drop with work is a crash. */
  private readonly busy = new WeakMap<HelperClient, number>()
  /** Crashes and failed launches in the last minute. */
  private readonly failures: { at: number; kind: 'crash' | 'launch' }[] = []
  /** Set once restarts are exhausted; only an explicit user action clears it. */
  private latched: string | null = null
  private pendingWait: { handle: unknown; wake(): void } | null = null
  /** Bumped by reconnect, reset and shutdown; stale launches are discarded. */
  private epoch = 0
  private stopped = false
  /** The helper's current windowRef table, mirrored from the last listing. */
  private readonly listedWindows = new Map<string, ListedWindow>()
  private readonly clock: HelperClock
  private readonly selfPid: number
  private readonly selfRoots: readonly string[]

  constructor(private readonly options: MacosDesktopDriverOptions) {
    this.clock = options.clock ?? systemClock
    const executable = options.self?.executablePath ?? process.execPath
    this.selfPid = options.self?.pid ?? process.pid
    const paths = new Set([executable])
    try {
      paths.add(realpathSync(executable))
    } catch {
      /* the given path alone */
    }
    this.selfRoots = [...paths].map((path) =>
      (appBundleOf(path) ?? path).toLowerCase(),
    )
  }

  capability(): DriverCapability {
    const diagnostics = this.client?.diagnostics()
    const permissions = this.latestPermissions ?? diagnostics?.permissions
    const accessibility = permissions?.accessibility ?? 'unknown'
    const screenRecording = permissions?.['screen-recording'] ?? 'unknown'
    const available =
      diagnostics?.connected === true && accessibility === 'granted'
    return {
      driver: 'desktop',
      platform: 'macos',
      stage: 'experimental',
      label: 'macOS 桌面（实验）',
      enabled: true,
      available,
      actions: available
        ? [
            'click',
            'clickPoint',
            'fill',
            'typeText',
            'press',
            'select',
            'scroll',
            'drag',
            'secondary',
            'menu',
            'activate',
          ]
        : [],
      missing: [
        ...(accessibility === 'granted' ? [] : ['辅助功能权限']),
        ...(screenRecording === 'granted' ? [] : ['屏幕录制权限']),
        '自动用户活动检测（请用接管或急停）',
        '真实动作矩阵与桌面凭据验收',
      ],
      permissions: { accessibility, 'screen-recording': screenRecording },
      ...(!available
        ? {
            reason:
              this.latched ??
              (this.pendingWait
                ? HELPER_RESTARTING_REASON
                : '请在电脑操作设置中连接 helper 并授予辅助功能权限'),
          }
        : {}),
    }
  }

  private async connection(): Promise<HelperClient> {
    if (this.stopped)
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'Computer Use helper is shut down',
      )
    if (this.latched !== null)
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'Computer Use helper failed repeatedly; the user must reconnect it in Settings',
      )
    this.clientPromise ??= this.launch(false)
    return await this.clientPromise
  }

  /** Runs one helper call and counts it as in flight on that connection. */
  private async use<T>(run: (client: HelperClient) => Promise<T>): Promise<T> {
    const client = await this.connection()
    this.busy.set(client, (this.busy.get(client) ?? 0) + 1)
    try {
      return await run(client)
    } finally {
      this.busy.set(client, (this.busy.get(client) ?? 1) - 1)
    }
  }

  /**
   * Starts the helper, after the backoff that the recent failures call for.
   * `automatic` is a crash restart that no caller is waiting on (00 §12).
   */
  private launch(automatic: boolean): Promise<HelperClient> {
    const epoch = this.epoch
    const attempt = (async () => {
      const wait = this.backoffRemaining()
      if (wait > 0) await this.sleep(wait)
      if (epoch !== this.epoch)
        throw new UiError('DRIVER_UNAVAILABLE', 'Helper launch was superseded')
      let client: HelperClient
      try {
        // Yield first: a synchronous throw must not settle before the
        // caller stores this attempt as the pending connection.
        client = await Promise.resolve().then(() => this.options.connect())
      } catch (error) {
        // Within one epoch no other launch can start while this one runs.
        if (epoch === this.epoch) {
          this.clientPromise = null
          this.recordFailure('launch', automatic)
        }
        throw error
      }
      if (epoch !== this.epoch) {
        void client.close().catch(() => undefined)
        throw new UiError('DRIVER_UNAVAILABLE', 'Helper launch was superseded')
      }
      this.adopt(client)
      // A crashed helper cannot release what it held; ask the new one too.
      if (automatic)
        void client.releaseAll({ recovery: true }).catch(() => undefined)
      return client
    })()
    // An automatic restart has no caller to observe its failure.
    attempt.catch(() => undefined)
    return attempt
  }

  private adopt(client: HelperClient): void {
    this.client = client
    client.onEvent((event) => {
      if (event.name === 'target.changed') {
        const data = event.data as { targetId: string; revision: number }
        const current = this.targets.get(data.targetId)
        if (current)
          this.targets.set(data.targetId, {
            ...current,
            revision: data.revision,
          })
        this.emit({
          type: 'changed',
          targetId: data.targetId,
          revision: data.revision,
        })
      } else if (event.name === 'target.lost') {
        const data = event.data as { targetId: string; reason: string }
        this.targets.delete(data.targetId)
        this.sensitive.delete(data.targetId)
        this.emit({
          type: 'lost',
          targetId: data.targetId,
          reason: data.reason,
        })
      } else if (event.name === 'user.input') {
        const data = event.data as { targetId: string }
        this.emit({ type: 'user-input', targetId: data.targetId })
      } else if (event.name === 'target.capture.stopped') {
        // "Stop Sharing" in the menu bar is the user taking the window back.
        const data = event.data as { targetId: string; reason: string }
        if (data.reason === 'user')
          this.emit({ type: 'user-input', targetId: data.targetId })
      }
    })
    client.onDisconnected(() => this.disconnected(client))
    // It may have dropped between its handshake and this listener.
    if (!client.diagnostics().connected) this.disconnected(client)
  }

  /**
   * An intentional close detaches the client first, so only an unexpected
   * drop reaches the restart path. A drop with no target and no request in
   * flight (the helper's idle exit) restarts lazily on the next use.
   */
  private disconnected(client: HelperClient): void {
    if (client !== this.client) return
    const hadWork = this.targets.size > 0 || (this.busy.get(client) ?? 0) > 0
    this.detach('helper disconnected')
    if (hadWork && !this.stopped) this.recordFailure('crash', true)
  }

  private detach(reason: string): void {
    this.client = null
    this.clientPromise = null
    this.latestPermissions = null
    this.listedWindows.clear()
    for (const targetId of this.targets.keys())
      this.emit({ type: 'lost', targetId, reason })
    this.targets.clear()
    this.paused.clear()
    this.sensitive.clear()
  }

  private recentFailures(): { at: number; kind: 'crash' | 'launch' }[] {
    const now = this.clock.now()
    const recent = this.failures.filter((f) => now - f.at < RESTART_WINDOW_MS)
    this.failures.splice(0, this.failures.length, ...recent)
    return this.failures
  }

  private backoffRemaining(): number {
    const recent = this.recentFailures()
    const last = recent.at(-1)
    if (last === undefined) return 0
    const delay =
      RESTART_BACKOFF_MS[
        Math.min(recent.length, RESTART_BACKOFF_MS.length) - 1
      ]!
    return Math.max(0, last.at + delay - this.clock.now())
  }

  /**
   * Records a crash or failed launch. A fourth failure within a minute
   * latches; otherwise `restart` schedules the next automatic attempt.
   */
  private recordFailure(kind: 'crash' | 'launch', restart: boolean): void {
    const recent = this.recentFailures()
    recent.push({ at: this.clock.now(), kind })
    if (recent.length > RESTART_BACKOFF_MS.length) {
      this.latched = recent.some((f) => f.kind === 'crash')
        ? HELPER_CRASH_LATCH_REASON
        : HELPER_LAUNCH_LATCH_REASON
      this.clientPromise = null
      return
    }
    if (restart) this.clientPromise = this.launch(true)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wait = {
        handle: this.clock.setTimeout(() => {
          if (this.pendingWait === wait) this.pendingWait = null
          resolve()
        }, ms),
        wake: () => {
          this.clock.clearTimeout(wait.handle)
          if (this.pendingWait === wait) this.pendingWait = null
          resolve()
        },
      }
      this.pendingWait = wait
    })
  }

  /** Invalidates pending launches and backoff waits. */
  private supersede(): void {
    this.epoch++
    this.pendingWait?.wake()
    this.clientPromise = null
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: Parameters<DriverEventListener>[0]): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* a UI listener cannot break the driver */
      }
    }
  }

  snapshot(targetId: string): TargetSnapshot | null {
    return this.targets.get(targetId) ?? null
  }
  list(): TargetSnapshot[] {
    return [...this.targets.values()]
  }

  private async executablePaths(
    pids: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    const unique = [...new Set(pids)]
    try {
      return await (this.options.processPaths ?? psExecutablePaths)(unique)
    } catch {
      // Bundle ID and pid still apply; the helper checks paths itself.
      return new Map()
    }
  }

  /**
   * 00 §6.5: Emperor is refused by bundle ID, by pid and by executable path.
   * The helper reports no path, so main looks it up by pid.
   */
  private refused(appId: string, pid: number, path: string | undefined) {
    if (protectedMacApp(appId) || pid === this.selfPid) return true
    if (path === undefined) return false
    const lower = path.toLowerCase()
    return this.selfRoots.some(
      (root) => lower === root || lower.startsWith(`${root}/`),
    )
  }

  async listApps(signal: AbortSignal): Promise<DesktopAppInfo[]> {
    const { apps } = await this.use((client) =>
      client.request('apps.list', {}, { signal, deadlineMs: 5_000 }),
    )
    const paths = await this.executablePaths(apps.map((app) => app.pid))
    return apps.filter(
      (app) => !this.refused(app.appId, app.pid, paths.get(app.pid)),
    )
  }

  async listWindows(
    filter: { readonly appId?: string },
    signal: AbortSignal,
  ): Promise<DesktopWindowInfo[]> {
    // The helper replaces its windowRef table on every listing.
    this.listedWindows.clear()
    const { windows } = await this.use((client) =>
      client.request('windows.list', filter, { signal, deadlineMs: 5_000 }),
    )
    const paths = await this.executablePaths(windows.map((item) => item.pid))
    return windows.filter((window) => {
      const refused = this.refused(
        window.appId,
        window.pid,
        paths.get(window.pid),
      )
      this.listedWindows.set(window.windowRef, {
        appId: window.appId,
        refused,
      })
      return !refused
    })
  }

  async bind(
    request: { readonly windowRef: string; readonly ownerSessionId: string },
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    // The bind result carries no pid; check the pid and path of the listing.
    const listed = this.listedWindows.get(request.windowRef)
    if (listed === undefined)
      throw new UiError(
        'STALE_TARGET',
        'window list is stale; list windows again',
      )
    if (listed.refused)
      throw new UiError('TARGET_FORBIDDEN', 'this app is protected')
    return await this.use((client) =>
      this.bindWith(client, request.windowRef, listed, signal),
    )
  }

  private async bindWith(
    client: HelperClient,
    windowRef: string,
    listed: ListedWindow,
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    const result = await client.request(
      'target.bind',
      { windowRef },
      { signal, deadlineMs: 5_000 },
    )
    const forbidden = protectedMacApp(result.appId)
    if (forbidden || result.appId !== listed.appId) {
      await client
        .request(
          'target.release',
          { targetId: result.targetId },
          { deadlineMs: 1_000 },
        )
        .catch(() => undefined)
      throw forbidden
        ? new UiError('TARGET_FORBIDDEN', 'this app is protected')
        : new UiError('STALE_TARGET', 'the listed window changed application')
    }
    const snapshot: TargetSnapshot = {
      targetId: result.targetId,
      kind: 'desktop-window',
      driver: 'desktop',
      generation: result.generation,
      revision: result.revision,
      url: `app:${result.appId}`,
      title: result.title,
      loading: false,
      profileId: 'desktop',
      appId: result.appId,
      windowRef,
    }
    this.targets.set(snapshot.targetId, snapshot)
    return snapshot
  }

  async close(targetId: string, _reason: TargetCloseReason): Promise<void> {
    this.targets.delete(targetId)
    this.paused.delete(targetId)
    this.sensitive.delete(targetId)
    if (this.client)
      await this.client
        .request('target.release', { targetId }, { deadlineMs: 2_000 })
        .catch(() => undefined)
  }

  private live(targetId: string, generation: number): TargetSnapshot {
    const target = this.targets.get(targetId)
    if (!target || target.generation !== generation)
      throw new UiError('STALE_TARGET', 'desktop target identity changed')
    return target
  }

  async observe(
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<DriverObservation> {
    this.live(request.targetId, request.generation)
    const result = await this.use((client) =>
      client.request(
        'observe.semantic',
        {
          targetId: request.targetId,
          generation: request.generation,
          budget: request.budget,
          includeText: request.includeText,
          ...(request.query ? { query: request.query } : {}),
          ...(request.diffFrom === undefined
            ? {}
            : { diffFrom: request.diffFrom }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        },
        {
          signal,
          deadlineMs: Math.min(120_000, request.budget.timeoutMs + 2_000),
        },
      ),
    )
    this.live(request.targetId, request.generation)
    if (result.generation !== request.generation)
      throw new UiError(
        'STALE_TARGET',
        'desktop target generation changed during observation',
      )
    const current = this.targets.get(request.targetId)!
    this.targets.set(request.targetId, {
      ...current,
      revision: result.revision,
      title: result.title,
    })
    // After a credential fill the app may show the secret in a plain field;
    // one-time codes often sit in ordinary text fields. Mask those values.
    const afterFill = this.sensitive.has(request.targetId)
    let masked = 0
    const elements = result.elements.map((element) => {
      const role = normalizedRole(element.role)
      const hide =
        element.value !== undefined &&
        element.value !== '' &&
        element.value !== '[has content]' &&
        (TEXT_ROLES.has(role) || role === 'combobox') &&
        (afterFill || looksSensitive(element.name))
      if (hide) masked += 1
      return {
        ...element,
        role,
        ...(hide ? { value: maskedValue(element.value!) } : {}),
      }
    })
    return {
      ...result,
      elements,
      redactions: result.redactions + masked,
      ...(afterFill
        ? {
            notes: [
              ...(result.notes ?? []),
              'field values stay hidden after a credential fill for this target',
            ],
          }
        : {}),
    }
  }

  /** The newest live frame of an agent-controlled window, for the pane preview. */
  async preview(
    targetId: string,
    afterSeq: number | undefined,
  ): Promise<DesktopPreviewFrame | null> {
    const target = this.targets.get(targetId)
    if (target === undefined || this.sensitive.has(targetId)) return null
    // A preview never launches the helper.
    if (this.client?.diagnostics().connected !== true) return null
    return await this.use(async (client) => {
      if (!client.diagnostics().capabilities.includes('target.preview'))
        return null
      const { result, blobs } = await client.requestWithBlobs(
        'target.preview',
        {
          targetId,
          generation: target.generation,
          maxEdge: 480,
          ...(afterSeq === undefined ? {} : { afterSeq }),
        },
        { deadlineMs: 3_000 },
      )
      if (!result.live) return null
      const jpeg =
        result.blobId === undefined ? undefined : blobs.get(result.blobId)
      return jpeg === undefined ||
        result.width === undefined ||
        result.height === undefined
        ? { seq: result.seq }
        : { seq: result.seq, jpeg, width: result.width, height: result.height }
    })
  }

  async restoreFront(target: {
    readonly targetId: string
    readonly generation: number
  }): Promise<boolean> {
    if (!this.targets.has(target.targetId)) return false
    if (this.client?.diagnostics().connected !== true) return false
    return await this.use(async (client) => {
      if (!client.diagnostics().capabilities.includes('front.restore'))
        return false
      const result = await client.request(
        'front.restore',
        { targetId: target.targetId, generation: target.generation },
        { deadlineMs: 5_000 },
      )
      return result.restored
    })
  }

  async setCapture(
    target: { readonly targetId: string; readonly generation: number },
    active: boolean,
  ): Promise<boolean> {
    if (!this.targets.has(target.targetId)) return false
    // A window that received a secret is never streamed again.
    const wanted = active && !this.sensitive.has(target.targetId)
    // Streams end with the helper; never launch one just to stop a stream.
    if (!wanted && this.client?.diagnostics().connected !== true) return false
    return await this.use(async (client) => {
      if (!client.diagnostics().capabilities.includes('target.capture'))
        return false
      const result = await client.request(
        'target.capture',
        {
          targetId: target.targetId,
          generation: target.generation,
          active: wanted,
        },
        { deadlineMs: 10_000 },
      )
      return result.active
    })
  }

  async menu(
    request: {
      readonly targetId: string
      readonly generation: number
      readonly path: readonly string[]
    },
    signal: AbortSignal,
  ): Promise<DesktopMenuListing> {
    this.live(request.targetId, request.generation)
    return await this.use(async (client) => {
      if (!client.diagnostics().capabilities.includes('observe.menu'))
        throw new UiError(
          'CAPABILITY_DISABLED',
          'this helper cannot read menus; restart it from Settings after updating',
        )
      return await client.request(
        'observe.menu',
        {
          targetId: request.targetId,
          generation: request.generation,
          path: [...request.path],
        },
        { signal, deadlineMs: 5_000 },
      )
    })
  }

  async screenshot(
    request: ScreenshotRequest,
    signal: AbortSignal,
  ): Promise<ScreenshotCapture> {
    this.live(request.targetId, request.generation)
    if (this.sensitive.has(request.targetId))
      throw new UiError(
        'CAPABILITY_DISABLED',
        'desktop screenshots are disabled after credential fill for this target',
      )
    const packet = await this.use((client) =>
      client.requestWithBlobs(
        'observe.screenshot',
        {
          targetId: request.targetId,
          generation: request.generation,
          modelCopy: request.modelCopy,
          modelMaxEdge: request.modelMaxEdge,
        },
        { signal, deadlineMs: 20_000 },
      ),
    )
    this.live(request.targetId, request.generation)
    const result = packet.result
    if (result.generation !== request.generation)
      throw new UiError(
        'STALE_TARGET',
        'desktop target generation changed during screenshot',
      )
    const png = packet.blobs.get(result.blobId)
    if (!png)
      throw new UiError(
        'DRIVER_UNAVAILABLE',
        'helper screenshot blob is missing',
      )
    const model =
      result.model === undefined
        ? undefined
        : packet.blobs.get(result.model.blobId)
    if (result.model && !model)
      throw new UiError('DRIVER_UNAVAILABLE', 'helper model image is missing')
    return {
      screenshotId: result.screenshotId,
      generation: result.generation,
      revision: result.revision,
      png,
      width: result.width,
      height: result.height,
      scale: result.scale,
      ...(result.model && model
        ? {
            model: {
              jpeg: model,
              width: result.model.width,
              height: result.model.height,
            },
          }
        : {}),
    }
  }

  async act(
    request: ActRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<ActOutcome> {
    this.live(request.targetId, request.generation)
    if (this.paused.has(request.targetId))
      throw new UiError('TARGET_BUSY', 'desktop target is paused')
    const stepsAside = POINTER_ACTIONS.has(request.action.kind)
    let pointerMoved = false
    if (stepsAside) this.options.pointer?.({ kind: 'hide' })
    try {
      return await this.sendAct(
        request,
        hooks,
        signal,
        () => (pointerMoved = true),
      )
    } finally {
      // Nothing was dispatched (or it carried no point): show it where it was.
      if (stepsAside && !pointerMoved)
        this.options.pointer?.({ kind: 'restore' })
    }
  }

  /** One helper `act` request; reports when the dispatch carried a point. */
  private async sendAct(
    request: ActRequest,
    hooks: ActHooks,
    signal: AbortSignal,
    pointerMoved: () => void,
  ): Promise<ActOutcome> {
    return await this.use(async (client) => {
      let dispatched = false
      const unsubscribe = client.onEvent((event) => {
        if (event.name !== 'act.dispatched') return
        const data = event.data as {
          operationId: string
          pointer?: DesktopPointer
        }
        if (data.operationId !== request.operationId || dispatched) return
        dispatched = true
        hooks.dispatched()
        if (data.pointer !== undefined) {
          pointerMoved()
          this.options.pointer?.({ kind: 'move', pointer: data.pointer })
        }
      })
      try {
        const result = await client.request(
          'act',
          {
            operationId: request.operationId,
            targetId: request.targetId,
            generation: request.generation,
            expectedRevision: request.expectedRevision,
            action: request.action,
            ...(request.bringForward === true ? { bringForward: true } : {}),
          },
          { signal, deadlineMs: request.deadlineMs },
        )
        if (!dispatched && result.outcome === 'observed')
          throw new UiError(
            'OUTCOME_UNKNOWN',
            'helper did not confirm the desktop action dispatch',
          )
        const current = this.live(request.targetId, request.generation)
        this.targets.set(request.targetId, {
          ...current,
          revision: result.afterRevision,
          title: result.title ?? current.title,
        })
        return result
      } finally {
        unsubscribe()
      }
    })
  }

  async fillCredential(
    request: DesktopCredentialFillRequest,
    hooks: ActHooks,
    signal: AbortSignal,
  ): Promise<CredentialFillOutcome> {
    const target = this.live(request.targetId, request.generation)
    if (target.appId !== request.binding.bundleId)
      throw new UiError('PERMISSION_DENIED', 'credential binding mismatch', {
        reason: 'credential-binding-mismatch',
      })
    if (this.paused.has(request.targetId))
      throw new UiError('TARGET_BUSY', 'desktop target is paused')
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
    const handle = vault
      .list()
      .find((item) => item.handleId === request.handleId)
    const matched = handle?.bindings.some(
      (binding) =>
        binding.kind === 'app' &&
        binding.bundleId === request.binding.bundleId &&
        binding.teamId === request.binding.teamId &&
        binding.path === request.binding.path &&
        (Boolean(binding.teamId) || Boolean(binding.path)),
    )
    if (!matched || !handle?.fields.includes(request.field))
      throw new UiError('PERMISSION_DENIED', 'credential binding mismatch', {
        reason: 'credential-binding-mismatch',
      })
    return await this.use(async (client) => {
      let dispatched = false
      const unsubscribe = client.onEvent((event) => {
        if (event.name !== 'act.dispatched' || dispatched) return
        const data = event.data as { operationId: string }
        if (data.operationId !== request.operationId) return
        dispatched = true
        hooks.dispatched()
      })
      try {
        // The plaintext is created only in main and sent directly to the authenticated helper.
        // The vault checks the binding again and records it as the target.
        const secret = vault.secret(
          request.handleId,
          request.field,
          request.binding,
        )
        // Once the request may reach the helper, a disconnect or unreadable
        // secure field can leave the fill outcome unknown. Keep this target out
        // of screenshots until it is released, even if no reply arrives.
        this.sensitive.add(request.targetId)
        const result = await client.request(
          'act.fillSecret',
          {
            operationId: request.operationId,
            targetId: request.targetId,
            generation: request.generation,
            expectedRevision: request.expectedRevision,
            ref: request.ref,
            field: request.field,
            binding: {
              bundleId: request.binding.bundleId,
              ...(request.binding.teamId === undefined
                ? {}
                : { teamId: request.binding.teamId }),
              ...(request.binding.path === undefined
                ? {}
                : { path: request.binding.path }),
            },
            secret,
          },
          { signal, deadlineMs: 20_000 },
        )
        if (result.filled && !dispatched)
          throw new UiError(
            'OUTCOME_UNKNOWN',
            'helper did not confirm the desktop credential dispatch',
          )
        return {
          filled: result.filled,
          bindingMatched: request.binding.bundleId,
        }
      } finally {
        unsubscribe()
      }
    })
  }

  async wait(
    _request: WaitRequest,
    _signal: AbortSignal,
  ): Promise<WaitOutcome> {
    throw new UiError(
      'CAPABILITY_DISABLED',
      'macOS desktop wait is not enabled',
    )
  }

  setPaused(targetId: string, paused: boolean): void {
    if (paused) this.paused.add(targetId)
    else this.paused.delete(targetId)
  }

  async permissions(): Promise<Readonly<Record<string, PermissionStatus>>> {
    const response = await this.use((client) =>
      client.request('permissions.status', {}, { deadlineMs: 5_000 }),
    )
    this.latestPermissions = response.permissions
    return this.latestPermissions
  }

  async status(): Promise<MacHelperStatus> {
    const previewBuild = (await this.options.previewBuild) ?? false
    const offline = (reason: string, code: string | null): MacHelperStatus => ({
      available: true,
      previewBuild,
      connected: false,
      helperVersion: null,
      protocol: null,
      permissions: { accessibility: 'unknown', 'screen-recording': 'unknown' },
      lastErrorCode: code,
      reason,
      ...(this.latched === null ? {} : { autoRestartSuspended: true }),
    })
    // Neither a latched helper nor a backoff wait may be hurried by polling.
    if (this.latched !== null)
      return offline(this.latched, 'DRIVER_UNAVAILABLE')
    if (this.pendingWait !== null)
      return offline(HELPER_RESTARTING_REASON, 'DRIVER_UNAVAILABLE')
    try {
      return await this.use(async (client) => {
        const diagnostics = client.diagnostics()
        const response = await client.request(
          'permissions.status',
          {},
          { deadlineMs: 5_000 },
        )
        this.latestPermissions = response.permissions
        return {
          available: true,
          previewBuild,
          connected: diagnostics.connected,
          helperVersion: diagnostics.helperVersion,
          protocol: diagnostics.protocol,
          permissions: {
            accessibility: response.permissions.accessibility ?? 'unknown',
            'screen-recording':
              response.permissions['screen-recording'] ?? 'unknown',
          },
          lastErrorCode: diagnostics.lastErrorCode,
        }
      })
    } catch (error) {
      return offline(
        this.latched ?? HELPER_OFFLINE_REASON,
        error instanceof UiError ? error.code : 'DRIVER_UNAVAILABLE',
      )
    }
  }

  async requestPermission(
    permission: MacHelperPermission,
  ): Promise<{ opened: boolean }> {
    return await this.use((client) =>
      client.request(
        'permissions.request',
        { permission },
        { deadlineMs: 15_000 },
      ),
    )
  }

  async resetPermission(
    permission: MacHelperPermission,
  ): Promise<{ reset: boolean }> {
    const service =
      permission === 'accessibility'
        ? 'Accessibility'
        : permission === 'screen-recording'
          ? 'ScreenCapture'
          : null
    if (!service) throw new UiError('INVALID_REQUEST', 'Unknown TCC permission')
    const file = '/usr/bin/tccutil'
    const args = ['reset', service, HELPER_BUNDLE_ID]
    if (this.options.resetTcc) await this.options.resetTcc(file, args)
    else await execFile(file, args, { timeout: 10_000 })
    // The helper restarts with the reset permission on its next use.
    await this.closeIntentionally('Helper TCC permission reset')
    this.clearRestartHistory()
    return { reset: true }
  }

  /**
   * Explicit user action in Settings: clears the crash latch and the restart
   * history, closes any current helper (it releases held input first) and
   * connects again.
   */
  async reconnect(): Promise<MacHelperStatus> {
    this.stopped = false
    await this.closeIntentionally('Helper reconnected')
    this.clearRestartHistory()
    return await this.status()
  }

  async releaseAll(): Promise<void> {
    await this.client?.releaseAll()
  }

  /** App quit: never restarts afterwards. */
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.closeIntentionally('Helper shut down')
  }

  private clearRestartHistory(): void {
    this.latched = null
    this.failures.length = 0
  }

  /** Detaches before closing, so the drop never counts as a crash. */
  private async closeIntentionally(reason: string): Promise<void> {
    this.supersede()
    const previous = this.client
    this.detach(reason)
    // HelperClient.close() sends input.releaseAll before shutdown (00 §12).
    await previous?.close().catch(() => undefined)
  }
}
