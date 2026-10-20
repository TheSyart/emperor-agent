<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  Expand,
  FolderOpen,
  ImageOff,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Scan,
  X,
} from 'lucide-vue-next'
import { closeImageViewer, imageViewer } from './imageViewer'
import { fitScale, panBounds, zoomAt } from './imageViewerGeometry'
import { pushModalLayer } from './modalStack'
import { useFocusTrap } from './useFocusTrap'
import { requestWorkspace } from '../workspace/workspaceState'

const root = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const index = ref(imageViewer.value?.index ?? 0)
const items = computed(() => imageViewer.value?.items ?? [])
const item = computed(() => items.value[index.value])
const natural = ref({ width: 0, height: 0 })
const available = ref({ width: 800, height: 600 })
const scale = ref(1)
const rotation = ref(0)
const pan = ref({ x: 0, y: 0 })
const loading = ref(true)
const failed = ref(false)
const fitMode = ref(true)
const dragging = ref(false)
let drag: {
  id: number
  x: number
  y: number
  startX: number
  startY: number
} | null = null
let moved = false
let observer: ResizeObserver | null = null
let releaseLayer = () => {}
// Tab stays in the viewer and the page behind is inert; imageViewer.ts
// gives focus back to the thumbnail that opened it.
useFocusTrap(root, () => true, {
  initialFocus: () => closeButton.value,
  restoreFocus: false,
})
const imageStyle = computed(() => ({
  width: `${natural.value.width}px`,
  height: `${natural.value.height}px`,
  transform: `translate(-50%, -50%) translate(${pan.value.x}px, ${pan.value.y}px) rotate(${rotation.value}deg) scale(${scale.value})`,
}))
const fitted = computed(() =>
  fitScale(
    rotation.value % 180 ? natural.value.height : natural.value.width,
    rotation.value % 180 ? natural.value.width : natural.value.height,
    available.value.width,
    available.value.height,
  ),
)

