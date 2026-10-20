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
 * action. Loopback pages cannot open externally (main refuses them). A link
 * the user clicked elsewhere in Emperor may open here too: main loads it
 * (设置 › 浏览器) and the state push shows it. With 地址栏显示完整网址 off
 * the bar shows only the site until the user edits it.
 *
 * 浏览历史 (设置 › 浏览器, main's temporary history): the pages committed in
 * this browser session, newest first. Picking one sends only its id; main
 * checks the stored address again before loading it.
 *
 * Downloads (设置 › 浏览器 › 下载, saved by main): a line under the page says
 * how the latest one goes — 正在下载, 已下载 with 在访达中显示, or 已拦截 and
 * why. It takes its own row, so the native page shrinks rather than being
 * covered; closing it hides that download for good.
 *
 * WorkspacePanel keeps the pane mounted behind the other panes (FIX-05):
 * another pane or a collapsed column only hides it (`visible` false, so
 * main hides the native view and the page keeps running with its
 * sign-ins). It is keyed by session: a session switch remounts it, and
 * unmounting closes the view (its in-memory partition is wiped).
 *
 * The pane is the user's own browsing only. Tabs the Agent controls show in
 * the conversation's computer-use preview instead.
 *
 * Props:
 * - visible: the pane is on screen (the column is open and this pane shows).
 * - prefill?: { url, nonce } — address to prefill; a new nonce refills.
 */
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Download,
  ExternalLink,
  Globe,
  History,
  LockKeyhole,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-vue-next'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import {
  browserAction,
  closeBrowserView,
  fetchBrowserHistory,
  onBrowserState,
  onUserDownload,
  openBrowserHistoryEntry,
  openBrowserUrl,
  openExternal,
  revealUserDownload,
  type BrowserHistoryEntry,
  type BrowserViewAction,
  type UserDownloadView,
} from '../../api/backend'
import { useBrowserPreferences } from '../../composables/useBrowserPreferences'
import IconButton from '../ui/IconButton.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import {
  addressText,
  applyBrowserState,
  clearBrowserError,
  downloadLine,
  emptyBrowserPage,
  externalOpenAllowed,
  followDownload,
  isLoopbackUrl,
} from './browserModel'
import { useBrowserViewBounds } from './useBrowserViewBounds'

const props = defineProps<{
  visible: boolean
  prefill?: { url: string; nonce: number } | null
}>()

const OPEN_FAILED = '无法打开网址'

const { preferences } = useBrowserPreferences()

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
/** The bar while not editing: the page address, whole or just the site. */
const idleAddress = computed(() =>
  addressText(pageUrl.value, preferences.value.showFullUrl),
)

useBrowserViewBounds({
  viewport,
  shown: () => props.visible && !page.value.error,
})

// ── 下载 ─────────────────────────────────────────────────────────────────
const download = shallowRef<UserDownloadView | null>(null)
const downloadStatus = computed(() => downloadLine(download.value))
/** Downloads whose line the user closed. */
const dismissed = new Set<string>()

