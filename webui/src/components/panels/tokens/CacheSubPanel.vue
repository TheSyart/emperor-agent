<script setup lang="ts">
import { computed } from 'vue'
import type { TokenStatsRow, TokenUsageRecord, TokensPayload, TokensRange } from '../../../types'
import { formatNumber, formatTokenCompact, usageTypeLabel } from '../../../utils/format'
import {
  buildModelRows,
  buildTokenComposition,
  cacheTotal,
  filterByRange,
  formatPercent,
  pickColor,
} from '../../../utils/tokens'

const props = defineProps<{ tokens: TokensPayload | null; range: TokensRange }>()

type CacheRow = {
  key: string
  label: string
  sub: string
  cacheRead: number
  cacheCreate: number
  cacheTotal: number
  total: number
  calls: number
  color: string
}

const rangedBuckets = computed(() => filterByRange(props.tokens?.byDate ?? {}, props.range))

const totals = computed(() => {
  const buckets = rangedBuckets.value
  return buckets.reduce(
    (acc, row) => {
      acc.calls += row.calls
      acc.total += row.total
      acc.input += row.input
      acc.output += row.output
      acc.cacheRead += row.cacheRead
      acc.cacheCreate += row.cacheCreate
      return acc
    },
    { calls: 0, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  )
})

const composition = computed(() => buildTokenComposition({
  input: totals.value.input,
  output: totals.value.output,
  cache_read: totals.value.cacheRead,
  cache_create: totals.value.cacheCreate,
  total: totals.value.total,
}))

const metricCards = computed(() => {
  const c = composition.value
  return [
    { label: '输入缓存命中', value: formatTokenCompact(c.cacheHit), raw: c.cacheHit, hint: `命中率 ${formatPercent(c.cacheHit, c.inputTotal)}` },
    { label: '输入缓存未命中', value: formatTokenCompact(c.cacheMiss), raw: c.cacheMiss, hint: '普通输入 + 写入缓存' },
    { label: '输出', value: formatTokenCompact(c.output), raw: c.output, hint: '模型生成消耗' },
    { label: '总 Token', value: formatTokenCompact(c.total), raw: c.total, hint: '输入命中 + 未命中 + 输出' },
  ]
})

const modelRows = computed<CacheRow[]>(() =>
  buildModelRows(props.tokens?.byModel ?? {})
    .map((row) => ({
      key: row.key,
      label: row.model,
      sub: row.provider,
      cacheRead: row.cacheRead,
      cacheCreate: row.cacheCreate,
      cacheTotal: row.cacheTotal,
      total: row.total,
      calls: row.calls,
      color: row.color,
    }))
    .filter((row) => row.cacheTotal > 0)
    .sort((a, b) => b.cacheTotal - a.cacheTotal),
)

const usageRows = computed<CacheRow[]>(() =>
  Object.entries(props.tokens?.byUsageType ?? {})
    .map(([key, row]) => ({
      key,
      label: usageTypeLabel(key),
      sub: key,
      cacheRead: row.cache_read ?? 0,
      cacheCreate: row.cache_create ?? 0,
      cacheTotal: cacheTotal(row),
      total: row.total ?? 0,
      calls: row.calls ?? 0,
      color: pickColor(key),
    }))
    .filter((row) => row.cacheTotal > 0)
    .sort((a, b) => b.cacheTotal - a.cacheTotal),
)

const trendRows = computed(() =>
  rangedBuckets.value.map((row) => ({
    key: row.date,
    label: row.date.slice(5),
    fullDate: row.date,
    cacheTotal: row.cacheTotal,
    cacheRead: row.cacheRead,
    cacheCreate: row.cacheCreate,
  })),
)

const maxTrend = computed(() => Math.max(1, ...trendRows.value.map((row) => row.cacheTotal)))
const recentRows = computed<TokenUsageRecord[]>(() => props.tokens?.recentCacheCalls ?? [])
const empty = computed(() => !props.tokens || composition.value.total === 0)

function width(value: number, total: number): string {
  if (!total) return '0%'
  return `${Math.max(3, (value / total) * 100)}%`
}

function shortTime(ts: string): string {
  if (!ts) return '—'
  return ts.replace('T', ' ').slice(0, 16)
}

function recordModel(record: TokenUsageRecord): string {
  return record.provider && record.provider !== 'unknown'
    ? `${record.provider}/${record.model}`
    : record.model
}
</script>

<template>
  <div class="tokens-cache">
    <section class="stat-grid cache-stat-grid">
      <article v-for="card in metricCards" :key="card.label" class="stat-card cache-stat-card">
        <span class="stat-card-label">{{ card.label }}</span>
        <strong class="stat-card-value compact-value" :title="`${formatNumber(card.raw)} tokens`">{{ card.value }}</strong>
        <small class="stat-card-hint">{{ card.hint }}</small>
      </article>
    </section>

    <section class="cache-composition-card">
      <header class="cache-section-head">
        <div>
          <strong>输入缓存效率</strong>
          <p>命中、未命中与输出共同构成总 Token。</p>
        </div>
        <span>{{ formatPercent(composition.cacheHit, composition.inputTotal) }}</span>
      </header>
      <div v-if="empty" class="empty-note compact">当前时间范围内还没有 Token 记录。</div>
      <div v-else class="cache-meter">
        <span
          v-for="part in composition.parts"
          :key="part.key"
          :style="{ width: width(part.value, composition.total), background: part.color }"
          :title="`${part.label}: ${formatNumber(part.value)}`"
        />
      </div>
      <div v-if="!empty" class="cache-legend">
        <span v-for="part in composition.parts" :key="part.key">
          <i :style="{ background: part.color }" />
          <em>{{ part.label }}</em>
          <strong :title="`${formatNumber(part.value)} tokens`">{{ formatTokenCompact(part.value) }}</strong>
        </span>
      </div>
    </section>

    <section class="cache-trend-card">
      <header class="cache-section-head">
        <div>
          <strong>缓存趋势</strong>
          <p>按当前时间范围显示每日 KV Cache Read / Create。</p>
        </div>
      </header>
      <div class="cache-trend-frame">
        <div class="cache-trend-bars">
          <div
            v-for="row in trendRows"
            :key="row.key"
            class="cache-trend-bar"
            :class="{ empty: row.cacheTotal === 0 }"
            :title="`${row.fullDate} · Read ${formatNumber(row.cacheRead)} · Create ${formatNumber(row.cacheCreate)}`"
          >
            <span class="read" :style="{ height: `${(row.cacheRead / maxTrend) * 100}%` }" />
            <span class="create" :style="{ height: `${(row.cacheCreate / maxTrend) * 100}%` }" />
          </div>
        </div>
        <div class="cache-trend-axis">
          <span v-if="trendRows[0]">{{ trendRows[0].label }}</span>
          <span v-if="trendRows.length > 2">{{ trendRows[Math.floor(trendRows.length / 2)].label }}</span>
          <span v-if="trendRows.length > 1">{{ trendRows[trendRows.length - 1].label }}</span>
        </div>
      </div>
    </section>

    <section class="cache-split-grid">
      <article class="cache-list-card">
        <header class="cache-section-head compact">
          <strong>按模型</strong>
          <span>{{ modelRows.length }} models</span>
        </header>
        <div v-if="!modelRows.length" class="empty-note compact">暂无模型产生缓存记录。</div>
        <div v-else class="cache-rank-list">
          <div v-for="row in modelRows.slice(0, 8)" :key="row.key" class="cache-rank-row">
            <i :style="{ background: row.color }" />
            <div>
              <strong>{{ row.label }}</strong>
              <small>{{ row.sub || 'unknown' }}</small>
            </div>
            <em :title="`${formatNumber(row.cacheTotal)} tokens`">{{ formatTokenCompact(row.cacheTotal) }}</em>
            <span><b :style="{ width: width(row.cacheTotal, composition.cacheHit + composition.cacheCreate) }" /></span>
          </div>
        </div>
      </article>

      <article class="cache-list-card">
        <header class="cache-section-head compact">
          <strong>按用途</strong>
          <span>{{ usageRows.length }} kinds</span>
        </header>
        <div v-if="!usageRows.length" class="empty-note compact">暂无用途维度缓存记录。</div>
        <div v-else class="cache-rank-list">
          <div v-for="row in usageRows.slice(0, 8)" :key="row.key" class="cache-rank-row">
            <i :style="{ background: row.color }" />
            <div>
              <strong>{{ row.label }}</strong>
              <small>{{ formatNumber(row.calls) }} calls</small>
            </div>
            <em :title="`${formatNumber(row.cacheTotal)} tokens`">{{ formatTokenCompact(row.cacheTotal) }}</em>
            <span><b :style="{ width: width(row.cacheTotal, composition.cacheHit + composition.cacheCreate) }" /></span>
          </div>
        </div>
      </article>
    </section>

    <section class="cache-recent-card">
      <header class="cache-section-head">
        <div>
          <strong>最近缓存调用</strong>
          <p>来自 tokens.jsonl 的最新 KV Cache 命中 / 写入记录。</p>
        </div>
      </header>
      <div v-if="!recentRows.length" class="empty-note compact">还没有最近缓存调用。</div>
      <div v-else class="cache-table-wrap">
        <table class="cache-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>用途</th>
              <th class="num">输入缓存命中</th>
              <th class="num">输入缓存未命中</th>
              <th class="num">输出</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in recentRows" :key="`${row.ts}-${row.provider}-${row.model}-${row.total}`">
              <td class="mono">{{ shortTime(row.ts) }}</td>
              <td>
                <strong>{{ recordModel(row) }}</strong>
              </td>
              <td>{{ usageTypeLabel(row.usage_type) }}</td>
              <td class="num read" :title="`${formatNumber(row.cache_read)} tokens`">{{ formatTokenCompact(row.cache_read) }}</td>
              <td class="num miss" :title="`${formatNumber(row.input + row.cache_create)} tokens`">{{ formatTokenCompact(row.input + row.cache_create) }}</td>
              <td class="num create" :title="`${formatNumber(row.output)} tokens`">{{ formatTokenCompact(row.output) }}</td>
              <td class="num strong" :title="`${formatNumber(row.total)} tokens`">{{ formatTokenCompact(row.total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
