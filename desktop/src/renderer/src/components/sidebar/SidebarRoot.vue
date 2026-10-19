<script setup lang="ts">
/**
 * Sidebar column (UI-S01): projects and chats only. Top to bottom: the 46px
 * SidebarBrandRow (Emperor + collapse; a window drag region), the search
 * capsule while searching, then the session list — 置顶 (pinned, pin order),
 * 项目 (projects → sessions), 对话 (chats grouped by day). New chat, search,
 * the full pages, the bell and settings live in the permanent rail
 * (SidebarRail, rendered by App beside this column). Geometry is owned by
 * AppFrame; this fills the column it is given and stays mounted (hidden by
 * App) while folded. The persisted layout (sorts, orders, pins) lives in
 * useSidebarState.
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
  searchSidebarSessions,
  sessionControlPendingTag,
  sessionRuntimeIndicator,
  type SidebarProjectGroup,
} from '../../runtime/sidebarModel'
import type { ProjectInfo, SessionInfo } from '../../types'
import { DsMore, DsPlus } from '../icons/ds'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import SessionRow from './SessionRow.vue'
import SidebarBrandRow from './SidebarBrandRow.vue'
import SidebarProjectRow from './SidebarProjectRow.vue'
import SidebarSearchResults from './SidebarSearchResults.vue'
import SidebarSectionHeader from './SidebarSectionHeader.vue'
import { useSidebarState } from './useSidebarState'
import { useAgentTree } from './agentTree'
import { fetchSessionLineage } from '../../api/sessions'

const props = defineProps<{ collapsed: boolean; width: number }>()
const emit = defineEmits<{ toggle: [] }>()

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
const pinnedCollapsed = ref(false)
const projectsCollapsed = ref(false)
const chatsCollapsed = ref(false)

const chatDayGroups = computed(() =>
  sidebarState.value.chat_sort === 'manual'
    ? [{ key: 'manual', label: '', sessions: grouped.value.chats }]
    : groupSessionsByDay(grouped.value.chats),
)
const searching = computed(() => searchQuery.value.trim().length > 0)
const searchVisible = computed(() => searchOpen.value || searching.value)
const searchResults = computed(() =>
  searchSidebarSessions(sessions.value, searchQuery.value),
)
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
// Opening a child reveals only its owning main row/project group.
watch(
  () => (layoutLoaded.value ? selectedRootId.value : ''),
  (root) => {
    if (!root) return
    if (grouped.value.pinned.some((session) => session.id === root))
      pinnedCollapsed.value = false
    const project = grouped.value.projects.find((item) =>
      item.sessions.some((session) => session.id === root),
    )
    if (project) {
      projectsCollapsed.value = false
      if (layout.isProjectCollapsed(project.id))
        layout.toggleProject(project.id)
    } else chatsCollapsed.value = false
  },
  { immediate: true },
)

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

function firstOtherSession(id: string): SessionInfo | undefined {
  return sessions.value.find(
    (session) => session.id !== id && !session.archived_at,
  )
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
  if (wasActive && next) openSession(next.id)
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
  if (wasActive && next) openSession(next.id)
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

watch(searchQuery, () => {
  searchIndex.value = 0
})

onMounted(async () => {
  await Promise.all([
    layout.load(),
    sessions.value.length ? Promise.resolve() : load(),
  ])
  layoutLoaded.value = true
})

defineExpose({ focusSearch })
</script>

<template>
  <aside
    class="sidebar-root"
    aria-label="会话侧栏"
    :style="{ width: `${width}px` }"
  >
    <SidebarBrandRow class="bar" @toggle="emit('toggle')" />

    <SearchField
      v-if="searchVisible"
      ref="searchInput"
      v-model="searchQuery"
      class="search"
      placeholder="搜索对话"
      @clear="clearSearch"
      @keydown.down.prevent="moveSearch(1)"
      @keydown.up.prevent="moveSearch(-1)"
      @keydown.enter.prevent="commitSearch"
      @keydown.esc.prevent="escapeSearch"
      @blur="onSearchBlur"
    />

    <div class="region">
      <div v-if="loading && !sessions.length" class="empty">加载中…</div>

      <SidebarSearchResults
        v-else-if="searching"
        :results="searchResults"
        :selected-index="searchIndex"
        @hover="searchIndex = $event"
        @open="openSearchResult"
      />

      <div v-else class="list">
        <section v-if="grouped.pinned.length" class="section" aria-label="置顶">
          <SidebarSectionHeader
            v-model:collapsed="pinnedCollapsed"
            label="置顶"
          />
          <template v-if="!pinnedCollapsed">
            <template v-for="session in grouped.pinned" :key="session.id">
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
          v-if="sidebarState.section_order.includes('projects')"
          class="section"
        >
          <SidebarSectionHeader
            v-model:collapsed="projectsCollapsed"
            label="项目"
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
          <template v-if="!projectsCollapsed">
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
          v-if="sidebarState.section_order.includes('chats')"
          class="section"
        >
          <SidebarSectionHeader v-model:collapsed="chatsCollapsed" label="对话">
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
          <template v-if="!chatsCollapsed">
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
      </div>
    </div>

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
  padding: 0 var(--space-3) var(--space-1-5);
  background: rgb(var(--sidebar-fill));
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  animation: ds-fade-in var(--duration-ds) var(--ease-in-out);
}

/* The top bar spans the column (it lines up with the traffic lights). */
.bar {
  margin: 0 calc(0px - var(--space-3)) var(--space-1);
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
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.head-button:hover,
.head-button[aria-expanded='true'] {
  background: var(--interactive-bg-hover);
}

.search {
  flex: none;
  width: auto;
  margin: 0 var(--space-0-5) var(--space-2);
  animation: ds-fade-in var(--duration-ds) var(--ease-in-out);
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
  color: rgb(var(--label-caption));
}

.empty {
  padding: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-caption));
}

.empty.nested {
  padding-left: calc(var(--space-2) + var(--space-5) + 2px);
}
</style>
