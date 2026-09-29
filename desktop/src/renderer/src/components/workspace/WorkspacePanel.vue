<script setup lang="ts">
/**
 * WorkspacePanel — the AppFrame's right workspace column: a header (pane
 * title, segmented pane switch 审查 / 终端 / 文件 / 浏览器 / 电脑, launcher home,
 * close) over one pane body. The launcher lists the panes with their
 * shortcuts; every pane is its own async chunk (xterm, the file
 * highlighter and the diff views stay out of the shell bundle). The
 * AppFrame owns the column width and drag handle; this fills whatever the
 * column gives and stays mounted while the column is closed.
 *
 * Open state and the active pane live in frameState. Chat components ask
 * for content through workspaceState.requestWorkspace() instead of holding
 * a component ref; this panel consumes those requests. The workspace
 * snapshot comes from the shared useWorkspaceSnapshot poller (active while
 * the column is open).
 *
 * Pane contract (what a request turns into):
 * - review: `focus-paths` (request.paths) and `commit-focus` (the request
 *   nonce of focus 'commit'; the pane scrolls to and focuses the commit box,
 *   then emits commitFocused and the nonce resets).
 * - files: `openPath(path, line)` on the pane instance (queued until the
 *   async chunk has mounted); `tree-width` in, `treeWidth` out (persisted as
 *   right_workspace.filesTreeWidth).
 * - browser: `prefill` ({ url, nonce }) only fills the address bar — a page
 *   loads on the user's submit alone; `visible` (the column is open) gates
 *   the native view. The pane is keyed by session, so a session switch
 *   remounts it and closes the view.
 * - terminal: session only.
 * - desktop: session-owned native windows, latest screenshot and target controls.
 *
 * Props:
 * - open: the column is visible (width > 0).
 * - agentBusy: disables conflicting Git writes while the agent runs.
 */
import { House } from 'lucide-vue-next'
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  ref,
  watch,
} from 'vue'
import { core } from '../../api/http'
import { normalizeSidebarState } from '../../runtime/sidebarModel'
import type { RightWorkspaceState, SidebarState } from '../../types'
import { DsClose } from '../icons/ds'
import {
  frameActions,
  useFrameState,
  type WorkspacePane,
} from '../shell/frameState'
import IconButton from '../ui/IconButton.vue'
import WorkspaceLauncher from './WorkspaceLauncher.vue'
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot'
import { WORKSPACE_PANE_ICONS } from './workspaceIcons'
import { FILES_TREE_DEFAULT, clampFilesTreeWidth } from './workspaceModel'
import {
  NO_PROJECT_REASON,
  WORKSPACE_PANE_ITEMS,
  workspacePaneDisabledReason,
  workspacePaneTitle,
  type WorkspaceAvailability,
  type WorkspaceContentPane,
} from './workspacePanes'
import {
  consumeWorkspaceRequest,
  workspaceRequest,
  type WorkspaceRequest,
} from './workspaceState'

// Every pane is its own async chunk (xterm, highlighter, diff views).
const GitReviewPane = defineAsyncComponent(() => import('./GitReviewPane.vue'))
const TerminalPane = defineAsyncComponent(() => import('./TerminalPane.vue'))
const FilesPane = defineAsyncComponent(() => import('./FilesPane.vue'))
const BrowserPane = defineAsyncComponent(() => import('./BrowserPane.vue'))
const DesktopPane = defineAsyncComponent(() => import('./DesktopPane.vue'))

const props = defineProps<{ open: boolean; agentBusy: boolean }>()

const frame = useFrameState()
const workspace = useWorkspaceSnapshot({ active: () => props.open })
const { sessionId, projectPath, snapshot, hasProject, hasGit } = workspace

const reviewFilterPaths = ref<string[]>([])
const filesTreeWidth = ref(FILES_TREE_DEFAULT)
const filesPane = ref<{
  openPath: (path: string, line?: number) => Promise<void>
} | null>(null)
const pendingFile = ref<{ path: string; line?: number } | null>(null)
/** Address a request asked to prefill (BrowserPane never auto-loads it). */
const browserPrefill = ref<{ url: string; nonce: number } | null>(null)
const browserAgentFocus = ref<{ targetId: string; nonce: number } | null>(null)
/** Nonce of a pending review commit-box focus request (0 = none). */
const commitFocus = ref(0)
let storedRightWorkspace: RightWorkspaceState | null = null

const pane = computed<WorkspacePane>(() => frame.workspacePane)
const title = computed(() => workspacePaneTitle(pane.value))
const availability = computed<WorkspaceAvailability>(() => ({
  hasProject: hasProject.value,
  snapshotLoaded: Boolean(snapshot.value),
  hasGit: hasGit.value,
}))
const segments = computed(() =>
  WORKSPACE_PANE_ITEMS.map((item) => ({
    ...item,
    icon: WORKSPACE_PANE_ICONS[item.pane],
    reason: workspacePaneDisabledReason(item.pane, availability.value),
  })),
)
const reviewReason = computed(() =>
  workspacePaneDisabledReason('review', availability.value),
)

onMounted(async () => {
  try {
    const stored = normalizeSidebarState(
      (await core('sidebar.get')) as unknown as SidebarState,
    ).right_workspace
    storedRightWorkspace = stored
    filesTreeWidth.value = clampFilesTreeWidth(stored.filesTreeWidth)
  } catch {
    // Preference failures must never block chat.
  }
})

