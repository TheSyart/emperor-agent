// Conversation store: one SessionWindow + ConversationAssembler per open
// session, published to Vue through shallow refs.
//
// - `order` and `snapshot` refs change only when the chat order/snapshot
//   changes; `node(key)` returns a per-key shallowRef triggered only when
//   that node's materialized value changes, so a streaming delta re-renders
//   exactly one row.
// - Flushes are batched: 'immediate' publications flush in a microtask,
//   streaming ('animation-frame') publications once per frame. The
//   scheduler is injectable for tests.
// - At most `capacity` (4) windows stay open (LRU); retained sessions (the
//   current one and breadcrumb parents) are never evicted.
// - Live raw events arrive through one global `onSessionEvents`
//   subscription and are routed to the open windows; the watch set follows
//   the open windows.
// - Extra targets (the trajectory) are lazy: a window assembles only chat
//   until `activate(target)` / `target(target)` first asks for one, so the
//   chat path pays nothing for an unopened trajectory tab.
import {
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  type ShallowRef,
} from 'vue'
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type { SessionEventBatch } from '../api/backend'
import {
  fetchSessionHistory,
  onSessionEvents,
  watchSessions,
} from '../api/sessions'
import type {
  ConversationAssembler,
  ConversationPublication,
} from './assembler'
import {
  EMPTY_CHAT_SNAPSHOT,
  chatSnapshotOf,
  createConversationAssembler,
  type ConversationExtensions,
} from './chatSnapshot'
import {
  inspectRequests,
  type RequestInspectionSnapshot,
} from './requestInspection'
import {
  SessionWindow,
  type SessionWindowApi,
  type SessionWindowState,
} from './sessionWindow'
import type { ChatNode, ChatSnapshot } from './types'

/** Default number of simultaneously open session windows. */
export const CONVERSATION_WINDOW_CAPACITY = 4

/** Flush scheduling primitives (injectable for tests). */
export interface ConversationScheduler {
  /** Run once before the next paint (streaming cadence). */
  frame(callback: () => void): void
  /** Run after the current task (state changes). */
  microtask(callback: () => void): void
}

export const browserScheduler: ConversationScheduler = {
  frame: (callback) => {
    if (typeof globalThis.requestAnimationFrame === 'function')
      globalThis.requestAnimationFrame(() => callback())
    else setTimeout(callback, 16)
  },
  microtask: (callback) => queueMicrotask(callback),
}

export interface ConversationStoreDeps {
  readonly api: SessionWindowApi
  /** Replace the set of sessions whose raw events stream to this window. */
  readonly watch: (sessionIds: readonly string[]) => Promise<unknown>
  /** Global live event subscription; returns an unsubscribe. */
  readonly subscribe: (
    listener: (batch: SessionEventBatch) => void,
  ) => () => void
  readonly scheduler?: ConversationScheduler
  readonly capacity?: number
  readonly pageMessages?: number
  /** Targets assembled from the start (beside chat). */
  readonly extensions?: ConversationExtensions
  /**
   * Targets registered on first use, by target name. Falls back to the
   * module-level registry (see `registerLazyConversationTarget`).
   */
  readonly lazyTargets?: Readonly<Record<string, ConversationExtensions>>
}

/**
 * Lazily activated targets registered by the modules that own them (the
 * trajectory model registers itself when its lazy chunk loads), so the chat
 * bundle never imports target definitions it may not need.
 */
const LAZY_TARGET_REGISTRY = new Map<string, ConversationExtensions>()

/** Make a lazy target available to every conversation store. */
export function registerLazyConversationTarget(
  target: string,
  extensions: ConversationExtensions,
): void {
  LAZY_TARGET_REGISTRY.set(target, extensions)
}

/** Reactive view of one open session conversation. */
export interface ConversationHandle {
  readonly sessionId: string
  /** Visible node keys in render order. */
  readonly order: Readonly<ShallowRef<readonly string[]>>
  /** Latest chat snapshot (running, turnStatus, todos, contextUsage...). */
  readonly snapshot: Readonly<ShallowRef<ChatSnapshot>>
  /** Window facts: open state, header, hasMore, loadingOlder, error. */
  readonly window: Readonly<ShallowRef<SessionWindowState>>
  /** Bumps on every published flush (trajectory and other targets). */
  readonly revision: Readonly<ShallowRef<number>>
  /** Per-key node ref, triggered only when that node changes. */
  node(key: string): Readonly<ShallowRef<ChatNode | undefined>>
  /**
   * Snapshot of another target (e.g. 'trajectory'). A lazy target is
   * activated (and flushed synchronously) on first access; prefer calling
   * `activate` in setup so the first flush does not run inside a computed.
   */
  target<Snapshot>(target: string): Snapshot | undefined
  /** Register a lazy target now and publish its first snapshot. */
  activate(target: string): void
  /** Provider requests of the loaded window (cached per revision). */
  requests(): RequestInspectionSnapshot
  /** Loaded raw events (seq ascending, wire-sanitized; read-only). */
  rawEvents(): readonly WireSessionEvent[]
  loadOlder(): Promise<void>
  /** Flush pending publications synchronously (tests, imperative reads). */
  flushNow(): void
}

