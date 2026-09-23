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
 * Props:
 * - visible: the pane is on screen (the workspace column is open).
 * - prefill?: { url, nonce } — address to prefill; a new nonce refills.
 */
import {
  ArrowLeft,
  ArrowRight,
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
  onBrowserState,
  openBrowserUrl,
  openExternal,
  type BrowserViewAction,
} from '../../api/backend'
import IconButton from '../ui/IconButton.vue'
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

useBrowserViewBounds({
  viewport,
  shown: () => props.visible && !page.value.error,
})

let unsubscribe = () => {}

onMounted(() => {
  unsubscribe = onBrowserState((next) => {
    page.value = applyBrowserState(page.value, next)
    if (!editing.value) address.value = page.value.state?.url ?? ''
  })
})

onBeforeUnmount(() => {
  unsubscribe()
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
  </div>
</template>

<style scoped>
.browser-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
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
