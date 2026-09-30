<script setup lang="ts">
/**
 * BrowserPairingSettings — the Chrome / Edge extension connection: register
 * the Native Messaging host, confirm a pairing by its 6-digit code, revoke a
 * pairing, count the tabs the user connected. Polls every 2 s.
 *
 * Props: embedded (render the rows only, inside the 应用与浏览器 group).
 * Emits: connection-changed (pairings or tabs changed), summary (counts for
 * the Chrome row; a pending pairing asks the parent to show this panel).
 */
import type { BrowserPairingStatus } from '../../../../../shared/ipc-contract'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  approveBrowserPairing,
  browserPairings,
  connectBrowsers,
  denyBrowserPairing,
  revokeBrowserPairing,
} from '../../../api/backend'
import Button from '../../ui/Button.vue'
import { EmptyState, SettingsGroup, SettingsRow, StatusBadge } from '../ui'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
})
const emit = defineEmits<{
  'connection-changed': []
  summary: [value: { pending: number; paired: number; tabs: number }]
}>()
const status = ref<BrowserPairingStatus>({
  bridgeListening: false,
  pendingPairings: [],
  pairedConnections: [],
  attachedTabs: 0,
})
const busy = ref(false)
const error = ref('')
const socketConflictMessage =
  '另一个 Emperor 正在使用浏览器连接，或此版本不支持'
let polling: ReturnType<typeof setInterval> | null = null
let lastConnectionSignature: string | null = null

async function refresh(): Promise<void> {
  try {
    const next = await browserPairings()
    if (
      next.bridgeListening &&
      !status.value.bridgeListening &&
      error.value === socketConflictMessage
    )
      error.value = ''
    status.value = next
    emit('summary', {
      pending: next.pendingPairings.length,
      paired: next.pairedConnections.length,
      tabs: next.attachedTabs,
    })
    const signature = JSON.stringify([
      next.bridgeListening,
      [...next.pairedConnections].sort(),
      next.attachedTabs,
    ])
    if (
      lastConnectionSignature !== null &&
      signature !== lastConnectionSignature
    )
      emit('connection-changed')
    lastConnectionSignature = signature
  } catch {
    error.value = '无法读取浏览器扩展配对状态'
  }
}

async function run(
  action: () => Promise<boolean>,
  failure: string,
): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!(await action())) throw new Error(failure)
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : failure
  } finally {
    busy.value = false
  }
}

const BROWSER_NAMES: Readonly<Record<string, string>> = {
  chrome: 'Chrome',
  'chrome-beta': 'Chrome Beta',
  'chrome-dev': 'Chrome Dev',
  'chrome-canary': 'Chrome Canary',
  'chrome-for-testing': 'Chrome for Testing',
  chromium: 'Chromium',
  edge: 'Edge',
}
const connected = ref('')
const PAIRING_NOTE =
  '在浏览器扩展中发起配对，对照两端的 6 位验证码后在这里确认；只会控制你在扩展中主动连接的标签页。'

/** 01 §11: write the Native Messaging host for the Emperor extension. */
async function connect(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  connected.value = ''
  try {
    const result = await connectBrowsers()
    if (result.browsers.length > 0)
      connected.value = `已为 ${result.browsers
        .map((name) => BROWSER_NAMES[name] ?? name)
        .join('、')} 登记连接；在浏览器中打开 Emperor 扩展发起配对。`
    else
      error.value =
        result.reason === 'no-host'
          ? '开发版无法登记浏览器连接，请使用安装版 Emperor'
          : result.reason === 'unavailable'
            ? socketConflictMessage
            : '没有找到可登记的 Chrome 或 Edge；请先打开一次浏览器'
  } catch {
    error.value = '无法登记浏览器连接'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh()
  polling = setInterval(() => {
    void refresh()
  }, 2_000)
})

onBeforeUnmount(() => {
  if (polling !== null) clearInterval(polling)
})
</script>

<template>
  <component
    :is="props.embedded ? 'div' : SettingsGroup"
    v-bind="
      props.embedded
        ? { class: 'pairing-embedded' }
        : {
            title: '扩展连接',
            description: PAIRING_NOTE,
          }
    "
  >
    <p v-if="props.embedded" class="pairing-note">{{ PAIRING_NOTE }}</p>
    <p v-if="error" class="pairing-error" role="alert">{{ error }}</p>
    <SettingsRow
      title="连接 Chrome/Edge"
      :description="
        connected ||
        '让本机的 Chrome 或 Edge 能找到 Emperor；之后在 Emperor 扩展中发起配对。'
      "
    >
      <Button
        size="sm"
        variant="outline"
        :disabled="busy"
        data-testid="browser-connect"
        @click="connect"
        >连接 Chrome/Edge</Button
      >
    </SettingsRow>
    <SettingsRow
      v-for="pending in status.pendingPairings"
      :key="pending.pairingId"
      title="待确认配对"
      :description="`扩展 ID：${pending.extensionId}`"
    >
      <div class="pairing-actions">
        <span
          v-if="pending.displayed"
          class="pairing-code"
          :aria-label="`配对验证码 ${pending.code}`"
          >{{ pending.code }}</span
        >
        <StatusBadge v-else tone="neutral">等待扩展显示验证码</StatusBadge>
        <Button
          size="sm"
          :disabled="busy || !pending.displayed"
          :aria-label="`确认配对 ${pending.extensionId}`"
          @click="
            run(
              () => approveBrowserPairing(pending.pairingId),
              '配对已失效，请在扩展中重新发起',
            )
          "
          >验证码一致，确认</Button
        >
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          :aria-label="`拒绝配对 ${pending.extensionId}`"
          @click="
            run(() => denyBrowserPairing(pending.pairingId), '配对已失效')
          "
          >拒绝</Button
        >
      </div>
    </SettingsRow>
    <SettingsRow
      v-for="pairingId in status.pairedConnections"
      :key="pairingId"
      title="已连接浏览器"
      :description="`配对 ID：${pairingId}`"
    >
      <div class="pairing-actions">
        <StatusBadge tone="ok">已连接</StatusBadge>
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          :aria-label="`撤销浏览器配对 ${pairingId}`"
          @click="run(() => revokeBrowserPairing(pairingId), '无法撤销配对')"
          >撤销配对</Button
        >
      </div>
    </SettingsRow>
    <SettingsRow
      v-if="status.pairedConnections.length"
      title="可操作标签页"
      description="配对成功后，还需在 Chrome 的目标网页打开扩展弹窗并点“连接当前标签页”。"
    >
      <StatusBadge :tone="status.attachedTabs > 0 ? 'ok' : 'neutral'">
        {{ status.attachedTabs }} 个可操作标签页
      </StatusBadge>
    </SettingsRow>
    <EmptyState
      v-if="!status.pendingPairings.length && !status.pairedConnections.length"
      compact
      variant="plain"
      title="没有浏览器连接"
      description="从扩展弹窗发起配对后，这里会显示验证码。"
    />
  </component>
</template>

<style scoped>
.pairing-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.pairing-code {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  font-weight: 700;
  letter-spacing: 0.15em;
  font-variant-numeric: tabular-nums;
}
.pairing-error {
  color: rgb(var(--danger));
  font-size: var(--fs-xs);
}
.pairing-embedded {
  padding: var(--space-1) 0 var(--space-2) var(--space-4);
  border-left: 2px solid var(--border-l1);
}
.pairing-note {
  margin: var(--space-1) 0 var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
