<script setup lang="ts">
/**
 * Settings › 浏览器 — everything about Emperor's built-in browser, laid out
 * like Codex's 浏览器 settings:
 * - the control card: whether Emperor may operate the built-in browser
 *   (computer use's embedded-browser driver; greyed out, with a way there,
 *   while 电脑操作 is off);
 * - 常规: where a clicked web link and a link to this machine open, the
 *   address bar, clearing the browsing data and the temporary history of the
 *   user's own browsing (the workspace 浏览器 pane, a memory-only session);
 * - 自动填充和密码: 密码管理器 and 登录状态 (sub pages);
 * - 下载: how long Emperor's downloads stay in its inbox;
 * - 浏览器权限: 网站设置 (sub page).
 *
 * The link and history choices save at once through
 * `browser.setPreferences` (Core tells every window,
 * `browser_preferences_changed`); the rest are computer use settings
 * (`computerUse.status`, refreshed on `computer_use_changed`).
 */
import type {
  BrowserPreferences,
  ComputerUseStatusView,
} from '@emperor/core/runtime-contract'
import { Globe } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { clearBrowserData, onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { useBrowserPreferences } from '../../composables/useBrowserPreferences'
import Button from '../ui/Button.vue'
import PasswordManagerPage from './browser/PasswordManagerPage.vue'
import SignInProfilesPage from './browser/SignInProfilesPage.vue'
import SiteSettingsPage from './browser/SiteSettingsPage.vue'
import { driverRows } from './computer/computerUseSettingsModel'
import { useSettingsPages } from './settingsHeader'
import {
  Select,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  Switch,
  type SelectOption,
} from './ui'
import { useSettingsRoute } from './useSettingsRoute'

const ctx = useAppContext()
const { preferences, update } = useBrowserPreferences()
const { page, open: openPage } = useSettingsPages({
  passwords: '密码管理器',
  profiles: '登录状态',
  sites: '网站设置',
})
const settingsRoute = useSettingsRoute()
const saving = ref(false)

type Target = BrowserPreferences['linkTarget']

const LINK_TARGETS: readonly SelectOption<Target>[] = [
  {
    value: 'builtin',
    label: 'Emperor',
    description: '在右侧「浏览器」面板打开',
  },
  {
    value: 'system',
    label: '系统默认浏览器',
    description: '沿用系统浏览器里的登录',
  },
]

function save(change: Partial<BrowserPreferences>): void {
  if (saving.value) return
  saving.value = true
  void ctx
    .runSafely(() => update(change))
    .finally(() => {
      saving.value = false
    })
}

// ── 浏览数据 ─────────────────────────────────────────────────────────────
/** 清除浏览数据: idle, running, or how the last run went. */
const clearing = ref<'idle' | 'running' | 'done' | 'failed'>('idle')
const clearError = ref('')

async function clearData(): Promise<void> {
  if (clearing.value === 'running') return
  clearing.value = 'running'
  clearError.value = ''
  const result = await clearBrowserData()
  if (result.ok) clearing.value = 'done'
  else {
    clearing.value = 'failed'
    clearError.value = result.error ?? '清除失败'
  }
}

// ── Emperor's control, downloads (computer use) ──────────────────────────
const status = ref<ComputerUseStatusView | null>(null)
const busy = ref(false)
const error = ref('')

const masterOn = computed(() => status.value?.enabled === true)
const agentRow = computed(() =>
  driverRows(status.value).find((row) => row.driver === 'embedded-browser'),
)
const agentOn = computed(
  () => masterOn.value && Boolean(agentRow.value?.switchedOn),
)
/** Named beside the title only when it is not simply available. */
const agentStage = computed(() =>
  agentRow.value && agentRow.value.stage !== '可用' ? agentRow.value : null,
)
const agentDescription = computed(() => {
  if (status.value && !status.value.supported) return '需要 Emperor 桌面应用'
  if (status.value && !masterOn.value)
    return '先打开「电脑操作」，才能让 Emperor 控制内置浏览器'
  return '让 Emperor 控制内置浏览器'
})

const RETENTION_OPTIONS: readonly SelectOption<number>[] = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 0, label: '一直保留' },
]
const retention = computed(() => status.value?.downloadRetentionDays ?? 30)

