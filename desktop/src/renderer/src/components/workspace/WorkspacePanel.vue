<script setup lang="ts">
/**
 * WorkspacePanel — the AppFrame's right workspace panel: a PaneHeader (the
 * segmented pane switch 审查 / 终端 / 文件 / 浏览器 on the left, close on
 * the right; the pane name is the region's hidden heading) over one pane
 * body. The 48px PaneHeader is pulled up 2px so its bottom meets the
 * conversation header's 46px row. The column opens on the pane used last;
 * before any pane has been chosen the body is WorkspaceEmpty (the four panes
 * with their shortcuts) — there is no launcher home to go back to (UI-S06).
 * Every pane is its own async chunk (xterm, the file highlighter and the
 * diff views stay out of the shell bundle). The AppFrame owns the column
 * width and drag handle; this fills whatever the column gives and stays
 * mounted while the column is closed.
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
 * Temporary views (UI-S13): a request with `view` (the environment card's
 * 来源) shows that component over the body without choosing a pane — no
 * tab is selected, the pane used last stays remembered and the hidden
 * heading takes the view's title. Picking a pane, any later request, its
 * 返回 (`close`), closing the column or leaving its chat closes it; 审查
 * and 文件 keep their state underneath (KeepAlive) and the native browser
 * view hides meanwhile.
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
import Tabs from '../ui/Tabs.vue'
import type { TabItem } from '../ui/blockTypes'
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  ref,
  shallowRef,
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
import WorkspaceEmpty from './WorkspaceEmpty.vue'
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot'
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
  type WorkspaceView,
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
const {
  sessionId,
  viewedSessionId,
  projectPath,
  snapshot,
  hasProject,
  hasGit,
} = workspace

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
/** A temporary view over the pane (never a pane of its own). */
const view = shallowRef<WorkspaceView | null>(null)
const title = computed(
  () => view.value?.title ?? workspacePaneTitle(pane.value),
)
function closeView(): void {
  view.value = null
}
const availability = computed<WorkspaceAvailability>(() => ({
  hasProject: hasProject.value,
  snapshotLoaded: Boolean(snapshot.value),
  hasGit: hasGit.value,
}))
/** The pane switch; a disabled pane says why on hover. */
const paneTabs = computed<TabItem[]>(() =>
  WORKSPACE_PANE_ITEMS.map((item) => {
    const reason = workspacePaneDisabledReason(item.pane, availability.value)
    return {
      id: item.pane,
      label: item.label,
      disabled: Boolean(reason),
      ...(reason ? { title: reason } : {}),
    }
  }),
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
// A temporary view belongs to its chat and to this visit of the column.
watch([sessionId, viewedSessionId], ([session, viewed]) => {
  const owner = view.value?.sessionId
  if (owner !== undefined && owner !== session && owner !== viewed) closeView()
})
watch(
  () => props.open,
  (isOpen) => !isOpen && closeView(),
)
// Focus / prefill requests are one-shot: they target the pane showing now.
watch(pane, (next) => {
  closeView()
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
  view.value = request.view ?? null
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
    if (ownsFiles(next.owner)) pendingFile.value = next
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
  else if (ownsFiles(request.owner)) await filesPane.value.openPreview(request)
}

/** The active session, or the child log on screen (its files open here). */
function ownsFiles(owner: string): boolean {
  return owner === sessionId.value || owner === viewedSessionId.value
}

function selectPane(target: string): void {
  closeView()
  frameActions.setWorkspacePane(frame, target as WorkspaceContentPane)
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
    <PaneHeader class="workspace-header">
      <template #tabs>
        <h2 class="workspace-title sr-only">{{ title }}</h2>
        <Tabs
          class="workspace-panes"
          variant="segmented"
          :tabs="paneTabs"
          :model-value="view || pane === 'launcher' ? '' : pane"
          aria-label="工作台面板"
          @update:model-value="selectPane"
        />
      </template>
      <template #actions>
        <IconButton shape="circle" label="关闭工作台" @click="close">
          <DsClose :size="14" />
        </IconButton>
      </template>
    </PaneHeader>
    <div class="workspace-body" :data-pane="view ? 'view' : pane">
      <component
        :is="view.component"
        v-if="view"
        v-bind="view.props.value"
        @close="closeView"
      />
      <WorkspaceEmpty
        v-else-if="pane === 'launcher'"
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
          v-if="!view && pane === 'review' && !reviewReason && !turnReview"
          :session-id="sessionId"
          :has-project="hasProject"
          :agent-busy="agentBusy"
          :visible="open"
          :focus-paths="reviewFilterPaths"
          :commit-focus="commitFocus"
          @commit-focused="commitFocus = 0"
        />
        <FilesPane
          v-else-if="!view && pane === 'files'"
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
        v-show="!view && pane === 'browser'"
        :key="sessionId"
        :visible="open && !view && pane === 'browser'"
        :prefill="browserPrefill"
      />
    </div>
  </div>
</template>

<style scoped>
/* Visually hidden, still announced (the Tailwind utility of the same name
   is gone with DS-02). */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}

.workspace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

/* The 48px PaneHeader, pulled up 2px: its bottom (and hairline) meets the
   conversation header's 46px row. */
.workspace-header {
  margin-top: calc(var(--shell-bar-h) - var(--pane-header-h));
}

/* The segmented switch starts where a title would (PaneHeader's left
   inset): the header has no other title. */
.workspace-header :deep(.tabs) {
  align-items: center;
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
