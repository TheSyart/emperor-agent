<script setup lang="ts">
/**
 * BrowserPane — the right workspace's embedded browser: toolbar (back,
 * forward, reload / stop, address bar, 在外部打开) over a viewport slot the
 * native view covers (useBrowserViewBounds keeps it there and hides it under
 * DOM overlays).
 *
 * Trust boundary: a page loads only when the user submits the address bar
 * (`submitAddress`, bound to the form's submit — guarded by
 * main/trusted-renderer-usage.test.ts). A `prefill` from
 * requestWorkspace({ pane: 'browser', url }) just fills the address bar.
 *
 * Page state comes from main (`onBrowserState`). A failed load hides the
 * native view and shows the pane's own error state until the next user
 * action. Loopback pages cannot open externally (main refuses them).
 *
 * WorkspacePanel keys the pane by session: a session switch remounts it, and
 * unmounting closes the view (its in-memory partition is wiped).
 *
 * Agent tabs (computer use): when this session's Agent holds browser tabs, a
 * tab strip lists them next to 「我的浏览」. Selecting one hides the native
 * view and shows AgentTabView (frame preview plus pause / take over /
 * close). Agent tabs belong to Core, not to the pane: unmounting only stops
 * their preview. The list follows `computer_use_changed` host events.
 *
 * Props:
 * - visible: the pane is on screen (the workspace column is open).
 * - prefill?: { url, nonce } — address to prefill; a new nonce refills.
 * - sessionId?: the session whose Agent tabs are listed.
 * - agentFocus?: { targetId, nonce } — show that Agent tab once it is listed.
 */
import type { ComputerUseStatusView } from '@emperor/core/runtime-contract'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  Globe,
  LockKeyhole,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  browserAction,
  closeBrowserView,
  hasCoreBridge,
  invokeCore,
  onBrowserState,
  onCoreEvent,
  openBrowserUrl,
  openExternal,
  type BrowserViewAction,
} from '../../api/backend'
import IconButton from '../ui/IconButton.vue'
import AgentTabView from './AgentTabView.vue'
import { agentTabsFor, type AgentTabControlAction } from './agentTabsModel'
import {
  applyBrowserState,
  clearBrowserError,
  emptyBrowserPage,
  externalOpenAllowed,
  isLoopbackUrl,
} from './browserModel'
import { useBrowserViewBounds } from './useBrowserViewBounds'

const props = defineProps<{
  visible: boolean
  prefill?: { url: string; nonce: number } | null
  sessionId?: string | null
  agentFocus?: { targetId: string; nonce: number } | null
}>()

const OPEN_FAILED = '无法打开网址'

const page = ref(emptyBrowserPage())
const address = ref('')
const inputError = ref('')
const submitting = ref(false)
const editing = ref(false)
const addressInput = ref<HTMLInputElement | null>(null)
const viewport = ref<HTMLElement | null>(null)

const state = computed(() => page.value.state)
const pageUrl = computed(() => state.value?.url ?? '')
const hasPage = computed(() => Boolean(pageUrl.value))
const loading = computed(
  () => Boolean(state.value?.loading) || submitting.value,
)
const secure = computed(() => pageUrl.value.startsWith('https:'))
const canOpenExternally = computed(() => externalOpenAllowed(pageUrl.value))
const externalLabel = computed(() =>
  hasPage.value && isLoopbackUrl(pageUrl.value)
    ? '本机地址不能在外部浏览器打开'
    : '在外部打开',
)
const pageLabel = computed(() => state.value?.title || hostOf(pageUrl.value))

// --- Agent tabs (computer use) ---------------------------------------------

const USER_TAB = 'user'
const computerUse = ref<ComputerUseStatusView | null>(null)
const selected = ref<string>(USER_TAB)
const controlBusy = ref(false)
const controlError = ref('')

const agentTabs = computed(() =>
  agentTabsFor(computerUse.value, props.sessionId),
)
const selectedAgentTab = computed(
  () => agentTabs.value.find((tab) => tab.targetId === selected.value) ?? null,
)

useBrowserViewBounds({
  viewport,
  shown: () =>
    props.visible && !page.value.error && selectedAgentTab.value === null,
})

let refreshTimer: ReturnType<typeof setTimeout> | null = null

