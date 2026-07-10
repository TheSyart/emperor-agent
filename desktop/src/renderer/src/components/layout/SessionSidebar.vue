<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  MessageSquarePlus,
  MoreHorizontal,
  Package,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-vue-next'
import { core } from '../../api/http'
import { selectDirectory } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import { useSession } from '../../composables/useSession'
import {
  buildSidebarGroups,
  completeManualOrder,
  moveId,
  defaultSidebarState,
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

const emit = defineEmits<{ activate: [id: string] }>()
const router = useRouter()
const ctx = useAppContext()
const {
  sessions,
  projects,
  activeId,
  loading,
  load,
  create,
  resolveProject,
  remove,
  rename,
  archive,
  activate,
} = useSession()

const editingId = ref<string | null>(null)
const editTitle = ref('')
const creatingBuild = ref(false)
const projectMenuOpen = ref(false)
const projectAddOpen = ref(false)
const chatMenuOpen = ref(false)
const searchOpen = ref(false)
const sidebarCollapsed = ref(false)
const projectsSectionCollapsed = ref(false)
const chatsSectionCollapsed = ref(false)
const searchQuery = ref('')
const searchIndex = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)
const sidebarState = ref<SidebarState>({ ...defaultSidebarState })

const grouped = computed(() =>
  buildSidebarGroups(sessions.value, sidebarState.value, projects.value),
)
const searchResults = computed(() =>
  searchSidebarSessions(sessions.value, searchQuery.value),
)
const schedulerCount = computed(
  () => ctx.boot.value?.scheduler?.jobs?.length || 0,
)

function controlPendingTag(session: SessionInfo) {
  return sessionControlPendingTag(session)
}

// P1-7：running spinner > pending tag > attention dot
function rowIndicator(session: SessionInfo) {
  return sessionRuntimeIndicator(
    ctx.sessionRuntimeStates[session.id],
    sessionControlPendingTag(session),
  )
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

async function activateAndEmit(id: string) {
  await router.push('/chat')
  await activate(id)
  emit('activate', id)
}

async function doCreateChat() {
  closeMenus()
  const s = await create({ mode: 'chat', title: '新会话' })
  await activateAndEmit(s.id)
}

// P1-6：项目行的「新建该项目会话」——继承项目元数据的隐藏 build draft
async function doCreateProjectSession(project: SidebarProjectGroup) {
  closeMenus()
  const s = await create({
    mode: 'build',
    title: '新会话',
    project: {
      project_id: project.id,
      project_path: project.path,
      project_name: project.name,
    } as ProjectInfo,
  })
  await activateAndEmit(s.id)
}

async function createBuildFromPath(path: string) {
  if (!path.trim()) return
  const project = await resolveProject(path.trim())
  const s = await create({
    mode: 'build',
    title: `构建 ${project.project_name}`,
    project,
  })
  await activateAndEmit(s.id)
}

async function pickBuildProject(kind: 'empty' | 'existing') {
  closeMenus()
  if (creatingBuild.value) return
  creatingBuild.value = true
  try {
    const picked = await selectDirectory()
    const fallbackLabel =
      kind === 'empty'
        ? '输入已创建的空白项目文件夹路径'
        : '输入要绑定的项目文件夹路径'
    const path = picked || window.prompt(fallbackLabel) || ''
    await createBuildFromPath(path)
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err))
  } finally {
    creatingBuild.value = false
  }
}

async function doDelete(id: string) {
  const wasActive = activeId.value === id
  await remove(id)
  if (wasActive) {
    const next = sessions.value[0]
    if (next) await activateAndEmit(next.id)
  }
}

async function doArchive(id: string) {
  const wasActive = activeId.value === id
  await archive(id, true)
  if (wasActive) {
    const next = sessions.value[0]
    if (next) await activateAndEmit(next.id)
  }
}

async function doRename(id: string) {
  const title = editTitle.value.trim()
  if (!title) {
    editingId.value = null
    return
  }
  await rename(id, title)
  editingId.value = null
}

function openSearch() {
  closeMenus()
  sidebarCollapsed.value = false
  searchOpen.value = true
  searchQuery.value = ''
  searchIndex.value = 0
  void nextTick(() => searchInput.value?.focus())
}

function closeSearch() {
  searchOpen.value = false
  searchQuery.value = ''
  searchIndex.value = 0
}

function selectSearchResult(result: { id: string }) {
  closeSearch()
  void activateAndEmit(result.id)
}

function moveSearch(delta: number) {
  if (!searchResults.value.length) return
  const count = searchResults.value.length
  searchIndex.value = (searchIndex.value + delta + count) % count
}

