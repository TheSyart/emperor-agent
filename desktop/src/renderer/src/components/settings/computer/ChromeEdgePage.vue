<script setup lang="ts">
/**
 * ChromeEdgePage — 设置 › 电脑操作 › Chrome 和 Edge, laid out like Codex's
 * 「Google Chrome」 page (without its developer mode):
 * - head: the title, what is going on (未安装扩展 / 已安装 · 未连接 /
 *   已连接 N 个浏览器 / 有配对等待确认), 安装扩展程序 (重新安装 once the
 *   extension is in a browser) and 移除扩展程序 (asks first);
 * - a notice while something needs the user: an action failed, a
 *   development build cannot register the browser host, the extension was
 *   loaded from another folder;
 * - 安装扩展 until a browser is paired (ExtensionInstallSteps);
 * - 连接: a waiting pairing (compare the code, 允许 / 拒绝), Chrome and Edge
 *   with their tabs (断开), pairings saved for a browser that is closed
 *   (撤销);
 * - slot `permissions`: 浏览器权限 and 智能体权限 (RV-09), last.
 *
 * Props: active (the page is on screen: the folder is polled every 3 s).
 * Emits: connection-changed (pairings or tabs changed), summary (counts for
 * the main page's Chrome row; a new pairing code asks for this page).
 * Pairings are polled every 2 s while mounted (ComputerUseSection keeps it
 * mounted, hidden, for the summary).
 */
import type {
  BrowserExtensionStatus,
  BrowserPairingStatus,
} from '../../../../../shared/ipc-contract'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  approveBrowserPairing,
  browserExtensionStatus,
  browserPairings,
  denyBrowserPairing,
  installBrowserExtension,
  removeBrowserExtension,
  revealBrowserExtension,
  revokeBrowserPairing,
} from '../../../api/backend'
import Button from '../../ui/Button.vue'
import { writeClipboard } from '../../ui/useCopyFeedback'
import { SettingsGroup, SettingsHero, Notice, SettingsRow, Badge } from '../ui'
import ExtensionInstallSteps from './ExtensionInstallSteps.vue'
import {
  browserName,
  connectionRows,
  extensionAddresses,
  extensionInBrowser,
  extensionSwitchedOff,
  formatCode,
  heroView,
  installSteps,
  loadedElsewhere,
  setupNeeded,
  type ConnectionRow,
} from './chromeEdgeModel'

const props = withDefaults(defineProps<{ active?: boolean }>(), {
  active: false,
})
const emit = defineEmits<{
  'connection-changed': []
  summary: [
    value: {
      pending: number
      paired: number
      tabs: number
      saved: number
      installed: boolean
    },
  ]
}>()

const pairing = ref<BrowserPairingStatus>({
  bridgeListening: false,
  pendingPairings: [],
  pairedConnections: [],
  attachedTabs: 0,
  pairings: [],
})
const extension = ref<BrowserExtensionStatus | null>(null)
const busy = ref(false)
const notice = ref<{
  tone: 'warn' | 'error' | 'info'
  title: string
  description?: string
} | null>(null)
/** 安装步骤 / 重新安装 asked for the steps although a browser is paired. */
const stepsWanted = ref(false)
const copied = ref<string | null>(null)

const hero = computed(() => heroView(pairing.value, extension.value))
const setup = computed(() => stepsWanted.value || setupNeeded(pairing.value))
const steps = computed(() => installSteps(pairing.value, extension.value))
const rows = computed(() =>
  connectionRows(pairing.value, extension.value, setup.value),
)
const addresses = computed(() => extensionAddresses(extension.value))
const elsewhere = computed(() => loadedElsewhere(extension.value))
const pending = computed(() => pairing.value.pendingPairings)
const showConnections = computed(
  () =>
    !setup.value ||
    pending.value.length > 0 ||
    pairing.value.pairings.length > 0,
)
const folder = computed(
  () =>
    extension.value?.folder ?? {
      path: '',
      displayPath: '~/.emperor/browser-extension',
      ready: false,
    },
)

// ── Loading ──────────────────────────────────────────────────────────────
let lastSignature: string | null = null

/** Counts for the main page's Chrome row. */
function summarize(): void {
  const next = pairing.value
  emit('summary', {
    pending: next.pendingPairings.length,
    paired: next.pairings.length
      ? next.pairings.filter((item) => item.connected).length
      : next.pairedConnections.length,
    tabs: next.attachedTabs,
    saved: next.pairings.length,
    installed: extensionInBrowser(next, extension.value),
  })
}

