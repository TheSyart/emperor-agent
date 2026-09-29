<script setup lang="ts">
/**
 * Settings › 电脑操作 — computer use (spec 00 §3.3, §6.3, §6.6, §6.9, §10.4):
 * - the master switch (off by default; turning it on registers the GUI tools),
 * - every driver with its stage (可用 / 实验 / 不可用) and what it lacks,
 * - the emergency stop: global shortcut status plus a 立即停止 / 恢复 button,
 * - one switch per driver (tools stay registered, §8.4),
 * - the emergency stop: shortcut status, 修改 / 恢复默认, 立即停止 / 恢复,
 * - the active GUI grants, each revocable or narrowable one piece at a time,
 * - saved screenshots against the quota, with 全部清除 (§8.5), and how
 *   long downloads stay in the inbox,
 * - the user's own protected / high-risk / sensitive app lists,
 * - a persistent GUI authorization mode independent of Shell permissions,
 * - the sensitive-action exceptions and Shell bypass notice.
 * Everything comes from `computerUse.status` and refreshes on the host's
 * `computer_use_changed` events. Stopping, resuming and revoking never wait
 * on a pending card (Core does not guard them).
 */
import type {
  ComputerUseStatusView,
  UiActionClass,
} from '@emperor/core/runtime-contract'
import type {
  MacHelperPermission,
  MacHelperPermissionStatus,
  MacHelperStatus,
} from '../../../../shared/ipc-contract'
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
  Select,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
  Switch,
} from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import {
  computerUseHeadline,
  driverRows,
  grantRows,
  killSwitchRow,
  screenshotRow,
} from './computer/computerUseSettingsModel'
import KillSwitchEditor from './computer/KillSwitchEditor.vue'
import AppListsSettings from './computer/AppListsSettings.vue'
import CredentialVaultSettings from './computer/CredentialVaultSettings.vue'
import BrowserProfileSettings from './computer/BrowserProfileSettings.vue'
import BrowserPairingSettings from './computer/BrowserPairingSettings.vue'

const ctx = useAppContext()
const status = ref<ComputerUseStatusView | null>(null)
const loaded = ref(false)
const busy = ref(false)
const error = ref('')
const helper = ref<MacHelperStatus | null>(null)

const headline = computed(() => computerUseHeadline(status.value, loaded.value))
const drivers = computed(() => driverRows(status.value))
const killSwitch = computed(() => killSwitchRow(status.value))
const grants = computed(() => grantRows(status.value?.grants ?? []))
const screenshots = computed(() => screenshotRow(status.value))
const supported = computed(() => Boolean(status.value?.supported))
const enabled = computed(() => Boolean(status.value?.enabled))
const unrestricted = computed(
  () => (status.value?.authorizationMode ?? 'unrestricted') === 'unrestricted',
)
const macDesktop = computed(() => status.value?.platform === 'macos')
const desktopDriver = computed(() =>
  status.value?.drivers.find((driver) => driver.driver === 'desktop'),
)

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

function setUnrestricted(next: boolean): void {
  if (next === unrestricted.value) return
  void act(() =>
    core('computerUse.setAuthorizationMode', next ? 'unrestricted' : 'scoped'),
  )
}

function stopAll(): void {
  void act(() => core('computerUse.stop'))
}

function resumeAll(): void {
  void act(() => core('computerUse.resume'))
}

function revoke(grantId: string): void {
  void act(() => core('computerUse.revokeGrant', grantId))
}

function setDriverEnabled(
  driver: 'embedded-browser' | 'external-browser' | 'desktop',
  next: boolean,
): void {
  void act(() =>
    core('computerUse.setDriverEnabled', { driver, enabled: next }),
  )
}

function setKillSwitch(accelerator: string | null): void {
  void act(() => core('computerUse.setKillSwitch', { accelerator }))
}

/** Take one action or one site away from a grant (the rest stays). */
function narrow(
  grantId: string,
  change: { allowedActions?: UiActionClass[]; origins?: string[] },
): void {
  void act(() => core('computerUse.narrowGrant', { grantId, ...change }))
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

const RETENTION_OPTIONS = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 0, label: '一直保留' },
]
const retention = computed(() => status.value?.downloadRetentionDays ?? 30)