interface Entry {
  readonly sessionId: string
  readonly window: SessionWindow
  readonly assembler: ConversationAssembler
  readonly order: ShallowRef<readonly string[]>
  readonly snapshot: ShallowRef<ChatSnapshot>
  readonly windowState: ShallowRef<SessionWindowState>
  readonly revision: ShallowRef<number>
  readonly nodeRefs: Map<string, ShallowRef<ChatNode | undefined>>
  readonly handle: ConversationHandle
  retainCount: number
  scheduled: 'none' | 'microtask' | 'frame'
  scheduleGeneration: number
  requestsCache: { revision: number; value: RequestInspectionSnapshot } | null
  opened: Promise<void> | null
}

export class ConversationStore {
  private readonly entries = new Map<string, Entry>()
  private readonly scheduler: ConversationScheduler
  private readonly capacity: number
  private readonly lazyTargets:
    Readonly<Record<string, ConversationExtensions>> | undefined
  private unsubscribe: (() => void) | null = null
  private watchChain: Promise<unknown> = Promise.resolve()
  private watched = ''

  constructor(private readonly deps: ConversationStoreDeps) {
    this.scheduler = deps.scheduler ?? browserScheduler
    this.capacity = Math.max(1, deps.capacity ?? CONVERSATION_WINDOW_CAPACITY)
    this.lazyTargets = deps.lazyTargets
  }

  /** Open ids, least recently used first. */
  openSessions(): string[] {
    return [...this.entries.keys()]
  }

  /** Handle of an already open session. */
  peek(sessionId: string): ConversationHandle | undefined {
    return this.entries.get(sessionId)?.handle
  }

  /** Open (or touch) one session and start loading it. */
  open(sessionId: string): ConversationHandle {
    this.ensureSubscribed()
    let entry = this.entries.get(sessionId)
    if (entry !== undefined) {
      this.entries.delete(sessionId)
      this.entries.set(sessionId, entry)
    } else {
      entry = this.createEntry(sessionId)
      this.entries.set(sessionId, entry)
      this.evict()
      this.syncWatch()
    }
    this.startOpen(entry)
    return entry.handle
  }

