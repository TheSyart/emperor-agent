<script setup lang="ts">
import { ArrowLeft, ArrowRight, ExternalLink, RefreshCw } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  closePreviewView,
  onPreviewState,
  openPreviewExternal,
  openPreviewView,
  previewAction,
  setPreviewBounds,
  type PreviewViewState,
} from '../../api/backend'

const props = defineProps<{ sessionId: string; previewId: string }>()
const viewport = ref<HTMLElement | null>(null)
const state = ref<PreviewViewState | null>(null)
const error = ref('')
let observer: ResizeObserver | null = null
let unsubscribe = () => {}
let boundsFrame = 0

onMounted(() => {
  observer = new ResizeObserver(syncBounds)
  if (viewport.value) observer.observe(viewport.value)
  window.addEventListener('resize', scheduleBounds)
  window.addEventListener('scroll', scheduleBounds, true)
  unsubscribe = onPreviewState((next) => {
    if (
      next.sessionId === props.sessionId &&
      next.previewId === props.previewId
    ) {
      state.value = next
      if (next.error) error.value = next.error
    }
  })
  void open()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', scheduleBounds)
  window.removeEventListener('scroll', scheduleBounds, true)
  if (boundsFrame) cancelAnimationFrame(boundsFrame)
  unsubscribe()
  closePreviewView()
})

watch(
  () => [props.sessionId, props.previewId],
  () => void open(),
)

async function open(): Promise<void> {
  error.value = ''
  state.value = null
  if (!props.sessionId || !props.previewId) {
    error.value = '当前没有可用的网站预览。'
    return
  }
  try {
    await openPreviewView({
      sessionId: props.sessionId,
      previewId: props.previewId,
    })
    syncBounds()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function syncBounds(): void {
  const rect = viewport.value?.getBoundingClientRect()
  if (!rect) return
  setPreviewBounds({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  })
}

function scheduleBounds(): void {
  if (boundsFrame) cancelAnimationFrame(boundsFrame)
  boundsFrame = requestAnimationFrame(() => {
    boundsFrame = 0
    syncBounds()
  })
}
</script>

<template>
  <div class="browser-pane">
    <header class="browser-toolbar">
      <button
        type="button"
        aria-label="后退"
        :disabled="!state?.canGoBack"
        @click="previewAction('back')"
      >
        <ArrowLeft :size="14" />
      </button>
      <button
        type="button"
        aria-label="前进"
        :disabled="!state?.canGoForward"
        @click="previewAction('forward')"
      >
        <ArrowRight :size="14" />
      </button>
      <button type="button" aria-label="刷新" @click="previewAction('reload')">
        <RefreshCw :size="14" :class="{ 'animate-spin': state?.loading }" />
      </button>
      <span class="browser-address" :title="state?.url || undefined">{{
        state?.url || '受控本地预览'
      }}</span>
      <button
        type="button"
        aria-label="在系统浏览器打开"
        @click="openPreviewExternal({ sessionId, previewId })"
      >
        <ExternalLink :size="14" />
      </button>
    </header>
    <div v-if="error" class="browser-error" role="alert">
      {{ error }}
    </div>
    <div
      ref="viewport"
      class="browser-viewport"
      :aria-busy="state?.loading || false"
    >
      <span v-if="!error && !state">正在连接本地预览…</span>
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
  display: flex;
  min-width: 0;
  height: calc(var(--space-8) + var(--space-2));
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--border-l1);
}

.browser-toolbar button {
  display: inline-grid;
  width: var(--space-7);
  height: var(--space-7);
  flex: none;
  place-items: center;
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
}

.browser-toolbar button:hover:not(:disabled) {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.browser-toolbar button:disabled {
  opacity: 0.35;
}

.browser-address {
  min-width: 0;
  flex: 1;
  margin: 0 var(--space-1);
  padding: var(--space-1) var(--space-2-5);
  overflow: hidden;
  border-radius: var(--radius-pill);
  color: rgb(var(--label-secondary));
  background: rgb(var(--input-major));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-error {
  flex: none;
  margin: var(--space-2) var(--space-3) 0;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--danger));
  background: rgb(var(--danger-soft));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.browser-viewport {
  display: grid;
  min-height: 0;
  flex: 1;
  place-items: center;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
</style>