async function reload(): Promise<void> {
  try {
    status.value = await core('computerUse.status')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function act(task: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await task()
    await reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

function setAgentBrowser(next: boolean): void {
  if (next === agentOn.value) return
  void act(() =>
    core('computerUse.setDriverEnabled', {
      driver: 'embedded-browser',
      enabled: next,
    }),
  )
}

function setRetention(days: number | undefined): void {
  if (days === undefined || days === retention.value) return
  void act(() =>
    core('computerUse.setDownloadRetention', {
      days: days as 0 | 7 | 30 | 90,
    }),
  )
}

function openComputerUse(): void {
  void settingsRoute.selectSection('computer')
}

let unsubscribe = () => {}
let timer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  void reload()
  unsubscribe = onCoreEvent((event) => {
    if (
      (event as { event?: unknown } | null)?.event !== 'computer_use_changed' ||
      timer !== null
    )
      return
    timer = setTimeout(() => {
      timer = null
      void reload()
    }, 80)
  })
})

onBeforeUnmount(() => {
  unsubscribe()
  if (timer !== null) clearTimeout(timer)
})
</script>

<template>
  <PasswordManagerPage v-if="page === 'passwords'" />
  <SignInProfilesPage v-else-if="page === 'profiles'" />
  <SiteSettingsPage v-else-if="page === 'sites'" />
  <SettingsSection
    v-else
    intro="你自己浏览网页，以及 Emperor 操作网页，用的都是内置浏览器。"
  >
    <p v-if="error" class="browser-error" role="alert">{{ error }}</p>
    <SettingsCard
      class="agent-card"
      data-testid="browser-agent-card"
      title="浏览器"
      :description="agentDescription"
    >
      <template #leading><Globe :size="20" /></template>
      <template v-if="agentStage" #meta>
        <StatusBadge :tone="agentStage.tone">{{
          agentStage.stage
        }}</StatusBadge>
      </template>
      <template #actions>
        <Button
          v-if="status?.supported && !masterOn"
          size="sm"
          variant="outline"
          @click="openComputerUse"
          >打开电脑操作</Button
        >
        <Switch
          id="browser-agent"
          :model-value="agentOn"
          :disabled="busy || !masterOn"
          aria-label="让 Emperor 控制内置浏览器"
          @update:model-value="setAgentBrowser"
        />
      </template>
    </SettingsCard>

    <SettingsGroup title="常规">
      <SettingsRow
        title="网页 URL 和链接打开位置"
        description="在会话、Pull Request 等界面中点击的网页链接"
        label-for="browser-link-target"
      >
        <Select
          id="browser-link-target"
          size="sm"
          :model-value="preferences.linkTarget"
          :options="LINK_TARGETS"
          :disabled="saving"
          @update:model-value="
            (value?: Target) => value && save({ linkTarget: value })
          "
        />
      </SettingsRow>
      <SettingsRow title="本地 URL 打开位置" label-for="browser-local-target">
        <template #description>
          <span>localhost 等本机开发站点</span>
          <span v-if="preferences.localTarget === 'system'" class="browser-note"
            >本机地址会带着你系统浏览器里的登录打开</span
          >
        </template>
        <Select
          id="browser-local-target"
          size="sm"
          :model-value="preferences.localTarget"
          :options="LINK_TARGETS"
          :disabled="saving"
          @update:model-value="
            (value?: Target) => value && save({ localTarget: value })
          "
        />
      </SettingsRow>
      <SettingsRow
        title="显示完整网址"
        description="在地址栏中显示路径、查询参数和片段"
        label-for="browser-full-url"
      >
        <Switch
          id="browser-full-url"
          :model-value="preferences.showFullUrl"
          :disabled="saving"
          @update:model-value="(value: boolean) => save({ showFullUrl: value })"
        />
      </SettingsRow>
      <SettingsRow
        title="浏览数据"
        description="清除内置浏览器里的 Cookie、网站数据、缓存和浏览历史"
      >
        <div class="browser-inline">
          <span
            v-if="clearing === 'done'"
            class="browser-status"
            data-clear-status
            role="status"
            >已清除</span
          >
          <span
            v-else-if="clearing === 'failed'"
            class="browser-status failed"
            data-clear-status
            role="alert"
            >清除失败：{{ clearError }}</span
          >
          <Button
            variant="outline"
            size="sm"
            data-action="clear-browser-data"
            :disabled="clearing === 'running'"
            @click="clearData"
          >
            {{ clearing === 'running' ? '正在清除…' : '清除浏览数据' }}
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="浏览历史"
        description="记录你在内置浏览器里打开过的网页；只在内存里，关闭即清空"
        label-for="browser-history"
      >
        <Switch
          id="browser-history"
          :model-value="preferences.history"
          :disabled="saving"
          @update:model-value="(value: boolean) => save({ history: value })"
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="自动填充和密码">
      <SettingsRow
        title="密码管理器"
        description="添加、删除和编辑 Emperor 代填用的密码"
      >
        <Button
          size="sm"
          variant="outline"
          data-action="manage-passwords"
          @click="openPage('passwords')"
          >管理</Button
        >
      </SettingsRow>
      <SettingsRow
        title="登录状态"
        description="Emperor 操作网页时保留登录的 profile"
      >
        <Button
          size="sm"
          variant="outline"
          data-action="manage-profiles"
          @click="openPage('profiles')"
          >管理</Button
        >
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="下载">
      <SettingsRow
        title="下载保留时间"
        description="Emperor 下载的文件在收件箱中保留的时间，到期自动删除"
        label-for="browser-download-retention"
      >
        <Select
          id="browser-download-retention"
          size="sm"
          :model-value="retention"
          :options="RETENTION_OPTIONS"
          :disabled="busy || !status?.supported"
          data-testid="browser-download-retention"
          @update:model-value="setRetention"
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="浏览器权限">
      <SettingsRow
        title="网站设置"
        description="管理摄像头、麦克风、位置、通知等网站权限"
      >
        <Button
          size="sm"
          variant="outline"
          data-action="manage-sites"
          @click="openPage('sites')"
          >管理</Button
        >
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.browser-error {
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--danger-soft));
  color: rgb(var(--danger));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.agent-card {
  margin-top: var(--space-2);
}

.browser-note {
  display: block;
  margin-top: var(--space-0-5);
  color: rgb(var(--state-warn-label));
}

.browser-inline {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.browser-status {
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
}

.browser-status.failed {
  color: rgb(var(--danger));
}
</style>
