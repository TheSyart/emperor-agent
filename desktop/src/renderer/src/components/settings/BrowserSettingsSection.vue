<script setup lang="ts">
/**
 * Settings › 浏览器 — everything about Emperor's built-in browser, laid out
 * like Codex's 浏览器 settings, one card per group (no lead-in paragraph):
 * - a Notice first, only while a computer use call failed;
 * - the control card: whether Emperor may operate the built-in browser
 *   (computer use's embedded-browser driver; greyed out, with a way there,
 *   while 电脑操作 is off);
 * - 常规: where a link to this machine opens (a clicked web link: 设置 ›
 *   常规 › 会话 › 网页链接), the address bar, clearing the browsing data (its outcome is a badge in the
 *   row) and the temporary history of the user's own browsing (the
 *   workspace 浏览器 pane, a memory-only session);
 * - 自动填充和密码: 密码管理器 and 登录状态 (sub pages), with 导入… beside
 *   the title, since it brings in exactly those;
 * - 下载: where the user's own downloads go (位置, picked in the system
 *   folder dialog main shows), whether to ask each time, the history of
 *   theirs and Emperor's downloads (sub page), and how long Emperor's
 *   downloads stay in its inbox;
 * - 浏览器权限: 网站设置 (sub page).
 *
 * The link, history and download choices save at once through
 * `browser.setPreferences` (Core tells every window and main,
 * `browser_preferences_changed`); the rest are computer use settings
 * (`computerUse.status`, refreshed on `computer_use_changed`).
 */
import type {
  BrowserPreferences,
  ComputerUseStatusView,
} from '@emperor/core/runtime-contract'
import { Globe } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  chooseDownloadFolder,
  clearBrowserData,
  onCoreEvent,
} from '../../api/backend'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { useBrowserPreferences } from '../../composables/useBrowserPreferences'
import Button from '../ui/Button.vue'
import DownloadsPage from './browser/DownloadsPage.vue'
import ImportDialog from './browser/ImportDialog.vue'
import PasswordManagerPage from './browser/PasswordManagerPage.vue'
import SignInProfilesPage from './browser/SignInProfilesPage.vue'
import SiteSettingsPage from './browser/SiteSettingsPage.vue'
import { driverRows } from './computer/computerUseSettingsModel'
import { useSettingsPages } from './settingsHeader'
import {
  Select,
  SettingsCard,
  SettingsGroup,
  Notice,
  SettingsRow,
  SettingsSection,
  Badge,
  Switch,
  type SelectOption,
} from './ui'
import { useSettingsRoute } from './useSettingsRoute'