function measure() {
  const rect = stage.value?.getBoundingClientRect()
  available.value = {
    width: Math.max(80, (rect?.width || window.innerWidth) - 64),
    height: Math.max(80, (rect?.height || window.innerHeight) - 32),
  }
  if (fitMode.value) fit()
  else constrainPan()
}
function fit() {
  fitMode.value = true
  scale.value = fitted.value
  pan.value = { x: 0, y: 0 }
}
function constrainPan() {
  const bounds = panBounds(
    natural.value.width,
    natural.value.height,
    scale.value,
    rotation.value,
    available.value.width,
    available.value.height,
  )
  pan.value = {
    x: Math.max(-bounds.x, Math.min(bounds.x, pan.value.x)),
    y: Math.max(-bounds.y, Math.min(bounds.y, pan.value.y)),
  }
}
function zoom(value: number, anchor = { x: 0, y: 0 }) {
  if (loading.value || failed.value) return
  const next = Math.max(Math.min(0.1, fitted.value), Math.min(8, value))
  pan.value = zoomAt(pan.value, scale.value, next, anchor)
  scale.value = next
  fitMode.value = false
  constrainPan()
}
function original() {
  zoom(1)
  pan.value = { x: 0, y: 0 }
}
function rotate(delta: number) {
  rotation.value = (rotation.value + delta + 360) % 360
  if (fitMode.value) fit()
  else constrainPan()
}
function change(delta: number) {
  index.value = Math.max(
    0,
    Math.min(items.value.length - 1, index.value + delta),
  )
}
function imageFailed() {
  failed.value = true
  loading.value = false
}
function loaded(event: Event) {
  const image = event.target as HTMLImageElement
  natural.value = { width: image.naturalWidth, height: image.naturalHeight }
  loading.value = false
  failed.value = false
  measure()
  fit()
}
function wheel(event: WheelEvent) {
  event.preventDefault()
  const rect = stage.value!.getBoundingClientRect()
  zoom(
    scale.value * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.01),
    {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    },
  )
}
function pointerDown(event: PointerEvent) {
  moved = false
  if (event.button !== 0 || !(event.target instanceof HTMLImageElement)) return
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startX: pan.value.x,
    startY: pan.value.y,
  }
  stage.value?.setPointerCapture?.(event.pointerId)
}
function pointerMove(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  const dx = event.clientX - drag.x,
    dy = event.clientY - drag.y
  if (Math.hypot(dx, dy) > 4) {
    moved = true
    dragging.value = true
  }
  pan.value = { x: drag.startX + dx, y: drag.startY + dy }
  constrainPan()
}
function pointerUp() {
  drag = null
  dragging.value = false
}
function maskClick(event: MouseEvent) {
  if (event.target === stage.value && !moved) closeImageViewer()
}
function openFile() {
  const file = item.value?.file
  if (!file) return
  closeImageViewer()
  requestWorkspace({ pane: 'files', file })
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    change(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    change(1)
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    zoom(scale.value * 1.25)
  } else if (event.key === '-') {
    event.preventDefault()
    zoom(scale.value / 1.25)
  }
}
watch(
  () => `${item.value?.id}:${item.value?.src}`,
  () => {
    loading.value = true
    failed.value = false
    natural.value = { width: 0, height: 0 }
    rotation.value = 0
    pan.value = { x: 0, y: 0 }
    fitMode.value = true
  },
)
watch(imageViewer, (next, previous) => {
  if (next && next !== previous) index.value = next.index ?? 0
})
onMounted(() => {
  releaseLayer = pushModalLayer({ onEscape: closeImageViewer })
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    if (stage.value) observer.observe(stage.value)
  }
  window.addEventListener('resize', measure)
  measure()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', measure)
  releaseLayer()
})
</script>
<template>
  <Teleport to="body">
    <div
      ref="root"
      class="image-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="`图片预览：${item?.name || '图片'}`"
      @keydown="keydown"
    >
      <header class="viewer-header">
        <div class="viewer-title">
          <strong>{{ item?.name }}</strong
          ><span v-if="item?.caption">{{ item.caption }}</span>
        </div>
        <button
          ref="closeButton"
          type="button"
          class="viewer-button viewer-close"
          aria-label="关闭图片预览"
          @click="closeImageViewer"
        >
          <X :size="22" />
        </button>
      </header>
      <div
        ref="stage"
        class="viewer-stage"
        :data-dragging="dragging || undefined"
        @wheel="wheel"
        @pointerdown="pointerDown"
        @pointermove="pointerMove"
        @pointerup="pointerUp"
        @pointercancel="pointerUp"
        @click="maskClick"
      >
        <div v-if="loading && !failed" class="viewer-status" role="status">
          <LoaderCircle :size="28" class="viewer-spinner" /><span
            >正在加载图片</span
          >
        </div>
        <div v-if="failed" class="viewer-status" role="alert">
          <ImageOff :size="32" /><strong>图片无法显示</strong
          ><span>文件可能已被移除或格式不受支持</span>
        </div>
        <img
          v-if="item && !failed"
          :key="`${item.id}:${item.src}`"
          class="viewer-image"
          :class="{ 'is-loading': loading }"
          :src="item.src"
          :alt="item.name"
          :style="imageStyle"
          draggable="false"
          @load="loaded"
          @error="imageFailed"
          @dblclick.stop="fitMode ? original() : fit()"
        />
      </div>
      <button
        v-if="items.length > 1"
        class="viewer-button viewer-previous"
        type="button"
        aria-label="上一张"
        :disabled="index === 0"
        @click="change(-1)"
      >
        <ChevronLeft :size="26" />
      </button>
      <button
        v-if="items.length > 1"
        class="viewer-button viewer-next"
        type="button"
        aria-label="下一张"
        :disabled="index === items.length - 1"
        @click="change(1)"
      >
        <ChevronRight :size="26" />
      </button>
      <footer class="viewer-footer">
        <span v-if="items.length > 1" class="viewer-counter"
          >{{ index + 1 }} / {{ items.length }}</span
        >
        <div class="viewer-toolbar" role="toolbar" aria-label="图片操作">
          <button
            class="viewer-button"
            type="button"
            aria-label="缩小"
            title="缩小"
            :disabled="loading || failed"
            @click="zoom(scale / 1.25)"
          >
            <Minus :size="19" />
          </button>
          <span class="viewer-scale">{{ Math.round(scale * 100) }}%</span>
          <button
            class="viewer-button"
            type="button"
            aria-label="放大"
            title="放大"
            :disabled="loading || failed"
            @click="zoom(scale * 1.25)"
          >
            <Plus :size="19" />
          </button>
          <i class="viewer-divider" aria-hidden="true" />
          <button
            class="viewer-button"
            type="button"
            aria-label="适应窗口"
            title="适应窗口"
            :disabled="loading || failed"
            @click="fit"
          >
            <Scan :size="19" />
          </button>
          <button
            class="viewer-button"
            type="button"
            aria-label="原始大小"
            title="原始大小"
            :disabled="loading || failed"
            @click="original"
          >
            <Expand :size="19" />
          </button>
          <i class="viewer-divider" aria-hidden="true" />
          <button
            class="viewer-button"
            type="button"
            aria-label="向左旋转"
            title="向左旋转"
            :disabled="loading || failed"
            @click="rotate(-90)"
          >
            <RotateCcw :size="19" />
          </button>
          <button
            class="viewer-button"
            type="button"
            aria-label="向右旋转"
            title="向右旋转"
            :disabled="loading || failed"
            @click="rotate(90)"
          >
            <RotateCw :size="19" />
          </button>
          <template v-if="item?.file"
            ><i class="viewer-divider" aria-hidden="true" /><button
              class="viewer-button"
              type="button"
              aria-label="在文件中查看"
              title="在文件中查看"
              @click="openFile"
            >
              <FolderOpen :size="19" /></button
          ></template>
        </div>
        <span class="viewer-hint">滚动缩放 · 拖动查看 · Esc 关闭</span>
      </footer>
    </div>
  </Teleport>
