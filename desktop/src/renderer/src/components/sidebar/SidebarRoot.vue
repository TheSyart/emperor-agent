<script setup lang="ts">
/**
 * Sidebar column (UI-S11: Emperor's own layout, redesigned; per mode since
 * 0.3 MOD-02, docs/design/modes.md). Top to bottom: SidebarTopRow
 * (collapse, ← →), SidebarBrandRow (the mode switcher 「Emperor Chat ▾」,
 * search toggle, bell), SidebarNav (the mode's ⌘N primary row), the search
 * box while searching, then the current mode's sessions only — Chat: 置顶
 * (its pins) + 对话 by day; Build: 置顶 (its pins) + 项目 → sessions;
 * Group: a placeholder until the contact list and groups arrive (GRP-05) — and
 * SidebarFooter (设置, the page icons, 明暗切换). The mode and its
 * controller come from the app context, so the switcher, the rail and the
 * primary row run what ⌘1–⌘3 and ⌘N run. Search finds titles at once and
 * contents after a pause (useContentSearch), in every mode; ↑ / ↓ on a
 * focused row move to the next one and open it. Collapsed, the column
 * renders the 56px SidebarRail instead. Geometry is owned by AppFrame; this
 * fills the column it is given. The persisted layout (sorts, orders, pins,
 * folded projects and sections) lives in useSidebarState.
 *
 * Folded sections (BUG-06) only hide rows: search and ↑ / ↓ still reach
 * them, and a section opens again when the open conversation changes into
 * it. The conversation open at start-up keeps the sections as saved, and
 * folding the section of the open conversation keeps it folded.
 */
import { elementOf } from '../ui/elementOf'
import IconButton from '../ui/IconButton.vue'
import SearchField from '../ui/SearchField.vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { selectDirectory } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import { useSession } from '../../composables/useSession'
import { sessionLocation } from '../../router'
import {
  groupSessionsByDay,
  pinnedInMode,
  searchSidebarSessions,
  sessionControlPendingTag,
  sessionRuntimeIndicator,
  type SidebarProjectGroup,
} from '../../runtime/sidebarModel'
import {
  isListedSession,
  modeActivity,
  nextListedSession,
  type AppMode,
} from '../../runtime/appMode'
import type { ProjectInfo, SessionInfo, SidebarSectionKey } from '../../types'
import { DsMore, DsPlus } from '../icons/ds'
import EmptyState from '../ui/EmptyState.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import SessionRow from './SessionRow.vue'
import SidebarBrandRow from './SidebarBrandRow.vue'
import SidebarFooter from './SidebarFooter.vue'
import SidebarNav from './SidebarNav.vue'
import SidebarProjectRow from './SidebarProjectRow.vue'
import SidebarRail from './SidebarRail.vue'
import SidebarSearchResults from './SidebarSearchResults.vue'
import SidebarSectionHeader from './SidebarSectionHeader.vue'
import SidebarTopRow from './SidebarTopRow.vue'
import { useContentSearch } from './useContentSearch'
import { useSidebarState } from './useSidebarState'
import { useAgentTree } from './agentTree'
import { fetchSessionLineage } from '../../api/sessions'

const props = defineProps<{ collapsed: boolean; width: number }>()
const emit = defineEmits<{ toggle: [] }>()

/** Below this width the switcher shows the mode name only (modes.md). */
const COMPACT_WIDTH = 248

const router = useRouter()
const route = useRoute()
const ctx = useAppContext()
const subagents = useAgentTree()
const {
  sessions,
  projects,
  activeId,
  loading,
  canDeletePersistedSession,
  sessionActionError,
  load,
  create,
  resolveProject,
  remove,
  restoreDeleted,
  rename,
  archive,
  isDraftSessionId,
} = useSession()
const mode = computed(() => ctx.appMode.mode.value)
const layout = useSidebarState({
  sessions,
  projects,
  showToast: (message) => ctx.showToast(message),
})
const { state: sidebarState, grouped } = layout

const searchQuery = ref('')
const searchOpen = ref(false)
const searchInput = ref<InstanceType<typeof SearchField> | null>(null)
const searchIndex = ref(0)
const creatingBuild = ref(false)
const projectMenuOpen = ref(false)
const projectMenuAnchor = ref<HTMLElement | null>(null)
const chatMenuOpen = ref(false)
const chatMenuAnchor = ref<HTMLElement | null>(null)

