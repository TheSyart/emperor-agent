<script setup lang="ts">
import {
  Check,
  Circle,
  FileDiff,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TurnChangeSnapshot } from '../../types'
import type { ExecutionProgressModel } from './executionProgressModel'
import {
  progressStatusParts,
  progressStatusText,
  type ProgressChangeSummary,
} from './executionProgressModel'

const props = defineProps<{
  progress?: ExecutionProgressModel | null
  snapshot?: TurnChangeSnapshot | null
}>()
const emit = defineEmits<{ openReview: [paths: string[]] }>()

const root = ref<HTMLElement | null>(null)
const pinned = ref(false)
const hovered = ref(false)
const focusWithin = ref(false)
const open = computed(() => pinned.value || hovered.value || focusWithin.value)
const changeSummary = computed<ProgressChangeSummary | null>(() => {
  const snapshot = props.snapshot
  if (!snapshot || snapshot.filesChanged <= 0) return null
  return {
    filesChanged: snapshot.filesChanged,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    partial: snapshot.status === 'partial',
  }
})
const summary = computed(() =>
  progressStatusText(props.progress || null, changeSummary.value),
)
/** 分段渲染:+/− 需要分别上色(stat-add 绿 / stat-del 红),二者空格相连 */
const summarySegments = computed(() => {
  const parts = progressStatusParts(props.progress || null, changeSummary.value)
  const segments: { text: string; tone?: 'add' | 'del'; tight?: boolean }[] = []
  if (parts.stepText) segments.push({ text: parts.stepText })
  if (parts.changesText) segments.push({ text: parts.changesText })
  if (parts.additions !== undefined)
    segments.push({ text: `+${parts.additions}`, tone: 'add' })
  if (parts.deletions !== undefined)
    segments.push({ text: `−${parts.deletions}`, tone: 'del', tight: true })
  return segments
})

function togglePinned(): void {
  pinned.value = !pinned.value
}

function onFocusOut(event: FocusEvent): void {
  if (
    event.relatedTarget instanceof Node &&
    root.value?.contains(event.relatedTarget)
  ) {
    return
  }
  focusWithin.value = false
}

function close(): void {
  pinned.value = false
  hovered.value = false
  focusWithin.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!pinned.value || !(event.target instanceof Node)) return
  if (!root.value?.contains(event.target)) close()
}

function openReview(): void {
  pinned.value = false
  emit(
    'openReview',
    (props.snapshot?.files || []).map((file) => file.path),
  )
}

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown)
  document.addEventListener('pointerdown', onDocumentPointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})
</script>

<template>
  <div
    v-if="summary"
    ref="root"
    class="composer-progress"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focusin="focusWithin = true"
    @focusout="onFocusOut"
  >
    <div
      v-if="open"
      id="composer-progress-popover"
      class="composer-progress-popover"
      role="dialog"
      aria-label="当前任务进度"
    >
      <div v-if="props.progress?.items.length" class="composer-progress-list">
        <div
          v-for="item in props.progress.items"
          :key="item.id"
          class="composer-progress-item"
          :data-status="item.status"
        >
          <span class="composer-progress-marker" aria-hidden="true">
            <Check v-if="item.status === 'completed'" :size="14" />
            <LoaderCircle
              v-else-if="item.status === 'active'"
              :size="14"
              class="composer-progress-spinner"
            />
            <TriangleAlert v-else-if="item.status === 'blocked'" :size="14" />
            <Circle v-else :size="13" />
          </span>
          <span class="composer-progress-item-copy">
            <strong>{{ item.label }}</strong>
            <small v-if="item.detail">{{ item.detail }}</small>
          </span>
        </div>
      </div>
      <button
        v-if="changeSummary"
        type="button"
        class="composer-progress-review"
        @click="openReview"
      >
        <FileDiff :size="14" aria-hidden="true" />
        <span>在 Review 中查看变更</span>
        <span
          ><b class="stat-add">+{{ changeSummary.additions }}</b>
          <i class="stat-del">−{{ changeSummary.deletions }}</i></span
        >
      </button>
    </div>

    <button
      type="button"
      class="composer-progress-trigger"
      aria-haspopup="dialog"
      aria-controls="composer-progress-popover"
      :aria-expanded="open"
      @click="togglePinned"
    >
      <span class="composer-progress-live-dot" aria-hidden="true"></span>
      <span>
        <template v-for="(segment, index) in summarySegments" :key="index">
          <span v-if="index > 0">{{ segment.tight ? ' ' : ' · ' }}</span>
          <span
            :class="
              segment.tone === 'add'
                ? 'stat-add'
                : segment.tone === 'del'
                  ? 'stat-del'
                  : ''
            "
            >{{ segment.text }}</span
          >
        </template>
      </span>
    </button>
    <span class="sr-only" aria-live="polite">{{ summary }}</span>
  </div>
</template>
