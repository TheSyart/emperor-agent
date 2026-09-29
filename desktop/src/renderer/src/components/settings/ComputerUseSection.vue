<script setup lang="ts">
/**
 * Settings › 电脑操作 — computer use (spec 00 §3.3, §6.6, §6.9, §10.4,
 * revised 2026-09-29: the AI drives continuously while it is on). Four
 * groups, the rest folded under 「高级」:
 * 1. 电脑操作 — the master switch (off by default; turning it on registers
 *    the GUI tools), with a notice when a saved per-item mode switched it
 *    off;
 * 2. 应用与浏览器 — one switch per driver with its stage and what it lacks
 *    (tools stay registered, §8.4); the Chrome row's 「管理」 shows the
 *    extension pairing (it opens by itself while a code waits); the user's
 *    protected apps;
 * 3. 系统权限 (macOS) — Emperor Computer Helper, Accessibility and Screen
 *    Recording with their repair actions;
 * 4. 紧急停止 — the shortcut (修改 / 恢复默认) and 立即停止 / 恢复.
 * 「高级」: the app lists, the credential vault, browser profiles and site
 * permissions, download retention and saved screenshots, the desktop
 * driver's current capability and diagnostics, and 须知.
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
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
const screenshots = computed(() => screenshotRow(status.value))
const supported = computed(() => Boolean(status.value?.supported))
const enabled = computed(() => Boolean(status.value?.enabled))
const macDesktop = computed(() => status.value?.platform === 'macos')

// 「高级」 and the Chrome pairing panel fold away; a waiting pairing code
// opens the panel, 「管理」 on the protected apps row opens 「高级」.
const advancedOpen = ref(false)
const pairingOpen = ref(false)
const pairing = ref({ pending: 0, paired: 0, tabs: 0 })
const appListsAnchor = ref<HTMLElement | null>(null)

function onPairingSummary(value: {
  pending: number
  paired: number
  tabs: number
}): void {
  pairing.value = value
  if (value.pending > 0) pairingOpen.value = true
}

const pairingSummary = computed(() =>
  pairing.value.paired > 0
    ? `已连接 ${pairing.value.paired} 个浏览器 · ${pairing.value.tabs} 个可操作标签页`
    : pairing.value.pending > 0
      ? '有配对等待确认'
      : '尚未配对',
)

const protectedCount = computed(
  () => status.value?.appLists?.protected.length ?? 0,
)

function showAppLists(): void {
  advancedOpen.value = true
  void nextTick(() => appListsAnchor.value?.scrollIntoView({ block: 'start' }))
}

function onAdvancedToggle(event: Event): void {
  advancedOpen.value = (event.target as HTMLDetailsElement).open
}
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

function stopAll(): void {
  void act(() => core('computerUse.stop'))
}

function resumeAll(): void {
  void act(() => core('computerUse.resume'))
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
    intro="让 Agent 在内置浏览器、已连接的 Chrome 标签页和 macOS 桌面窗口中连续操作。受控窗口会以只读预览显示在对话里；只有高影响操作、需要输入密码或 Agent 有问题要问时才会停下来等你。每个动作都记入会话日志，随时可以急停。"
  >
    <p v-if="error" class="cu-error" role="alert">{{ error }}</p>
    <p
      v-if="status?.scopedRetired && !enabled"
      class="cu-notice"
      role="status"
      data-testid="computer-use-scoped-retired"
    >
      电脑操作改为由 AI
      连续操作，不再逐项授权。你之前选择的「逐项授权」已停用，电脑操作因此已关闭；确认后重新打开即可。
    </p>

    <SettingsGroup title="电脑操作">
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
    </SettingsGroup>

    <SettingsGroup
      title="应用与浏览器"
      description="每种驱动单独标注阶段；尚不支持的动作会直接告知 Agent「能力未启用」"
    >
      <template v-for="driver in drivers" :key="driver.driver">
        <SettingsRow
          :title="driver.label"
          :description="driver.description"
          :data-driver="driver.driver"
        >
          <template #description>
            <span>{{ driver.description }}</span>
            <span v-if="driver.missing.length" class="cu-missing"
              >尚不支持：{{ driver.missing.join('、') }}</span
            >
            <span
              v-if="driver.driver === 'external-browser'"
              class="cu-missing"
              data-testid="browser-pairing-summary"
              >{{ pairingSummary }}</span
            >
          </template>
          <div class="cu-control">
            <StatusBadge :tone="driver.tone">{{ driver.stage }}</StatusBadge>
            <Button
              v-if="driver.driver === 'external-browser'"
              size="sm"
              variant="outline"
              :aria-expanded="pairingOpen"
              aria-controls="computer-use-pairing"
              data-testid="browser-pairing-manage"
              @click="pairingOpen = !pairingOpen"
              >管理</Button
            >
            <Switch
              :id="`computer-use-driver-${driver.driver}`"
              :model-value="driver.switchedOn"
              :disabled="busy || !enabled"
              :aria-label="`${driver.label}开关`"
              @update:model-value="setDriverEnabled(driver.driver, $event)"
            />
          </div>
        </SettingsRow>
        <div
          v-if="driver.driver === 'external-browser'"
          v-show="pairingOpen"
          id="computer-use-pairing"
        >
          <BrowserPairingSettings
            embedded
            @connection-changed="reload"
            @summary="onPairingSummary"
          />
        </div>
      </template>
      <SettingsRow
        v-if="macDesktop"
        title="不让 Agent 操作的应用"
        :description="
          protectedCount
            ? `你另外保护了 ${protectedCount} 个应用；系统授权界面和 Emperor 自身已内置保护`
            : '系统授权界面和 Emperor 自身已内置保护；可以另外添加密码管理器、网银等应用'
        "
      >
        <Button
          size="sm"
          variant="outline"
          data-testid="computer-use-app-lists"
          @click="showAppLists"
          >管理</Button
        >
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      v-if="macDesktop"
      title="系统权限"
      description="桌面权限只授予 Emperor Computer Helper，不授予主应用"
    >
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
        description="截图和对话里的实时画面需要。点“请求权限”后到系统设置的“录屏与系统录音”打开开关；若列表没有 Helper，点“＋ 添加”，在 ~/.emperor/native-helpers/ 中选择本次安装的 Emperor Computer Helper.app。macOS 要到 Helper 重新启动后才生效，打开开关后点“重启 Helper”。"
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
            ? '已停止，所有窗口和标签页已释放（没有关闭）。恢复后 Agent 可以重新接手。'
            : '取消进行中的动作，释放所有窗口和标签页（不关闭它们）；也可以用 Dock 菜单的「停止电脑操作」'
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

    <details
      class="cu-advanced"
      :open="advancedOpen"
      data-testid="computer-use-advanced"
      @toggle="onAdvancedToggle"
    >
      <summary class="cu-advanced-summary">高级</summary>
      <div ref="appListsAnchor">
        <AppListsSettings
          v-if="macDesktop"
          :lists="appLists"
          :busy="busy"
          @change="setAppList"
        />
      </div>
      <CredentialVaultSettings />
      <BrowserProfileSettings />

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

      <SettingsGroup v-if="macDesktop" title="桌面驱动">
        <SettingsRow
          title="当前能力"
          :description="
            desktopDriver?.available
              ? desktopDriver.actions.length
                ? '可列出应用、窗口并读取控件，点击与输入已开放。桌面凭据代填和真实动作矩阵尚待验收。'
                : '可列出应用与窗口、读取控件；获得屏幕录制权限后可截图。点击、键盘鼠标输入和凭据代填尚未开放。'
              : '桌面驱动当前不可用；点击、键盘鼠标输入和凭据代填尚未开放。'
          "
        >
          <StatusBadge
            :tone="desktopDriver?.actions.length ? 'warn' : 'accent'"
          >
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

      <SettingsGroup title="须知">
        <ul class="cu-notes">
          <li>
            电脑操作打开后，由 AI
            连续操作：普通的查看、点击、输入（包括终端）、跳转和文件传输都会直接进行。付款、删除、发送等高影响操作和账号密码代填逐次确认；AI
            需要你时会在对话里提问。
          </li>
          <li>
            菜单栏的「停止共享」只停止该窗口在对话里的画面，不会停止
            Agent；要停止 Agent，请使用急停快捷键、Dock
            菜单或上方的「立即停止」。
          </li>
          <li>
            如果也向 Emperor Agent 主应用授予屏幕录制权限，它启动的 Shell
            子进程可能直接截图。受限 Shell 的现有隔离规则不能阻止这种继承。
          </li>
          <li>
            Shell 权限独立于电脑操作；完全放行的 Shell
            可以绕开这里的限制。关闭电脑操作只停用 Emperor
            内建的图形界面操作，不代表 Agent 只能操作浏览器或桌面窗口。
          </li>
          <li>
            页面和桌面窗口内容一律视为不可信内容；Agent
            不会把其中的文字当作你的指令。
          </li>
        </ul>
      </SettingsGroup>
    </details>
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

.cu-kbd {
  padding: var(--space-0-5) var(--space-1-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  font-family: var(--font-mono);
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

.cu-advanced {
  margin-top: var(--space-4);
}

.cu-advanced-summary {
  padding: var(--space-2) 0;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-s);
  font-weight: 600;
  cursor: pointer;
}

.cu-advanced-summary:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
  border-radius: var(--radius-row);
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
