<script setup lang="ts">
/**
 * 能力 › Skills — the Skills tab of the /capabilities page (PageShell). The list
 * view: SearchField + source Segmented (全部 / 个人 / 项目 / 插件 / 内置), the
 * 「不合格的 Skill (N)」 notice (InvalidSkillsNotice) and one SkillRow per
 * Skill. Selecting a Skill swaps the list for its inline detail
 * (SkillDetail) — the choice lives in the route (`/capabilities/skills?skill=
 * <name>`, useSkillSelection), so /skills/:name deep links land on it and
 * 「全部 Skills」 goes back.
 *
 * Header: refresh (`skills.list` for the current session) and 「新增」 with
 * the four ways to add a Skill — 粘贴 SKILL.md (SkillPasteDialog), 选择本地
 * 文件夹 and 导入 zip 或 GitHub 链接 (SkillImportDialog), and opening the
 * personal / project Skills folder in the file manager.
 *
 * Data: `boot.skills` / `boot.invalidSkills`, reloaded here on open, when
 * the kept-alive page is shown again and after every change (the runtime
 * also reloads them on `skill_catalog_changed`).
 * The current session scopes the catalog; its project (Build sessions only)
 * enables the 「当前项目」 scope.
 */
import { computed, onMounted, ref } from 'vue'
import Button from '../ui/Button.vue'
import {
  DsCode,
  DsDownload,
  DsFolderClose,
  DsFolderOpen,
  DsPlus,
  DsSkill,
} from '../icons/ds'
import {
  openPath,
  openSkillsFolder,
  selectDirectory,
  SkillsFolderError,
} from '../../api/backend'
import {
  deleteSkill,
  listSkills,
  skillErrorInfo,
  type SkillScope,
} from '../../api/skills'
import { useAppContext } from '../../composables/useAppContext'
import { useSession } from '../../composables/useSession'
import type { InvalidSkillInfo } from '../../types'
import { EmptyState, SearchField, Segmented, SettingsSection } from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { onPageReactivated } from '../pages/pageLifecycle'
import InvalidSkillsNotice from './skills/InvalidSkillsNotice.vue'
import SkillConfirmDialog from './skills/SkillConfirmDialog.vue'
import SkillDetail from './skills/SkillDetail.vue'
import SkillImportDialog from './skills/SkillImportDialog.vue'
import SkillPasteDialog from './skills/SkillPasteDialog.vue'
import SkillRow from './skills/SkillRow.vue'
import { useSkillSelection } from './skills/useSkillSelection'
import {
  filterInvalidSkills,
  filterSkills,
  invalidSkillDeleteTarget,
  invalidSkillFolder,
  SKILL_SCOPE_HINTS,
  SKILL_SOURCE_FILTERS,
  skillCountText,
  skillImportToast,
  skillProject,
  skillScopeOptions,
  skillSessionId,
  type SkillImportSummary,
  type SkillSourceFilter,
} from './skills/skillsModel'

const ctx = useAppContext()
const selection = useSkillSelection()
const sessions = useSession()

const query = ref('')
const source = ref<SkillSourceFilter>('all')
const invalidOpen = ref(false)
const pasteOpen = ref(false)
const importOpen = ref(false)
const importMode = ref<'archive' | 'folder'>('archive')
const importFolder = ref('')
const pendingDelete = ref<InvalidSkillInfo | null>(null)
const deletingPath = ref<string | null>(null)
const detailRef = ref<InstanceType<typeof SkillDetail> | null>(null)

const sessionId = computed(() => skillSessionId(ctx.sessionId.value))
const project = computed(() =>
  skillProject(
    sessions.sessions.value.find(
      (session) => session.id === ctx.sessionId.value,
    ),
  ),
)
const scopeOptions = computed(() => skillScopeOptions(project.value))

