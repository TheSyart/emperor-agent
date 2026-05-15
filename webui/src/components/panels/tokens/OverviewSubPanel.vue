<script setup lang="ts">
import { computed } from 'vue'
import type { TokensPayload, TokensRange } from '../../../types'
import { formatNumber, formatTokenCompact } from '../../../utils/format'
import {
  buildTokenComposition,
  buildHeatmap,
  filterByRange,
  formatPercent,
  peakHourLabel,
  topModelDisplay,
} from '../../../utils/tokens'

const props = defineProps<{ tokens: TokensPayload | null; range: TokensRange }>()

const heatmap = computed(() => buildHeatmap(props.tokens?.byDate ?? {}))

const rangedBuckets = computed(() =>
  filterByRange(props.tokens?.byDate ?? {}, props.range),
)

const rangedTotals = computed(() => {
  const buckets = rangedBuckets.value
  let total = 0
  let active = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreate = 0
  for (const b of buckets) {
    total += b.total
    input += b.input
    output += b.output
    cacheRead += b.cacheRead
    cacheCreate += b.cacheCreate
    if (b.total > 0) active += 1
  }
  return { total, active, input, output, cacheRead, cacheCreate, cacheTotal: cacheRead + cacheCreate }
})

const composition = computed(() => buildTokenComposition({
  input: rangedTotals.value.input,
  output: rangedTotals.value.output,
  cache_read: rangedTotals.value.cacheRead,
  cache_create: rangedTotals.value.cacheCreate,
  total: rangedTotals.value.total,
}))

const cards = computed(() => {
  const tokens = props.tokens
  if (!tokens) {
    const empty = '—'
    return [
      { label: '输入缓存命中', value: empty, hint: 'cache_read', raw: 0, tone: 'hit' },
      { label: '输入缓存未命中', value: empty, hint: 'input + cache_create', raw: 0, tone: 'miss' },
      { label: '输出', value: empty, hint: 'output', raw: 0, tone: 'output' },
      { label: '总 Token', value: empty, hint: 'input + cache + output', raw: 0, tone: 'total' },
    ]
  }
  const c = composition.value
  return [
    { label: '输入缓存命中', value: formatTokenCompact(c.cacheHit), hint: `命中率 ${formatPercent(c.cacheHit, c.inputTotal)}`, raw: c.cacheHit, tone: 'hit' },
    { label: '输入缓存未命中', value: formatTokenCompact(c.cacheMiss), hint: '普通输入 + 写入缓存', raw: c.cacheMiss, tone: 'miss' },
    { label: '输出', value: formatTokenCompact(c.output), hint: '模型生成消耗', raw: c.output, tone: 'output' },
    { label: '总 Token', value: formatTokenCompact(c.total), hint: '输入命中 + 未命中 + 输出', raw: c.total, tone: 'total' },
  ]
})

const quickStats = computed(() => {
  const tokens = props.tokens
  if (!tokens) return []
  return [
    { label: 'Sessions', value: formatTokenCompact(tokens.sessions), title: `${formatNumber(tokens.sessions)} sessions` },
    { label: 'Messages', value: formatTokenCompact(tokens.messages), title: `${formatNumber(tokens.messages)} messages` },
    { label: 'Active days', value: formatTokenCompact(rangedTotals.value.active), title: `${formatNumber(rangedTotals.value.active)} active days` },
    { label: 'Peak hour', value: peakHourLabel(tokens.byHour), title: '消耗最多 Token 的时段' },
    { label: 'Favorite model', value: topModelDisplay(tokens.byModel), title: '总量最高的模型' },
  ]
})

function partWidth(value: number, total: number) {
  if (!total) return '0%'
  return `${Math.max(3, (value / total) * 100)}%`
}

const weekdayLabels = ['一', '三', '五']

function cellTitle(date: string | null, total: number, calls: number) {
  if (!date) return ''
  if (total === 0) return `${date} · 无记录`
  return `${date} · ${formatNumber(total)} tokens · ${formatNumber(calls)} calls`
}
</script>

<template>
  <div class="tokens-overview">
    <section class="stat-grid">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-card-label">{{ card.label }}</span>
        <strong class="stat-card-value compact-value" :data-tone="card.tone" :title="`${formatNumber(card.raw)} tokens`">
          {{ card.value }}
        </strong>
        <small class="stat-card-hint">{{ card.hint }}</small>
      </article>
    </section>

    <section class="token-composition-card">
      <header class="cache-section-head">
        <div>
          <strong>Token 构成</strong>
          <p>输入缓存命中、输入缓存未命中与输出的实际占比。</p>
        </div>
        <span :title="`${formatNumber(composition.total)} tokens`">{{ formatTokenCompact(composition.total) }}</span>
      </header>
      <div class="token-composition-meter">
        <span
          v-for="part in composition.parts"
          :key="part.key"
          :style="{ width: partWidth(part.value, composition.total), background: part.color }"
          :title="`${part.label}: ${formatNumber(part.value)} tokens`"
        />
      </div>
      <div class="token-composition-legend">
        <span v-for="part in composition.parts" :key="part.key">
          <i :style="{ background: part.color }" />
          <em>{{ part.label }}</em>
          <strong :title="`${formatNumber(part.value)} tokens`">{{ formatTokenCompact(part.value) }}</strong>
        </span>
      </div>
      <div v-if="quickStats.length" class="tokens-quick-grid">
        <span v-for="item in quickStats" :key="item.label" :title="item.title">
          <em>{{ item.label }}</em>
          <strong>{{ item.value }}</strong>
        </span>
      </div>
    </section>

    <section class="activity-heatmap-card">
      <header class="heatmap-head">
        <strong>活跃热力图</strong>
        <span class="heatmap-legend">
          <em>更少</em>
          <i class="legend-cell" data-level="0" />
          <i class="legend-cell" data-level="1" />
          <i class="legend-cell" data-level="2" />
          <i class="legend-cell" data-level="3" />
          <i class="legend-cell" data-level="4" />
          <em>更多</em>
        </span>
      </header>
      <div class="heatmap-frame">
        <div class="heatmap-months" :style="{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, 14px)` }">
          <span
            v-for="m in heatmap.months"
            :key="`${m.weekIndex}-${m.label}`"
            :style="{ gridColumnStart: m.weekIndex + 1 }"
          >
            {{ m.label }}
          </span>
        </div>
        <div class="heatmap-body">
          <div class="heatmap-weekdays">
            <span v-for="(label, idx) in weekdayLabels" :key="label" :style="{ gridRowStart: idx * 2 + 2 }">
              {{ label }}
            </span>
          </div>
          <div
            class="heatmap-grid"
            :style="{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, 14px)` }"
          >
            <div
              v-for="(week, wIdx) in heatmap.weeks"
              :key="wIdx"
              class="heatmap-col"
            >
              <div
                v-for="(cell, dIdx) in week"
                :key="dIdx"
                class="heatmap-cell"
                :data-level="cell.level"
                :data-empty="cell.date === null ? '1' : '0'"
                :title="cellTitle(cell.date, cell.total, cell.calls)"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