function commitSearch() {
  const result = searchResults.value[searchIndex.value]
  if (result) selectSearchResult(result)
}

function setProjectSort(mode: SidebarSortMode) {
  projectMenuOpen.value = false
  void patchSidebarState({ project_sort: mode })
}

function setChatSort(mode: SidebarSortMode) {
  chatMenuOpen.value = false
  void patchSidebarState({ chat_sort: mode })
}

function toggleProject(projectId: string) {
  const current = sidebarState.value.collapsed_project_ids
  const next = current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId]
  void patchSidebarState({ collapsed_project_ids: next })
}

function moveProject(projectId: string, delta: -1 | 1) {
  const ids = grouped.value.projects.map((project) => project.id)
  void patchSidebarState({
    project_sort: 'manual',
    project_order: moveId(
      completeManualOrder(sidebarState.value.project_order, ids),
      projectId,
      delta,
    ),
  })
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

function closeMenus() {
  projectMenuOpen.value = false
  projectAddOpen.value = false
  chatMenuOpen.value = false
}

function toggleSidebar() {
  closeMenus()
  closeSearch()
  sidebarCollapsed.value = !sidebarCollapsed.value
}

function toggleProjectsSection() {
  projectMenuOpen.value = false
  projectAddOpen.value = false
  projectsSectionCollapsed.value = !projectsSectionCollapsed.value
}

function toggleChatsSection() {
  chatMenuOpen.value = false
  chatsSectionCollapsed.value = !chatsSectionCollapsed.value
}

function go(path: string) {
  closeMenus()
  sidebarCollapsed.value = false
  void router.push(path)
}

function beginRename(session: SessionInfo) {
  editingId.value = session.id
  editTitle.value = session.title
}

function isProjectCollapsed(projectId: string) {
  return sidebarState.value.collapsed_project_ids.includes(projectId)
}

function relativeDate(value?: string) {
  if (!value) return ''
  return value.slice(0, 10)
}

onMounted(async () => {
  await Promise.all([
    loadSidebarState(),
    sessions.value.length ? Promise.resolve() : load(),
  ])
  if (activeId.value) emit('activate', activeId.value)
})
</script>

<template>
  <aside
    class="session-sidebar codex-sidebar"
    :class="{ collapsed: sidebarCollapsed }"
    aria-label="Emperor Agent sidebar"
    @mouseleave="closeMenus"
  >
    <div class="sidebar-window-controls">
      <button
        class="sidebar-icon-button"
        type="button"
        aria-label="侧边栏"
        :aria-pressed="sidebarCollapsed"
        :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
        @click="toggleSidebar"
      >
        <PanelLeft :size="15" />
      </button>
    </div>

    <nav class="sidebar-top-actions" aria-label="快捷入口">
      <button type="button" @click="doCreateChat">
        <MessageSquarePlus :size="16" />
        <span>新对话</span>
      </button>
      <button type="button" @click="openSearch">
        <Search :size="16" />
        <span>搜索</span>
      </button>
      <button type="button" @click="go('/plugins/skills')">
        <Package :size="16" />
        <span>插件</span>
      </button>
      <button type="button" @click="go('/scheduler')">
        <CalendarClock :size="16" />
        <span>定时任务</span>
        <em v-if="schedulerCount">{{ schedulerCount }}</em>
      </button>
    </nav>

    <div v-if="loading" class="session-sidebar-empty"><p>Loading...</p></div>

    <div v-else class="session-list codex-session-list">
      <section
        v-if="sidebarState.section_order.includes('projects')"
        class="sidebar-section"
      >
        <div class="sidebar-section-head">
          <button
            class="sidebar-section-title"
            :class="{ collapsed: projectsSectionCollapsed }"
            type="button"
            :aria-expanded="!projectsSectionCollapsed"
            @click="toggleProjectsSection"
          >
            <span>项目</span>
            <ChevronDown :size="13" />
          </button>
          <div class="sidebar-section-actions">
            <button
              class="sidebar-icon-button"
              title="项目排序"
              @click="projectMenuOpen = !projectMenuOpen"
            >
              <MoreHorizontal :size="15" />
            </button>
            <button
              class="sidebar-icon-button"
              title="新增项目"
              @click="projectAddOpen = !projectAddOpen"
            >
              <FolderPlus :size="15" />
            </button>
          </div>

          <div v-if="projectMenuOpen" class="sidebar-popover section-popover">
            <button @click="setProjectSort('manual')">
              <Check v-if="sidebarState.project_sort === 'manual'" :size="14" />
              <span v-else class="menu-spacer" />
              <span>Manual order</span>
            </button>
            <button @click="setProjectSort('created_at')">
              <Check
                v-if="sidebarState.project_sort === 'created_at'"
                :size="14"
              />
              <span v-else class="menu-spacer" />
              <span>创建时间</span>
            </button>
            <button @click="setProjectSort('updated_at')">
              <Check
                v-if="sidebarState.project_sort === 'updated_at'"
                :size="14"
              />
              <span v-else class="menu-spacer" />
              <span>更新时间</span>
            </button>
          </div>

          <div v-if="projectAddOpen" class="sidebar-popover add-popover">
            <button @click="pickBuildProject('empty')">
              <FolderPlus :size="15" />
              <span>新建空白项目</span>
            </button>
            <button @click="pickBuildProject('existing')">
              <Folder :size="15" />
              <span>使用现有文件夹</span>
            </button>
          </div>
        </div>

        <template v-if="!projectsSectionCollapsed">
          <template v-for="project in grouped.projects" :key="project.id">
            <div class="project-row codex-project-row">
              <button class="project-main" @click="toggleProject(project.id)">
                <Folder :size="15" />
                <span>{{ project.name }}</span>
              </button>
              <span class="project-count">{{ project.sessions.length }}</span>
              <button
                class="sidebar-icon-button project-add-session"
                title="新建该项目会话"
                @click.stop="doCreateProjectSession(project)"
              >
                <Plus :size="13" />
              </button>
              <span
                v-if="sidebarState.project_sort === 'manual'"
                class="row-move-actions"
              >
                <button
                  title="上移项目"
                  @click.stop="moveProject(project.id, -1)"
                >
                  <ArrowUp :size="12" />
                </button>
                <button
                  title="下移项目"
                  @click.stop="moveProject(project.id, 1)"
                >
                  <ArrowDown :size="12" />
                </button>
              </span>
            </div>
            <template v-if="!isProjectCollapsed(project.id)">
              <div
                v-for="s in project.sessions"
                :key="s.id"
                class="session-row build-row"
                :class="{ active: s.id === activeId }"
                @click="activateAndEmit(s.id)"
              >
                <span class="session-status-slot" aria-hidden="true">
                  <span
                    v-if="rowIndicator(s) === 'running'"
                    class="session-status-spinner"
                  />
                  <span
                    v-else-if="rowIndicator(s) === 'attention'"
                    class="session-status-dot"
                  />
                </span>
                <div class="session-row-main">
                  <span v-if="editingId === s.id" class="session-rename-wrap">
                    <input
                      v-model="editTitle"
                      @keyup.enter="doRename(s.id)"
                      @keyup.escape="editingId = null"
                      @click.stop
                    />
                  </span>
                  <span
                    v-else
                    class="session-title"
                    @dblclick.stop="beginRename(s)"
                    >{{ s.title }}</span
                  >
                  <small>{{ s.preview || relativeDate(s.updated_at) }}</small>
                </div>
                <span
                  v-if="rowIndicator(s) === 'pending'"
                  class="session-control-tag"
                  :data-tone="controlPendingTag(s)?.tone"
                  >{{ controlPendingTag(s)?.label }}</span
                >
                <span
                  v-if="sidebarState.project_sort === 'manual'"
                  class="row-move-actions"
                >
                  <button
                    title="上移"
                    @click.stop="moveProjectSession(project, s.id, -1)"
                  >
                    <ArrowUp :size="12" />
                  </button>
                  <button
                    title="下移"
                    @click.stop="moveProjectSession(project, s.id, 1)"
                  >
                    <ArrowDown :size="12" />
                  </button>
                </span>
                <button
                  class="session-del-btn"
                  title="归档"
                  @click.stop="doArchive(s.id)"
                >
                  <Archive :size="13" />
                </button>
                <button
                  class="session-del-btn"
                  title="删除"
                  @click.stop="doDelete(s.id)"
                >
                  <Trash2 :size="13" />
                </button>
              </div>
            </template>
          </template>
        </template>
        <div
          v-if="!projectsSectionCollapsed && !grouped.projects.length"
          class="session-empty-row"
        >
          还没有绑定项目
        </div>
      </section>

      <section
        v-if="sidebarState.section_order.includes('chats')"
        class="sidebar-section"
      >
        <div class="sidebar-section-head">
          <button
            class="sidebar-section-title"
            :class="{ collapsed: chatsSectionCollapsed }"
            type="button"
            :aria-expanded="!chatsSectionCollapsed"
            @click="toggleChatsSection"
          >
            <span>对话</span>
            <ChevronDown :size="13" />
          </button>
          <div class="sidebar-section-actions">
            <button
              class="sidebar-icon-button"
              title="对话排序"
              @click="chatMenuOpen = !chatMenuOpen"
            >
              <MoreHorizontal :size="15" />
            </button>
            <button
              class="sidebar-icon-button"
              title="新对话"
              @click="doCreateChat"
            >
              <Plus :size="15" />
            </button>
          </div>
          <div v-if="chatMenuOpen" class="sidebar-popover section-popover">
            <button @click="setChatSort('manual')">
              <Check v-if="sidebarState.chat_sort === 'manual'" :size="14" />
              <span v-else class="menu-spacer" />
              <span>Manual order</span>
            </button>
            <button @click="setChatSort('created_at')">
              <Check
                v-if="sidebarState.chat_sort === 'created_at'"
                :size="14"
              />
              <span v-else class="menu-spacer" />
              <span>创建时间</span>
            </button>
            <button @click="setChatSort('updated_at')">
              <Check
                v-if="sidebarState.chat_sort === 'updated_at'"
                :size="14"
              />
              <span v-else class="menu-spacer" />
              <span>更新时间</span>
            </button>
          </div>
        </div>

        <template v-if="!chatsSectionCollapsed">
          <div
            v-for="s in grouped.chats"
            :key="s.id"
            class="session-row"
            :class="{ active: s.id === activeId }"
            @click="activateAndEmit(s.id)"
          >
            <span class="session-status-slot" aria-hidden="true">
              <span
                v-if="rowIndicator(s) === 'running'"
                class="session-status-spinner"
              />
              <span
                v-else-if="rowIndicator(s) === 'attention'"
                class="session-status-dot"
              />
            </span>
            <div class="session-row-main">
              <span v-if="editingId === s.id" class="session-rename-wrap">
                <input
                  v-model="editTitle"
                  @keyup.enter="doRename(s.id)"
                  @keyup.escape="editingId = null"
                  @click.stop
                />
              </span>
              <span
                v-else
                class="session-title"
                @dblclick.stop="beginRename(s)"
                >{{ s.title }}</span
              >
              <small>{{ s.preview || relativeDate(s.updated_at) }}</small>
            </div>
            <span
              v-if="rowIndicator(s) === 'pending'"
              class="session-control-tag"
              :data-tone="controlPendingTag(s)?.tone"
              >{{ controlPendingTag(s)?.label }}</span
            >
            <span
              v-if="sidebarState.chat_sort === 'manual'"
              class="row-move-actions"
            >
              <button title="上移" @click.stop="moveChat(s.id, -1)">
                <ArrowUp :size="12" />
              </button>
              <button title="下移" @click.stop="moveChat(s.id, 1)">
                <ArrowDown :size="12" />
              </button>
            </span>
            <button
              class="session-del-btn"
              title="归档"
              @click.stop="doArchive(s.id)"
            >
              <Archive :size="13" />
            </button>
            <button
              class="session-del-btn"
              title="删除"
              @click.stop="doDelete(s.id)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </template>
        <div
          v-if="!chatsSectionCollapsed && !grouped.chats.length"
          class="session-empty-row"
        >
          暂无对话
        </div>
      </section>
    </div>

    <button
      class="sidebar-settings-button"
      type="button"
      @click="go('/settings/general')"
    >
      <Settings :size="16" />
      <span>设置</span>
    </button>

    <div
      v-if="searchOpen"
      class="sidebar-search-backdrop"
      @click.self="closeSearch"
    >
      <div class="sidebar-search-panel" @keydown.esc="closeSearch">
        <div class="sidebar-search-input-wrap">
          <Search :size="16" />
          <input
            ref="searchInput"
            v-model="searchQuery"
            placeholder="搜索对话"
            @keydown.down.prevent="moveSearch(1)"
            @keydown.up.prevent="moveSearch(-1)"
            @keydown.enter.prevent="commitSearch"
          />
        </div>
        <div class="search-section-label">近期对话</div>
        <button
          v-for="(result, index) in searchResults"
          :key="result.id"
          class="search-result-row"
          :class="{ active: index === searchIndex }"
          @mouseenter="searchIndex = index"
          @click="selectSearchResult(result)"
        >
          <span>{{ result.title }}</span>
          <small>
            <Sparkles v-if="result.mode === 'build'" :size="12" />
            {{ result.subtitle }}
          </small>
        </button>
        <div
          v-if="searchQuery && !searchResults.length"
          class="session-empty-row"
        >
          没有匹配的会话
        </div>
      </div>
    </div>
  </aside>
</template>