const skills = computed(() => ctx.boot.value?.skills ?? [])
const invalid = computed(() => ctx.boot.value?.invalidSkills ?? [])
const filter = computed(() => ({ query: query.value, source: source.value }))
const visible = computed(() => filterSkills(skills.value, filter.value))
const visibleInvalid = computed(() =>
  filterInvalidSkills(invalid.value, filter.value),
)
const filtered = computed(
  () => Boolean(query.value.trim()) || source.value !== 'all',
)
const countText = computed(() =>
  skillCountText(visible.value.length, skills.value.length),
)

const selected = selection.selected
const selectedSummary = computed(
  () => skills.value.find((skill) => skill.name === selected.value) ?? null,
)

useSettingsHeader({
  actions: () => [
    refreshAction(() => refresh(), { title: '刷新 Skills' }),
    {
      id: 'add',
      label: '新增',
      kind: 'primary',
      icon: DsPlus,
      menu: [
        {
          id: 'paste',
          label: '粘贴 SKILL.md',
          description: '粘贴内容，自动识别名称并校验',
          icon: DsCode,
          onSelect: () => (pasteOpen.value = true),
        },
        {
          id: 'folder',
          label: '选择本地文件夹',
          description: '导入包含 SKILL.md 的文件夹',
          icon: DsFolderOpen,
          onSelect: () => pickFolder(),
        },
        {
          id: 'archive',
          label: '导入 zip 或 GitHub 链接',
          description: 'zip 文件、GitHub 仓库或目录链接',
          icon: DsDownload,
          onSelect: () => openImport('archive'),
        },
        {
          id: 'open-user-folder',
          label: '打开个人 Skills 文件夹',
          description: SKILL_SCOPE_HINTS.user,
          icon: DsFolderClose,
          onSelect: () => openFolder('user'),
        },
        {
          id: 'open-project-folder',
          label: '打开项目 Skills 文件夹',
          description: project.value
            ? `${project.value.name}/.emperor/skills`
            : '需要在项目会话中打开',
          icon: DsFolderClose,
          disabled: !project.value,
          onSelect: () => openFolder('project'),
        },
      ],
    },
  ],
})

onMounted(() => {
  void ctx.runSafely(reload)
})
onPageReactivated(() => ctx.runSafely(reload))

async function reload() {
  const catalog = await listSkills({ sessionId: sessionId.value })
  const boot = ctx.boot.value
  if (!boot) return
  boot.skills = catalog.skills
  boot.invalidSkills = catalog.invalid
}

function refresh() {
  return ctx.runSafely(async () => {
    await reload()
    await detailRef.value?.reload()
  })
}

function openSkill(name: string) {
  void selection.select(name)
}

function closeDetail() {
  void selection.select(null)
}

function onDetailChanged() {
  void ctx.runSafely(reload)
}

function onDeleted() {
  closeDetail()
  void ctx.runSafely(reload)
}

function clearFilters() {
  query.value = ''
  source.value = 'all'
}

function openImport(mode: 'archive' | 'folder', folder = '') {
  importMode.value = mode
  importFolder.value = folder
  importOpen.value = true
}

async function pickFolder() {
  const path = await selectDirectory()
  if (path) openImport('folder', path)
}

function openFolder(scope: SkillScope) {
  return ctx.runSafely(async () => {
    try {
      await openSkillsFolder({ scope, sessionId: sessionId.value })
    } catch (error) {
      // The project folder lives in the user's repository, so Emperor creates
      // it with the first project Skill instead of on a mere look.
      if (
        scope !== 'project' ||
        !(error instanceof SkillsFolderError) ||
        error.code !== 'skill_scope_unavailable'
      )
        throw error
      ctx.showToast(
        '这个项目还没有 Skills 目录，保存第一个项目 Skill 后会自动创建。',
      )
    }
  })
}

/** The import dialog shows its own result; a paste closes and opens the new Skill. */
function onImported(summary: SkillImportSummary, fromPaste = false) {
  void ctx.runSafely(reload)
  if (!fromPaste) return
  ctx.showToast(skillImportToast(summary))
  const [only] = summary.imported
  if (only && summary.imported.length === 1) openSkill(only.name)
}

