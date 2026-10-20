<script setup lang="ts">
/**
 * WorkspacePanel — the AppFrame's right workspace panel: a PaneHeader (pane
 * title, segmented pane switch 审查 / 终端 / 文件 / 浏览器, launcher home,
 * close) over one pane body. The 48px PaneHeader is pulled up 2px so its
 * bottom meets the 46px top bars of the other columns (UI-S01); its empty
 * space moves the window. The launcher lists the panes with their
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
 * Pane lifetimes (FIX-05):
 * - 审查 and 文件 live in a KeepAlive: switching panes keeps the commit
 *   message, the PR draft, the open file tabs and their scroll positions.
 *   审查 polls (through the shared snapshot) only while it shows.
 * - 浏览器 mounts the first time it is shown and then stays, hidden with
 *   v-show (`visible` false hides the native view), so the page and its
 *   sign-ins survive other panes and a collapsed column. A session switch
 *   ends it (keyed by session; unmounting closes the view).
 * - 终端 remounts per visit (Core keeps the PTYs and replays them).
 *
 * Pane contract (what a request turns into):
 * - review: `focus-paths` (request.paths) and `commit-focus` (the request
 *   nonce of focus 'commit'; the pane scrolls to and focuses the commit box,
 *   then emits commitFocused and the nonce resets); `visible`.
 * - files: `openPath(path, line)` or `openDirectory(path)` on the pane
 *   instance (queued until the async chunk has mounted); `tree-width` in, `treeWidth` out (persisted as
 *   right_workspace.filesTreeWidth).
 * - browser: `prefill` ({ url, nonce }) only fills the address bar — a page
 *   loads on the user's submit alone; `visible` (the column is open and the
 *   pane shows) gates the native view.
 * - terminal: session, `visible` (the column is open) and `focus-request`
 *   (a nonce sent when the user shows the pane: picking it, or opening the
 *   column on it — never on a session switch).
 *
 * Props:
 * - open: the column is visible (width > 0).
 * - agentBusy: disables conflicting Git writes while the agent runs.
 */
import EmptyState from '../ui/EmptyState.vue'
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
import PaneHeader from '../ui/PaneHeader.vue'
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
  type TurnReviewRequest,
  type WorkspaceRequest,
  type WorkspaceFileRequest,
} from './workspaceState'

// Every pane is its own async chunk (xterm, highlighter, diff views).
const GitReviewPane = defineAsyncComponent(() => import('./GitReviewPane.vue'))
const TerminalPane = defineAsyncComponent(() => import('./TerminalPane.vue'))
const FilesPane = defineAsyncComponent(() => import('./FilesPane.vue'))
const BrowserPane = defineAsyncComponent(() => import('./BrowserPane.vue'))
const TurnReviewView = defineAsyncComponent(
  () => import('./TurnReviewView.vue'),
)

const props = defineProps<{ open: boolean; agentBusy: boolean }>()

const frame = useFrameState()
const workspace = useWorkspaceSnapshot({ active: () => props.open })
const { sessionId, projectPath, snapshot, hasProject, hasGit } = workspace

const reviewFilterPaths = ref<string[]>([])
const filesTreeWidth = ref(FILES_TREE_DEFAULT)
const filesPane = ref<{
  openPath: (path: string, line?: number) => Promise<void>
  openPreview: (request: WorkspaceFileRequest) => Promise<void>
  openDirectory: (path: string) => Promise<void>
} | null>(null)
const pendingFile = ref<
  WorkspaceFileRequest | { path: string; directory: true } | null
