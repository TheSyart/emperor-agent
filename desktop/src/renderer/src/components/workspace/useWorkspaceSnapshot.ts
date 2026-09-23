/**
 * Shared, ref-counted `workspace.snapshot` poller (project, git summary,
 * terminals, worktrees of the active session). One app-wide snapshot serves
 * every consumer — the right workspace, the chat environment card, the
 * changes pill — instead of each polling on its own.
 *
 * App.vue binds the source once (`bindWorkspaceSnapshotSource`: active
 * session id, its project path, and a refresh key that bumps as the
 * transcript grows). Consumers call `useWorkspaceSnapshot({ active })`;
 * while at least one active consumer is mounted the snapshot refreshes on
 * activation, on window focus and every 5s while the window is focused.
 * Refresh-key bumps are debounced (280ms). A generation guard drops replies
 * that land after the session switched or a newer request started.
 */
import {
  computed,
  effectScope,
  getCurrentScope,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type EffectScope,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from 'vue'
import { core } from '../../api/http'
import { isGitStatus, type WorkspaceSnapshot } from './workspaceTypes'

export const WORKSPACE_POLL_MS = 5_000
export const WORKSPACE_REFRESH_DEBOUNCE_MS = 280

export interface WorkspaceSnapshotSource {
  /** Session whose workspace is polled (drafts never are). */
  sessionId: () => string
  /** Its bound project root ('' for plain chats). */
  projectPath: () => string
  /** Any change schedules a debounced refresh (e.g. transcript length). */
  refreshKey?: () => unknown
}

export interface WorkspaceSnapshotView {
  sessionId: ComputedRef<string>
  /** Snapshot project root, falling back to the bound project path. */
  projectPath: ComputedRef<string>
  snapshot: Readonly<ShallowRef<WorkspaceSnapshot | null>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  /** A persisted session bound to a project. */
  hasProject: ComputedRef<boolean>
  /** The loaded snapshot reports a git repository. */
  hasGit: ComputedRef<boolean>
  refresh: () => Promise<void>
  scheduleRefresh: () => void
}

const source = shallowRef<WorkspaceSnapshotSource | null>(null)
const snapshot = shallowRef<WorkspaceSnapshot | null>(null)
const loading = ref(false)
const error = ref('')

const sessionId = computed(() => source.value?.sessionId() ?? '')
const boundProjectPath = computed(() => source.value?.projectPath() ?? '')
const hasProject = computed(() =>
  Boolean(
    boundProjectPath.value &&
    sessionId.value &&
    !sessionId.value.startsWith('draft:'),
  ),
)
const hasGit = computed(() => isGitStatus(snapshot.value?.git))
const projectPath = computed(
  () => snapshot.value?.project.path || boundProjectPath.value,
)

let consumers = 0
let generation = 0
let refreshingSession = ''
let pollTimer: ReturnType<typeof setInterval> | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let binding: EffectScope | null = null

async function refresh(): Promise<void> {
  if (!hasProject.value) {
    generation += 1
    refreshingSession = ''
    loading.value = false
    snapshot.value = null
    return
  }
  const owner = sessionId.value
  if (loading.value && refreshingSession === owner) return
  const current = ++generation
  refreshingSession = owner
  loading.value = true
  error.value = ''
  const stale = () => owner !== sessionId.value || current !== generation
  try {
    const result = await core('workspace.snapshot', { sessionId: owner })
    if (stale()) return
    snapshot.value = result
  } catch (cause) {
    if (stale()) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (!stale()) {
      loading.value = false
      refreshingSession = ''
    }
  }
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    if (consumers > 0) void refresh()
  }, WORKSPACE_REFRESH_DEBOUNCE_MS)
}

function refreshOnFocus(): void {
  if (consumers > 0 && !loading.value) void refresh()
}

function windowFocused(): boolean {
  return typeof document === 'undefined' || document.hasFocus()
}

function start(): void {
  if (typeof window !== 'undefined')
    window.addEventListener('focus', refreshOnFocus)
  pollTimer = setInterval(() => {
    if (windowFocused() && !loading.value) void refresh()
  }, WORKSPACE_POLL_MS)
}

function stop(): void {
  if (typeof window !== 'undefined')
    window.removeEventListener('focus', refreshOnFocus)
  clearInterval(pollTimer)
  clearTimeout(refreshTimer)
  pollTimer = undefined
  refreshTimer = undefined
}

function retain(): void {
  consumers += 1
  if (consumers === 1) start()
  void refresh()
}

function release(): void {
  if (consumers === 0) return
  consumers -= 1
  if (consumers === 0) stop()
}

/**
 * Bind the snapshot to the app's active session (App.vue, once). Returns
 * the unbind function; inside a component scope it unbinds on dispose.
 */
export function bindWorkspaceSnapshotSource(
  next: WorkspaceSnapshotSource,
): () => void {
  binding?.stop()
  source.value = next
  const scope = effectScope(true)
  scope.run(() => {
    watch(sessionId, () => {
      // Drop the previous session's snapshot and any reply still in flight.
      generation += 1
      refreshingSession = ''
      loading.value = false
      snapshot.value = null
      error.value = ''
      if (consumers > 0) void refresh()
    })
    if (next.refreshKey) watch(next.refreshKey, () => scheduleRefresh())
  })
  binding = scope
  const unbind = () => {
    if (binding !== scope) return
    scope.stop()
    binding = null
    source.value = null
  }
  if (getCurrentScope()) onScopeDispose(unbind)
  return unbind
}

/**
 * Consume the shared snapshot. The caller counts as a consumer while
 * `active` is true (default: while mounted) — polling runs only then.
 */
export function useWorkspaceSnapshot(
  options: { active?: MaybeRefOrGetter<boolean> } = {},
): WorkspaceSnapshotView {
  let held = false
  const setActive = (active: boolean) => {
    if (active === held) return
    held = active
    if (active) retain()
    else release()
  }
  if (getCurrentScope()) {
    watch(() => toValue(options.active ?? true), setActive, {
      immediate: true,
    })
    onScopeDispose(() => setActive(false))
  }
  return {
    sessionId,
    projectPath,
    snapshot,
    loading,
    error,
    hasProject,
    hasGit,
    refresh,
    scheduleRefresh,
  }
}

/** Test hook: drop the binding, consumers, timers and cached snapshot. */
export function resetWorkspaceSnapshotForTest(): void {
  binding?.stop()
  binding = null
  source.value = null
  consumers = 0
  stop()
  generation += 1
  refreshingSession = ''
  snapshot.value = null
  loading.value = false
  error.value = ''
}