function revealInvalid(item: InvalidSkillInfo) {
  return ctx.runSafely(() => openPath(invalidSkillFolder(item)))
}

async function confirmDeleteInvalid() {
  const item = pendingDelete.value
  const target = item ? invalidSkillDeleteTarget(item) : null
  if (!item || !target) return
  deletingPath.value = item.path
  try {
    await deleteSkill(target.name, {
      scope: target.scope,
      sessionId: sessionId.value,
    })
    pendingDelete.value = null
    ctx.showToast(`已删除不合格的 Skill「${item.name}」`)
    await reload()
  } catch (error) {
    ctx.showToast(skillErrorInfo(error).message)
  } finally {
    deletingPath.value = null
  }
}

const deleteDialogOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (value: boolean) => {
    if (!value) pendingDelete.value = null
  },
})
</script>

<template>
  <SettingsSection>
    <SkillDetail
      v-if="selected"
      ref="detailRef"
      :name="selected"
      :session-id="sessionId"
      :summary="selectedSummary"
      @back="closeDetail"
      @changed="onDetailChanged"
      @deleted="onDeleted"
    />

    <div v-else class="skills-list-view">
      <div class="toolbar">
        <SearchField
          v-model="query"
          class="search"
          placeholder="搜索 Skill"
          aria-label="搜索 Skill"
        >
          <template v-if="countText" #trailing>{{ countText }}</template>
        </SearchField>
        <Segmented
          v-model="source"
          :options="SKILL_SOURCE_FILTERS"
          aria-label="按来源筛选"
          class="sources"
        />
      </div>

      <InvalidSkillsNotice
        v-if="visibleInvalid.length"
        v-model:open="invalidOpen"
        :items="visibleInvalid"
        :busy-path="deletingPath"
        @open-folder="revealInvalid"
        @delete="pendingDelete = $event"
      />

      <ul v-if="visible.length" class="skill-list" aria-label="Skills">
        <SkillRow
          v-for="skill in visible"
          :key="`${skill.source}:${skill.name}`"
          :skill="skill"
          @select="openSkill(skill.name)"
        />
      </ul>
      <EmptyState
        v-else-if="!skills.length"
        :icon="DsSkill"
        title="还没有 Skill"
        description="粘贴一个 SKILL.md，或把 Skill 文件夹放进个人 Skills 文件夹。"
      >
        <Button size="sm" variant="primary" @click="pasteOpen = true">
          粘贴 SKILL.md
        </Button>
        <Button size="sm" variant="outline" @click="openFolder('user')">
          打开 Skills 文件夹
        </Button>
      </EmptyState>
      <EmptyState
        v-else-if="filtered"
        compact
        title="没有匹配的 Skill"
        description="换个关键词或来源试试。"
      >
        <Button size="sm" variant="outline" @click="clearFilters">
          清除筛选
        </Button>
      </EmptyState>
    </div>

    <SkillPasteDialog
      v-model:open="pasteOpen"
      :scope-options="scopeOptions"
      :session-id="sessionId"
      @imported="onImported($event, true)"
    />
    <SkillImportDialog
      v-model:open="importOpen"
      :mode="importMode"
      :folder-path="importFolder"
      :scope-options="scopeOptions"
      :session-id="sessionId"
      @imported="onImported($event)"
      @select="openSkill"
    />
    <SkillConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="`删除不合格的 Skill「${pendingDelete?.name ?? ''}」？`"
      description="整个 Skill 文件夹会从磁盘删除，无法撤销。"
      :detail="pendingDelete?.path"
      confirm-label="删除"
      danger
      :busy="deletingPath !== null"
      @confirm="confirmDeleteInvalid"
    />
  </SettingsSection>
</template>

<style scoped>
.skills-list-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding-top: var(--space-1);
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.search {
  flex: 1 1 220px;
}

.sources {
  flex: none;
}

.skill-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-3));
}
</style>
