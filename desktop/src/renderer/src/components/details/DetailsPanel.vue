<script setup lang="ts">
/**
 * DetailsPanel — the AppFrame's right "details" column (port of dsh
 * DetailsPanel): a tab header (Inspect / Git / Files / Terminal / Environment /
 * Browser) plus a close button over one pane body. The AppFrame owns the
 * column width and drag handle; this fills whatever the column gives.
 *
 * Open/close state and the active tab live in frameState. Chat components ask
 * for content through detailsState.requestDetails() instead of holding a
 * component ref; this panel consumes those requests.
 *
 * Props:
 * - sessionId / projectPath: the active conversation and its project root.
 * - sources: attachment/media sources listed by the Environment pane.
 * - agentBusy: disables conflicting Git writes while the agent runs.
 * - refreshKey: bump to schedule a workspace snapshot refresh.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { core } from '../../api/http'
import type { RightWorkspaceState, SidebarState } from '../../types'
import { normalizeSidebarState } from '../../runtime/sidebarModel'
import IconButton from '../ui/IconButton.vue'
import Tabs from '../ui/Tabs.vue'
import type { TabItem } from '../ui/blockTypes'
import { DsClose } from '../icons/ds'
import {
  frameActions,
  isDetailsTab,
  useFrameState,
  type DetailsTab,
} from '../shell/frameState'
import BrowserPane from '../workspace/BrowserPane.vue'
import EnvironmentPane from '../workspace/EnvironmentPane.vue'
import FilesPane from '../workspace/FilesPane.vue'
import GitReviewPane from '../workspace/GitReviewPane.vue'
import TerminalPane from '../workspace/TerminalPane.vue'
import { clampFilesTreeWidth } from '../workspace/workspaceModel'
import {
  isGitStatus,
  type WorkspaceSnapshot,
  type WorkspaceSource,
} from '../workspace/workspaceTypes'
import {
  consumeDetailsRequest,
  detailsRequest,
  type DetailsRequest,
} from './detailsState'
import { TrajectoryInspectorAsync } from '../trajectory/lazy'
import InspectPane from './InspectPane.vue'
import { inspectSelection } from './inspectState'

const props = defineProps<{
  sessionId: string
  projectPath: string
  sources: WorkspaceSource[]
  agentBusy: boolean
  refreshKey: number
  /**
   * Session whose Trajectory tab is active: the Inspect tab then hosts the
   * trajectory inspector (shared selection via useTrajectory) instead of
   * the chat tool-call pane.
   */
  trajectorySessionId?: string
}>()
const emit = defineEmits<{ 'open-subagent': [sessionId: string] }>()

const frame = useFrameState()
const snapshot = ref<WorkspaceSnapshot | null>(null)
const loading = ref(false)
const error = ref('')
const reviewFilterPaths = ref<string[]>([])
const filesTreeWidth = ref(280)
const filesPane = ref<{
  openPath: (path: string, line?: number) => Promise<void>
} | null>(null)
const pendingFile = ref<{ path: string; line?: number } | null>(null)
const pendingPreviewId = ref('')
let storedRightWorkspace: RightWorkspaceState | null = null
let refreshTimer: number | undefined
let pollTimer: number | undefined
let snapshotGeneration = 0
let refreshingSession = ''

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
const detailsOpen = computed(() => frame.details > 0)

const tabs = computed<TabItem[]>(() => {
  const list: TabItem[] = [
    { id: 'inspect', label: 'Inspect' },
    {
      id: 'git',
      label: 'Git',
      // Unknown until the first snapshot lands: keep it reachable meanwhile.
      disabled: !hasProject.value || (Boolean(snapshot.value) && !hasGit.value),
    },
    { id: 'files', label: 'Files', disabled: !hasProject.value },
    { id: 'terminal', label: 'Terminal', disabled: !hasProject.value },
    { id: 'environment', label: 'Environment' },
  ]
  if (pendingPreviewId.value || frame.detailsTab === 'browser')
    list.push({
      id: 'browser',
      label: 'Browser',
      disabled: !hasProject.value || !pendingPreviewId.value,
    })
  return list
})

const activeTab = computed<string>({
  get: () => frame.detailsTab,
  set: (value) => {
    if (isDetailsTab(value)) frame.detailsTab = value
  },
})

onMounted(async () => {
  window.addEventListener('focus', refreshSnapshotOnFocus)
  try {
    const stored = normalizeSidebarState(
      (await core('sidebar.get')) as unknown as SidebarState,
    ).right_workspace
    storedRightWorkspace = stored
    filesTreeWidth.value = clampFilesTreeWidth(stored.filesTreeWidth)
  } catch {
    // Preference failures must never block chat.
  }
  if (detailsOpen.value) await refreshSnapshot()
  pollTimer = window.setInterval(() => {
    if (document.hasFocus() && detailsOpen.value && !loading.value)
      void refreshSnapshot()
  }, 5_000)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', refreshSnapshotOnFocus)
  window.clearTimeout(refreshTimer)
  window.clearInterval(pollTimer)
})

watch(
  () => props.sessionId,
  async () => {
    snapshot.value = null
    error.value = ''
    reviewFilterPaths.value = []
    pendingFile.value = null
    // A preview belongs to the session that produced it.
    pendingPreviewId.value = ''
    if (frame.detailsTab === 'browser') frame.detailsTab = 'environment'
    await refreshSnapshot()
  },
)
watch(
  () => props.refreshKey,
  () => scheduleRefresh(),
)
watch(detailsOpen, (open) => {
  if (open) void refreshSnapshot()
})