/** 置顶 of the mode on screen; no header when the mode has no pins. */
const pinnedHere = computed(() =>
  pinnedInMode(grouped.value.pinned, mode.value),
)
/** Running / waiting per mode, for the switcher and the rail (MOD-02). */
const activity = computed(() =>
  modeActivity(sessions.value, {
    running: (id) => Boolean(ctx.sessionRuntimeStates[id]?.running),
    waiting: (session) =>
      Boolean(
        sessionControlPendingTag(session) ||
        ctx.pendingInteractionsBySession[session.id],
      ),
  }),
)
const chatDayGroups = computed(() =>
  sidebarState.value.chat_sort === 'manual'
    ? [{ key: 'manual', label: '', sessions: grouped.value.chats }]
    : groupSessionsByDay(grouped.value.chats),
)
const searching = computed(() => searchQuery.value.trim().length > 0)
const searchVisible = computed(() => searchOpen.value || searching.value)
const content = useContentSearch(searchQuery)
const searchResults = computed(() => {
  const titles = searchSidebarSessions(sessions.value, searchQuery.value)
  const seen = new Set(titles.map((result) => result.id))
  const known = new Map(sessions.value.map((session) => [session.id, session]))
  // A hit in a session nobody lists (a group member's, a trial) is dropped
  // (MOD-01); MOD-04 shows the group instead.
  const listable = (id: string) => {
    const session = known.get(id)
    return !session || isListedSession(session)
  }
  return [
    ...titles.map((result) => ({ ...result, group: 'title' as const })),
    ...content.hits.value
      .filter((hit) => !seen.has(hit.sessionId) && listable(hit.sessionId))
      .map((hit) => ({
        id: hit.sessionId,
        title: hit.title || '新会话',
        subtitle: `${hit.role === 'user' ? '你' : '助手'}：${hit.snippet}`,
        mode: 'chat' as const,
        group: 'content' as const,
      })),
  ]
})
const layoutLoaded = ref(false)
const visibleRootIds = computed(() =>
  sessions.value
    .filter((session) => !session.archived_at && !session.draft)
    .map((session) => session.id),
)
watch(visibleRootIds, (ids) => subagents.sync(ids), { immediate: true })
const selectedAgent = computed(() => {
  const id =
    route.name === 'external-agent'
      ? route.params.delegationId
      : route.params.sessionId
  if (typeof id !== 'string') return undefined
  for (const tree of Object.values(subagents.trees)) {
    const agent = tree.byId[id]
    if (
      agent &&
      (route.name !== 'external-agent' ||
        agent.rootSessionId === route.params.sessionId)
    )
      return agent
  }
  return undefined
})
const lineageRoot = ref('')
let selectionGeneration = 0
watch(
  () =>
    [
      route.name,
      route.params.sessionId,
      selectedAgent.value?.rootSessionId,
      sessions.value.length,
    ] as const,
  async ([name, id, indexedRoot]) => {
    const generation = ++selectionGeneration
    lineageRoot.value = ''
    if (
      name === 'external-agent' ||
      typeof id !== 'string' ||
      indexedRoot ||
      sessions.value.some((session) => session.id === id) ||
      isDraftSessionId(id)
    )
      return
    try {
      const lineage = await fetchSessionLineage(id)
      if (generation === selectionGeneration && lineage.chain.length > 1)
        lineageRoot.value = lineage.chain[0]!.sessionId
    } catch {
      /* A missing child must not select an unrelated root. */
    }
  },
  { immediate: true },
)
const selectedRootId = computed(() => {
  if (route.name === 'external-agent')
    return String(route.params.sessionId ?? '')
  if (selectedAgent.value) return selectedAgent.value.rootSessionId
  if (lineageRoot.value) return lineageRoot.value
  const id = route.params.sessionId
  return typeof id === 'string' ? id : activeId.value
})
/** Where the open conversation's main row is (null while it has none). */
const selectedPlace = computed<{
  root: string
  section: SidebarSectionKey
  projectId?: string
} | null>(() => {
  const root = layoutLoaded.value ? selectedRootId.value : ''
  if (!root) return null
  // Only the sections on screen (the current mode's) are revealed.
  if (pinnedHere.value.some((session) => session.id === root))
    return { root, section: 'pinned' }
  if (mode.value === 'build') {
    const project = grouped.value.projects.find((item) =>
      item.sessions.some((session) => session.id === root),
    )
    if (project) return { root, section: 'projects', projectId: project.id }
  }
  if (
    mode.value === 'chat' &&
    grouped.value.chats.some((session) => session.id === root)
  )
    return { root, section: 'chats' }
  return null
})
/** The conversation last revealed; the open one once the layout loads. */
let revealedRoot = ''
// Opening a child reveals only its owning main row/project group; its
// section opens only when the open conversation changed (BUG-06).
watch(
  () => {
    const place = selectedPlace.value
    return place ? [place.root, place.section, place.projectId].join('\0') : ''
  },
  () => {
    const place = selectedPlace.value
    if (!place) return
    if (place.projectId && layout.isProjectCollapsed(place.projectId))
      layout.toggleProject(place.projectId)
    if (place.root === revealedRoot) return
    revealedRoot = place.root
    if (layout.isSectionCollapsed(place.section))
      layout.toggleSection(place.section)
  },
)
/** The mode's main rows in list order, folded sections included (↑ / ↓). */
const keyboardOrder = computed(() => [
  ...pinnedHere.value.map((session) => session.id),
  ...(mode.value === 'build'
    ? grouped.value.projects.flatMap((project) =>
        layout.isProjectCollapsed(project.id)
          ? []
          : project.sessions.map((session) => session.id),
      )
    : []),
  ...(mode.value === 'chat'
    ? chatDayGroups.value.flatMap((group) =>
        group.sessions.map((session) => session.id),
      )
    : []),
])