async function refreshAgentTabs(): Promise<void> {
  if (!hasCoreBridge()) return
  try {
    computerUse.value = await invokeCore('computerUse.status')
  } catch {
    computerUse.value = null
  }
}

function scheduleAgentTabsRefresh(): void {
  if (refreshTimer !== null) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshAgentTabs()
  }, 60)
}

// A renderer reload keeps showing the Agent tab the user was watching.
const storageKey = (): string | null =>
  props.sessionId ? `emperor.browserPane.agentTab.${props.sessionId}` : null
let restoreId: string | null = (() => {
  try {
    const key = storageKey()
    return key === null ? null : sessionStorage.getItem(key)
  } catch {
    return null
  }
})()

watch(selected, (id) => {
  try {
    const key = storageKey()
    if (key === null) return
    if (id === USER_TAB) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, id)
  } catch {
    // per-viewer convenience only
  }
})

// A tab that went away falls back to the user's own browsing; the first
// Agent tab is shown when the user has nothing open.
watch(agentTabs, (tabs, previous) => {
  if (restoreId !== null && tabs.some((tab) => tab.targetId === restoreId)) {
    selected.value = restoreId
    restoreId = null
    return
  }
  applyFocusRequest()
  if (selected.value !== USER_TAB && !selectedAgentTab.value)
    selected.value = USER_TAB
  const known = new Set((previous ?? []).map((tab) => tab.targetId))
  const added = tabs.find((tab) => !known.has(tab.targetId))
  if (added && selected.value === USER_TAB && !hasPage.value)
    selected.value = added.targetId
})

// A tool row asked to show its tab: select it now or once the list has it.
let focusRequest: string | null = null
watch(
  () => props.agentFocus,
  (focus) => {
    if (!focus?.targetId) return
    focusRequest = focus.targetId
    applyFocusRequest()
    void refreshAgentTabs()
  },
  { immediate: true },
)

function applyFocusRequest(): void {
  if (focusRequest === null) return
  if (!agentTabs.value.some((tab) => tab.targetId === focusRequest)) return
  selected.value = focusRequest
  focusRequest = null
}

async function controlAgentTab(action: AgentTabControlAction): Promise<void> {
  const tab = selectedAgentTab.value
  if (!tab || controlBusy.value) return
  controlBusy.value = true
  controlError.value = ''
  try {
    await invokeCore('computerUse.controlTarget', {
      targetId: tab.targetId,
      action,
    })
    if (action === 'close') selected.value = USER_TAB
    await refreshAgentTabs()
  } catch (cause) {
    controlError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    controlBusy.value = false
  }
}

function selectTab(id: string): void {
  selected.value = id
  controlError.value = ''
}

let unsubscribe = () => {}
let unsubscribeCore = () => {}

onMounted(() => {
  unsubscribe = onBrowserState((next) => {
    page.value = applyBrowserState(page.value, next)
    if (!editing.value) address.value = page.value.state?.url ?? ''
  })
  unsubscribeCore = onCoreEvent((event) => {
    if (
      event &&
      typeof event === 'object' &&
      (event as { event?: unknown }).event === 'computer_use_changed'
    )
      scheduleAgentTabsRefresh()
  })
  void refreshAgentTabs()
})

onBeforeUnmount(() => {
  unsubscribe()
  unsubscribeCore()
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  // The user's view closes with the pane; Agent tabs keep running in Core.
  closeBrowserView()
})

// A requested address only fills the bar; loading it takes a submit.
watch(
  () => props.prefill,
  (prefill) => {
    if (!prefill?.url) return
    selected.value = USER_TAB
    address.value = prefill.url
    inputError.value = ''
    void nextTick(() => {
      addressInput.value?.focus()
      addressInput.value?.select()
    })
  },
  { immediate: true },
)

async function submitAddress(): Promise<void> {
  const input = address.value.trim()
  if (!input || submitting.value) return
  submitting.value = true
  inputError.value = ''
  page.value = clearBrowserError(page.value)
  const result = await openBrowserUrl(input)
  submitting.value = false
  if (!result.ok) {
    inputError.value = result.error || OPEN_FAILED
    return
  }
  address.value = result.url ?? input
  addressInput.value?.blur()
}

function navigate(action: BrowserViewAction): void {
  inputError.value = ''
  page.value = clearBrowserError(page.value)
  browserAction(action)
}