// Chat asks for content via requestDetails(); the request may predate this
// mount (the frame opens the column first), hence immediate.
watch(detailsRequest(), (request) => request && handleRequest(request), {
  immediate: true,
})
// A file request can land before FilesPane exists (tab switch pending).
watch(filesPane, () => void flushPendingFile())

function handleRequest(request: DetailsRequest): void {
  consumeDetailsRequest(request)
  if (request.tab === 'git')
    reviewFilterPaths.value = [
      ...new Set((request.paths ?? []).filter(Boolean)),
    ]
  if (request.tab === 'files' && request.file?.path)
    pendingFile.value = {
      path: request.file.path,
      ...(request.file.line ? { line: request.file.line } : {}),
    }
  if (request.tab === 'browser' && request.previewId)
    pendingPreviewId.value = request.previewId
  if (request.tab !== 'inspect') void refreshSnapshot()
  void nextTick(flushPendingFile)
}

async function flushPendingFile(): Promise<void> {
  const request = pendingFile.value
  if (!request || !filesPane.value) return
  pendingFile.value = null
  await filesPane.value.openPath(request.path, request.line)
}

/** Environment rows jump to a workbench tab (same guards as the launcher). */
function openPane(pane: 'review' | 'terminal' | 'files' | 'browser'): void {
  const tab: DetailsTab = pane === 'review' ? 'git' : pane
  if (tab === 'browser' && !pendingPreviewId.value) return
  if (tab === 'git' && !hasGit.value) return
  if (!hasProject.value) return
  frameActions.openDetails(frame, tab)
}

function close(): void {
  frameActions.closeDetails(frame)
}

function refreshSnapshotOnFocus(): void {
  if (detailsOpen.value && !loading.value) void refreshSnapshot()
}

function setFilesTreeWidth(width: number): void {
  filesTreeWidth.value = clampFilesTreeWidth(width)
  void persistFilesTreeWidth()
}

async function persistFilesTreeWidth(): Promise<void> {
  const base =
    storedRightWorkspace ?? normalizeSidebarState(undefined).right_workspace
  storedRightWorkspace = { ...base, filesTreeWidth: filesTreeWidth.value }
  try {
    await core('sidebar.patch', { right_workspace: storedRightWorkspace })
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
  refreshTimer = window.setTimeout(() => {
    if (detailsOpen.value) void refreshSnapshot()
  }, 280)
}

defineExpose({ refreshSnapshot })
</script>

<template>
  <div class="details-panel" role="region" aria-label="详情面板">
    <header class="details-header">
      <div class="details-tabs">
        <Tabs v-model="activeTab" :tabs="tabs" />
      </div>
      <IconButton label="关闭详情面板" round @click="close">
        <DsClose :size="14" />
      </IconButton>
    </header>
    <div class="details-body" :data-tab="frame.detailsTab">
      <TrajectoryInspectorAsync
        v-if="frame.detailsTab === 'inspect' && trajectorySessionId"
        :key="trajectorySessionId"
        :session-id="trajectorySessionId"
        :closable="false"
        @open-subagent="emit('open-subagent', $event)"
      />
      <InspectPane
        v-else-if="frame.detailsTab === 'inspect'"
        :selection="inspectSelection"
      />
      <template v-else-if="frame.detailsTab === 'git'">
        <p v-if="hasProject && snapshot && !hasGit" class="details-empty">
          当前项目未初始化 Git
        </p>
        <GitReviewPane
          v-else
          :session-id="sessionId"
          :has-project="hasProject"
          :agent-busy="agentBusy"
          :focus-paths="reviewFilterPaths"
        />
      </template>
      <template v-else-if="frame.detailsTab === 'files'">
        <FilesPane
          v-if="hasProject"
          ref="filesPane"
          :session-id="sessionId"
          :project-path="effectiveProjectPath"
          :tree-width="filesTreeWidth"
          @tree-width="setFilesTreeWidth"
        />
        <p v-else class="details-empty">当前会话未绑定项目</p>
      </template>
      <template v-else-if="frame.detailsTab === 'terminal'">
        <TerminalPane v-if="hasProject" :session-id="sessionId" />
        <p v-else class="details-empty">当前会话未绑定项目</p>
      </template>
      <template v-else-if="frame.detailsTab === 'browser'">
        <BrowserPane
          v-if="hasProject && pendingPreviewId"
          :session-id="sessionId"
          :preview-id="pendingPreviewId"
        />
        <p v-else class="details-empty">当前没有可用的网站预览</p>
      </template>
      <EnvironmentPane
        v-else
        :snapshot="snapshot"
        :sources="sources"
        :loading="loading"
        :error="error"
        :has-project="hasProject"
        @refresh="refreshSnapshot"
        @open-pane="openPane"
      />
    </div>
  </div>
</template>

<style scoped>
.details-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: rgb(var(--bg-base));
  color: rgb(var(--label-primary));
}

/* dsh RightSidebar header frame: pad 14/12/12, gap 8, hairline below. */
.details-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3-5) var(--space-3) var(--space-3);
  border-bottom: 1px solid var(--border-l2);
}

/* Six tabs overflow a 300px column: scroll the strip, hide the bar. */
.details-tabs {
  min-width: 0;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
}

.details-tabs::-webkit-scrollbar {
  display: none;
}

/* Panes scroll themselves. */
.details-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.details-empty {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
