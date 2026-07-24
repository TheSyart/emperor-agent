<script setup lang="ts">
import {
  ArrowLeft,
  Files,
  GitCompareArrows,
  ListTree,
  PanelRight,
  TerminalSquare,
  X,
} from 'lucide-vue-next'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue'
import { core } from '../../api/http'
import type { RightWorkspaceState, SidebarState } from '../../types'
import { normalizeSidebarState } from '../../runtime/sidebarModel'
import EnvironmentPane from './EnvironmentPane.vue'
import FilesPane from './FilesPane.vue'
import GitReviewPane from './GitReviewPane.vue'
import TerminalPane from './TerminalPane.vue'
import {
  availableWorkspacePanes,
  clampWorkspaceWidth,
  DEFAULT_WORKSPACE_WIDTH,
  normalizeRightWorkspaceState,
  workspacePresentation,
  type WorkspacePaneId,
} from './workspaceModel'
import {
  isGitStatus,
  type WorkspaceSnapshot,
  type WorkspaceSource,
} from './workspaceTypes'

const props = defineProps<{
  sessionId: string
  projectPath: string
  sources: WorkspaceSource[]
  agentBusy: boolean
  refreshKey: number
}>()

const state = reactive<RightWorkspaceState>(
  normalizeRightWorkspaceState(undefined),
)
const viewportWidth = ref(window.innerWidth)
const snapshot = ref<WorkspaceSnapshot | null>(null)
const loading = ref(false)
const error = ref('')
const panel = ref<HTMLElement | null>(null)
let refreshTimer: number | undefined
let pollTimer: number | undefined
let dragStartX = 0
let dragStartWidth = 840
let snapshotGeneration = 0
let refreshingSession = ''
let focusBeforeOverlay: HTMLElement | null = null

const hasProject = computed(() =>
  Boolean(
    props.projectPath &&
    props.sessionId &&
    !props.sessionId.startsWith('draft:'),
  ),
)
const hasGit = computed(() => isGitStatus(snapshot.value?.git))
const effectiveProjectPath = computed(
  () => snapshot.value?.project.path || props.projectPath,
)
const presentation = computed(() => workspacePresentation(viewportWidth.value))
const workbenchVisible = computed(() => state.workbenchOpen)
const environmentVisible = computed(
  () =>
    !state.workbenchOpen &&
    presentation.value === 'fixed',
)
const panes = computed(() => availableWorkspacePanes(hasProject.value))
const workbenchTitle = computed(
  () =>
    panes.value.find((pane) => pane.id === state.pane)?.label || 'Workspace',
)
const panelStyle = computed(() =>
  presentation.value === 'fixed'
    ? {
        width:
          state.width === DEFAULT_WORKSPACE_WIDTH
            ? 'clamp(640px, 46vw, 960px)'
            : `${state.width}px`,
      }
    : undefined,
)

onMounted(async () => {
  window.addEventListener('resize', updateViewport)
  window.addEventListener('focus', refreshSnapshotOnFocus)
  window.addEventListener('keydown', handleWindowKeydown)
  try {
    const stored = normalizeSidebarState(
      (await core('sidebar.get')) as unknown as SidebarState,
    ).right_workspace
    Object.assign(state, normalizeRightWorkspaceState(stored))
  } catch {
    // Preference failures must never block chat.
  }
  coercePane()
  await refreshSnapshot()
  pollTimer = window.setInterval(() => {
    if (
      document.hasFocus() &&
      (environmentVisible.value || workbenchVisible.value) &&
      !loading.value
    )
      void refreshSnapshot()
  }, 5_000)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewport)
  window.removeEventListener('focus', refreshSnapshotOnFocus)
  window.removeEventListener('keydown', handleWindowKeydown)
  window.clearTimeout(refreshTimer)
  window.clearInterval(pollTimer)
  stopResize()
})

watch(
  () => props.sessionId,
  async () => {
    snapshot.value = null
    error.value = ''
    coercePane()
    await refreshSnapshot()
  },
)
watch(
  () => props.refreshKey,
  () => scheduleRefresh(),
)
watch(hasProject, coercePane)

function updateViewport(): void {
  viewportWidth.value = window.innerWidth
  state.width = clampedWidth(state.width)
}