  /** Pin a session against eviction; returns the release function. */
  retain(sessionId: string): () => void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return () => {}
    entry.retainCount++
    let released = false
    return () => {
      if (released) return
      released = true
      entry.retainCount = Math.max(0, entry.retainCount - 1)
      this.evict()
      this.syncWatch()
    }
  }

  /** Stop the live subscription and drop every window. */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.entries.clear()
    this.syncWatch()
  }

  private ensureSubscribed(): void {
    if (this.unsubscribe !== null) return
    this.unsubscribe = this.deps.subscribe((batch) => {
      this.entries.get(batch.sessionId)?.window.acceptLive(batch.events)
    })
  }

  private startOpen(entry: Entry): void {
    if (entry.opened !== null) return
    // Watch first so no live event falls between the history cut and the
    // subscription; events that race the fetch are buffered by the window.
    entry.opened = this.watchChain
      .catch(() => undefined)
      .then(() => entry.window.open())
  }

  private syncWatch(): void {
    const ids = [...this.entries.keys()].sort()
    const key = ids.join('\n')
    if (key === this.watched) return
    this.watched = key
    this.watchChain = this.watchChain
      .catch(() => undefined)
      .then(() => this.deps.watch(ids))
      .catch((error: unknown) => {
        if (import.meta.env?.DEV)
          console.warn('[conversation] watchSessions failed', error)
      })
  }

  private evict(): void {
    const newest = [...this.entries.keys()].at(-1)
    while (this.entries.size > this.capacity) {
      let victim: string | undefined
      for (const [id, entry] of this.entries) {
        // The most recently opened window is the one being shown.
        if (entry.retainCount === 0 && id !== newest) {
          victim = id
          break
        }
      }
      if (victim === undefined) return
      const entry = this.entries.get(victim)
      if (entry !== undefined) entry.scheduleGeneration++
      this.entries.delete(victim)
    }
  }

  private createEntry(sessionId: string): Entry {
    const assembler = createConversationAssembler(this.deps.extensions)
    const order = shallowRef<readonly string[]>(EMPTY_CHAT_SNAPSHOT.order)
    const snapshot = shallowRef<ChatSnapshot>(EMPTY_CHAT_SNAPSHOT)
    const revision = shallowRef(0)
    const nodeRefs = new Map<string, ShallowRef<ChatNode | undefined>>()
    // The window's onChange and the handle close over the entry built below.
    const box: { entry: Entry | null } = { entry: null }
    const window = new SessionWindow(sessionId, this.deps.api, assembler, {
      ...(this.deps.pageMessages === undefined
        ? {}
        : { pageMessages: this.deps.pageMessages }),
      onChange: (publication) => {
        if (box.entry !== null) this.schedule(box.entry, publication)
      },
    })
    const windowState = shallowRef<SessionWindowState>(window.snapshot)
    const handle: ConversationHandle = {
      sessionId,
      order,
      snapshot,
      window: windowState,
      revision,
      node: (key) => {
        let ref = nodeRefs.get(key)
        if (ref === undefined) {
          ref = shallowRef(snapshot.value.nodes.get(key))
          nodeRefs.set(key, ref)
        }
        return ref
      },
      target: <Snapshot>(target: string) => {
        if (!assembler.hasTarget(target)) handle.activate(target)
        return assembler.snapshot<Snapshot | undefined>(target)
      },
      activate: (target) => {
        if (assembler.hasTarget(target)) return
        const extension =
          this.lazyTargets?.[target] ?? LAZY_TARGET_REGISTRY.get(target)
        if (extension === undefined) return
        assembler.extend(extension.definitions ?? [], extension.views ?? [])
        if (box.entry !== null) this.flush(box.entry)
      },
      requests: () => {
        const cache = box.entry?.requestsCache ?? null
        if (cache !== null && cache.revision === revision.value)
          return cache.value
        const value = inspectRequests(window.window)
        if (box.entry !== null)
          box.entry.requestsCache = { revision: revision.value, value }
        return value
      },
      rawEvents: () => window.window,
      loadOlder: () => window.loadOlder(),
      flushNow: () => {
        if (box.entry !== null) this.flush(box.entry)
      },
    }
    const entry: Entry = {
      sessionId,
      window,
      assembler,
      order,
      snapshot,
      windowState,
      revision,
      nodeRefs,
      handle,
      retainCount: 0,
      scheduled: 'none',
      scheduleGeneration: 0,
      requestsCache: null,
      opened: null,
    }
    box.entry = entry
    return entry
  }

  private schedule(entry: Entry, publication: ConversationPublication): void {
    if (publication === 'none') return
    if (publication === 'immediate') {
      if (entry.scheduled === 'microtask') return
      this.enqueue(entry, 'microtask')
      return
    }
    if (entry.scheduled !== 'none') return
    this.enqueue(entry, 'frame')
  }

  private enqueue(entry: Entry, kind: 'microtask' | 'frame'): void {
    const generation = ++entry.scheduleGeneration
    entry.scheduled = kind
    const run = (): void => {
      if (generation !== entry.scheduleGeneration) return
      entry.scheduled = 'none'
      this.flush(entry)
    }
    if (kind === 'frame') this.scheduler.frame(run)
    else this.scheduler.microtask(run)
  }

  private flush(entry: Entry): void {
    entry.scheduleGeneration++
    entry.scheduled = 'none'
    const windowState = entry.window.snapshot
    if (entry.windowState.value !== windowState)
      entry.windowState.value = windowState
    const report = entry.assembler.flush()
    const chat = report.targets.get('chat')
    if (report.targets.size === 0) return
    const next = chatSnapshotOf(entry.assembler)
    if (chat !== undefined) {
      for (const key of chat.changed) {
        const ref = entry.nodeRefs.get(key)
        if (ref !== undefined) ref.value = next.nodes.get(key)
      }
      for (const key of chat.removed) {
        const ref = entry.nodeRefs.get(key)
        if (ref !== undefined) ref.value = undefined
      }
    }
    if (entry.order.value !== next.order) entry.order.value = next.order
    if (entry.snapshot.value !== next) entry.snapshot.value = next
    entry.revision.value++
  }
}

let defaultStore: ConversationStore | null = null

/** App-wide store bound to the Core IPC session operations. */
export function defaultConversationStore(): ConversationStore {
  defaultStore ??= new ConversationStore({
    api: { history: fetchSessionHistory },
    watch: watchSessions,
    subscribe: onSessionEvents,
  })
  return defaultStore
}

/**
 * Open one session's conversation for the calling component. The window
 * opens (and joins the watch set) immediately; the session stays retained
 * until the component's scope is disposed, after which it is subject to
 * LRU eviction.
 */
export function useConversation(
  sessionId: string,
  store: ConversationStore = defaultConversationStore(),
): ConversationHandle {
  const handle = store.open(sessionId)
  const release = store.retain(sessionId)
  if (getCurrentScope() !== undefined) onScopeDispose(release)
  return handle
}