>(null)
/** Session the 浏览器 pane was opened in ('' = not mounted). */
const browserSession = ref('')
/** Nonce of the user showing 终端 (0 = no focus wanted). */
const terminalFocus = ref(0)
/** Address a request asked to prefill (BrowserPane never auto-loads it). */
const browserPrefill = ref<{ url: string; nonce: number } | null>(null)
/** Nonce of a pending review commit-box focus request (0 = none). */
const commitFocus = ref(0)
/** The review pane shows one recorded turn (本轮改动) instead of Git status. */
const turnReview = ref<TurnReviewRequest | null>(null)
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
  commitFocus.value = 0
  turnReview.value = null
  terminalFocus.value = 0
})
// Focus / prefill requests are one-shot: they target the pane showing now.
watch(pane, (next) => {
  if (next !== 'review') commitFocus.value = 0
  if (next !== 'browser') browserPrefill.value = null
})
// The browser pane belongs to the session it was opened in: shown, it
// mounts (or stays); another session ends it.
watch(
  [pane, sessionId],
  ([next, session], previous) => {
    if (next === 'browser') browserSession.value = session
    else if (previous && session !== previous[1]) browserSession.value = ''
  },
  { immediate: true },
)
// The user showed 终端 (picked it, or opened the column on it): focus it.
watch([pane, () => props.open], ([next, isOpen], [previous, wasOpen]) => {
  if (next === 'terminal' && isOpen && (previous !== 'terminal' || !wasOpen))
    terminalFocus.value += 1
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
    turnReview.value = request.turn ?? null
    reviewFilterPaths.value = [
      ...new Set((request.paths ?? []).filter(Boolean)),
    ]
    commitFocus.value = request.focus === 'commit' ? request.nonce : 0
  }
  if (request.pane === 'files' && request.file) {
    const file = request.file
    const next =
      'target' in file
        ? file
        : {
            owner: sessionId.value,
            target: {
              source: 'project' as const,
              sessionId: sessionId.value,
              path: file.path.replace(/^\.\//, ''),
            },
            line: file.line,
          }
    if (next.owner === sessionId.value) pendingFile.value = next
  }
  if (request.pane === 'files' && request.directory !== undefined)
    pendingFile.value = { path: request.directory, directory: true }
  if (request.pane === 'browser' && request.url)
    browserPrefill.value = { url: request.url, nonce: request.nonce }
  void workspace.refresh()
  void nextTick(flushPendingFile)
}

async function flushPendingFile(): Promise<void> {
  const request = pendingFile.value
  if (!request || !filesPane.value) return
  pendingFile.value = null
  if ('directory' in request) await filesPane.value.openDirectory(request.path)
  else if (request.owner === sessionId.value)
    await filesPane.value.openPreview(request)
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
    <PaneHeader class="workspace-header" data-app-drag>
      <template #title>
        <h2 class="workspace-title">{{ title }}</h2>
      </template>
      <template #actions>
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
        <IconButton shape="circle" label="关闭工作台" @click="close">
          <DsClose :size="14" />
        </IconButton>
      </template>
    </PaneHeader>
    <div class="workspace-body" :data-pane="pane">
      <WorkspaceLauncher
        v-if="pane === 'launcher'"
        :availability="availability"
        @open="selectPane"
      />
      <template v-else-if="pane === 'review' && (reviewReason || turnReview)">
        <EmptyState
          v-if="reviewReason"
          class="workspace-empty"
          variant="inline"
          :title="reviewReason"
        />
        <TurnReviewView
          v-else-if="turnReview"
          :request="turnReview"
          @close="turnReview = null"
        />
      </template>
      <template v-else-if="pane === 'terminal'">
        <TerminalPane
          v-if="hasProject"
          :session-id="sessionId"
          :visible="open"
          :focus-request="terminalFocus"
        />
        <EmptyState
          v-else
          class="workspace-empty"
          variant="inline"
          :title="NO_PROJECT_REASON"
        />
      </template>
      <!-- Drafts, open tabs and scroll positions survive pane switches. -->
      <KeepAlive>
        <GitReviewPane
          v-if="pane === 'review' && !reviewReason && !turnReview"
          :session-id="sessionId"
          :has-project="hasProject"
          :agent-busy="agentBusy"
          :visible="open"
          :focus-paths="reviewFilterPaths"
          :commit-focus="commitFocus"
          @commit-focused="commitFocus = 0"
        />
        <FilesPane
          v-else-if="pane === 'files'"
          ref="filesPane"
          :session-id="sessionId"
          :project-path="projectPath"
          :tree-width="filesTreeWidth"
          @tree-width="setFilesTreeWidth"
        />
      </KeepAlive>
      <!-- Hidden, not closed, behind the other panes (its page stays). -->
      <BrowserPane
        v-if="browserSession && browserSession === sessionId"
        v-show="pane === 'browser'"
        :key="sessionId"
        :visible="open && pane === 'browser'"
        :prefill="browserPrefill"
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
  background: rgb(var(--surface-base));
  color: rgb(var(--label-primary));
}

/* The 48px PaneHeader, pulled up 2px: its bottom (and hairline) meets the
   46px top bars of the rail, the sidebar and the conversation. */
.workspace-header {
  margin-top: calc(var(--shell-bar-h) - var(--pane-header-h));
}

.workspace-title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
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
  margin: 0 var(--space-4);
}
</style>