const ctx = useAppContext()
const { preferences, update } = useBrowserPreferences()
const { page, open: openPage } = useSettingsPages({
  passwords: '密码管理器',
  profiles: '登录状态',
  downloads: '下载历史记录',
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

/** 从浏览器导入 dialog (ST-06). */
const importOpen = ref(false)

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

// ── 下载 · 位置 ──────────────────────────────────────────────────────────
const choosingFolder = ref(false)

/** Main shows the system folder picker; a cancel changes nothing. */
async function changeDownloadFolder(): Promise<void> {
  if (choosingFolder.value) return
  choosingFolder.value = true
  try {
    const folder = await chooseDownloadFolder()
    if (folder) save({ downloadDirectory: folder })
  } finally {
    choosingFolder.value = false
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
  <DownloadsPage v-else-if="page === 'downloads'" />
  <SiteSettingsPage v-else-if="page === 'sites'" />
  <SettingsSection v-else>
    <Notice v-if="error" tone="error" :title="error" />
    <SettingsCard
      class="agent-card"
      data-testid="browser-agent-card"
      title="浏览器"
      :description="agentDescription"
      master
    >
      <template #leading><Globe :size="18" /></template>
      <template v-if="agentStage" #meta>
        <Badge :tone="agentStage.tone">{{ agentStage.stage }}</Badge>
      </template>
      <template #actions>
        <Button
          v-if="status?.supported && !masterOn"
          size="sm"
          variant="secondary"
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
      <SettingsRow title="浏览数据">
        <template #description>
          <span v-if="clearing === 'failed'" class="browser-failed" role="alert"
            >没能清除：{{ clearError }}</span
          >
          <template v-else
            >清除 Cookie、网站数据、缓存、浏览历史和下载记录</template
          >
        </template>
        <Badge
          v-if="clearing === 'done'"
          tone="ok"
          variant="dot-label"
          data-clear-status
          role="status"
          >已清除</Badge
        >
        <Badge
          v-else-if="clearing === 'failed'"
          tone="error"
          variant="dot-label"
          data-clear-status
          >清除失败</Badge
        >
        <Button
          variant="secondary"
          size="sm"
          data-action="clear-browser-data"
          :disabled="clearing === 'running'"
          @click="clearData"
        >
          {{ clearing === 'running' ? '正在清除…' : '清除浏览数据' }}
        </Button>
      </SettingsRow>
      <SettingsRow
        title="浏览历史"
        description="只在内存里记录你打开过的网页，关闭即清空"
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
      <template #actions>
        <Button
          size="sm"
          variant="secondary"
          data-testid="open-import"
          @click="importOpen = true"
          >导入…</Button
        >
      </template>
      <SettingsRow
        title="密码管理器"
        description="Emperor 代填用的密码，保存在这台 Mac 的 Emperor 目录里"
      >
        <Button
          size="sm"
          variant="secondary"
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
          variant="secondary"
          data-action="manage-profiles"
          @click="openPage('profiles')"
          >管理</Button
        >
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="下载">
      <SettingsRow title="位置">
        <template #description>
          <span
            class="download-folder"
            data-testid="download-folder"
            :title="preferences.downloadDirectory ?? undefined"
            >{{ preferences.downloadDirectory ?? '系统下载文件夹' }}</span
          >
        </template>
        <Button
          v-if="preferences.downloadDirectory"
          variant="secondary"
          size="sm"
          data-action="reset-download-folder"
          :disabled="saving"
          @click="save({ downloadDirectory: null })"
          >恢复默认</Button
        >
        <Button
          variant="secondary"
          size="sm"
          data-action="change-download-folder"
          :disabled="saving || choosingFolder"
          @click="changeDownloadFolder"
          >更改</Button
        >
      </SettingsRow>
      <SettingsRow
        title="下载前询问保存位置"
        description="每次下载先弹出系统的保存对话框"
        label-for="browser-ask-save"
      >
        <Switch
          id="browser-ask-save"
          :model-value="preferences.askWhereToSave"
          :disabled="saving"
          @update:model-value="
            (value: boolean) => save({ askWhereToSave: value })
          "
        />
      </SettingsRow>
      <SettingsRow title="下载历史记录" description="你的下载和 Emperor 的下载">
        <Button
          size="sm"
          variant="secondary"
          data-action="manage-downloads"
          @click="openPage('downloads')"
          >管理</Button
        >
      </SettingsRow>
      <SettingsRow
        title="下载保留时间"
        description="Emperor 下载的文件在收件箱中保留的时间"
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
        description="摄像头、麦克风、位置、通知等网站权限"
      >
        <Button
          size="sm"
          variant="secondary"
          data-action="manage-sites"
          @click="openPage('sites')"
          >管理</Button
        >
      </SettingsRow>
    </SettingsGroup>
    <ImportDialog v-model:open="importOpen" />
  </SettingsSection>
</template>

<style scoped>
/* After the notice, the control card keeps the groups' 20px rhythm. */
.agent-card:not(:first-child) {
  margin-top: var(--space-5);
}

.browser-note {
  display: block;
  margin-top: var(--space-0-5);
  color: rgb(var(--state-warn-label));
}

.browser-failed {
  color: rgb(var(--state-error-label));
}

.download-folder {
  overflow-wrap: anywhere;
}
</style>
