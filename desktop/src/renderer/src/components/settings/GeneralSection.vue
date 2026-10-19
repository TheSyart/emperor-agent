<script setup lang="ts">
/**
 * GeneralSection — Settings › 常规, the reference native section built on
 * components/settings/ui: runtime facts as SettingsRows, the dsh appearance
 * cubes (light / dark / follow system via useTheme), the archived
 * conversation list (restore / delete through useSession) and 最近删除
 * (FIX-01: deleted sessions kept 30 days, restore or delete for good after
 * a confirmation). Both lists reload from the header refresh action; a
 * list that failed to load says so with 重试 instead of looking empty.
 */
import { computed, onMounted, ref, type Component } from 'vue'
import Button from '../ui/Button.vue'
import { DsDark, DsFollowSystem, DsLight } from '../icons/ds'
import {
  EmptyState,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  Switch,
} from './ui'
import { confirm } from '../ui/confirm'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { useAppContext } from '../../composables/useAppContext'
import { useSession } from '../../composables/useSession'
import { useTheme, type ThemePreference } from '../../composables/useTheme'
import { useUiPreferences } from '../../composables/useUiPreferences'
import type { DeletedSessionInfo, SessionInfo } from '../../types'

const ctx = useAppContext()
const sessions = useSession()
const theme = useTheme()
const { preferences: uiPrefs, setUiPreference } = useUiPreferences()

const archivedSessions = ref<SessionInfo[]>([])
const archivedLoading = ref(false)
const archivedError = ref('')
const deletedSessions = ref<DeletedSessionInfo[]>([])
const deletedError = ref('')

const currentModel = computed(
  () =>
    ctx.boot.value?.modelConfig?.current?.modelId ||
    ctx.boot.value?.model ||
    '未配置',
)
const projectCount = computed(() => ctx.boot.value?.projects?.length || 0)

const runtime = computed(() => {
  const text = ctx.runtimeText()
  const tone: 'ok' | 'warn' | 'error' | 'accent' = /不可用|异常/.test(text)
    ? 'error'
    : /在线/.test(text)
      ? 'ok'
      : /办差/.test(text)
        ? 'accent'
        : 'warn'
  return { text, tone }
})

const themes: { key: ThemePreference; label: string; icon: Component }[] = [
  { key: 'light', label: '浅色', icon: DsLight },
  { key: 'dark', label: '深色', icon: DsDark },
  { key: 'system', label: '跟随系统', icon: DsFollowSystem },
]

useSettingsHeader({
  actions: () => [
    refreshAction(() => Promise.all([loadArchived(), loadDeleted()]), {
      title: '刷新归档与最近删除',
    }),
  ],
})

onMounted(() => {
  void loadArchived()
  void loadDeleted()
})

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
</script>

<template>
  <SettingsSection>
    <SettingsGroup>
      <SettingsRow title="运行状态" description="当前本地 Agent 服务状态">
        <StatusBadge :tone="runtime.tone" dot data-testid="runtime-status">
          {{ runtime.text }}
        </StatusBadge>
      </SettingsRow>
      <SettingsRow
        title="当前模型"
        description="在聊天输入框中选择，新的请求会使用该模型"
      >
        <code class="value">{{ currentModel }}</code>
      </SettingsRow>
      <SettingsRow
        title="已绑定项目"
        description="Build 模式可用的本地项目数量"
      >
        <code class="value">{{ projectCount }}</code>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="外观">
      <SettingsRow
        title="主题"
        description="跟随系统时随 macOS 自动切换"
        layout="stacked"
      >
        <div class="cube-row" role="group" aria-label="外观">
          <button
            v-for="item in themes"
            :key="item.key"
            type="button"
            class="theme-cube"
            :class="{ selected: theme.preference.value === item.key }"
            :aria-pressed="theme.preference.value === item.key"
            :data-theme-option="item.key"
            @click="theme.set(item.key)"
          >
            <component :is="item.icon" :size="16" />
            {{ item.label }}
          </button>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="会话">
      <SettingsRow
        title="显示网站图标"
        description="在回复里的网页链接前显示网站自己的图标；打开后会联网访问这些网站"
      >
        <Switch
          id="general-site-icons"
          :model-value="uiPrefs.siteIcons"
          aria-label="显示网站图标"
          @update:model-value="
            (on: boolean) => setUiPreference('siteIcons', on)
          "
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      title="已归档对话"
      description="恢复后会重新出现在主侧边栏"
      data-group="archived"
    >
      <SettingsNotice
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
      </SettingsNotice>
      <EmptyState
        v-else-if="archivedLoading && !archivedSessions.length"
        class="archive-empty"
        title="加载归档对话中…"
        variant="plain"
        compact
      />
      <EmptyState
        v-else-if="!archivedSessions.length"
        class="archive-empty"
        title="暂无归档对话。"
        description="在侧边栏会话菜单中选择「归档」即可收进这里。"
        compact
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
      <SettingsNotice
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
      </SettingsNotice>
      <EmptyState
        v-else-if="!deletedSessions.length"
        class="archive-empty"
        title="最近没有删除的对话。"
        compact
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
  </SettingsSection>
</template>

<style scoped>
.value {
  display: inline-block;
  max-width: 240px;
  overflow: hidden;
  padding: 0 var(--space-2);
  border-radius: var(--radius-row);
  background: var(--interactive-bg-hover);
  font: var(--font-code-small);
  color: rgb(var(--label-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* dsh AppearanceRow: cubes flex down from 276×82 so all three share a row,
   wrapping when the column is narrower. */
.cube-row {
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.theme-cube {
  box-sizing: border-box;
  flex: 1 1 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-5) var(--space-4);
  border: 1px solid var(--border-l2);
  border-radius: calc(var(--radius-card) + var(--space-1));
  background: transparent;
  font: inherit;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
  cursor: pointer;
  transition:
    background-color var(--duration-ds-fast) ease,
    border-color var(--duration-ds-fast) ease;
}

.theme-cube:hover:not(.selected) {
  background: var(--interactive-bg-hover);
}

/* Selected cube: module fill + the static bluish-400 outline (dsh). */
.theme-cube.selected {
  border-color: rgb(var(--nb-400));
  background: rgb(var(--selector-fill));
}

.theme-cube:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.archive-empty {
  margin-top: var(--space-3);
}
</style>
