<script setup lang="ts">
/**
 * Sidebar column (dsh SidebarRoot + WorkspaceBrowser): logo row with the
 * collapse toggle, the 38px New chat bar, a search capsule, the session list
 * (projects → sessions, chats grouped by day) and the settings/theme foot.
 * Collapsed, the column renders the 56px SidebarRail instead. Geometry is
 * owned by AppFrame; this fills the column it is given.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { core } from '../../api/http'
import { selectDirectory } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import { useSession } from '../../composables/useSession'
import { sessionLocation } from '../../router'
import {
  buildSidebarGroups,
  completeManualOrder,
  defaultSidebarState,
  groupSessionsByDay,
  moveId,
  normalizeSidebarState,
  searchSidebarSessions,
  sessionControlPendingTag,
  sessionRuntimeIndicator,
  type SidebarProjectGroup,
} from '../../runtime/sidebarModel'
import type {
  ProjectInfo,
  SessionInfo,
  SidebarSortMode,
  SidebarState,
} from '../../types'
import BrandMark from '../brand/BrandMark.vue'
import {
  DsChevronRight,
  DsFolderClose,
  DsFolderOpen,
  DsMore,
  DsNewChat,
  DsPanelLeft,
  DsPlus,
  DsSearch,
  DsClose,
} from '../icons/ds'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import Tooltip from '../ui/Tooltip.vue'
import SessionRow from './SessionRow.vue'
import SidebarFooter from './SidebarFooter.vue'
import SidebarRail from './SidebarRail.vue'
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

const sidebarState = ref<SidebarState>({ ...defaultSidebarState })
const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const searchIndex = ref(0)
const creatingBuild = ref(false)
const projectMenuOpen = ref(false)
const projectMenuAnchor = ref<HTMLElement | null>(null)
const chatMenuOpen = ref(false)
const chatMenuAnchor = ref<HTMLElement | null>(null)
const projectsCollapsed = ref(false)
const chatsCollapsed = ref(false)

const grouped = computed(() =>
  buildSidebarGroups(sessions.value, sidebarState.value, projects.value),
)
const chatDayGroups = computed(() =>
  sidebarState.value.chat_sort === 'manual'
    ? [{ key: 'manual', label: '', sessions: grouped.value.chats }]
    : groupSessionsByDay(grouped.value.chats),
)
const searching = computed(() => searchQuery.value.trim().length > 0)
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

async function loadSidebarState() {
  try {
    sidebarState.value = normalizeSidebarState(await core('sidebar.get'))
  } catch {
    sidebarState.value = { ...defaultSidebarState }
  }
}

async function patchSidebarState(update: Partial<SidebarState>) {
  const next = normalizeSidebarState({ ...sidebarState.value, ...update })
  sidebarState.value = next
  try {
    sidebarState.value = normalizeSidebarState(
      await core('sidebar.patch', update),
    )
  } catch {
    sidebarState.value = next
  }
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
  if (wasActive && next) openSession(next.id)
}

async function doArchive(id: string) {
  const wasActive = activeId.value === id
  const next = firstOtherSession(id)
  await archive(id, true)
  if (wasActive && next) openSession(next.id)
}

async function doRename(id: string, title: string) {
  await rename(id, title)
}

function setProjectSort(mode: SidebarSortMode) {
  void patchSidebarState({ project_sort: mode })
}

function setChatSort(mode: SidebarSortMode) {
  void patchSidebarState({ chat_sort: mode })
}

function isProjectCollapsed(projectId: string) {
  return sidebarState.value.collapsed_project_ids.includes(projectId)
}

function toggleProject(projectId: string) {
  const current = sidebarState.value.collapsed_project_ids
  const next = current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId]
  void patchSidebarState({ collapsed_project_ids: next })
}

function moveChat(sessionId: string, delta: -1 | 1) {
  const ids = grouped.value.chats.map((session) => session.id)
  void patchSidebarState({
    chat_sort: 'manual',
    chat_order: moveId(
      completeManualOrder(sidebarState.value.chat_order, ids),
      sessionId,
      delta,
    ),
  })
}

function moveProjectSession(
  project: SidebarProjectGroup,
  sessionId: string,
  delta: -1 | 1,
) {
  const current = sidebarState.value.project_session_order
  const order = completeManualOrder(
    current[project.id] || [],
    project.sessions.map((session) => session.id),
  )
  void patchSidebarState({
    project_sort: 'manual',
    project_session_order: {
      ...current,
      [project.id]: moveId(order, sessionId, delta),
    },
  })
}

function focusSearch() {
  if (props.collapsed) emit('toggle')
  void nextTick(() => searchInput.value?.focus())
}

function clearSearch() {
  searchQuery.value = ''
  searchIndex.value = 0
}

function moveSearch(delta: number) {
  const count = searchResults.value.length
  if (!count) return
  searchIndex.value = (searchIndex.value + delta + count) % count
}

function commitSearch() {
  const result = searchResults.value[searchIndex.value]
  if (!result) return
  clearSearch()
  openSession(result.id)
}

watch(searchQuery, () => {
  searchIndex.value = 0
})

onMounted(async () => {
  await Promise.all([
    loadSidebarState(),
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
    <div class="logo-row">
      <button type="button" class="brand" aria-label="新对话" @click="newChat">
        <BrandMark :size="24" />
        <span class="brand-name">Emperor</span>
      </button>
      <Tooltip label="收起侧栏" :delay-ms="500">
        <button
          type="button"
          class="head-button"
          aria-label="收起侧栏"
          @click="emit('toggle')"
        >
          <DsPanelLeft :size="16" />
        </button>
      </Tooltip>
    </div>

    <button type="button" class="new-session" @click="newChat">
      <DsNewChat :size="14" />
      <span>新对话</span>
    </button>

    <label class="search" :data-active="searching || undefined">
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
        @keydown.esc.prevent="clearSearch"
      />
      <button
        v-if="searching"
        type="button"
        class="search-clear"
        aria-label="清除搜索"
        @click="clearSearch"
      >
        <DsClose :size="12" />
      </button>
    </label>

    <div class="region">
      <div v-if="loading && !sessions.length" class="empty">加载中…</div>

      <div
        v-else-if="searching"
        class="list"
        role="listbox"
        aria-label="搜索结果"
      >
        <button
          v-for="(result, index) in searchResults"
          :key="result.id"
          type="button"
          class="search-result"
          :data-selected="index === searchIndex || undefined"
          @mouseenter="searchIndex = index"
          @click="(clearSearch(), openSession(result.id))"
        >
          <span class="search-title">{{ result.title }}</span>
          <span class="search-meta">{{ result.subtitle }}</span>
        </button>
        <div v-if="!searchResults.length" class="empty">没有匹配的会话</div>
      </div>

      <div v-else class="list">
        <section
          v-if="sidebarState.section_order.includes('projects')"
          class="section"
        >
          <header class="section-header">
            <button
              type="button"
              class="section-label"
              :aria-expanded="!projectsCollapsed"
              @click="projectsCollapsed = !projectsCollapsed"
            >
              项目
            </button>
            <div class="section-actions">
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
            </div>
          </header>
          <template v-if="!projectsCollapsed">
            <template v-for="project in grouped.projects" :key="project.id">
              <div
                class="project-row"
                role="button"
                tabindex="0"
                :title="project.path"
                :aria-expanded="!isProjectCollapsed(project.id)"
                @click="toggleProject(project.id)"
                @keydown.enter.self="toggleProject(project.id)"
              >
                <span class="slot">
                  <DsChevronRight
                    :size="14"
                    class="chevron"
                    :data-open="!isProjectCollapsed(project.id) || undefined"
                  />
                  <component
                    :is="
                      isProjectCollapsed(project.id)
                        ? DsFolderClose
                        : DsFolderOpen
                    "
                    :size="16"
                    class="folder"
                  />
                </span>
                <span class="project-name">{{ project.name }}</span>
                <span class="project-count">{{ project.sessions.length }}</span>
                <button
                  type="button"
                  class="row-action"
                  aria-label="新建该项目会话"
                  title="新建该项目会话"
                  @click.stop="newProjectSession(project)"
                >
                  <DsNewChat :size="14" />
                </button>
              </div>
              <template v-if="!isProjectCollapsed(project.id)">
                <SessionRow
                  v-for="session in project.sessions"
                  :key="session.id"
                  nested
                  :session="session"
                  :active="session.id === activeId"
                  :indicator="indicator(session)"
                  :pending-label="pendingLabel(session)"
                  :subagents="subagents.counts[session.id] || 0"
                  :can-delete="
                    Boolean(session.draft) || canDeletePersistedSession
                  "
                  :manual="sidebarState.project_sort === 'manual'"
                  @open="openSession(session.id)"
                  @rename="doRename(session.id, $event)"
                  @archive="doArchive(session.id)"
                  @delete="doDelete(session.id)"
                  @move="moveProjectSession(project, session.id, $event)"
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
          <header class="section-header">
            <button
              type="button"
              class="section-label"
              :aria-expanded="!chatsCollapsed"
              @click="chatsCollapsed = !chatsCollapsed"
            >
              对话
            </button>
            <div class="section-actions">
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
            </div>
          </header>
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
                :can-delete="
                  Boolean(session.draft) || canDeletePersistedSession
                "
                :manual="sidebarState.chat_sort === 'manual'"
                @open="openSession(session.id)"
                @rename="doRename(session.id, $event)"
                @archive="doArchive(session.id)"
                @delete="doDelete(session.id)"
                @move="moveChat(session.id, $event)"
              />
            </template>
            <div v-if="!grouped.chats.length" class="empty">暂无对话</div>
          </template>
        </section>
      </div>
    </div>

    <SidebarFooter />

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
        @select="setProjectSort('updated_at')"
      >
        更新时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.project_sort === 'created_at'"
        @select="setProjectSort('created_at')"
      >
        创建时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.project_sort === 'manual'"
        @select="setProjectSort('manual')"
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
        @select="setChatSort('updated_at')"
      >
        更新时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.chat_sort === 'created_at'"
        @select="setChatSort('created_at')"
      >
        创建时间
      </MenuItem>
      <MenuItem
        :selected="sidebarState.chat_sort === 'manual'"
        @select="setChatSort('manual')"
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

.logo-row {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  height: 60px;
  margin-bottom: var(--space-2);
  padding: var(--space-2) 0 var(--space-2) var(--space-1);
  overflow: hidden;
}

.brand {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.brand-name {
  overflow: hidden;
  font-size: 18px;
  font-weight: 600;
  line-height: var(--space-6);
  letter-spacing: 0.04em;
  white-space: nowrap;
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

.new-session {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: var(--space-1-5);
  box-sizing: border-box;
  height: 38px;
  margin: 0 var(--space-0-5) var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-2));
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  font-weight: 500;
  line-height: var(--lh-s);
  cursor: pointer;
}

.new-session:hover {
  background: rgb(var(--sidebar-item-hover));
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

.section-header {
  position: sticky;
  top: 0;
  z-index: var(--z-raised);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  height: 36px;
  padding-left: var(--space-1);
  background: rgb(var(--sidebar-fill));
}

.section-label {
  padding: 0 var(--space-1);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 700;
  cursor: pointer;
}

.section-label:hover {
  color: rgb(var(--label-secondary));
}

.section-label[aria-expanded='false'] {
  color: rgb(var(--label-caption));
}

.section-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.day-label {
  padding: var(--space-2) var(--space-2) var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-caption));
}

.project-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  box-sizing: border-box;
  height: 34px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  cursor: pointer;
  user-select: none;
  outline: none;
}

.project-row:hover {
  background: var(--interactive-bg-hover);
}

.project-row:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.slot {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-5);
  color: rgb(var(--label-tertiary));
}

.slot .chevron {
  display: none;
  color: rgb(var(--label-caption));
  transition: transform var(--duration-ds) var(--ease-in-out);
}

.slot .chevron[data-open] {
  transform: rotate(90deg);
}

.project-row:hover .chevron {
  display: inline-flex;
}

.project-row:hover .folder {
  display: none;
}

.project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--space-5);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-count {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--space-5);
  color: rgb(var(--label-tertiary));
}

.row-action {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-5);
  height: var(--space-5);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.row-action:hover {
  color: rgb(var(--label-primary));
}

.project-row:hover .row-action,
.project-row:focus-within .row-action {
  display: inline-flex;
}

.project-row:hover .project-count {
  display: none;
}

.search-result {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  box-sizing: border-box;
  width: 100%;
  min-height: 48px;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
}

.search-result:hover,
.search-result[data-selected] {
  background: var(--interactive-bg-hover);
}

.search-title,
.search-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-title {
  font-size: var(--fs-s);
  line-height: var(--space-5);
}

.search-meta {
  font-size: var(--fs-xxs);
  line-height: 17px;
  color: rgb(var(--label-tertiary));
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