</template>
<style scoped>
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-lightbox);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgb(var(--image-viewer-bg) / var(--material-2-alpha));
  backdrop-filter: blur(var(--material-1-blur));
  color: rgb(var(--image-viewer-ink));
  animation: viewer-enter 160ms ease-out;
  -webkit-app-region: no-drag;
}
.viewer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6) var(--space-3);
  flex: none;
  z-index: var(--z-raised);
}
.viewer-title {
  min-width: 0;
  display: grid;
  gap: var(--space-1-5);
}
.viewer-title strong {
  font-size: var(--fs-s);
  font-weight: var(--weight-medium);
  line-height: 22px;
  overflow-wrap: anywhere;
}
.viewer-title span {
  font-size: var(--fs-xxs);
  line-height: 18px;
  color: rgb(var(--image-viewer-muted));
  overflow-wrap: anywhere;
}
.viewer-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: var(--radius-cell);
  background: transparent;
  color: rgb(var(--image-viewer-control-ink));
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;
}
.viewer-button:hover:not(:disabled) {
  background: rgb(var(--image-viewer-white) / 9%);
  color: rgb(var(--accent));
}
.viewer-button:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 3px;
}
.viewer-button:disabled {
  opacity: 0.3;
  cursor: default;
}
.viewer-close {
  border-radius: 50%;
  background: rgb(var(--image-viewer-white) / 5%);
}
.viewer-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  touch-action: none;
}
.viewer-image {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: none;
  max-height: none;
  transform-origin: center;
  user-select: none;
  cursor: grab;
  box-shadow: 0 12px 64px rgb(var(--image-viewer-shadow) / 40%);
}
.viewer-stage[data-dragging] .viewer-image {
  cursor: grabbing;
}
.viewer-image.is-loading {
  opacity: 0;
}
.viewer-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: rgb(var(--image-viewer-muted));
  font-size: var(--fs-xs);
}
.viewer-status strong {
  color: rgb(var(--image-viewer-control-ink));
  font-weight: var(--weight-medium);
}
.viewer-spinner {
  animation: viewer-spin 1s linear infinite;
}
.viewer-previous,
.viewer-next {
  position: absolute;
  top: 50%;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgb(var(--image-viewer-control) / 80%);
  backdrop-filter: blur(var(--material-1-blur));
}
.viewer-previous {
  left: var(--space-5);
}
.viewer-next {
  right: var(--space-5);
}
.viewer-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5) calc(var(--space-5) + var(--space-0-5));
  flex: none;
  z-index: var(--z-raised);
}
.viewer-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  padding: var(--space-1-5) var(--space-2-5);
  border: 1px solid rgb(var(--image-viewer-white) / 7%);
  border-radius: var(--radius-takeover);
  background: rgb(var(--image-viewer-toolbar) / 85%);
  box-shadow: 0 8px 32px rgb(var(--image-viewer-shadow) / 33%);
  backdrop-filter: blur(var(--material-2-blur));
}
.viewer-scale {
  min-width: 48px;
  text-align: center;
  font-size: var(--fs-xxs);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--image-viewer-secondary));
}
.viewer-divider {
  width: 1px;
  height: 18px;
  margin: 0 var(--space-2);
  background: rgb(var(--image-viewer-white) / 11%);
}
.viewer-hint,
.viewer-counter {
  font-size: var(--fs-xxxs);
  line-height: 16px;
  color: rgb(var(--image-viewer-subtle));
}
.viewer-counter {
  color: rgb(var(--image-viewer-counter));
  font-variant-numeric: tabular-nums;
}
@keyframes viewer-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes viewer-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 600px) {
  .viewer-header {
    padding: var(--space-4) var(--space-4) var(--space-2);
  }
  .viewer-footer {
    padding: var(--space-2) var(--space-2) var(--space-3);
  }
  .viewer-toolbar {
    gap: 0;
    padding: var(--space-1);
    border-radius: var(--radius-card);
  }
  .viewer-toolbar .viewer-button {
    width: 34px;
    height: 36px;
  }
  .viewer-divider {
    margin: 0 3px;
  }
  .viewer-scale {
    min-width: 40px;
  }
  .viewer-previous {
    left: var(--space-2-5);
  }
  .viewer-next {
    right: var(--space-2-5);
  }
  .viewer-previous,
  .viewer-next {
    width: 36px;
    height: 36px;
  }
}
</style>