function refreshSnapshotOnFocus(): void {
  if ((environmentVisible.value || workbenchVisible.value) && !loading.value)
    void refreshSnapshot()
}

function coercePane(): void {
  if (
    state.pane === 'launcher' ||
    panes.value.some((pane) => pane.id === state.pane)
  )
    return
  state.pane = 'launcher'
  void persist()
}

function showEnvironment(): void {
  if (state.workbenchOpen) {
    state.workbenchOpen = false
  }
  void persist()
  void refreshSnapshot()
}

function setWorkbench(open: boolean): void {
  const overlay = presentation.value !== 'fixed'
  if (open && overlay && !state.workbenchOpen)
    focusBeforeOverlay =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  state.workbenchOpen = open
  void persist()
  if (open) {
    void refreshSnapshot()
    if (overlay) void nextTick(() => panel.value?.focus())
  } else if (overlay && focusBeforeOverlay) {
    const restore = focusBeforeOverlay
    focusBeforeOverlay = null
    void nextTick(() => restore.isConnected && restore.focus())
  }
}

function openLauncher(): void {
  state.pane = 'launcher'
  setWorkbench(true)
}

function openPane(pane: WorkspacePaneId): void {
  if (pane === 'launcher') return
  if (!panes.value.some((entry) => entry.id === pane)) return
  if (pane === 'review' && !hasGit.value) return
  state.pane = pane
  setWorkbench(true)
}

function openReview(): void {
  openPane('review')
}

defineExpose({ openReview, refreshSnapshot })

function setFilesTreeWidth(width: number): void {
  state.filesTreeWidth = width
  void persist()
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (
    event.key === 'Escape' &&
    workbenchVisible.value &&
    presentation.value !== 'fixed'
  )
    setWorkbench(false)
  else if (
    event.key === 'Tab' &&
    workbenchVisible.value &&
    presentation.value !== 'fixed'
  )
    trapOverlayFocus(event)
}

function trapOverlayFocus(event: KeyboardEvent): void {
  const root = panel.value
  if (!root) return
  const focusable = [
    ...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ].filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true',
  )
  if (!focusable.length) {
    event.preventDefault()
    root.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable.at(-1)!
  const active = document.activeElement
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

function clampedWidth(value: number): number {
  const viewportMaximum = Math.max(520, Math.floor(viewportWidth.value * 0.72))
  return Math.min(viewportMaximum, clampWorkspaceWidth(value))
}

function resizeWithKeyboard(event: KeyboardEvent): void {
  let next = state.width
  if (event.key === 'ArrowLeft') next += event.shiftKey ? 40 : 10
  else if (event.key === 'ArrowRight') next -= event.shiftKey ? 40 : 10
  else if (event.key === 'Home') next = 520
  else if (event.key === 'End') next = 960
  else return
  event.preventDefault()
  state.width = clampedWidth(next)
  void persist()
}

async function persist(): Promise<void> {
  try {
    await core('sidebar.patch', {
      right_workspace: { ...state },
    })
  } catch {
    // Best effort only.
  }
}

async function refreshSnapshot(): Promise<void> {
  if (!hasProject.value) {
    snapshotGeneration += 1
    refreshingSession = ''
    loading.value = false
    snapshot.value = null
    return
  }
  const owner = props.sessionId
  if (loading.value && refreshingSession === owner) return
  const generation = ++snapshotGeneration
  refreshingSession = owner
  loading.value = true
  error.value = ''
  try {
    const result = await core('workspace.snapshot', { sessionId: owner })
    if (owner !== props.sessionId || generation !== snapshotGeneration) return
    snapshot.value = result
  } catch (cause) {
    if (owner !== props.sessionId || generation !== snapshotGeneration) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (owner === props.sessionId && generation === snapshotGeneration) {
      loading.value = false
      refreshingSession = ''
    }
  }
}

function scheduleRefresh(): void {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => void refreshSnapshot(), 280)
}

function startResize(event: MouseEvent): void {
  if (presentation.value !== 'fixed') return
  dragStartX = event.clientX
  dragStartWidth = panel.value?.getBoundingClientRect().width ?? state.width
  document.body.classList.add('workspace-resizing')
  window.addEventListener('mousemove', resize)
  window.addEventListener('mouseup', finishResize, { once: true })
}

