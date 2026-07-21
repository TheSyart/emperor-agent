<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TokenStatsRow, TokensPayload, TokensRange } from '../../../types'
import { formatNumber, formatTokenCompact } from '../../../utils/format'
import {
  buildModelRows,
  buildStackedBars,
  modelDisplayName,
  pickColor,
  formatPercent,
  type BarColumn,
  type ModelRow,
} from '../../../utils/tokens'

const props = defineProps<{
  tokens: TokensPayload | null
  range: TokensRange
}>()

type SortKey =
  'total' | 'calls' | 'output' | 'cacheRead' | 'cacheMiss' | 'hitRate' | 'model'
const sortKey = ref<SortKey>('total')
const sortAsc = ref(false)

const stacked = computed(() =>
  buildStackedBars(
    props.tokens?.byDateModel ?? {},
    props.tokens?.byDate ?? {},
    props.range,
  ),
)

const allModelRows = computed<ModelRow[]>(() =>
  buildModelRows(props.tokens?.byModel ?? {}),
)

const totalTokens = computed(() =>
  allModelRows.value.reduce((acc, row) => acc + row.total, 0),
)

const sortedModelRows = computed<ModelRow[]>(() => {
  const rows = [...allModelRows.value]
  const key = sortKey.value
  const dir = sortAsc.value ? 1 : -1
  rows.sort((a, b) => {
    if (key === 'model') {
      return a.model.localeCompare(b.model) * dir
    }
    if (key === 'hitRate') {
      return (hitRate(a) - hitRate(b)) * dir
    }
    return ((a[key] ?? 0) - (b[key] ?? 0)) * dir
  })
  return rows
})

const maxColumnTotal = computed(() => {
  let max = 0
  for (const col of stacked.value.columns) {
    if (col.total > max) max = col.total
  }
  return max
})

const xAxisLabels = computed(() => {
  const cols = stacked.value.columns
  if (!cols.length) return [] as { date: string; index: number }[]
  const last = cols.length - 1
  if (cols.length <= 3) {
    return cols.map((c, i) => ({ date: c.date, index: i }))
  }
  const mid = Math.floor(last / 2)
  return [
    { date: cols[0].date, index: 0 },
    { date: cols[mid].date, index: mid },
    { date: cols[last].date, index: last },
  ]
})

const legendEntries = computed(() => {
  const top = stacked.value.topModelKeys
  const otherKey = stacked.value.otherKey
  const tokens = props.tokens
  const byModel = tokens?.byModel ?? {}
  const entries = top.map((key) => {
    const info = byModel[key] as TokenStatsRow | undefined
    return { key, label: modelDisplayName(key, info), color: pickColor(key) }
  })
  if (otherKey) {
    entries.push({
      key: otherKey,
      label: '其他',
      color: 'rgb(var(--fg-muted) / 0.65)',
    })
  }
  return entries
})

const hovered = ref<BarColumn | null>(null)
const hoverIndex = ref<number>(-1)

function onEnter(col: BarColumn, idx: number) {
  hovered.value = col
  hoverIndex.value = idx
}

function onLeave() {
  hovered.value = null
  hoverIndex.value = -1
}

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value
  } else {
    sortKey.value = key
    sortAsc.value = key === 'model'
  }
}

function sortIndicator(key: SortKey) {
  if (sortKey.value !== key) return ''
  return sortAsc.value ? '↑' : '↓'
}

function tooltipLeftStyle(idx: number, total: number) {
  if (total <= 0) return ''
  const left = ((idx + 0.5) / total) * 100
  return `left: ${left}%`
}

function segmentLabel(model: string, info?: TokenStatsRow): string {
  if (model === '__other__') return '其他'
  return modelDisplayName(model, info)
}

function emptyState() {
  return !props.tokens || allModelRows.value.length === 0
}

function hitRate(row: ModelRow): number {
  const inputTotal = row.cacheRead + row.cacheMiss
  return inputTotal ? row.cacheRead / inputTotal : 0
}
</script>

