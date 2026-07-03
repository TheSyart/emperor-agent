<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AttachmentRef } from '../../types'
import { attachmentRawUrl } from '../../api/attachments'
import { attachmentIcon } from '../../icons'

const props = defineProps<{ data: AttachmentRef; removable?: boolean }>()
const emit = defineEmits<{ (e: 'remove'): void }>()

const isImage = computed(() => props.data.kind === 'image')
const thumbFailed = ref(false)
const previewUrl = computed(() => (isImage.value && !thumbFailed.value ? attachmentRawUrl(props.data.id) : null))
const iconComp = computed(() => attachmentIcon(props.data.kind, props.data.mime, props.data.name))

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
</script>

<template>
  <div class="attach-chip" :class="{ 'is-image': isImage }" :title="data.name">
    <img
      v-if="previewUrl"
      class="attach-thumb"
      :src="previewUrl"
      :alt="data.name"
      loading="lazy"
      @error="thumbFailed = true"
    />
    <span v-else class="attach-doc-icon" aria-hidden="true">
      <component :is="iconComp" :size="22" />
    </span>
    <div class="attach-meta">
      <div class="attach-name">{{ data.name }}</div>
      <div class="attach-sub">
        {{ formatBytes(data.size) }} · {{ data.kind }}<span v-if="data.hasText"> · 已抽文本</span>
      </div>
    </div>
    <button
      v-if="removable"
      type="button"
      class="attach-remove"
      title="移除"
      aria-label="移除附件"
      @click="emit('remove')"
    >×</button>
  </div>
</template>