function indicator(session: SessionInfo) {
  return sessionRuntimeIndicator(
    ctx.sessionRuntimeStates[session.id],
    sessionControlPendingTag(session),
  )
}

function pendingLabel(session: SessionInfo): string {
  return sessionControlPendingTag(session)?.label || ''
}

function canDelete(session: SessionInfo): boolean {
  return Boolean(session.draft) || canDeletePersistedSession.value
}

function openSession(id: string) {
  void router.push(sessionLocation(id)).catch(() => undefined)
}

/** The primary row and the rail: exactly what ⌘N runs (App.vue). */
function newSession(): Promise<void> {
  return ctx.runSafely(ctx.appMode.newSession)
}

function switchMode(next: AppMode): Promise<void> {
  return ctx.runSafely(() => ctx.appMode.switchTo(next))
}

/** The + of the primary row: Build opens a folder; Group a new contact (GRP-04). */
function runSecondary(): void {
  if (mode.value === 'build') void pickBuildProject()
  else if (mode.value === 'group')
    void router.push({ name: 'contact-new' }).catch(() => undefined)
}

async function newProjectSession(project: SidebarProjectGroup) {
  const session = await create({
    mode: 'build',
    title: '新会话',
    project: {
      project_id: project.id,
      project_path: project.path,
      project_name: project.name,
    } as ProjectInfo,
  })
  openSession(session.id)
}

async function pickBuildProject() {
  if (creatingBuild.value) return
  creatingBuild.value = true
  try {
    // Cancelling the folder picker does nothing (Electron has no
    // window.prompt; the old typed-path fallback threw into a toast).
    const path = ((await selectDirectory()) ?? '').trim()
    if (!path) return
    const project = await resolveProject(path)
    const session = await create({
      mode: 'build',
      title: `构建 ${project.project_name}`,
      project,
    })
    openSession(session.id)
  } catch (err) {
    ctx.showError(err)
  } finally {
    creatingBuild.value = false
  }
}

/**
 * Where to go when the open session `id` goes away: another listed session
 * of the mode on screen; undefined means the mode's home (MOD-02), never a
 * jump into another mode.
 */
function firstOtherSession(id: string): SessionInfo | undefined {
  return nextListedSession(sessions.value, { mode: mode.value, exclude: id })
}

/** After a delete or an archive of the open session. */
async function leaveRemoved(next: SessionInfo | undefined): Promise<void> {
  if (next) openSession(next.id)
  else await newSession()
}

/** How long 「撤销」 stays offered after a delete (FIX-01). */
const UNDO_DELETE_MS = 10_000

