<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { AttachmentRef } from '../../types'
import { attachmentRawUrl } from '../../api/attachments'
import { attachmentIcon } from '../../icons'

const props = defineProps<{ data: AttachmentRef; removable?: boolean }>()
const emit = defineEmits<{ (e: 'remove'): void }>()

const isImage = computed(() => props.data.kind === 'image')
const thumbFailed = ref(false)
const previewOpen = ref(false)
const closeButton = ref<HTMLButtonElement | null>(null)
const previewUrl = computed(() =>
  isImage.value && !thumbFailed.value ? attachmentRawUrl(props.data.id) : null,
)
const iconComp = computed(() =>
  attachmentIcon(props.data.kind, props.data.mime, props.data.name),
)

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function openPreview() {
  if (!previewUrl.value) return
  previewOpen.value = true
  void nextTick(() => closeButton.value?.focus())
}

function closePreview() {
  previewOpen.value = false
}

function onPreviewKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closePreview()
}

watch(previewOpen, (open) => {
  if (open) window.addEventListener('keydown', onPreviewKeydown)
  else window.removeEventListener('keydown', onPreviewKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKeydown))
</script>

<template>
  <div class="attach-chip" :class="{ 'is-image': isImage }" :title="data.name">
    <button
      v-if="previewUrl"
      type="button"
      class="attach-preview-trigger"
      :aria-label="`放大预览 ${data.name}`"
      :title="`放大预览 ${data.name}`"
      @click="openPreview"
    >
      <img
        class="attach-thumb"
        :src="previewUrl"
        :alt="data.name"
        loading="lazy"
        @error="thumbFailed = true"
      />
    </button>
    <span v-else class="attach-doc-icon" aria-hidden="true">
      <component :is="iconComp" :size="22" />
    </span>
    <div class="attach-meta">
      <div class="attach-name">{{ data.name }}</div>
      <div class="attach-sub">
        {{ formatBytes(data.size) }} · {{ data.kind
        }}<span v-if="data.hasText"> · 已抽文本</span>
      </div>
    </div>
    <button
      v-if="removable"
      type="button"
      class="attach-remove"
      title="移除"
      aria-label="移除附件"
      @click="emit('remove')"
    >
      ×
    </button>
  </div>

  <Teleport to="body">
    <div
      v-if="previewOpen && previewUrl"
      class="attachment-preview-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="`图片预览：${data.name}`"
      @click.self="closePreview"
    >
      <div class="attachment-preview-stage">
        <button
          ref="closeButton"
          type="button"
          class="attachment-preview-close"
          aria-label="关闭图片预览"
          @click="closePreview"
        >
          ×
        </button>
        <img :src="previewUrl" :alt="data.name" />
        <div class="attachment-preview-caption">
          <strong>{{ data.name }}</strong>
          <span>{{ data.mime }} · {{ formatBytes(data.size) }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
