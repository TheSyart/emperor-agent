<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ToolInfo } from '../../types'
import { emptyAssets, toolIcon } from '../../assets'

const props = defineProps<{ tools: ToolInfo[] }>()
const filter = ref('')
const expanded = ref<Set<string>>(new Set())

const filtered = computed(() => {
  const query = filter.value.trim().toLowerCase()
  if (!query) return props.tools
  return props.tools.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(query))
})

function toggleParams(name: string) {
  const next = new Set(expanded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expanded.value = next
}

function paramNames(params?: Record<string, unknown>): string[] {
  if (!params || typeof params !== 'object') return []
  const props = (params as any).properties
  if (!props || typeof props !== 'object') return []
  return Object.keys(props)
}
</script>

<template>
  <div class="panel-content">
    <div class="panel-toolbar">
      <div class="filter-wrap">
        <input v-model="filter" placeholder="筛选 tool" />
        <span v-if="filter" class="filter-badge">{{ filtered.length }}</span>
      </div>
    </div>
    <div class="tool-card-grid panel-scroll">
      <div
        v-for="tool in filtered"
        :key="tool.name"
        class="tool-card"
      >
        <div class="tool-card-head">
          <img class="tool-card-icon" :src="toolIcon(tool.name)" alt="" width="40" height="40" />
          <div class="min-w-0 flex-1">
            <div class="tool-card-name">{{ tool.name }}</div>
            <div class="tool-card-desc">{{ tool.description || '无描述' }}</div>
          </div>
        </div>
        <div class="tool-badge-row">
          <span class="badge" :class="tool.read_only ? 'green' : 'red'">{{ tool.read_only ? '只读' : '可写' }}</span>
          <span v-if="tool.concurrency_safe" class="badge green">并发安全</span>
          <span v-if="tool.exclusive" class="badge gold">独占</span>
        </div>
        <div v-if="paramNames(tool.parameters).length" class="tool-param-section">
          <button class="tool-param-toggle" @click="toggleParams(tool.name)">
            <span>参数 ({{ paramNames(tool.parameters).length }})</span>
            <span class="tool-param-caret" :class="{ open: expanded.has(tool.name) }">▼</span>
          </button>
          <div v-if="expanded.has(tool.name)" class="tool-param-list">
            <span v-for="p in paramNames(tool.parameters)" :key="p" class="tool-param-chip">{{ p }}</span>
          </div>
        </div>
      </div>
      <div v-if="!filtered.length" class="empty-state illustrated-empty tool-empty">
        <img :src="emptyAssets.tools" alt="" />
        <span>没有匹配的 tool。</span>
      </div>
    </div>
  </div>
</template>