function reloadOrStop(): void {
  navigate(state.value?.loading ? 'stop' : 'reload')
}

function onAddressFocus(): void {
  editing.value = true
  addressInput.value?.select()
}

function onAddressBlur(): void {
  editing.value = false
}

function revertAddress(): void {
  address.value = pageUrl.value
  inputError.value = ''
  addressInput.value?.blur()
}

async function openInSystemBrowser(): Promise<void> {
  if (!canOpenExternally.value) return
  try {
    await openExternal(pageUrl.value)
  } catch (cause) {
    inputError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
</script>

<template>
  <div
    class="browser-pane"
    :data-state="
      selectedAgentTab
        ? 'agent'
        : page.error
          ? 'error'
          : hasPage
            ? 'page'
            : 'empty'
    "
  >
    <nav v-if="agentTabs.length" class="browser-tabs" aria-label="浏览器标签页">
      <button
        type="button"
        class="browser-tab"
        :aria-pressed="selected === USER_TAB"
        @click="selectTab(USER_TAB)"
      >
        <Globe :size="12" aria-hidden="true" />
        <span class="browser-tab-title">我的浏览</span>
      </button>
      <button
        v-for="tab in agentTabs"
        :key="tab.targetId"
        type="button"
        class="browser-tab"
        :data-tone="tab.tone"
        :aria-pressed="selected === tab.targetId"
        :title="`${tab.title} · ${tab.label}`"
        @click="selectTab(tab.targetId)"
      >
        <Bot :size="12" aria-hidden="true" />
        <span class="browser-tab-title">{{ tab.title }}</span>
        <span class="browser-tab-dot" aria-hidden="true"></span>
      </button>
    </nav>
    <template v-if="selectedAgentTab">
      <p v-if="controlError" class="browser-input-error" role="alert">
        {{ controlError }}
      </p>
      <AgentTabView
        class="browser-agent-tab"
        :tab="selectedAgentTab"
        :busy="controlBusy"
        @control="controlAgentTab"
      />
    </template>
    <header v-if="!selectedAgentTab" class="browser-toolbar">
      <IconButton
        label="后退"
        :disabled="!state?.canGoBack"
        @click="navigate('back')"
      >
        <ArrowLeft :size="15" />
      </IconButton>
      <IconButton
        label="前进"
        :disabled="!state?.canGoForward"
        @click="navigate('forward')"
      >
        <ArrowRight :size="15" />
      </IconButton>
      <IconButton
        :label="state?.loading ? '停止加载' : '刷新'"
        :disabled="!hasPage"
        @click="reloadOrStop"
      >
        <X v-if="state?.loading" :size="15" />
        <RotateCw v-else :size="14" />
      </IconButton>
      <form
        class="browser-address"
        role="search"
        :data-invalid="inputError ? 'true' : undefined"
        @submit.prevent="submitAddress"
      >
        <LockKeyhole
          v-if="secure && !editing"
          :size="13"
          class="address-glyph"
          aria-hidden="true"
        />
        <Globe v-else :size="13" class="address-glyph" aria-hidden="true" />
        <input
          ref="addressInput"
          v-model="address"
          type="text"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="输入网址（支持 localhost）"
          aria-label="网址"
          :aria-invalid="inputError ? 'true' : undefined"
          @focus="onAddressFocus"
          @blur="onAddressBlur"
          @keydown.esc.prevent="revertAddress"
        />
      </form>
      <IconButton
        :label="externalLabel"
        :disabled="!canOpenExternally"
        @click="openInSystemBrowser"
      >
        <ExternalLink :size="14" />
      </IconButton>
      <div
        v-if="loading"
        class="browser-progress"
        role="progressbar"
        aria-label="正在加载"
      ></div>
    </header>
    <p
      v-if="inputError && !selectedAgentTab"
      class="browser-input-error"
      role="alert"
    >
      {{ inputError }}
    </p>
    <div
      v-show="!selectedAgentTab"
      ref="viewport"
      class="browser-viewport"
      :aria-busy="loading || undefined"
    >
      <div v-if="page.error" class="browser-state" role="alert">
        <TriangleAlert :size="22" class="state-glyph danger" />
        <strong>无法打开此网页</strong>
        <p class="state-detail">{{ page.error }}</p>
        <p v-if="pageUrl" class="state-url">{{ pageUrl }}</p>
        <button type="button" class="state-action" @click="navigate('reload')">
          重试
        </button>
      </div>
      <!-- Under the native view: shows while it is hidden (drags, menus). -->
      <div v-else-if="hasPage" class="browser-state">
        <Globe :size="22" class="state-glyph" />
        <strong>{{ pageLabel }}</strong>
        <p class="state-url">{{ pageUrl }}</p>
        <p v-if="state?.loading" class="state-detail">正在加载…</p>
      </div>
      <div v-else class="browser-state">
        <Globe :size="22" class="state-glyph" />
        <strong>输入网址（支持 localhost）</strong>
        <p class="state-detail">例如 localhost:5173 或 example.com</p>
        <p class="state-note">页面在独立沙箱中打开，关闭后不保留浏览数据</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.browser-tabs {
  display: flex;
  min-width: 0;
  flex: none;
  gap: var(--space-1);
  overflow-x: auto;
  padding: var(--space-1-5) var(--space-2) 0;
  border-bottom: 1px solid var(--border-l1);
  scrollbar-width: none;
}

.browser-tab {
  display: inline-flex;
  min-width: 0;
  max-width: 180px;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  margin-bottom: -1px;
  padding: var(--space-1) var(--space-2-5);
  border: 1px solid transparent;
  border-radius: var(--radius-row) var(--radius-row) 0 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  transition: background-color var(--duration-ds-fast) ease;
}

.browser-tab:hover {
  background: var(--interactive-bg-hover);
}

.browser-tab[aria-pressed='true'] {
  border-color: var(--border-l1);
  border-bottom-color: rgb(var(--bg-layer-1));
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-primary));
}

