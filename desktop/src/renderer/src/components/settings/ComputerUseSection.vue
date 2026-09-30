<script setup lang="ts">
/**
 * Settings › 电脑操作 — laid out like Codex's 电脑操控 (spec 00 §3.3, §6.6,
 * §6.9, revised 2026-09-29: the AI drives continuously while it is on):
 * - the master card: 电脑操作 on or off (off by default; turning it on
 *   registers the GUI tools); after an emergency stop it says 已停止 and
 *   offers 恢复. A notice explains when a saved per-item mode switched it
 *   off;
 * - 控制: 任意应用 (the macOS desktop driver) and Chrome 和 Edge (the
 *   extension connection), each with 管理 (its sub page) and its own
 *   switch (tools stay registered, §8.4); the stage is named only when it
 *   is not simply available;
 * - 不让 Emperor 操作的应用: the user's protected apps (添加 / 移除);
 * - 紧急停止: the shortcut (修改) and 立即停止 / 恢复.
 * Sub pages (`useSettingsPages`):
 * - 任意应用: Emperor Computer Helper, Accessibility and Screen Recording
 *   with their repair actions (shown only when needed), the high-risk and
 *   no-screenshot app lists, and saved screenshots;
 * - Chrome 和 Edge: the extension pairing. The pairing panel stays mounted
 *   (hidden elsewhere) so the main page shows its summary, and a pairing
 *   code that starts waiting opens this page.
 * Emperor's control of the built-in browser, passwords, sign-ins, site
 * permissions and download retention live in 设置 › 浏览器.
 * Everything comes from `computerUse.status` and refreshes on the host's
 * `computer_use_changed` events. Stopping and resuming never wait on a
 * pending card (Core does not guard them).
 */
import type { ComputerUseStatusView } from '@emperor/core/runtime-contract'
import type {
  MacHelperPermission,
  MacHelperPermissionStatus,
  MacHelperStatus,
} from '../../../../shared/ipc-contract'
import { MousePointerClick } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  macHelperRequestPermission,
  macHelperReconnect,
  macHelperResetPermission,
  macHelperStatus,
  onCoreEvent,
} from '../../api/backend'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import Button from '../ui/Button.vue'
import {
  EmptyState,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  Switch,
} from './ui'
import {
  refreshAction,
  useSettingsHeader,
  useSettingsPages,
} from './settingsHeader'
import {
  computerUseHeadline,
  driverRows,
  killSwitchRow,
  screenshotRow,
} from './computer/computerUseSettingsModel'
import KillSwitchEditor from './computer/KillSwitchEditor.vue'
import AppIdDialog from './computer/AppIdDialog.vue'
import AppListsSettings from './computer/AppListsSettings.vue'
import BrowserPairingSettings from './computer/BrowserPairingSettings.vue'

const ctx = useAppContext()
const { page, open: openPage } = useSettingsPages({
  apps: '任意应用',
  chrome: 'Chrome 和 Edge',
})
const status = ref<ComputerUseStatusView | null>(null)
const loaded = ref(false)
const busy = ref(false)
const error = ref('')
const helper = ref<MacHelperStatus | null>(null)

const headline = computed(() => computerUseHeadline(status.value, loaded.value))
const killSwitch = computed(() => killSwitchRow(status.value))
const screenshots = computed(() => screenshotRow(status.value))
const supported = computed(() => Boolean(status.value?.supported))
const enabled = computed(() => Boolean(status.value?.enabled))
const stopped = computed(() => Boolean(status.value?.stopped))
const macDesktop = computed(() => status.value?.platform === 'macos')

const rows = computed(() => driverRows(status.value))
const desktopRow = computed(() =>
  rows.value.find((row) => row.driver === 'desktop'),
)
const chromeRow = computed(() =>
  rows.value.find((row) => row.driver === 'external-browser'),
)