async function refreshPairings(): Promise<void> {
  try {
    const next = await browserPairings()
    pairing.value = next
    summarize()
    const signature = JSON.stringify([
      next.bridgeListening,
      [...next.pairedConnections].sort(),
      next.attachedTabs,
      next.pairings.length,
    ])
    if (lastSignature !== null && signature !== lastSignature)
      emit('connection-changed')
    lastSignature = signature
  } catch {
    notice.value = { tone: 'error', title: '无法读取浏览器连接状态' }
  }
}

async function refreshExtension(): Promise<void> {
  try {
    const before = extensionInBrowser(pairing.value, extension.value)
    extension.value = await browserExtensionStatus()
    // Once pairings are known, a newly loaded extension updates the summary.
    if (
      lastSignature !== null &&
      before !== extensionInBrowser(pairing.value, extension.value)
    )
      summarize()
  } catch {
    /* keep the last known state */
  }
}

// ── Actions ──────────────────────────────────────────────────────────────
async function act(task: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  notice.value = null
  try {
    await task()
  } catch (cause) {
    notice.value = {
      tone: 'error',
      title: cause instanceof Error ? cause.message : String(cause),
    }
  } finally {
    busy.value = false
  }
}

const INSTALL_NOTICES: Readonly<
  Record<string, { title: string; description: string }>
> = {
  'no-host': {
    title: '开发版无法登记浏览器连接',
    description:
      '请使用安装版 Emperor；开发版可按 desktop/native/browser-host 的说明手动登记。',
  },
  'no-browser': {
    title: '没有找到 Chrome 或 Edge',
    description: '先打开一次 Chrome 或 Edge，再点「安装扩展程序」。',
  },
  unavailable: {
    title: '另一个 Emperor 正在使用浏览器连接',
    description: '退出另一个 Emperor 后，这里会自动恢复；再点一次安装即可。',
  },
}

function install(showSteps = false): void {
  void act(async () => {
    const result = await installBrowserExtension()
    if (!result) throw new Error('这个版本的 Emperor 不能安装浏览器扩展')
    extension.value = result.status
    if (!result.ok)
      throw new Error(
        result.reason === 'no-source'
          ? '这个版本的 Emperor 没有带浏览器扩展'
          : '无法写入扩展文件夹',
      )
    if (showSteps) stepsWanted.value = true
    const why = result.reason ? INSTALL_NOTICES[result.reason] : undefined
    if (why) notice.value = { tone: 'warn', ...why }
    await refreshPairings()
  })
}

function remove(): void {
  if (
    !window.confirm(
      '移除扩展程序？已连接的浏览器会自动卸载它，Emperor 会删除扩展文件夹和所有配对。没打开的浏览器，请之后在它的扩展页手动移除。',
    )
  )
    return
  void act(async () => {
    const result = await removeBrowserExtension()
    if (!result) throw new Error('无法移除扩展程序')
    extension.value = result.status
    stepsWanted.value = false
    await refreshPairings()
    notice.value = {
      tone: 'info',
      title: '已移除扩展程序',
      description: `${result.uninstalled > 0 ? `${result.uninstalled} 个浏览器已自动卸载扩展。` : ''}没打开的浏览器，请在它的扩展页手动移除 Emperor 扩展。`,
    }
  })
}

function reveal(): void {
  void act(async () => {
    if (!(await revealBrowserExtension()))
      throw new Error('还没有扩展文件夹：先点「安装扩展程序」')
  })
}

let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copy(text: string, key: string): Promise<void> {
  if (!text || !(await writeClipboard(text))) {
    notice.value = { tone: 'error', title: '无法拷贝，请手动选中复制' }
    return
  }
  copied.value = key
  if (copiedTimer !== null) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = null
    copiedTimer = null
  }, 1_500)
}

function approve(pairingId: string): void {
  void act(async () => {
    if (!(await approveBrowserPairing(pairingId)))
      throw new Error('配对已失效，请在扩展里重新连接')
    await refreshPairings()
  })
}

function deny(pairingId: string): void {
  void act(async () => {
    await denyBrowserPairing(pairingId)
    await refreshPairings()
  })
}

function rowAction(row: ConnectionRow): void {
  if (row.action === 'setup') {
    stepsWanted.value = true
    return
  }
  if (!row.pairingId) return
  const pairingId = row.pairingId
  if (
    !window.confirm(
      `${row.action === 'disconnect' ? '断开' : '撤销'} ${row.title}？之后要在扩展里重新连接 Emperor。`,
    )
  )
    return
  void act(async () => {
    if (!(await revokeBrowserPairing(pairingId)))
      throw new Error('无法断开这个浏览器')
    await refreshPairings()
  })
}

const ROW_ACTIONS = { disconnect: '断开', revoke: '撤销', setup: '安装步骤' }