function resize(event: MouseEvent): void {
  state.width = clampedWidth(dragStartWidth + dragStartX - event.clientX)
}

function finishResize(): void {
  stopResize()
  void persist()
}

function stopResize(): void {
  document.body.classList.remove('workspace-resizing')
  window.removeEventListener('mousemove', resize)
  window.removeEventListener('mouseup', finishResize)
}

const iconForPane: Record<string, typeof GitCompareArrows> = {
  review: GitCompareArrows,
  terminal: TerminalSquare,
  files: Files,
}

const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
</script>

<template>
  <div class="right-workspace-controls">
    <button
      type="button"
      class="workspace-control-button"
      :class="{ active: environmentVisible }"
      aria-label="显示或刷新 Environment"
      :aria-pressed="environmentVisible"
      @click="showEnvironment"
    >
      <ListTree :size="15" />
    </button>
    <button
      type="button"
      class="workspace-control-button"
      :class="{ active: workbenchVisible }"
      aria-label="打开右侧工作区"
      :aria-pressed="workbenchVisible"
      @click="workbenchVisible ? setWorkbench(false) : openLauncher()"
    >
      <PanelRight :size="15" />
    </button>
  </div>

  <aside
    v-if="environmentVisible"
    class="environment-floating-card"
    aria-label="项目环境"
  >
    <EnvironmentPane
      :snapshot="snapshot"
      :sources="sources"
      :loading="loading"
      :error="error"
      :has-project="hasProject"
      @refresh="refreshSnapshot"
      @open-pane="openPane"
    />
  </aside>

  <button
    v-if="workbenchVisible && presentation !== 'fixed'"
    type="button"
    class="right-workspace-backdrop"
    aria-label="关闭项目工作台"
    @click="setWorkbench(false)"
  ></button>

  <aside
    v-if="workbenchVisible"
    ref="panel"
    class="right-workspace"
    :class="`presentation-${presentation}`"
    :style="panelStyle"
    aria-label="项目工作台"
    :role="presentation === 'fixed' ? undefined : 'dialog'"
    :aria-modal="presentation === 'fixed' ? undefined : 'true'"
    :tabindex="presentation === 'fixed' ? undefined : -1"
  >
    <button
      v-if="presentation === 'fixed'"
      type="button"
      class="right-workspace-resizer"
      aria-label="调整项目工作台宽度"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin="520"
      aria-valuemax="960"
      :aria-valuenow="state.width"
      @mousedown="startResize"
      @keydown="resizeWithKeyboard"
    ></button>
    <header class="right-workspace-head">
      <div>
        <button
          v-if="state.pane !== 'launcher'"
          type="button"
          class="workspace-icon-button"
          aria-label="返回工作区启动器"
          @click="openLauncher"
        >
          <ArrowLeft :size="15" />
        </button>
        <strong>{{
          state.pane === 'launcher' ? 'Workspace' : workbenchTitle
        }}</strong>
      </div>
      <button
        type="button"
        class="workspace-icon-button"
        aria-label="关闭项目工作台"
        @click="setWorkbench(false)"
      >
        <X :size="15" />
      </button>
    </header>
    <div class="right-workspace-body">
      <div v-if="state.pane === 'launcher'" class="workspace-launcher">
        <button
          v-for="pane in panes"
          :key="pane.id"
          type="button"
          :disabled="pane.id === 'review' && !hasGit"
          @click="openPane(pane.id)"
        >
          <component :is="iconForPane[pane.id]" :size="15" />
          <span>{{ pane.label }}</span>
          <small v-if="pane.id === 'review' && !hasGit"
            >当前项目未初始化 Git</small
          >
        </button>
      </div>
      <GitReviewPane
        v-else-if="state.pane === 'review'"
        :session-id="sessionId"
        :has-project="hasProject"
        :agent-busy="agentBusy"
      />
      <TerminalPane
        v-else-if="state.pane === 'terminal' && hasProject"
        :session-id="sessionId"
      />
      <FilesPane
        v-else-if="state.pane === 'files' && hasProject"
        :session-id="sessionId"
        :project-path="effectiveProjectPath"
        :tree-width="state.filesTreeWidth"
        @tree-width="setFilesTreeWidth"
      />
    </div>
  </aside>
</template>