watch(sessionId, () => {
  reviewFilterPaths.value = []
  pendingFile.value = null
  browserPrefill.value = null
  browserAgentFocus.value = null
  commitFocus.value = 0
})
// Focus / prefill requests are one-shot: they target the pane showing now.
watch(pane, (next) => {
  if (next !== 'review') commitFocus.value = 0
  if (next !== 'browser') {
    browserPrefill.value = null
    browserAgentFocus.value = null
  }
})

// Chat asks for content via requestWorkspace(); the request may predate
// this mount (the frame opens the column first), hence immediate.
watch(workspaceRequest(), (request) => request && handleRequest(request), {
  immediate: true,
})
// A file request can land before FilesPane exists (pane switch pending).
watch(filesPane, () => void flushPendingFile())

function handleRequest(request: WorkspaceRequest): void {
  consumeWorkspaceRequest(request)
  if (request.pane === 'review') {
    reviewFilterPaths.value = [
      ...new Set((request.paths ?? []).filter(Boolean)),
    ]
    commitFocus.value = request.focus === 'commit' ? request.nonce : 0
  }
  if (request.pane === 'files' && request.file?.path)
    pendingFile.value = {
      path: request.file.path,
      ...(request.file.line ? { line: request.file.line } : {}),
    }
  if (request.pane === 'browser' && request.url)
    browserPrefill.value = { url: request.url, nonce: request.nonce }
  if (request.pane === 'browser' && request.agentTargetId)
    browserAgentFocus.value = {
      targetId: request.agentTargetId,
      nonce: request.nonce,
    }
  void workspace.refresh()
  void nextTick(flushPendingFile)
}

async function flushPendingFile(): Promise<void> {
  const request = pendingFile.value
  if (!request || !filesPane.value) return
  pendingFile.value = null
  await filesPane.value.openPath(request.path, request.line)
}

function selectPane(target: WorkspaceContentPane): void {
  frameActions.setWorkspacePane(frame, target)
}

function showLauncher(): void {
  frameActions.setWorkspacePane(frame, 'launcher')
}

function close(): void {
  frameActions.closeWorkspace(frame)
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
</script>

<template>
  <div class="workspace-panel" role="region" aria-label="工作台">
    <header class="workspace-header">
      <h2 class="workspace-title">{{ title }}</h2>
      <div class="segments" role="group" aria-label="工作台面板">
        <IconButton
          v-for="segment in segments"
          :key="segment.pane"
          :label="segment.label"
          :active="pane === segment.pane"
          :aria-pressed="pane === segment.pane"
          :disabled="Boolean(segment.reason)"
          :data-pane="segment.pane"
          @click="selectPane(segment.pane)"
        >
          <component :is="segment.icon" :size="16" />
        </IconButton>
      </div>
      <IconButton
        label="工作台首页"
        :active="pane === 'launcher'"
        @click="showLauncher"
      >
        <House :size="16" />
      </IconButton>
      <IconButton label="关闭工作台" round @click="close">
        <DsClose :size="14" />
      </IconButton>
    </header>
    <div class="workspace-body" :data-pane="pane">
      <WorkspaceLauncher
        v-if="pane === 'launcher'"
        :availability="availability"
        @open="selectPane"
      />
      <template v-else-if="pane === 'review'">
        <p v-if="reviewReason" class="workspace-empty">{{ reviewReason }}</p>
        <GitReviewPane
          v-else
          :session-id="sessionId"
          :has-project="hasProject"
          :agent-busy="agentBusy"
          :focus-paths="reviewFilterPaths"
          :commit-focus="commitFocus"
          @commit-focused="commitFocus = 0"
        />
      </template>
      <template v-else-if="pane === 'files'">
        <FilesPane
          v-if="hasProject"
          ref="filesPane"
          :session-id="sessionId"
          :project-path="projectPath"
          :tree-width="filesTreeWidth"
          @tree-width="setFilesTreeWidth"
        />
        <p v-else class="workspace-empty">{{ NO_PROJECT_REASON }}</p>
      </template>
      <template v-else-if="pane === 'terminal'">
        <TerminalPane v-if="hasProject" :session-id="sessionId" />
        <p v-else class="workspace-empty">{{ NO_PROJECT_REASON }}</p>
      </template>
      <DesktopPane
        v-else-if="pane === 'desktop'"
        :key="sessionId"
        :session-id="sessionId"
      />
      <BrowserPane
        v-else-if="pane === 'browser'"
        :key="sessionId"
        :visible="open"
        :prefill="browserPrefill"
        :agent-focus="browserAgentFocus"
        :session-id="sessionId"
      />
    </div>
  </div>
</template>

<style scoped>
.workspace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: rgb(var(--bg-base));
  color: rgb(var(--label-primary));
}

/* dsh RightSidebar header frame: pad 14/12/12, gap 8, hairline below. */
.workspace-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3-5) var(--space-3) var(--space-3);
  border-bottom: 1px solid var(--border-l2);
}

.workspace-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  padding-left: var(--space-1);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.segments {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  padding: var(--space-0-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-cell);
}

/* Panes scroll themselves. */
.workspace-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.workspace-body[data-pane='launcher'] {
  overflow-y: auto;
}

.workspace-empty {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
