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
  <div class="workspace-pane browser-pane">
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
      <span class="browser-address">{{ state?.url || '受控本地预览' }}</span>
      <button
        type="button"
        aria-label="在系统浏览器打开"
        @click="openPreviewExternal({ sessionId, previewId })"
      >
        <ExternalLink :size="14" />
      </button>
    </header>
    <div v-if="error" class="workspace-inline-error browser-error">
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
