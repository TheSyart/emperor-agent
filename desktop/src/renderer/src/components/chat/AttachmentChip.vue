<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AttachmentRef } from '../../types'
import { openImageViewer } from '../ui/imageViewer'
import { requestWorkspace } from '../workspace/workspaceState'
import { attachmentRawUrl } from '../../api/attachments'
import { attachmentIcon } from '../../icons'

const props = defineProps<{
  data: AttachmentRef
  removable?: boolean
  owner?: string
  group?: readonly AttachmentRef[]
}>()
const emit = defineEmits<{ (e: 'remove'): void }>()

const isImage = computed(() => props.data.kind === 'image')
const thumbFailed = ref(false)
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
  const owner = props.owner || ''
  const group = (props.group ?? [props.data]).filter(
    (item) => item.kind === 'image',
  )
  openImageViewer({
    owner,
    index: Math.max(
      0,
      group.findIndex((item) => item.id === props.data.id),
    ),
    items: group.map((item) => ({
      id: item.id,
      name: item.name,
      src: attachmentRawUrl(item.id),
      file: {
        owner,
        target: { source: 'attachment' as const, attachmentId: item.id },
      },
    })),
  })
}
function openFile() {
  if (props.owner)
    requestWorkspace({
      pane: 'files',
      file: {
        owner: props.owner,
        target: { source: 'attachment', attachmentId: props.data.id },
      },
    })
}
</script>

<template>
  <div class="attach-chip" :class="{ 'is-image': isImage }" :title="data.name">
    <button
      v-if="isImage"
      type="button"
      class="attach-preview-trigger"
      :aria-label="`放大预览 ${data.name}`"
      :title="`放大预览 ${data.name}`"
      @click="openPreview"
    >
      <img
        v-if="previewUrl"
        class="attach-thumb"
        :src="previewUrl"
        :alt="data.name"
        loading="lazy"
        @error="thumbFailed = true"
      />
      <span v-else class="attach-doc-icon" aria-hidden="true">
        <component :is="iconComp" :size="20" />
      </span>
    </button>
    <span v-else class="attach-doc-icon" aria-hidden="true">
      <component :is="iconComp" :size="20" />
    </span>
    <div v-if="!isImage" class="attach-meta">
      <button
        type="button"
        class="attach-name attach-file-open"
        @click="openFile"
      >
        {{ data.name }}
      </button>
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
</template>
<style scoped>
.attach-chip.is-image {
  position: relative;
  padding: 0;
  gap: 0;
  overflow: visible;
}
.attach-chip.is-image .attach-preview-trigger {
  padding: 0;
  border: 0;
  background: transparent;
  border-radius: inherit;
}
.attach-chip.is-image .attach-thumb,
.attach-chip.is-image .attach-doc-icon {
  width: 64px;
  height: 64px;
  border-radius: inherit;
}
.attach-chip.is-image .attach-remove {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  width: 20px;
  height: 20px;
  margin: 0;
  background: rgb(var(--image-viewer-bg) / 80%);
  color: rgb(var(--image-viewer-ink));
}
.attach-chip.is-image .attach-remove:hover {
  background: rgb(var(--image-viewer-bg));
  color: rgb(var(--accent));
}
.attach-file-open {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.attach-chip .attach-file-open {
  white-space: normal;
  overflow: visible;
  overflow-wrap: anywhere;
  text-overflow: clip;
}
.attach-file-open:hover {
  color: rgb(var(--accent));
}
</style>
