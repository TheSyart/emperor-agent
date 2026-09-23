<script setup lang="ts">
/**
 * Sidebar column. Top to bottom: SidebarTopRow (collapse, ← →),
 * SidebarBrandRow (BrandMark + Emperor, search toggle, bell),
 * SidebarNav (新对话 + the full pages), the search capsule while
 * searching, then the session list — 置顶 (pinned, pin order), 项目
 * (projects → sessions), 对话 (chats grouped by day) — and SidebarFooter
 * (设置 / 明暗切换).
 * Collapsed, the column renders the 56px SidebarRail instead. Geometry is
 * owned by AppFrame; this fills the column it is given. The persisted
 * layout (sorts, orders, pins) lives in useSidebarState.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
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
import { DsClose, DsFolderClose, DsMore, DsPlus, DsSearch } from '../icons/ds'
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
import { useSidebarState } from './useSidebarState'
import { useSubagentCounts } from './subagentCounts'

const props = defineProps<{ collapsed: boolean; width: number }>()
const emit = defineEmits<{ toggle: [] }>()

const router = useRouter()
const ctx = useAppContext()
const subagents = useSubagentCounts()
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
const searchInput = ref<HTMLInputElement | null>(null)
const searchIndex = ref(0)
const creatingBuild = ref(false)
const projectMenuOpen = ref(false)
const projectMenuAnchor = ref<HTMLElement | null>(null)
const newProjectMenuOpen = ref(false)
const newProjectMenuAnchor = ref<HTMLElement | null>(null)
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
const runningSessionIds = computed(() =>
  Object.entries(ctx.sessionRuntimeStates)
    .filter(([, state]) => state.running)
    .map(([id]) => id),
)

watch(runningSessionIds, (ids) => subagents.sync(ids), { immediate: true })

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

async function newChat() {
  const session = await create({ mode: 'chat', title: '新会话' })
  openSession(session.id)
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

async function pickBuildProject(kind: 'empty' | 'existing') {
  if (creatingBuild.value) return
  creatingBuild.value = true
  try {
    const picked = await selectDirectory()
    const fallbackLabel =
      kind === 'empty'
        ? '输入已创建的空白项目文件夹路径'
        : '输入要绑定的项目文件夹路径'
    const path = (picked || window.prompt(fallbackLabel) || '').trim()
    if (!path) return
    const project = await resolveProject(path)
    const session = await create({
      mode: 'build',
      title: `构建 ${project.project_name}`,
      project,
    })
    openSession(session.id)
  } catch (err) {
    ctx.showToast(err instanceof Error ? err.message : String(err))
  } finally {
    creatingBuild.value = false
  }
}

function openNewProjectMenu(anchor: HTMLElement) {
  newProjectMenuAnchor.value = anchor
  newProjectMenuOpen.value = !newProjectMenuOpen.value
}

function firstOtherSession(id: string): SessionInfo | undefined {
  return sessions.value.find(
    (session) => session.id !== id && !session.archived_at,
  )
}

async function doDelete(id: string) {
  if (!isDraftSessionId(id) && !canDeletePersistedSession.value) {
    ctx.showToast('至少保留一个持久化会话')
    return
  }
  const wasActive = activeId.value === id
  const next = firstOtherSession(id)
  const removed = await remove(id)
  if (!removed) {
    ctx.showToast(sessionActionError.value || '删除会话失败')
    return
  }
  layout.forgetPinned(id)
  if (wasActive && next) openSession(next.id)
}

async function doArchive(id: string) {
  const wasActive = activeId.value === id
  const next = firstOtherSession(id)
  await archive(id, true)
  layout.forgetPinned(id)
  if (wasActive && next) openSession(next.id)
}

async function doRename(id: string, title: string) {
  await rename(id, title)
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

watch(searchQuery, () => {
  searchIndex.value = 0
})

onMounted(async () => {
  await Promise.all([
    layout.load(),
    sessions.value.length ? Promise.resolve() : load(),
  ])
})

defineExpose({ focusSearch })
</script>

<template>
  <SidebarRail
    v-if="collapsed"
    @toggle="emit('toggle')"
    @new-chat="newChat"
    @search="focusSearch"
  />
  <aside
    v-else
    class="sidebar-root"
    aria-label="会话侧栏"
    :style="{ width: `${width}px` }"
  >
    <SidebarTopRow @toggle="emit('toggle')" />
    <SidebarBrandRow :search-active="searchVisible" @search="toggleSearch" />
    <SidebarNav
      :project-menu-open="newProjectMenuOpen"
      @new-chat="newChat"
      @new-project="openNewProjectMenu"
    />

    <label
      v-if="searchVisible"
      class="search"
      :data-active="searching || undefined"
    >
      <DsSearch :size="14" class="search-icon" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="search"
        placeholder="搜索对话"
        aria-label="搜索对话"
        @keydown.down.prevent="moveSearch(1)"
        @keydown.up.prevent="moveSearch(-1)"
        @keydown.enter.prevent="commitSearch"
        @keydown.esc.prevent="escapeSearch"
        @blur="onSearchBlur"
      />
      <button
        v-if="searching"
        type="button"
        class="search-clear"
        aria-label="清除搜索"
        @mousedown.prevent
        @click="clearSearch"
      >
        <DsClose :size="12" />
      </button>
    </label>

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
            <SessionRow
              v-for="session in grouped.pinned"
              :key="session.id"
              pinned
              manual
              :session="session"
              :active="session.id === activeId"
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
        </section>

        <section
          v-if="sidebarState.section_order.includes('projects')"
          class="section"
        >
          <SidebarSectionHeader
            v-model:collapsed="projectsCollapsed"
            label="项目"
          >
            <button
              ref="projectMenuAnchor"
              type="button"
              class="head-button"
              aria-label="项目操作"
              :aria-expanded="projectMenuOpen"
              @click="projectMenuOpen = !projectMenuOpen"
            >
              <DsPlus :size="16" />
            </button>
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
                <SessionRow
                  v-for="session in project.sessions"
                  :key="session.id"
                  nested
                  :session="session"
                  :active="session.id === activeId"
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
                  @move="layout.moveProjectSession(project, session.id, $event)"
                />
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
            <button
              ref="chatMenuAnchor"
              type="button"
              class="head-button"
              aria-label="对话排序"
              :aria-expanded="chatMenuOpen"
              @click="chatMenuOpen = !chatMenuOpen"
            >
              <DsMore :size="16" />
            </button>
          </SidebarSectionHeader>
          <template v-if="!chatsCollapsed">
            <template v-for="group in chatDayGroups" :key="group.key">
              <div v-if="group.label" class="day-label">{{ group.label }}</div>
              <SessionRow
                v-for="session in group.sessions"
                :key="session.id"
                :session="session"
                :active="session.id === activeId"
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
            <div v-if="!grouped.chats.length" class="empty">暂无对话</div>
          </template>
        </section>
      </div>
    </div>

    <SidebarFooter />

    <Menu
      v-model:open="newProjectMenuOpen"
      :anchor="newProjectMenuAnchor"
      :width="220"
      placement="bottom"
      label="新建项目会话"
    >
      <template v-if="grouped.projects.length">
        <MenuItem variant="label">在项目中新建会话</MenuItem>
        <MenuItem
          v-for="project in grouped.projects.slice(0, 6)"
          :key="project.id"
          @select="newProjectSession(project)"
        >
          <template #icon><DsFolderClose :size="16" /></template>
          {{ project.name }}
        </MenuItem>
        <MenuItem variant="separator" />
      </template>
      <MenuItem
        :disabled="creatingBuild"
        @select="pickBuildProject('existing')"
      >
        选择项目文件夹…
      </MenuItem>
    </Menu>

    <Menu
      v-model:open="projectMenuOpen"
      :anchor="projectMenuAnchor"
      :width="200"
      label="项目操作"
    >
      <MenuItem :disabled="creatingBuild" @select="pickBuildProject('empty')">
        新建空白项目
      </MenuItem>
      <MenuItem
        :disabled="creatingBuild"
        @select="pickBuildProject('existing')"
      >
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
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  animation: ds-fade-in var(--duration-ds) var(--ease-in-out);
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
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  box-sizing: border-box;
  height: 30px;
  margin: 0 var(--space-0-5) var(--space-2);
  padding: 0 var(--space-1) 0 var(--space-2-5);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-cell);
  color: rgb(var(--label-caption));
  cursor: text;
  animation: ds-fade-in var(--duration-ds) var(--ease-in-out);
}

.search:focus-within,
.search[data-active] {
  border-color: var(--border-l3);
  color: rgb(var(--label-secondary));
}

.search input {
  flex: 1;
  width: 0;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.search input:focus {
  box-shadow: none;
}

.search input::placeholder {
  color: rgb(var(--label-caption));
}

.search input::-webkit-search-cancel-button {
  display: none;
}

.search-clear {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--space-5);
  height: var(--space-5);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.search-clear:hover {
  background: var(--interactive-bg-hover);
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