.browser-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.browser-tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-tab-dot {
  width: var(--space-1-5);
  height: var(--space-1-5);
  flex: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent-fill));
}

.browser-tab[data-tone='paused'] .browser-tab-dot {
  background: rgb(var(--warn));
}

.browser-tab[data-tone='user'] .browser-tab-dot {
  background: rgb(var(--ok));
}

.browser-tab[data-tone='stopped'] .browser-tab-dot {
  background: rgb(var(--danger));
}

.browser-agent-tab {
  min-height: 0;
  flex: 1;
}

.browser-toolbar {
  position: relative;
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--border-l1);
}

.browser-address {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--space-7);
  margin: 0 var(--space-1);
  padding: 0 var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  background: rgb(var(--input-major));
  color: rgb(var(--label-tertiary));
}

.browser-address:focus-within {
  border-color: var(--border-l4);
}

.browser-address[data-invalid] {
  border-color: rgb(var(--danger) / 0.6);
}

.address-glyph {
  flex: none;
}

.browser-address input {
  min-width: 0;
  flex: 1;
  height: 100%;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  box-shadow: none;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-overflow: ellipsis;
}

.browser-address input::placeholder {
  color: rgb(var(--label-tertiary));
}

/* Indeterminate load bar on the toolbar's bottom hairline. */
.browser-progress {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}

.browser-progress::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  background: rgb(var(--accent-fill));
  animation: browser-progress 1.1s var(--ease-in-out) infinite;
}

@keyframes browser-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}

.browser-input-error {
  flex: none;
  margin: var(--space-2) var(--space-3) 0;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--danger-soft));
  color: rgb(var(--danger));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.browser-viewport {
  display: grid;
  min-height: 0;
  flex: 1;
  place-items: center;
  overflow: hidden;
  padding: var(--space-6) var(--space-4);
}

.browser-state {
  display: flex;
  max-width: 360px;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1-5);
  text-align: center;
}

.browser-state strong {
  max-width: 100%;
  overflow: hidden;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-glyph {
  margin-bottom: var(--space-1);
  color: rgb(var(--label-tertiary));
}

.state-glyph.danger {
  color: rgb(var(--danger));
}

.state-detail,
.state-url,
.state-note {
  max-width: 100%;
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.state-url {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-note {
  margin-top: var(--space-2);
  color: rgb(var(--label-caption));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.state-action {
  margin-top: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  transition: background-color var(--duration-ds-fast) ease;
}

.state-action:hover {
  background: var(--interactive-bg-hover);
}

.state-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}
</style>
