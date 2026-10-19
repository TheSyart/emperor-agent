<script setup lang="ts">
/**
 * GeneralSection — Settings › 常规 (UI-S07), one card per group:
 * - 外观: 主题 (跟随系统 / 浅色 / 深色, useTheme) and 桌宠 (the desktop
 *   companion's switch, ctx.setDesktopPetEnabled; its last error under it);
 * - 会话: 新会话的权限 (Core `sessions.defaults`; choosing 完全访问 asks
 *   first), 处理过程 (how a finished turn's steps show), 网页链接 (where a
 *   clicked web link opens, the browser preference `linkTarget`) and
 *   显示网站图标;
 * - 开发者: 显示轨迹 and 显示系统步骤, both off until turned on (per-Mac UI
 *   preferences, useUiPreferences);
 * - 对话: one row into the 已归档对话 sub page (`page=archived`): the
 *   archived conversations (restore / delete through useSession) and
 *   最近删除 (FIX-01: deleted sessions kept 30 days, restore or delete for
 *   good after a confirmation). A list that failed to load says so with
 *   重试 instead of looking empty.
 * The runtime facts this page used to open with (service state, current
 * model, bound projects) are in 高级 › 诊断 › 运行时.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { useBrowserPreferences } from '../../composables/useBrowserPreferences'
import { useSession } from '../../composables/useSession'
import { useTheme, type ThemePreference } from '../../composables/useTheme'
import {
  useUiPreferences,
  type ProcessDisplay,
} from '../../composables/useUiPreferences'
import type { DeletedSessionInfo, SessionInfo } from '../../types'
import { composerModeOptions } from '../chat/composerControls'
import Button from '../ui/Button.vue'
import { confirm } from '../ui/confirm'
import { useSettingsPages } from './settingsHeader'
import {
  EmptyState,
  Notice,
  Segmented,
  Select,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
  Switch,
  type SegmentedOption,
  type SelectOption,
} from './ui'

type Permission = 'read-only' | 'workspace-write' | 'danger-full-access'
type LinkTarget = 'system' | 'builtin'

const ctx = useAppContext()
const sessions = useSession()
const theme = useTheme()
const { preferences: uiPrefs, setUiPreference } = useUiPreferences()
const browser = useBrowserPreferences()
const { page, open: openPage } = useSettingsPages({ archived: '已归档对话' })

const THEMES: SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const PERMISSIONS: SelectOption<Permission>[] = composerModeOptions.map(
  (option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }),
)

const PROCESS: SelectOption<ProcessDisplay>[] = [
  { value: 'collapse-when-done', label: '完成后收起' },
  { value: 'expanded', label: '始终展开' },
  { value: 'collapsed', label: '始终收起' },
]

const LINK_TARGETS: SelectOption<LinkTarget>[] = [
  {
    value: 'system',
    label: '用系统浏览器打开',
    description: '沿用系统浏览器里的登录',
  },
  {
    value: 'builtin',
    label: '在 Emperor 中打开',
    description: '在右侧「浏览器」面板打开',
  },
]

// ── 外观 · 桌宠 ──────────────────────────────────────────────────────────
const pet = computed(() => ctx.boot.value?.desktopPet)
const petOn = computed(() => Boolean(pet.value?.enabled))
const petBusy = ref(false)

const petDescription = computed(() => {
  if (petBusy.value) return petOn.value ? '正在关闭桌宠…' : '正在启动桌宠…'
  return '在桌面角落显示小单，跟着 Agent 的工作切换动作'
})

function setPet(next: boolean): void {
  if (petBusy.value || next === petOn.value) return
  petBusy.value = true
  void ctx
    .runSafely(async () => {
      await ctx.setDesktopPetEnabled(next)
    })
    .finally(() => {
      petBusy.value = false
    })
}

// ── 会话 ────────────────────────────────────────────────────────────────
const permission = ref<Permission>('workspace-write')
const permissionBusy = ref(false)
const permissionError = ref('')

async function loadPermission(): Promise<void> {
  try {
    const defaults = await core('sessions.defaults')
    permission.value = defaults.permission
    permissionError.value = ''
  } catch (error) {
    permissionError.value = `读取失败：${messageOf(error)}`
  }
}

async function setPermission(next?: Permission): Promise<void> {
  if (!next || next === permission.value || permissionBusy.value) return
  if (
    next === 'danger-full-access' &&
    !(await confirm({
      title: '新会话默认完全访问？',
      body: '新会话不启用沙箱，命令和写入都不再询问。只在你信任要做的任务时这样设置。',
      confirmLabel: '设为完全访问',
      tone: 'danger',
    }))
  )
    return
  permissionBusy.value = true
  try {
    const saved = await core('sessions.setDefaults', { permission: next })
    permission.value = saved.permission
    permissionError.value = ''
  } catch (error) {
    permissionError.value = `保存失败：${messageOf(error)}`
  } finally {
    permissionBusy.value = false
  }
}

const linkSaving = ref(false)

function setLinkTarget(next?: LinkTarget): void {
  if (!next || linkSaving.value) return
  linkSaving.value = true
  void ctx
    .runSafely(() => browser.update({ linkTarget: next }))
    .finally(() => {
      linkSaving.value = false
    })
}

// ── 对话 · 已归档 / 最近删除 ─────────────────────────────────────────────
const archivedSessions = ref<SessionInfo[]>([])
const archivedLoading = ref(false)
const archivedError = ref('')
const deletedSessions = ref<DeletedSessionInfo[]>([])
const deletedError = ref('')

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadArchived() {
  archivedLoading.value = true
  try {
    archivedSessions.value = (await sessions.loadArchived()).filter(
      (session) => session.archived_at,
    )
    archivedError.value = ''
  } catch (error) {
    archivedError.value = messageOf(error) || '无法读取归档对话'
  } finally {
    archivedLoading.value = false
  }
}

async function loadDeleted() {
  try {
    deletedSessions.value = await sessions.listDeleted()
    deletedError.value = ''
  } catch (error) {
    deletedError.value = messageOf(error) || '无法读取最近删除'
  }
}

async function restoreDeleted(item: DeletedSessionInfo) {
  if (!(await sessions.restoreDeleted(item.id))) {
    ctx.showError(sessions.sessionActionError.value || '未知错误', '恢复失败')
    return
  }
  ctx.showToast(`已恢复「${item.title}」`)
  await loadDeleted()
}

async function purgeDeleted(item: DeletedSessionInfo) {
  if (
    !(await confirm({
      title: `永久删除「${item.title}」？`,
      body: '对话记录、附件和回合快照都会删除，无法恢复。',
      confirmLabel: '永久删除',
      tone: 'danger',
    }))
  )
    return
  if (!(await sessions.purgeDeleted(item.id))) {
    ctx.showError(sessions.sessionActionError.value || '未知错误', '删除失败')
    return
  }
  await loadDeleted()
}

function deletedMeta(item: DeletedSessionInfo) {
  const day = item.deleted_at.slice(0, 10)
  return item.project_name
    ? `${item.project_name} · ${day} 删除`
    : `${day} 删除`
}

async function restoreArchived(id: string) {
  const ok = await sessions.archive(id, false)
  if (ok) {
    archivedSessions.value = archivedSessions.value.filter(
      (session) => session.id !== id,
    )
    ctx.showToast('已恢复会话')
  }
}

async function deleteArchived(id: string) {
  const ok = await sessions.remove(id)
  if (!ok) {
    ctx.showError(sessions.sessionActionError.value || '未知错误', '删除失败')
    return
  }
  archivedSessions.value = archivedSessions.value.filter(
    (session) => session.id !== id,
  )
  await loadDeleted()
}

function archivedMeta(session: SessionInfo) {
  return session.project_name || session.updated_at?.slice(0, 10) || ''
}

// The lists load each time their page opens.
watch(
  page,
  (current) => {
    if (current !== 'archived') return
    void loadArchived()
    void loadDeleted()
  },
  { immediate: true },
)

onMounted(() => void loadPermission())
</script>

<template>
  <SettingsSection>
    <template v-if="page === 'archived'">
      <SettingsGroup
        title="已归档对话"
        description="恢复后会重新出现在主侧边栏"
        data-group="archived"
      >
        <Notice
          v-if="archivedError"
          tone="error"
          title="无法读取归档对话"
          :description="archivedError"
        >
          <template #actions>
            <Button size="sm" variant="secondary" @click="loadArchived()"
              >重试</Button
            >
          </template>
        </Notice>
        <EmptyState
          v-else-if="archivedLoading && !archivedSessions.length"
          title="加载归档对话中…"
          variant="inline"
        />
        <EmptyState
          v-else-if="!archivedSessions.length"
          title="暂无归档对话。"
          description="在侧边栏会话菜单中选择「归档」即可收进这里。"
          variant="inline"
        />
        <template v-else>
          <SettingsRow
            v-for="session in archivedSessions"
            :key="session.id"
            :title="session.title"
            :description="archivedMeta(session)"
            dense
            data-testid="archived-session"
          >
            <Button
              size="sm"
              variant="secondary"
              @click="restoreArchived(session.id)"
            >
              恢复
            </Button>
            <Button
              size="sm"
              variant="danger"
              @click="deleteArchived(session.id)"
            >
              删除
            </Button>
          </SettingsRow>
        </template>
      </SettingsGroup>

      <SettingsGroup
        title="最近删除"
        description="删除的对话保留 30 天，可以恢复；之后自动清除"
        data-group="deleted"
      >
        <Notice
          v-if="deletedError"
          tone="error"
          title="无法读取最近删除"
          :description="deletedError"
        >
          <template #actions>
            <Button size="sm" variant="secondary" @click="loadDeleted()"
              >重试</Button
            >
          </template>
        </Notice>
        <EmptyState
          v-else-if="!deletedSessions.length"
          title="最近没有删除的对话。"
          variant="inline"
        />
        <template v-else>
          <SettingsRow
            v-for="item in deletedSessions"
            :key="item.id"
            :title="item.title"
            :description="deletedMeta(item)"
            dense
            data-testid="deleted-session"
          >
            <Button size="sm" variant="secondary" @click="restoreDeleted(item)">
              恢复
            </Button>
            <Button size="sm" variant="danger" @click="purgeDeleted(item)">
              永久删除
            </Button>
          </SettingsRow>
        </template>
      </SettingsGroup>
    </template>

    <template v-else>
      <SettingsGroup title="外观" data-group="appearance">
        <SettingsRow title="主题" description="跟随系统时随 macOS 自动切换">
          <Segmented
            :model-value="theme.preference.value"
            :options="THEMES"
            aria-label="主题"
            @update:model-value="
              (value?: ThemePreference) => value && theme.set(value)
            "
          />
        </SettingsRow>
        <SettingsRow title="桌宠" label-for="general-pet">
          <template #description>
            <span>{{ petDescription }}</span>
            <span v-if="pet?.lastError" class="error-text">{{
              pet.lastError
            }}</span>
          </template>
          <Switch
            id="general-pet"
            :model-value="petOn"
            :disabled="petBusy"
            @update:model-value="setPet"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="会话" data-group="session">
        <SettingsRow title="新会话的权限" label-for="general-permission">
          <template #description>
            <span v-if="permissionError" class="error-text" role="alert">{{
              permissionError
            }}</span>
            <template v-else
              >新建的会话从这个权限开始，之后可在输入框里切换</template
            >
          </template>
          <Select
            id="general-permission"
            size="sm"
            :model-value="permission"
            :options="PERMISSIONS"
            :disabled="permissionBusy"
            @update:model-value="setPermission"
          />
        </SettingsRow>
        <SettingsRow
          title="处理过程"
          description="一轮回复完成后，工具步骤怎么显示"
          label-for="general-process"
        >
          <Select
            id="general-process"
            size="sm"
            :model-value="uiPrefs.processDisplay"
            :options="PROCESS"
            @update:model-value="
              (value?: ProcessDisplay) =>
                value && setUiPreference('processDisplay', value)
            "
          />
        </SettingsRow>
        <SettingsRow
          title="网页链接"
          description="点击回复、Pull Request 等界面里的网页链接时"
          label-for="general-link-target"
        >
          <Select
            id="general-link-target"
            size="sm"
            :model-value="browser.preferences.value.linkTarget"
            :options="LINK_TARGETS"
            :disabled="linkSaving"
            @update:model-value="setLinkTarget"
          />
        </SettingsRow>
        <SettingsRow
          title="显示网站图标"
          description="在回复里的网页链接前显示网站自己的图标；打开后会联网访问这些网站"
          label-for="general-site-icons"
        >
          <Switch
            id="general-site-icons"
            :model-value="uiPrefs.siteIcons"
            @update:model-value="
              (on: boolean) => setUiPreference('siteIcons', on)
            "
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="开发者" data-group="developer">
        <SettingsRow
          title="显示轨迹"
          description="在会话顶部加「轨迹」页，查看每次模型请求、工具调用和耗时，排查问题时使用"
          label-for="general-show-trajectory"
        >
          <Switch
            id="general-show-trajectory"
            :model-value="uiPrefs.showTrajectory"
            @update:model-value="
              (on: boolean) => setUiPreference('showTrajectory', on)
            "
          />
        </SettingsRow>
        <SettingsRow
          title="显示系统步骤"
          description="在处理过程里列出上下文注入和 Hook 执行"
          label-for="general-system-steps"
        >
          <Switch
            id="general-system-steps"
            :model-value="uiPrefs.showSystemSteps"
            @update:model-value="
              (on: boolean) => setUiPreference('showSystemSteps', on)
            "
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="对话" data-group="conversations">
        <SettingsLinkRow
          title="已归档对话"
          description="恢复归档的对话；删除的对话在这里保留 30 天"
          data-testid="open-archived"
          @click="openPage('archived')"
        />
      </SettingsGroup>
    </template>
  </SettingsSection>
</template>

<style scoped>
.error-text {
  display: block;
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
</style>