/** The card names its state only when it is not simply on or off. */
const cardBadge = computed(() =>
  ['已急停', '已暂停', '不可用'].includes(headline.value.badge)
    ? {
        tone: headline.value.tone,
        text:
          headline.value.badge === '已急停' ? '已停止' : headline.value.badge,
      }
    : null,
)
const cardDescription = computed(() =>
  stopped.value || !supported.value || status.value?.scopedRetired
    ? headline.value.description
    : '允许 Emperor 在对话里操作应用和网页',
)

// ── Chrome 和 Edge ───────────────────────────────────────────────────────
const pairing = ref({ pending: 0, paired: 0, tabs: 0 })

function onPairingSummary(value: {
  pending: number
  paired: number
  tabs: number
}): void {
  // A code that starts waiting needs the user now: show the pairing page.
  if (value.pending > pairing.value.pending && page.value === null)
    openPage('chrome')
  pairing.value = value
}

const chromeDescription = computed(() => {
  const row = chromeRow.value
  if (row && (!row.switchedOn || row.stage === '不可用')) return row.description
  if (pairing.value.pending > 0) return '有配对等待确认'
  if (pairing.value.paired > 0)
    return `已连接 ${pairing.value.paired} 个浏览器 · ${pairing.value.tabs} 个可操作标签页`
  return '尚未连接'
})

// ── 任意应用 ─────────────────────────────────────────────────────────────
const permissionsMissing = computed(
  () =>
    macDesktop.value &&
    helper.value !== null &&
    (helper.value.permissions.accessibility !== 'granted' ||
      helper.value.permissions['screen-recording'] !== 'granted'),
)
const desktopDescription = computed(() => {
  const row = desktopRow.value
  if (row && enabled.value && !row.switchedOn) return row.description
  if (row?.stage === '不可用') return row.description
  if (permissionsMissing.value) return '需要辅助功能和屏幕录制权限'
  return '允许 Emperor 操作你 Mac 上的应用'
})

const helperDescription = computed(() => {
  const value = helper.value
  if (!value) return '正在检查连接状态'
  if (!value.connected)
    return (
      value.reason ??
      (value.autoRestartSuspended
        ? 'Helper 已停止自动重启'
        : '正在检查连接状态')
    )
  const parts = [
    `版本 ${value.helperVersion ?? '未知'}`,
    `协议 ${value.protocol ?? '未知'}`,
  ]
  if (value.lastErrorCode) parts.push(`最近错误码：${value.lastErrorCode}`)
  return parts.join(' · ')
})

const permissionLabels: Record<MacHelperPermissionStatus, string> = {
  granted: '已授权',
  denied: '未授权',
  unknown: '待检查',
  stale: '需重启',
}

function permissionLabel(permission: MacHelperPermission): string {
  return permissionLabels[helper.value?.permissions[permission] ?? 'unknown']
}

function permissionTone(
  permission: MacHelperPermission,
): 'ok' | 'warn' | 'neutral' {
  const state = helper.value?.permissions[permission]
  return state === 'granted'
    ? 'ok'
    : state === 'denied' || state === 'stale'
      ? 'warn'
      : 'neutral'
}

function needsReset(permission: MacHelperPermission): boolean {
  return ['denied', 'stale'].includes(
    helper.value?.permissions[permission] ?? '',
  )
}

// ── Loading and actions ──────────────────────────────────────────────────
async function refreshHelper(): Promise<void> {
  if (!macDesktop.value) {
    helper.value = null
    return
  }
  try {
    helper.value = await macHelperStatus()
  } catch {
    helper.value = null
  }
}

