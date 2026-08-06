<script setup lang="ts">
import { ExternalLink, Globe2 } from 'lucide-vue-next'

const props = defineProps<{
  previewId: string
  title: string
  status: 'ready' | 'probing' | 'unreachable' | 'stopped'
}>()

function openPreview(): void {
  if (props.status !== 'ready') return
  window.dispatchEvent(
    new CustomEvent('emperor:open-preview', {
      detail: { previewId: props.previewId },
    }),
  )
}

function openSystemBrowser(): void {
  if (props.status !== 'ready') return
  window.dispatchEvent(
    new CustomEvent('emperor:open-preview-external', {
      detail: { previewId: props.previewId },
    }),
  )
}
</script>

<template>
  <div class="timeline-node website-card" :data-status="status">
    <span class="website-card-icon"><Globe2 :size="17" /></span>
    <div>
      <strong>{{ title || 'Web preview' }}</strong>
      <span>Website · {{ status === 'ready' ? '已就绪' : status }}</span>
    </div>
    <div class="website-card-actions">
      <button type="button" :disabled="status !== 'ready'" @click="openPreview">
        右侧预览
      </button>
      <button
        type="button"
        aria-label="在系统浏览器打开"
        :disabled="status !== 'ready'"
        @click="openSystemBrowser"
      >
        <ExternalLink :size="13" />
      </button>
    </div>
  </div>
</template>