async function doDelete(id: string) {
  if (!isDraftSessionId(id) && !canDeletePersistedSession.value) {
    ctx.showToast('至少保留一个持久化会话')
    return
  }
  const draft = isDraftSessionId(id)
  const title = sessions.value.find((s) => s.id === id)?.title || '会话'
  const wasActive = activeId.value === id
  const wasPinned = layout.state.value.pinned_session_ids.includes(id)
  const next = firstOtherSession(id)
  const removed = await remove(id)
  if (!removed) {
    ctx.showError(sessionActionError.value || '未知错误', '删除失败')
    return
  }
  layout.forgetPinned(id)
  if (wasActive) await leaveRemoved(next)
  if (draft) return
  // Deleted sessions wait in 最近删除 (30 days); undo puts this one back.
  ctx.showToast(`已删除「${title}」`, {
    durationMs: UNDO_DELETE_MS,
    action: {
      label: '撤销',
      run: async () => {
        const restored = await restoreDeleted(id)
        if (!restored) {
          ctx.showError(sessionActionError.value || '未知错误', '撤销删除失败')
          return
        }
        if (wasPinned) layout.togglePin(id)
        if (wasActive) openSession(id)
      },
    },
  })
}

async function doArchive(id: string) {
  const wasActive = activeId.value === id
  const next = firstOtherSession(id)
  // A failed archive leaves the pin and the page alone and says why.
  if (!(await archive(id, true))) {
    ctx.showError(sessionActionError.value || '未知错误', '归档失败')
    return
  }
  layout.forgetPinned(id)
  if (wasActive) await leaveRemoved(next)
}

async function doRename(id: string, title: string) {
  // The row keeps its old title (it changes only on success).
  if (!(await rename(id, title)))
    ctx.showError(sessionActionError.value || '未知错误', '重命名失败')
}

function focusSearch() {
  if (props.collapsed) emit('toggle')
  searchOpen.value = true
  void nextTick(() => searchInput.value?.focus())
}

/** Brand-row search icon: open + focus, or close an empty capsule. */
function toggleSearch() {
  if (searchVisible.value && !searching.value) {
    searchOpen.value = false
    return
  }
  focusSearch()
}

function clearSearch() {
  searchQuery.value = ''
  searchIndex.value = 0
}

/** Esc: clear the query, then close the capsule. */
function escapeSearch() {
  if (searching.value) {
    clearSearch()
    return
  }
  searchOpen.value = false
  searchInput.value?.blur()
}

function onSearchBlur() {
  if (!searching.value) searchOpen.value = false
}

function moveSearch(delta: number) {
  const count = searchResults.value.length
  if (!count) return
  searchIndex.value = (searchIndex.value + delta + count) % count
}

function openSearchResult(id: string) {
  clearSearch()
  searchOpen.value = false
  openSession(id)
}

function commitSearch() {
  const result = searchResults.value[searchIndex.value]
  if (result) openSearchResult(result.id)
}

/**
 * ↑ / ↓ on a focused row: open the next main row in list order and focus
 * it. A row of a folded section has no element yet: it takes the focus
 * once opening it has unfolded the section.
 */
async function moveRow(event: KeyboardEvent, delta: -1 | 1): Promise<void> {
  const row = event.target as HTMLElement | null
  if (!row?.classList.contains('session-row')) return
  event.preventDefault()
  const list = event.currentTarget as HTMLElement
  const order = keyboardOrder.value
  const index = order.indexOf(row.dataset.sessionId ?? '')
  const id = index < 0 ? undefined : order[index + delta]
  if (!id) return
  const rowOf = () =>
    [...list.querySelectorAll<HTMLElement>('.session-row')].find(
      (element) => element.dataset.sessionId === id,
    )
  const next = rowOf()
  next?.focus()
  await router.push(sessionLocation(id)).catch(() => undefined)
  if (next) return
  await nextTick()
  rowOf()?.focus()
}

watch(searchQuery, () => {
  searchIndex.value = 0
})

onMounted(async () => {
  await Promise.all([
    layout.load(),
    sessions.value.length ? Promise.resolve() : load(),
  ])
  layoutLoaded.value = true
  revealedRoot = selectedRootId.value
})

defineExpose({ focusSearch })
</script>

