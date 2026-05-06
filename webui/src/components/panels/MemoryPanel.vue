<script setup lang="ts">
import type { MemoryPayload } from '../../types'
import { actionAssets, emptyAssets } from '../../assets'

const props = defineProps<{ memory: MemoryPayload | null }>()
const emit = defineEmits<{ refresh: [] }>()
</script>

<template>
  <div class="panel-content split-panel">
    <div class="panel-toolbar">
      <button class="tool-button asset-button refresh-action" @click="emit('refresh')">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新记忆</span>
      </button>
    </div>

    <div v-if="!props.memory" class="empty-state illustrated-empty">
      <img :src="emptyAssets.memory" alt="" />
      <span>暂无记忆数据。</span>
    </div>
    <div v-else class="split-body memory-body">
      <div class="editor">
        <div class="editor-title">MEMORY.local.md</div>
        <textarea :value="props.memory.long_term || ''" readonly />
        <div class="editor-actions"><span class="status-pill">{{ props.memory.episodes?.length || 0 }} 个情景记忆</span></div>
      </div>
      <div class="resource-list">
        <div class="section-label">情景记忆</div>
        <div v-for="path in props.memory.episodes || []" :key="path" class="list-item">
          <div class="min-w-0">
            <div class="item-title">{{ path.split('/').pop() || path }}</div>
            <div class="item-desc">{{ path }}</div>
          </div>
          <span class="badge">md</span>
        </div>
        <div v-if="!props.memory.episodes?.length" class="empty-note">还没有情景记忆。</div>
      </div>
    </div>
  </div>
</template>