// ── Polling ──────────────────────────────────────────────────────────────
let pairingTimer: ReturnType<typeof setInterval> | null = null
let extensionTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.active,
  (active) => {
    if (extensionTimer !== null) clearInterval(extensionTimer)
    extensionTimer = null
    if (!active) return
    void refreshExtension()
    extensionTimer = setInterval(() => {
      void refreshExtension()
    }, 3_000)
  },
)

onMounted(() => {
  void refreshExtension()
  void refreshPairings()
  pairingTimer = setInterval(() => {
    void refreshPairings()
  }, 2_000)
  if (props.active)
    extensionTimer = setInterval(() => {
      void refreshExtension()
    }, 3_000)
})

onBeforeUnmount(() => {
  if (pairingTimer !== null) clearInterval(pairingTimer)
  if (extensionTimer !== null) clearInterval(extensionTimer)
  if (copiedTimer !== null) clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="chrome-edge" data-testid="chrome-edge-page">
    <SettingsHero title="Chrome 和 Edge" :description="hero.description">
      <template #badge>
        <Badge
          :tone="hero.tone"
          :variant="hero.dot ? 'dot-label' : 'soft'"
          data-testid="chrome-status"
          >{{ hero.badge }}</Badge
        >
      </template>
      <template #actions>
        <Button
          size="sm"
          :variant="hero.installPrimary ? 'primary' : 'secondary'"
          :disabled="busy"
          data-action="install-extension"
          @click="install()"
          >{{ hero.installLabel }}</Button
        >
        <Button
          v-if="hero.canRemove"
          size="sm"
          variant="danger"
          :disabled="busy"
          data-action="remove-extension"
          @click="remove"
          >移除扩展程序</Button
        >
      </template>
    </SettingsHero>

    <div v-if="notice || elsewhere" class="notices">
      <Notice
        v-if="notice"
        :tone="notice.tone"
        :title="notice.title"
        :description="notice.description"
        data-testid="chrome-notice"
      />
      <Notice
        v-if="elsewhere"
        title="扩展是从另一个文件夹加载的"
        data-testid="chrome-elsewhere"
      >
        {{ elsewhere.name }} 里的 Emperor 扩展来自 {{ elsewhere.path }}，升级
        Emperor 时它不会更新。在扩展页移除它，再按步骤从 Emperor
        的文件夹重新加载。
        <template #actions>
          <Button
            size="sm"
            variant="secondary"
            :disabled="busy"
            data-action="reinstall-extension"
            @click="install(true)"
            >重新安装</Button
          >
        </template>
      </Notice>
    </div>

    <ExtensionInstallSteps
      v-if="setup"
      :steps="steps"
      :folder="folder"
      :addresses="addresses"
      :switched-off="extensionSwitchedOff(extension)"
      :pending="pending.length > 0"
      :copied="copied"
      :busy="busy"
      @reveal="reveal"
      @copy="copy"
    />

    <SettingsGroup
      v-if="showConnections"
      title="连接"
      data-testid="chrome-connections"
    >
      <SettingsRow
        v-for="item in pending"
        :key="item.pairingId"
        title="新的配对请求"
        :data-pending="item.pairingId"
      >
        <template #badge>
          <Badge tone="warn">等待确认</Badge>
        </template>
        <template #description>
          {{ browserName(item.browser) }} ·
          {{
            item.displayed
              ? '验证码与扩展里显示的一致再允许'
              : '等扩展显示验证码'
          }}
        </template>
        <span
          v-if="item.displayed"
          class="code"
          :aria-label="`配对验证码 ${item.code}`"
          >{{ formatCode(item.code) }}</span
        >
        <Button
          size="sm"
          variant="secondary"
          :disabled="busy"
          :aria-label="`拒绝配对 ${browserName(item.browser)}`"
          @click="deny(item.pairingId)"
          >拒绝</Button
        >
        <Button
          size="sm"
          variant="primary"
          :disabled="busy || !item.displayed"
          :aria-label="`允许配对 ${browserName(item.browser)}`"
          @click="approve(item.pairingId)"
          >允许</Button
        >
      </SettingsRow>
      <SettingsRow
        v-for="row in rows"
        :key="row.key"
        :title="row.title"
        :description="row.description"
        :data-connection="row.key"
      >
        <Button
          v-if="row.action"
          size="sm"
          variant="secondary"
          :disabled="busy"
          :aria-label="`${ROW_ACTIONS[row.action]} ${row.title}`"
          @click="rowAction(row)"
          >{{ ROW_ACTIONS[row.action] }}</Button
        >
      </SettingsRow>
    </SettingsGroup>

    <!-- 浏览器权限 and 智能体权限 (RV-09) go here. -->
    <slot name="permissions" />
  </div>
</template>

<style scoped>
.chrome-edge {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.notices {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.code {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  line-height: var(--lh-s);
  font-weight: 600;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