<template>
  <div class="tokens-models">
    <section class="model-bars-card">
      <header class="bars-head">
        <div>
          <strong>每日 Token 用量 · 多模型对比</strong>
          <p>柱状高度按日总量缩放，分段对应当天各模型 tokens。</p>
        </div>
        <div v-if="legendEntries.length" class="bars-legend">
          <span
            v-for="entry in legendEntries"
            :key="entry.key"
            class="legend-item"
          >
            <i class="legend-swatch" :style="{ background: entry.color }" />
            <em>{{ entry.label }}</em>
          </span>
        </div>
      </header>

      <div class="bars-frame">
        <div class="bars-grid-lines"><span /><span /><span /></div>
        <div class="model-bars" @mouseleave="onLeave">
          <div
            v-for="(col, idx) in stacked.columns"
            :key="col.date"
            class="model-bar"
            :class="{ active: hoverIndex === idx, empty: col.total === 0 }"
            @mouseenter="onEnter(col, idx)"
            @focus="onEnter(col, idx)"
            tabindex="0"
          >
            <div
              class="model-bar-fill"
              :style="{
                height: `${maxColumnTotal ? (col.total / maxColumnTotal) * 100 : 0}%`,
              }"
            >
              <span
                v-for="seg in col.segments"
                :key="`${col.date}-${seg.model}`"
                class="model-bar-segment"
                :style="{ flexGrow: seg.total, background: seg.color }"
              />
            </div>
          </div>
          <div
            v-if="hovered && hovered.total > 0"
            class="bar-tooltip"
            :style="tooltipLeftStyle(hoverIndex, stacked.columns.length)"
          >
            <strong>{{ hovered.date }}</strong>
            <ul>
              <li v-for="seg in hovered.segments" :key="seg.model">
                <i class="tooltip-swatch" :style="{ background: seg.color }" />
                <span>{{
                  segmentLabel(seg.model, props.tokens?.byModel?.[seg.model])
                }}</span>
                <em>{{ formatTokenCompact(seg.total) }}</em>
              </li>
            </ul>
            <footer>合计 {{ formatTokenCompact(hovered.total) }} tokens</footer>
          </div>
        </div>
      </div>
      <div class="bars-axis">
        <span
          v-for="label in xAxisLabels"
          :key="label.index"
          :style="{
            left: `${stacked.columns.length ? ((label.index + 0.5) / stacked.columns.length) * 100 : 0}%`,
          }"
        >
          {{ label.date.slice(5) }}
        </span>
      </div>
    </section>

    <section class="model-list-card">
      <header class="list-head">
        <strong>模型明细</strong>
        <small>点击表头切换排序</small>
      </header>
      <div v-if="emptyState()" class="empty-note compact">
        还没有 token 记录。发起一次真实模型调用后会自动出现统计。
      </div>
      <table v-else class="model-list">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th class="sortable" @click="setSort('model')">
              模型 / 厂家 {{ sortIndicator('model') }}
            </th>
            <th class="sortable num" @click="setSort('calls')">
              Calls {{ sortIndicator('calls') }}
            </th>
            <th class="sortable num cache-col" @click="setSort('cacheRead')">
              缓存命中 {{ sortIndicator('cacheRead') }}
            </th>
            <th class="sortable num cache-col" @click="setSort('cacheMiss')">
              缓存未命中 {{ sortIndicator('cacheMiss') }}
            </th>
            <th class="sortable num" @click="setSort('output')">
              输出 {{ sortIndicator('output') }}
            </th>
            <th class="sortable num" @click="setSort('total')">
              总 Token {{ sortIndicator('total') }}
            </th>
            <th class="sortable num cache-col" @click="setSort('hitRate')">
              命中率 {{ sortIndicator('hitRate') }}
            </th>
            <th class="col-share">占比</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in sortedModelRows" :key="row.key">
            <td class="col-rank">
              <i class="row-swatch" :style="{ background: row.color }" />
              <span>{{ idx + 1 }}</span>
            </td>
            <td>
              <strong class="row-model">{{ row.model }}</strong>
              <small v-if="row.provider">{{ row.provider }}</small>
            </td>
            <td class="num">{{ formatTokenCompact(row.calls) }}</td>
            <td
              class="num cache-value"
              :title="`${formatNumber(row.cacheRead)} tokens`"
            >
              {{ formatTokenCompact(row.cacheRead) }}
            </td>
            <td
              class="num cache-value miss"
              :title="`${formatNumber(row.cacheMiss)} tokens`"
            >
              {{ formatTokenCompact(row.cacheMiss) }}
            </td>
            <td
              class="num cache-value create"
              :title="`${formatNumber(row.output)} tokens`"
            >
              {{ formatTokenCompact(row.output) }}
            </td>
            <td class="num strong" :title="`${formatNumber(row.total)} tokens`">
              {{ formatTokenCompact(row.total) }}
            </td>
            <td class="num cache-value">
              {{ formatPercent(row.cacheRead, row.cacheRead + row.cacheMiss) }}
            </td>
            <td class="col-share">
              <div class="model-list-bar">
                <span
                  :style="{
                    width: `${totalTokens ? (row.total / totalTokens) * 100 : 0}%`,
                  }"
                />
              </div>
              <em>{{ formatPercent(row.total, totalTokens) }}</em>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