async function reload(): Promise<void> {
  try {
    status.value = await core('computerUse.status')
    await refreshHelper()
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loaded.value = true
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

function setEnabled(next: boolean): void {
  if (next === enabled.value) return
  void act(() => core('computerUse.setEnabled', next))
}

function stopAll(): void {
  void act(() => core('computerUse.stop'))
}

function resumeAll(): void {
  void act(() => core('computerUse.resume'))
}

function setDriverEnabled(
  driver: 'external-browser' | 'desktop',
  next: boolean,
): void {
  void act(() =>
    core('computerUse.setDriverEnabled', { driver, enabled: next }),
  )
}

function setKillSwitch(accelerator: string | null): void {
  void act(() => core('computerUse.setKillSwitch', { accelerator }))
}

const appLists = computed(() => ({
  protected: status.value?.appLists?.protected ?? [],
  highRisk: status.value?.appLists?.highRisk ?? [],
  sensitive: status.value?.appLists?.sensitive ?? [],
}))

function setAppList(
  kind: 'protected' | 'highRisk' | 'sensitive',
  next: string[],
): void {
  void act(() => core('computerUse.setAppLists', { [kind]: next }))
}

const addingProtected = ref(false)

function addProtected(id: string): void {
  if (appLists.value.protected.includes(id)) return
  setAppList('protected', [...appLists.value.protected, id])
}

function removeProtected(id: string): void {
  setAppList(
    'protected',
    appLists.value.protected.filter((item) => item !== id),
  )
}

function clearScreenshots(): void {
  if (
    !window.confirm(
      '删除电脑操作保存的全部截图？对话记录里的截图将显示为「附件已清除」。',
    )
  )
    return
  void act(() => core('computerUse.clearScreenshots', {}))
}

/** 00 §12: after the crash latch the user restarts the Helper here. */
function reconnectHelper(): void {
  void act(async () => {
    const next = await macHelperReconnect()
    if (!next.connected)
      throw new Error(next.reason ?? '无法连接 Emperor Computer Helper')
  })
}

function requestPermission(permission: MacHelperPermission): void {
  void act(async () => {
    const result = await macHelperRequestPermission(permission)
    if (!result.opened)
      throw new Error(
        '无法打开系统权限设置；请在系统设置中找到 Emperor Computer Helper',
      )
  })
}

function resetPermission(permission: MacHelperPermission): void {
  const label = permission === 'accessibility' ? '辅助功能' : '屏幕录制'
  if (
    !window.confirm(
      `重置 Emperor Computer Helper 的${label}授权？之后需要重新打开系统开关。`,
    )
  )
    return
  void act(async () => {
    const result = await macHelperResetPermission(permission)
    if (!result.reset) throw new Error(`${label}授权重置失败`)
  })
}

useSettingsHeader({ actions: () => [refreshAction(() => reload())] })

let unsubscribe = () => {}
let timer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  void ctx.runSafely(reload)
  unsubscribe = onCoreEvent((event) => {
    if (
      !event ||
      typeof event !== 'object' ||
      (event as { event?: unknown }).event !== 'computer_use_changed' ||
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
  <SettingsSection
    :intro="
      page === 'apps'
        ? '让 Emperor 操作你 Mac 上的应用所需的系统权限、另外的应用名单，以及保存的截图。'
        : undefined
    "
  >
    <p v-if="error" class="cu-error" role="alert">{{ error }}</p>

    <!-- 任意应用 -->
    <template v-if="page === 'apps'">
      <p v-if="desktopRow?.missing.length" class="cu-note">
        实验阶段，尚不支持：{{ desktopRow.missing.join('、') }}
      </p>
      <SettingsGroup
        v-if="macDesktop"
        title="系统权限"
        description="桌面权限只授予 Emperor Computer Helper，不授予主应用"
      >
        <p v-if="helper?.previewBuild" class="cu-notice" role="status">
          预览版每次更新后需重新授权辅助功能和屏幕录制；如系统开关显示已开启但权限失效，请使用“重置授权”重新登记。
        </p>
        <SettingsRow
          title="Emperor Computer Helper"
          :description="helperDescription"
        >
          <div class="cu-control">
            <StatusBadge :tone="helper?.connected ? 'ok' : 'warn'">
              {{ helper?.connected ? '已连接' : '未连接' }}
            </StatusBadge>
            <Button
              v-if="helper?.available && !helper.connected"
              size="sm"
              variant="outline"
              :disabled="busy"
              data-testid="mac-helper-reconnect"
              @click="reconnectHelper"
              >重新连接</Button
            >
          </div>
        </SettingsRow>
        <SettingsRow
          title="辅助功能"
          description="读取其他应用的窗口和控件。系统设置里没有 Helper 时，先点“请求权限”让它登记。"
        >
          <div class="cu-control">
            <StatusBadge :tone="permissionTone('accessibility')">{{
              permissionLabel('accessibility')
            }}</StatusBadge>
            <Button
              v-if="helper?.permissions.accessibility !== 'granted'"
              size="sm"
              variant="outline"
              :disabled="busy || !helper?.connected"
              @click="requestPermission('accessibility')"
              >请求权限</Button
            >
            <Button
              v-if="needsReset('accessibility')"
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="resetPermission('accessibility')"
              >重置授权</Button
            >
          </div>
        </SettingsRow>
        <SettingsRow
          title="屏幕录制"
          description="截图和对话里的实时画面需要。打开系统开关后点“重启 Helper”生效；列表里没有 Helper 时，点“＋”在 ~/.emperor/native-helpers/ 中选择 Emperor Computer Helper.app。"
        >
          <div class="cu-control">
            <StatusBadge :tone="permissionTone('screen-recording')">{{
              permissionLabel('screen-recording')
            }}</StatusBadge>
            <Button
              v-if="helper?.permissions['screen-recording'] !== 'granted'"
              size="sm"
              variant="outline"
              :disabled="busy || !helper?.connected"
              @click="requestPermission('screen-recording')"
              >请求权限</Button
            >
            <!-- A running helper keeps its first screen-recording answer. -->
            <Button
              v-if="
                helper?.connected &&
                helper.permissions['screen-recording'] !== 'granted'
              "
              size="sm"
              variant="outline"
              :disabled="busy"
              data-testid="mac-helper-restart"
              @click="reconnectHelper"
              >重启 Helper</Button
            >
            <Button
              v-if="needsReset('screen-recording')"
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="resetPermission('screen-recording')"
              >重置授权</Button
            >
          </div>
        </SettingsRow>
      </SettingsGroup>
      <AppListsSettings
        v-if="macDesktop"
        :lists="appLists"
        :busy="busy"
        :kinds="['highRisk', 'sensitive']"
        @change="setAppList"
      />
      <SettingsGroup title="截图">
        <SettingsRow
          title="已保存的截图"
          :description="screenshots.description"
        >
          <Button
            size="sm"
            variant="outline"
            :disabled="busy || screenshots.empty"
            data-testid="computer-use-clear-screenshots"
            @click="clearScreenshots"
          >
            全部清除
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </template>

    <!-- Main page -->
    <template v-else-if="page === null">
      <p
        v-if="status?.scopedRetired && !enabled"
        class="cu-notice"
        role="status"
        data-testid="computer-use-scoped-retired"
      >
        电脑操作改为由 AI
        连续操作，不再逐项授权。你之前选择的「逐项授权」已停用，电脑操作因此已关闭；确认后重新打开即可。
      </p>
      <SettingsCard
        class="cu-card"
        data-testid="computer-use-card"
        title="电脑操作"
        :description="cardDescription"
      >
        <template #leading><MousePointerClick :size="20" /></template>
        <template v-if="cardBadge" #meta>
          <StatusBadge
            :tone="cardBadge.tone"
            dot
            data-testid="computer-use-status"
            >{{ cardBadge.text }}</StatusBadge
          >
        </template>
        <template #actions>
          <Button
            v-if="stopped"
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="resumeAll"
            >恢复</Button
          >
          <Switch
            id="computer-use-enabled"
            :model-value="enabled"
            :disabled="busy || !supported"
            aria-label="电脑操作"
            @update:model-value="setEnabled"
          />
        </template>
      </SettingsCard>

      <SettingsGroup title="控制">
        <SettingsRow
          v-if="macDesktop && desktopRow"
          title="任意应用"
          :description="desktopDescription"
          data-driver="desktop"
        >
          <template v-if="desktopRow.stage !== '可用'" #badge>
            <StatusBadge :tone="desktopRow.tone">{{
              desktopRow.stage
            }}</StatusBadge>
          </template>
          <div class="cu-control">
            <Button
              size="sm"
              variant="outline"
              data-action="manage-apps"
              @click="openPage('apps')"
              >管理</Button
            >
            <Switch
              id="computer-use-driver-desktop"
              :model-value="desktopRow.switchedOn"
              :disabled="busy || !enabled"
              aria-label="任意应用开关"
              @update:model-value="setDriverEnabled('desktop', $event)"
            />
          </div>
        </SettingsRow>
        <SettingsRow
          v-if="chromeRow"
          title="Chrome 和 Edge"
          data-driver="external-browser"
        >
          <template v-if="chromeRow.stage !== '可用'" #badge>
            <StatusBadge :tone="chromeRow.tone">{{
              chromeRow.stage
            }}</StatusBadge>
          </template>
          <template #description>
            <span data-testid="browser-pairing-summary">{{
              chromeDescription
            }}</span>
          </template>
          <div class="cu-control">
            <Button
              size="sm"
              variant="outline"
              data-testid="browser-pairing-manage"
              @click="openPage('chrome')"
              >管理</Button
            >
            <Switch
              id="computer-use-driver-external-browser"
              :model-value="chromeRow.switchedOn"
              :disabled="busy || !enabled"
              aria-label="Chrome 和 Edge 开关"
              @update:model-value="setDriverEnabled('external-browser', $event)"
            />
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup v-if="macDesktop" title="不让 Emperor 操作的应用">
        <template #actions>
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            data-action="add-protected-app"
            @click="addingProtected = true"
            >添加</Button
          >
        </template>
        <EmptyState
          v-if="!appLists.protected.length"
          compact
          title="暂无"
          description="系统授权界面和 Emperor 自身已内置保护"
        />
        <SettingsRow
          v-for="id in appLists.protected"
          :key="id"
          :title="id"
          :data-protected-app="id"
          dense
        >
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            :aria-label="`移除 ${id}`"
            @click="removeProtected(id)"
            >移除</Button
          >
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="紧急停止">
        <SettingsRow
          :title="stopped ? '已停止' : '停止所有操作'"
          :description="
            stopped
              ? '所有窗口和标签页已释放（没有关闭）；恢复后 Emperor 可以重新接手。'
              : killSwitch.description
          "
        >
          <div class="cu-control">
            <KillSwitchEditor
              :accelerator="status?.killSwitch.accelerator ?? ''"
              :busy="busy"
              @save="setKillSwitch"
            />
            <Button
              v-if="stopped"
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="resumeAll"
              >恢复</Button
            >
            <Button
              v-else
              size="sm"
              variant="danger"
              :disabled="busy || !enabled"
              @click="stopAll"
              >立即停止</Button
            >
          </div>
        </SettingsRow>
      </SettingsGroup>
    </template>

    <!-- Chrome 和 Edge: always mounted, for the summary and the auto-open. -->
    <div v-show="page === 'chrome'" id="computer-use-pairing">
      <p v-if="chromeRow?.missing.length" class="cu-note">
        实验阶段，尚不支持：{{ chromeRow.missing.join('、') }}
      </p>
      <BrowserPairingSettings
        @connection-changed="reload"
        @summary="onPairingSummary"
      />
    </div>
  </SettingsSection>

  <AppIdDialog
    v-model:open="addingProtected"
    title="添加不让 Emperor 操作的应用"
    description="Emperor 看不到也不能操作这些应用，例如密码管理器、网银客户端。"
    :busy="busy"
    @save="addProtected"
  />
</template>

<style scoped>
.cu-error {
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--danger-soft));
  color: rgb(var(--danger));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.cu-card {
  margin-top: var(--space-2);
}

.cu-control {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.cu-note {
  margin: var(--space-2) 0 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.cu-notice {
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--warn-soft));
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
