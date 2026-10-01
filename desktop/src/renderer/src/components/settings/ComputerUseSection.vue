<script setup lang="ts">
/**
 * Settings › 电脑操作 — one page, laid out like Codex's 电脑操控 (spec 00
 * §3.3, §6.6, §6.9; 2026-09-29: the AI drives continuously while it is on;
 * 2026-10-01: every app but the system-protected ones, no app lists and no
 * emergency stop — switching off or stopping the conversation ends the
 * work). Top to bottom:
 * - notices, only while something needs the user: an action failed; the
 *   apps the user once kept from Emperor can be operated now (once, until
 *   知道了); a saved per-item mode switched computer use off; the Helper is
 *   offline or a macOS permission is missing (with the buttons that fix it);
 * - the master card (off by default; turning it on registers the GUI tools);
 * - 控制: 任意应用 (the macOS desktop driver) and Chrome 和 Edge (the
 *   extension connection, 管理 opens its sub page), each with its own
 *   switch (tools stay registered, §8.4); the stage is named only when it
 *   is not simply available;
 * - 系统权限 (macOS): one row while the Helper runs with Accessibility and
 *   Screen Recording, else a row each and the Helper's, with 重置授权;
 * - 截图: saved screenshots and 全部清除.
 * Sub page (`useSettingsPages`): Chrome 和 Edge, the extension pairing. The
 * pairing panel stays mounted (hidden elsewhere) so the main page shows its
 * summary, and a pairing code that starts waiting opens the page. The old
 * 任意应用 page (`?page=apps`) is gone: its links show this page.
 * Emperor's control of the built-in browser, passwords, sign-ins, site
 * permissions and download retention live in 设置 › 浏览器.
 * Everything comes from `computerUse.status` and the Helper's status, and
 * refreshes on the host's `computer_use_changed` events. Switching off
 * never waits on a pending card (Core does not guard it).
 */
import type { ComputerUseStatusView } from '@emperor/core/runtime-contract'
import type {
  MacHelperPermission,
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
  SettingsCard,
  SettingsGroup,
  SettingsNotice,
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
  desktopNotice,
  desktopRowText,
  driverRows,
  permissionRows,
  permissionsToReset,
  screenshotRow,
} from './computer/computerUseSettingsModel'
import BrowserPairingSettings from './computer/BrowserPairingSettings.vue'

const ctx = useAppContext()
const { page, open: openPage } = useSettingsPages({
  chrome: 'Chrome 和 Edge',
})
const status = ref<ComputerUseStatusView | null>(null)
const loaded = ref(false)
const busy = ref(false)
const error = ref('')
const helper = ref<MacHelperStatus | null>(null)

const headline = computed(() => computerUseHeadline(status.value, loaded.value))
const screenshots = computed(() => screenshotRow(status.value))
const supported = computed(() => Boolean(status.value?.supported))
const enabled = computed(() => Boolean(status.value?.enabled))
const macDesktop = computed(() => status.value?.platform === 'macos')
const retiredApps = computed(() => status.value?.retiredProtectedApps ?? [])
const scopedRetired = computed(
  () => status.value?.scopedRetired === true && !enabled.value,
)

const rows = computed(() => driverRows(status.value))
const desktopRow = computed(() =>
  rows.value.find((row) => row.driver === 'desktop'),
)
const chromeRow = computed(() =>
  rows.value.find((row) => row.driver === 'external-browser'),
)

/** The card names its state only when it is not simply on or off. */
const cardBadge = computed(() =>
  headline.value.badge === '不可用'
    ? { tone: headline.value.tone, text: headline.value.badge }
    : null,
)
const cardDescription = computed(() =>
  !supported.value || status.value?.scopedRetired
    ? headline.value.description
    : '允许 Emperor 在对话里操作应用和网页',
)