function setRetention(days: number | undefined): void {
  if (days === undefined || days === retention.value) return
  void act(() =>
    core('computerUse.setDownloadRetention', {
      days: days as 0 | 7 | 30 | 90,
    }),
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
    intro="让 Agent 在内置浏览器、已配对的 Chrome 标签页和获得权限的 macOS 桌面窗口中操作。每个动作都记入会话日志，随时可以暂停、接管或急停。"
  >
    <p v-if="error" class="cu-error" role="alert">{{ error }}</p>

    <SettingsRow
      title="启用电脑操作"
      :description="headline.description"
      label-for="computer-use-enabled"
    >
      <div class="cu-control">
        <StatusBadge
          :tone="headline.tone"
          dot
          data-testid="computer-use-status"
        >
          {{ headline.badge }}
        </StatusBadge>
        <Switch
          id="computer-use-enabled"
          :model-value="enabled"
          :disabled="busy || !supported"
          @update:model-value="setEnabled"
        />
      </div>
    </SettingsRow>

    <SettingsRow
      title="持续允许电脑操作"
      description="开启后，普通查看、点击、输入、跳转和文件传输无需按网站或应用反复授权；关闭则逐项授权。此设置会保存，且与会话的 Shell 权限独立。"
      label-for="computer-use-unrestricted"
    >
      <Switch
        id="computer-use-unrestricted"
        :model-value="unrestricted"
        :disabled="busy || !supported"
        @update:model-value="setUnrestricted"
      />
    </SettingsRow>

    <BrowserPairingSettings @connection-changed="reload" />

    <SettingsGroup
      v-if="drivers.length"
      title="驱动"
      description="每种驱动单独标注阶段；尚不支持的动作会直接告知 Agent「能力未启用」，Agent 也可随时查询当前可用能力"
    >
      <SettingsRow
        v-for="driver in drivers"
        :key="driver.driver"
        :title="driver.label"
        :description="driver.description"
        :data-driver="driver.driver"
      >
        <template v-if="driver.missing.length" #description>
          <span>{{ driver.description }}</span>
          <span class="cu-missing"
            >尚不支持：{{ driver.missing.join('、') }}</span
          >
        </template>
        <div class="cu-control">
          <StatusBadge :tone="driver.tone">{{ driver.stage }}</StatusBadge>
          <Switch
            :id="`computer-use-driver-${driver.driver}`"
            :model-value="driver.switchedOn"
            :disabled="busy || !enabled"
            :aria-label="`${driver.label}开关`"
            @update:model-value="setDriverEnabled(driver.driver, $event)"
          />
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      v-if="macDesktop"
      title="macOS 桌面"
      description="桌面权限由 Emperor Computer Helper 使用；桌面动作仍处于实验验收阶段"
    >
      <p class="cu-missing" role="note">
        如果也向 Emperor Agent 主应用授予屏幕录制权限，它启动的 Shell
        子进程可能直接截图，绕过电脑操作的目标授权。受限 Shell
        的现有隔离规则不能阻止这种继承。
      </p>
      <p v-if="helper?.previewBuild" class="cu-missing" role="status">
        预览版每次更新后需重新授权辅助功能和屏幕录制；如系统开关显示已开启但权限失效，请使用下方的“重置授权”重新登记。
      </p>
      <SettingsRow
        title="Emperor Computer Helper"
        :description="
          helper?.connected
            ? `版本 ${helper.helperVersion ?? '未知'} · 协议 ${helper.protocol ?? '未知'}`
            : (helper?.reason ?? '正在检查连接状态')
        "
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
        description="允许 Helper 读取其他应用的窗口和控件。若系统设置列表中没有 Helper，先点“请求权限”使它登记，再打开开关。"
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
            v-if="
              ['denied', 'stale'].includes(
                helper?.permissions.accessibility ?? '',
              )
            "
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
        description="仅截图需要。点“请求权限”后到系统设置的“录屏与系统录音”打开开关；若列表没有 Helper，点“＋ 添加”，在 ~/.emperor/native-helpers/ 中选择本次安装的 Emperor Computer Helper.app。macOS 要到 Helper 重新启动后才生效，打开开关后点“重启 Helper”。"
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
            v-if="
              ['denied', 'stale'].includes(
                helper?.permissions['screen-recording'] ?? '',
              )
            "
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="resetPermission('screen-recording')"
            >重置授权</Button
          >
        </div>
      </SettingsRow>
      <SettingsRow
        title="当前能力"
        :description="
          desktopDriver?.available
            ? desktopDriver.actions.length
              ? '可列出应用、窗口并读取控件；点击与输入仅在当前授权目标中开放。桌面凭据代填和真实动作矩阵尚待验收。'
              : '可列出应用与窗口、读取控件；获得屏幕录制权限后可截图。点击、键盘鼠标输入和凭据代填尚未开放。'
            : '桌面驱动当前不可用；点击、键盘鼠标输入和凭据代填尚未开放。'
        "
      >
        <StatusBadge :tone="desktopDriver?.actions.length ? 'warn' : 'accent'">
          {{ desktopDriver?.actions.length ? '可交互（实验）' : '只读' }}
        </StatusBadge>
      </SettingsRow>
      <SettingsRow
        title="诊断"
        :description="
          helper?.autoRestartSuspended
            ? (helper.reason ?? 'Helper 已停止自动重启')
            : helper?.lastErrorCode
              ? `最近错误码：${helper.lastErrorCode}`
              : helper?.connected
                ? '连接正常'
                : (helper?.reason ?? '等待 Helper 连接')
        "
        dense
      />
    </SettingsGroup>

    <SettingsGroup title="紧急停止">
      <SettingsRow title="全局快捷键" :description="killSwitch.description">
        <div class="cu-control">
          <kbd v-if="killSwitch.shortcut" class="cu-kbd">{{
            killSwitch.shortcut
          }}</kbd>
          <StatusBadge :tone="killSwitch.tone">{{
            killSwitch.badge
          }}</StatusBadge>
          <KillSwitchEditor
            :accelerator="status?.killSwitch.accelerator ?? ''"
            :busy="busy"
            @save="setKillSwitch"
          />
        </div>
      </SettingsRow>
      <SettingsRow
        :title="status?.stopped ? '已停止' : '停止所有操作'"
        :description="
          status?.stopped
            ? '所有目标已暂停，授权已挂起。恢复后 Agent 可以继续。'
            : '取消进行中的动作，暂停所有目标，并挂起全部授权'
        "
      >
        <Button
          v-if="status?.stopped"
          size="sm"
          variant="outline"
          :disabled="busy"
          @click="resumeAll"
        >
          恢复
        </Button>
        <Button
          v-else
          size="sm"
          variant="danger"
          :disabled="busy || !enabled"
          @click="stopAll"
        >
          立即停止
        </Button>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      title="授权"
      description="Agent 可以操作的网站、应用与动作。一次性和本任务的授权随任务结束失效。"
    >
      <SettingsRow
        v-for="grant in grants"
        :key="grant.grantId"
        :title="grant.title"
        :description="grant.detail"
        dense
      >
        <template
          v-if="grant.actions.length > 1 || grant.origins.length > 1"
          #description
        >
          <span>{{ grant.detail }}</span>
          <span class="cu-chips" role="group" aria-label="收窄授权">
            <button
              v-for="action in grant.actions.length > 1 ? grant.actions : []"
              :key="action.value"
              type="button"
              class="cu-chip"
              :disabled="busy"
              :aria-label="`不再允许${action.label}`"
              @click="
                narrow(grant.grantId, {
                  allowedActions: grant.actions
                    .map((item) => item.value)
                    .filter((value) => value !== action.value),
                })
              "
            >
              {{ action.label }} ×
            </button>
            <button
              v-for="origin in grant.origins.length > 1 ? grant.origins : []"
              :key="origin"
              type="button"
              class="cu-chip"
              :disabled="busy"
              :aria-label="`不再允许 ${origin}`"
              @click="
                narrow(grant.grantId, {
                  origins: grant.origins.filter((item) => item !== origin),
                })
              "
            >
              {{ origin }} ×
            </button>
          </span>
        </template>
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          :aria-label="`撤销 ${grant.title} 的授权`"
          @click="revoke(grant.grantId)"
        >
          撤销
        </Button>
      </SettingsRow>
      <EmptyState
        v-if="loaded && !grants.length"
        compact
        variant="plain"
        title="没有生效的授权"
        :description="
          unrestricted
            ? '普通电脑操作已持续允许；敏感动作仍会当次确认'
            : 'Agent 首次使用受控网站或桌面窗口时，会在对话里请你授权'
        "
      />
    </SettingsGroup>

    <AppListsSettings
      v-if="macDesktop"
      :lists="appLists"
      :busy="busy"
      @change="setAppList"
    />

    <SettingsGroup title="截图与下载">
      <SettingsRow
        title="下载保留时间"
        description="Agent 下载的文件在收件箱中保留的时间，到期自动删除；已移到工作区或另存的文件不受影响。"
      >
        <Select
          :model-value="retention"
          :options="RETENTION_OPTIONS"
          size="sm"
          :disabled="busy || !supported"
          aria-label="下载保留时间"
          data-testid="computer-use-download-retention"
          @update:model-value="setRetention"
        />
      </SettingsRow>
      <SettingsRow title="已保存的截图" :description="screenshots.description">
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

    <BrowserProfileSettings />
    <CredentialVaultSettings />

    <SettingsGroup title="须知">
      <ul class="cu-notes">
        <li>
          「持续允许电脑操作」开启时，普通操作和文件传输自动放行，包含本机与局域网网站、终端等应用。账号密码代填及高影响操作（付款、发送、删除等）仍逐次确认。
        </li>
        <li>
          Shell 权限独立于电脑操作授权；完全放行的 Shell
          可以绕开这里的授权。关闭电脑操作只停用 Emperor
          内建的图形界面操作，不代表 Agent 只能操作浏览器或桌面窗口。
        </li>
        <li>
          页面和桌面窗口内容一律视为不可信内容；Agent
          不会把其中的文字当作你的指令。
        </li>
      </ul>
    </SettingsGroup>
  </SettingsSection>
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

.cu-control {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.cu-missing {
  display: block;
  margin-top: var(--space-0-5);
  color: rgb(var(--label-tertiary));
}

.cu-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

.cu-chip {
  padding: 0 var(--space-1-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-secondary));
  font: inherit;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  cursor: pointer;
}

.cu-chip:hover:not(:disabled) {
  color: rgb(var(--danger));
  border-color: rgb(var(--danger));
}

.cu-chip:disabled {
  cursor: default;
  opacity: 0.5;
}

.cu-kbd {
  padding: var(--space-0-5) var(--space-1-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.cu-notes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3) 0 var(--space-1) var(--space-4);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-wrap: pretty;
}
</style>
