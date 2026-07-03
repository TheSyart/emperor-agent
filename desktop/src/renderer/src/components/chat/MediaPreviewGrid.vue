<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MediaArtifactRef } from '../../types'
import { mediaRawUrl } from '../../api/media'

const props = defineProps<{ items: MediaArtifactRef[] }>()
const selected = ref<MediaArtifactRef | null>(null)
// Wave4.5：加载失败的图片不再静默显示破图标
const failedIds = ref(new Set<string>())
const retryNonce = ref(0)

const imageItems = computed(() => props.items.filter((item) => item.kind === 'image'))

function imageUrl(item: MediaArtifactRef): string {
  const base = mediaRawUrl(item.id)
  return retryNonce.value ? `${base}${base.includes('?') ? '&' : '?'}retry=${retryNonce.value}` : base
}

function markFailed(item: MediaArtifactRef) {
  failedIds.value = new Set([...failedIds.value, item.id])
}

function retryFailed() {
  failedIds.value = new Set()
  retryNonce.value += 1
}

function closePreview() {
  selected.value = null
}
</script>

<template>
  <div v-if="imageItems.length" class="media-preview-grid">
    <template v-for="item in imageItems" :key="item.id">
      <button
        v-if="!failedIds.has(item.id)"
        type="button"
        class="media-preview-item"
        :title="item.originalPath || item.name"
        @click="selected = item"
      >
        <img :src="imageUrl(item)" :alt="item.name" loading="lazy" @error="markFailed(item)" />
        <span>{{ item.name }}</span>
      </button>
      <button
        v-else
        type="button"
        class="media-preview-item media-preview-broken"
        :title="`加载失败: ${item.name}`"
        @click="retryFailed"
      >
        <span class="media-preview-broken-icon" aria-hidden="true">⚠</span>
        <span>{{ item.name }} · 点击重试</span>
      </button>
    </template>
  </div>

  <div v-if="selected" class="media-preview-modal" role="dialog" aria-modal="true" @click.self="closePreview">
    <button type="button" class="media-preview-close" aria-label="关闭预览" @click="closePreview">×</button>
    <img :src="imageUrl(selected)" :alt="selected.name" />
    <div class="media-preview-caption">
      <strong>{{ selected.name }}</strong>
      <span>{{ selected.mime }}</span>
      <code>{{ selected.originalPath }}</code>
    </div>
  </div>
</template>
