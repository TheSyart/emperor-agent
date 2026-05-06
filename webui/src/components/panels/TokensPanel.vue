<script setup lang="ts">
import { computed } from 'vue'
import type { MemoryPayload, TokenStatsRow } from '../../types'
import { formatNumber, usageTypeLabel } from '../../utils/format'
import { actionAssets, navAssets } from '../../assets'

const props = defineProps<{ memory: MemoryPayload | null }>()
const emit = defineEmits<{ refresh: [] }>()

function sortStats(stats?: Record<string, TokenStatsRow>) {
  return Object.entries(stats || {}).sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
}

const byModel = computed(() => sortStats(props.memory?.tokensByModel))
const byUsage = computed(() => sortStats(props.memory?.tokensByUsageType))
const byDate = computed(() => sortStats(props.memory?.tokens))
const totals = computed(() => props.memory?.tokenTotals || {})
const tables = computed(() => [
  { title: '按模型 / 厂家', rows: byModel.value, kind: 'model' as const },
  { title: '按使用种类', rows: byUsage.value, kind: 'usage' as const },
  { title: '按日期', rows: byDate.value, kind: 'date' as const },
])

function label(key: string, kind: 'model' | 'usage' | 'date') {
  return kind === 'usage' ? usageTypeLabel(key) : key
}
</script>

<template>
  <div class="panel-content">
    <div class="panel-toolbar">
      <span class="status-pill"><span class="dot" />Token 用量账本</span>
      <button class="tool-button asset-button refresh-action" @click="emit('refresh')">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新统计</span>
      </button>
    </div>

    <section class="usage-board">
      <div class="usage-total">
        <img class="usage-mark" :src="navAssets.tokensActive" alt="" width="72" height="72" />
        <span>Token 总量</span>
        <strong>{{ formatNumber(totals.total || 0) }}</strong>
        <small>{{ formatNumber(totals.calls || 0) }} 次模型调用 · input {{ formatNumber(totals.input || 0) }} · output {{ formatNumber(totals.output || 0) }}</small>
      </div>
    </section>

    <div class="usage-grid">
      <section v-for="table in tables" :key="table.title" class="usage-card">
        <div class="usage-card-title">{{ table.title }}</div>
        <div v-if="!table.rows.length" class="empty-note compact">还没有 token 记录。发起一次真实模型调用后会自动出现统计。</div>
        <div v-else class="usage-table">
          <div v-for="[key, row] in table.rows" :key="key" class="usage-row">
            <div class="min-w-0">
              <strong class="truncate">{{ label(key, table.kind) }}</strong>
              <span>{{ formatNumber(row.calls || 0) }} calls · cache {{ formatNumber((row.cache_read || 0) + (row.cache_create || 0)) }}</span>
            </div>
            <div class="usage-number">{{ formatNumber(row.total || 0) }}</div>
          </div>
        </div>
      </section>
    </div>

    <div class="empty-note">这里专门统计模型调用用量。Model 面板只负责配置，Memory 面板只负责记忆内容。</div>
  </div>
</template>