async function revealDownload(): Promise<void> {
  const shown = download.value
  if (!shown) return
  try {
    await revealUserDownload(shown.id)
  } catch (cause) {
    inputError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function dismissDownload(): void {
  if (download.value) dismissed.add(download.value.id)
  download.value = null
}

let unsubscribe = () => {}
let unsubscribeDownloads = () => {}

onMounted(() => {
  unsubscribe = onBrowserState((next) => {
    page.value = applyBrowserState(page.value, next)
    if (!editing.value) address.value = idleAddress.value
  })
  unsubscribeDownloads = onUserDownload((next) => {
    if (!dismissed.has(next.id))
      download.value = followDownload(download.value, next)
  })
})

onBeforeUnmount(() => {
  unsubscribe()
  unsubscribeDownloads()
  // The user's view closes with the pane (its partition is wiped).
  closeBrowserView()
})

// A requested address only fills the bar; loading it takes a submit.
watch(
  () => props.prefill,
  (prefill) => {
    if (!prefill?.url) return
    address.value = prefill.url
    inputError.value = ''
    void nextTick(() => {
      addressInput.value?.focus()
      addressInput.value?.select()
    })
  },
  { immediate: true },
)

// ── 浏览历史 ─────────────────────────────────────────────────────────────
const historyShown = computed(() => preferences.value.history)
const historyAnchor = ref<HTMLElement | null>(null)
const historyOpen = ref(false)
const historyEntries = shallowRef<BrowserHistoryEntry[]>([])

// A hidden pane leaves no menu of its own behind.
watch(
  () => props.visible,
  (visible) => {
    if (!visible) historyOpen.value = false
  },
)

async function toggleHistory(): Promise<void> {
  if (historyOpen.value) {
    historyOpen.value = false
    return
  }
  historyEntries.value = await fetchBrowserHistory()
  historyOpen.value = true
}

async function openHistoryEntry(entry: BrowserHistoryEntry): Promise<void> {
  historyOpen.value = false
  inputError.value = ''
  const result = await openBrowserHistoryEntry(entry.id)
  if (!result.ok) inputError.value = result.error ?? '无法打开这条记录'
}

function historySite(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function historyTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

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
  // Editing shows the whole address; text the user left typed stays.
  if (address.value === idleAddress.value) address.value = pageUrl.value
  void nextTick(() => addressInput.value?.select())
}

function onAddressBlur(): void {
  editing.value = false
  if (address.value === pageUrl.value) address.value = idleAddress.value
}

// 地址栏显示完整网址 changed (设置 › 浏览器): an idle bar follows at once.
watch(idleAddress, (next, previous) => {
  if (!editing.value && address.value === previous) address.value = next
})

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
    :data-state="page.error ? 'error' : hasPage ? 'page' : 'empty'"
  >
    <header class="browser-toolbar">
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
      <span v-if="historyShown" ref="historyAnchor" class="history-anchor">
        <IconButton
          label="浏览历史"
          aria-haspopup="menu"
          :aria-expanded="historyOpen"
          @click="toggleHistory"
        >
          <History :size="14" />
        </IconButton>
      </span>
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
      <Menu
        v-model:open="historyOpen"
        :anchor="historyAnchor"
        placement="bottom"
        :width="300"
        dense
        label="浏览历史"
      >
        <MenuItem variant="label">浏览历史 · 关闭浏览器后清空</MenuItem>
        <MenuItem v-if="!historyEntries.length" disabled
          >还没有浏览记录</MenuItem
        >
        <MenuItem
          v-for="entry in historyEntries"
          :key="entry.id"
          :description="`${historySite(entry.url)} · ${historyTime(entry.time)}`"
          @select="openHistoryEntry(entry)"
        >
          {{ entry.title || historySite(entry.url) }}
        </MenuItem>
      </Menu>
    </header>
    <p v-if="inputError" class="browser-input-error" role="alert">
      {{ inputError }}
    </p>
    <div
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
    <div
      v-if="downloadStatus"
      class="browser-download"
      :data-tone="downloadStatus.tone"
      data-testid="browser-download"
      role="status"
    >
      <ShieldAlert
        v-if="downloadStatus.tone === 'blocked'"
        :size="14"
        class="download-glyph"
        aria-hidden="true"
      />
      <CircleCheck
        v-else-if="downloadStatus.tone === 'done'"
        :size="14"
        class="download-glyph"
        aria-hidden="true"
      />
      <TriangleAlert
        v-else-if="downloadStatus.tone === 'failed'"
        :size="14"
        class="download-glyph"
        aria-hidden="true"
      />
      <Download v-else :size="14" class="download-glyph" aria-hidden="true" />
      <span class="download-text">{{ downloadStatus.text }}</span>
      <span v-if="downloadStatus.detail" class="download-detail">{{
        downloadStatus.detail
      }}</span>
      <button
        v-if="downloadStatus.reveal"
        type="button"
        class="download-action"
        @click="revealDownload"
      >
        在访达中显示
      </button>
      <IconButton label="关闭下载提示" @click="dismissDownload">
        <X :size="13" />
      </IconButton>
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

.history-anchor {
  display: inline-flex;
}

.browser-toolbar {
  position: relative;
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--stroke-1);
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
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-pill);
  background: rgb(var(--input-major));
  color: rgb(var(--label-tertiary));
}

.browser-address:focus-within {
  border-color: var(--stroke-4);
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
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  transition: background-color var(--duration-ds-fast) ease;
}

.state-action:hover {
  background: var(--surface-hover);
}

.state-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

/* One status row under the page (the native view shrinks, never covered). */
.browser-download {
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
  border-top: 1px solid var(--stroke-1);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.download-glyph {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.browser-download[data-tone='done'] .download-glyph {
  color: rgb(var(--state-ok));
}

.browser-download[data-tone='blocked'] .download-glyph,
.browser-download[data-tone='failed'] .download-glyph {
  color: rgb(var(--danger));
}

.download-text {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-detail {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-action {
  flex: none;
  margin-left: auto;
  padding: 0 var(--space-2);
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-primary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xs);
  transition: background-color var(--duration-ds-fast) ease;
}

.download-action:hover {
  background: var(--surface-hover);
}

.download-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.download-detail + .ds-icon-button,
.download-text + .ds-icon-button {
  margin-left: auto;
}
</style>