// ── 任意应用 and its macOS permissions ──────────────────────────────────
const notice = computed(() =>
  macDesktop.value ? desktopNotice(helper.value) : null,
)
const desktopText = computed(() =>
  desktopRowText(
    desktopRow.value,
    enabled.value,
    macDesktop.value ? helper.value : null,
  ),
)
const permissions = computed(() => permissionRows(helper.value))
const resettable = computed(() => permissionsToReset(helper.value))
const anyNotice = computed(
  () =>
    error.value !== '' ||
    retiredApps.value.length > 0 ||
    scopedRetired.value ||
    notice.value !== null,
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

function setDriverEnabled(
  driver: 'external-browser' | 'desktop',
  next: boolean,
): void {
  void act(() =>
    core('computerUse.setDriverEnabled', { driver, enabled: next }),
  )
}

function acknowledgeRetiredApps(): void {
  void act(() => core('computerUse.acknowledgeRetiredApps'))
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

const PERMISSION_LABELS: Record<MacHelperPermission, string> = {
  accessibility: '辅助功能',
  'screen-recording': '屏幕录制',
}

function resetPermissions(): void {
  const targets = resettable.value
  if (targets.length === 0) return
  const labels = targets.map((item) => PERMISSION_LABELS[item]).join('和')
  if (
    !window.confirm(
      `重置 Emperor Computer Helper 的${labels}授权？之后需要在系统设置里重新打开开关。`,
    )
  )
    return
  void act(async () => {
    for (const permission of targets) {
      const result = await macHelperResetPermission(permission)
      if (!result.reset)
        throw new Error(`${PERMISSION_LABELS[permission]}授权重置失败`)
    }
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
  <SettingsSection>
    <template v-if="page === null">
      <div v-if="anyNotice" class="cu-notices">
        <SettingsNotice
          v-if="error"
          tone="error"
          title="操作没有完成"
          :description="error"
        />
        <SettingsNotice
          v-if="retiredApps.length"
          tone="info"
          title="这些应用现在也可以由 Emperor 操作"
          data-testid="computer-use-retired-apps"
        >
          应用名单已取消：除系统设置、钥匙串访问、「密码」和授权弹窗等受系统保护的应用外，Emperor
          可以操作所有应用。你以前不让它操作的应用：
          <span v-for="id in retiredApps" :key="id" class="cu-app-id">{{
            id
          }}</span>
          <template #actions>
            <Button
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="acknowledgeRetiredApps"
              >知道了</Button
            >
          </template>
        </SettingsNotice>
        <SettingsNotice
          v-if="scopedRetired"
          tone="info"
          title="电脑操作已关闭"
          description="电脑操作改为由 AI 连续操作，不再逐项授权。你之前选择的「逐项授权」已停用；确认后重新打开即可。"
          data-testid="computer-use-scoped-retired"
        />
        <SettingsNotice
          v-if="notice"
          :title="notice.title"
          :description="notice.description"
          data-testid="computer-use-desktop-notice"
        >
          <template
            v-if="notice.request || notice.restart || notice.reconnect"
            #actions
          >
            <Button
              v-if="notice.request"
              size="sm"
              variant="primary"
              :disabled="busy"
              @click="requestPermission(notice.request)"
              >请求权限</Button
            >
            <!-- A running Helper keeps its first Screen Recording answer. -->
            <Button
              v-if="notice.restart"
              size="sm"
              variant="outline"
              :disabled="busy"
              data-testid="mac-helper-restart"
              @click="reconnectHelper"
              >重启 Helper</Button
            >
            <Button
              v-if="notice.reconnect"
              size="sm"
              variant="primary"
              :disabled="busy"
              data-testid="mac-helper-reconnect"
              @click="reconnectHelper"
              >重新连接</Button
            >
          </template>
        </SettingsNotice>
      </div>

      <SettingsCard
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
          data-driver="desktop"
        >
          <template v-if="desktopRow.stage !== '可用'" #badge>
            <StatusBadge :tone="desktopRow.tone">{{
              desktopRow.stage
            }}</StatusBadge>
          </template>
          <template #description>
            <span :class="{ 'cu-warn': desktopText.warn }">{{
              desktopText.text
            }}</span>
          </template>
          <Switch
            id="computer-use-driver-desktop"
            :model-value="desktopRow.switchedOn"
            :disabled="busy || !enabled"
            aria-label="任意应用开关"
            @update:model-value="setDriverEnabled('desktop', $event)"
          />
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

      <SettingsGroup
        v-if="macDesktop"
        title="系统权限"
        data-testid="computer-use-permissions"
      >
        <template v-if="resettable.length" #actions>
          <Button
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="resetPermissions"
            >重置授权</Button
          >
        </template>
        <SettingsRow
          v-for="row in permissions"
          :key="row.id"
          :title="row.title"
          :description="row.description"
          :data-permission="row.id"
        >
          <StatusBadge :tone="row.tone" :dot="row.tone === 'ok'">{{
            row.badge
          }}</StatusBadge>
        </SettingsRow>
      </SettingsGroup>

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
</template>

<style scoped>
.cu-notices {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-5);
}

.cu-control {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.cu-warn {
  color: rgb(var(--state-warn-label));
}

.cu-app-id {
  display: inline-block;
  margin: var(--space-1) var(--space-1) 0 0;
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-xs);
  background: rgb(var(--settings-card-control-fill));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.cu-note {
  margin: var(--space-2) 0 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