<template>
  <SidebarRail
    v-if="collapsed"
    :mode="mode"
    :activity="activity"
    @toggle="emit('toggle')"
    @new-session="newSession"
    @search="focusSearch"
    @select-mode="switchMode"
  />
  <aside
    v-else
    class="sidebar-root"
    aria-label="会话侧栏"
    :style="{ width: `${width}px` }"
  >
    <SidebarTopRow data-sidebar-block="top" @toggle="emit('toggle')" />
    <SidebarBrandRow
      data-sidebar-block="brand"
      :search-active="searchVisible"
      :mode="mode"
      :activity="activity"
      :compact="width < COMPACT_WIDTH"
      @search="toggleSearch"
      @select-mode="switchMode"
    />
    <SidebarNav
      :mode="mode"
      @new-session="newSession"
      @secondary="runSecondary"
    />

    <SearchField
      v-if="searchVisible"
      ref="searchInput"
      v-model="searchQuery"
      class="search"
      placeholder="搜索会话标题和内容"
      aria-label="搜索对话"
      @clear="clearSearch"
      @keydown.down.prevent="moveSearch(1)"
      @keydown.up.prevent="moveSearch(-1)"
      @keydown.enter.prevent="commitSearch"
      @keydown.esc.prevent="escapeSearch"
      @blur="onSearchBlur"
    />

    <div class="region" data-sidebar-block="sections">
      <div v-if="loading && !sessions.length" class="empty">加载中…</div>

      <SidebarSearchResults
        v-else-if="searching"
        :results="searchResults"
        :pending="content.pending.value"
        :selected-index="searchIndex"
        @hover="searchIndex = $event"
        @open="openSearchResult"
      />

      <div
        v-else
        class="list"
        @keydown.down="moveRow($event, 1)"
        @keydown.up="moveRow($event, -1)"
      >
        <section
          v-if="pinnedHere.length"
          class="section"
          aria-label="置顶"
          data-sidebar-section="pinned"
        >
          <SidebarSectionHeader
            :collapsed="layout.isSectionCollapsed('pinned')"
            label="置顶"
            @update:collapsed="layout.toggleSection('pinned')"
          />
          <template v-if="!layout.isSectionCollapsed('pinned')">
            <template v-for="session in pinnedHere" :key="session.id">
              <SessionRow
                pinned
                manual
                :session="session"
                :active="session.id === selectedRootId"
                :indicator="indicator(session)"
                :pending-label="pendingLabel(session)"
                :subagents="subagents.counts[session.id] || 0"
                :can-delete="canDelete(session)"
                @open="openSession(session.id)"
                @rename="doRename(session.id, $event)"
                @pin="layout.togglePin(session.id)"
                @archive="doArchive(session.id)"
                @delete="doDelete(session.id)"
                @move="layout.movePinned(session.id, $event)"
              />
            </template>
          </template>
        </section>

        <section
          v-if="mode === 'build'"
          class="section"
          data-sidebar-section="projects"
        >
          <SidebarSectionHeader
            :collapsed="layout.isSectionCollapsed('projects')"
            label="项目"
            @update:collapsed="layout.toggleSection('projects')"
          >
            <IconButton
              :ref="(c) => (projectMenuAnchor = elementOf(c))"
              class="head-button"
              label="项目操作"
              size="xs"
              :active="projectMenuOpen"
              :aria-expanded="projectMenuOpen"
              @click="projectMenuOpen = !projectMenuOpen"
            >
              <DsPlus :size="16" />
            </IconButton>
          </SidebarSectionHeader>
          <template v-if="!layout.isSectionCollapsed('projects')">
            <template v-for="project in grouped.projects" :key="project.id">
              <SidebarProjectRow
                :project="project"
                :collapsed="layout.isProjectCollapsed(project.id)"
                @toggle="layout.toggleProject(project.id)"
                @new-session="newProjectSession(project)"
              />
              <template v-if="!layout.isProjectCollapsed(project.id)">
                <template v-for="session in project.sessions" :key="session.id">
                  <SessionRow
                    nested
                    :session="session"
                    :active="session.id === selectedRootId"
                    :indicator="indicator(session)"
                    :pending-label="pendingLabel(session)"
                    :subagents="subagents.counts[session.id] || 0"
                    :can-delete="canDelete(session)"
                    :manual="sidebarState.project_sort === 'manual'"
                    @open="openSession(session.id)"
                    @rename="doRename(session.id, $event)"
                    @pin="layout.togglePin(session.id)"
                    @archive="doArchive(session.id)"
                    @delete="doDelete(session.id)"
                    @move="
                      layout.moveProjectSession(project, session.id, $event)
                    "
                  />
                </template>
                <div v-if="!project.sessions.length" class="empty nested">
                  暂无会话
                </div>
              </template>
            </template>
            <div v-if="!grouped.projects.length" class="empty">
              还没有绑定项目
            </div>
          </template>
        </section>

        <section
          v-if="mode === 'chat'"
          class="section"
          data-sidebar-section="chats"
        >
          <SidebarSectionHeader
            :collapsed="layout.isSectionCollapsed('chats')"
            label="对话"
            @update:collapsed="layout.toggleSection('chats')"
          >
            <IconButton
              :ref="(c) => (chatMenuAnchor = elementOf(c))"
              class="head-button"
              label="对话排序"
              size="xs"
              :active="chatMenuOpen"
              :aria-expanded="chatMenuOpen"
              @click="chatMenuOpen = !chatMenuOpen"
            >
              <DsMore :size="16" />
            </IconButton>
          </SidebarSectionHeader>
          <template v-if="!layout.isSectionCollapsed('chats')">
            <template v-for="group in chatDayGroups" :key="group.key">
              <div v-if="group.label" class="day-label">{{ group.label }}</div>
              <template v-for="session in group.sessions" :key="session.id">
                <SessionRow
                  :session="session"
                  :active="session.id === selectedRootId"
                  :indicator="indicator(session)"
                  :pending-label="pendingLabel(session)"
                  :subagents="subagents.counts[session.id] || 0"
                  :can-delete="canDelete(session)"
                  :manual="sidebarState.chat_sort === 'manual'"
                  @open="openSession(session.id)"
                  @rename="doRename(session.id, $event)"
                  @pin="layout.togglePin(session.id)"
                  @archive="doArchive(session.id)"
                  @delete="doDelete(session.id)"
                  @move="layout.moveChat(session.id, $event)"
                />
              </template>
            </template>
            <div v-if="!grouped.chats.length" class="empty">暂无对话</div>
          </template>
        </section>

        <!-- Group: the contact list and groups arrive with GRP-05. -->
        <section
          v-if="mode === 'group'"
          class="section"
          aria-label="群聊"
          data-sidebar-section="group"
        >
          <EmptyState
            title="联系人和群聊在这里"
            description="点 + 新建联系人；拉群聊即将推出"
          />
        </section>
      </div>
    </div>

    <SidebarFooter data-sidebar-block="footer" />

    <Menu
      v-model:open="projectMenuOpen"
      :anchor="projectMenuAnchor"
      :width="200"
      label="项目操作"
    >
      <MenuItem :disabled="creatingBuild" @select="pickBuildProject()">
        新建空白项目
      </MenuItem>
      <MenuItem :disabled="creatingBuild" @select="pickBuildProject()">
        使用现有文件夹
      </MenuItem>
      <MenuItem variant="separator" />
      <MenuItem variant="label">排序</MenuItem>
      <MenuItem
        :selected="sidebarState.project_sort === 'updated_at'"
        @select="layout.setProjectSort('updated_at')"
      >
        更新时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.project_sort === 'created_at'"
        @select="layout.setProjectSort('created_at')"
      >
        创建时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.project_sort === 'manual'"
        @select="layout.setProjectSort('manual')"
      >
        手动排序
      </MenuItem>
    </Menu>

    <Menu
      v-model:open="chatMenuOpen"
      :anchor="chatMenuAnchor"
      :width="180"
      label="对话排序"
    >
      <MenuItem variant="label">排序</MenuItem>
      <MenuItem
        :selected="sidebarState.chat_sort === 'updated_at'"
        @select="layout.setChatSort('updated_at')"
      >
        更新时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.chat_sort === 'created_at'"
        @select="layout.setChatSort('created_at')"
      >
        创建时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.chat_sort === 'manual'"
        @select="layout.setChatSort('manual')"
      >
        手动排序
      </MenuItem>
    </Menu>
  </aside>
</template>

<style scoped>
.sidebar-root {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-width: 0;
  padding: var(--space-1-5) var(--space-3);
  background: rgb(var(--sidebar-fill));
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  animation: ds-fade-in var(--motion-base) var(--ease-standard);
}

.head-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--text-2));
  cursor: pointer;
}

.head-button:hover,
.head-button[aria-expanded='true'] {
  background: var(--surface-hover);
}

.search {
  flex: none;
  width: auto;
  margin: 0 var(--space-0-5) var(--space-2);
  animation: ds-fade-in var(--motion-base) var(--ease-standard);
}

.region {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  margin-right: calc(0px - var(--space-3));
}

.list {
  flex: 1;
  min-height: 0;
  padding-right: var(--space-2);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.section + .section {
  margin-top: var(--space-2);
}

.day-label {
  padding: var(--space-2) var(--space-2) var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.empty {
  padding: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
}

.empty.nested {
  padding-left: calc(var(--space-2) + var(--space-5) + 2px);
}
</style>
