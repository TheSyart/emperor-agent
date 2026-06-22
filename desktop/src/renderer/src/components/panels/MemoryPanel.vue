<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MemoryPayload, MemoryVersionDetail } from '../../types'
import { actionIcons, emptyIcons } from '../../icons'
import MarkdownBlock from '../chat/MarkdownBlock.vue'

const props = defineProps<{
  memory: MemoryPayload | null
  loadEpisode: (date: string) => Promise<{ date: string; content: string }>
  loadVersion: (id: string) => Promise<MemoryVersionDetail>
}>()
const emit = defineEmits<{
  refresh: []
  saveLongTerm: [content: string]
  saveEpisode: [date: string, content: string]
  saveWatchlist: [content: string]
  checkWatchlist: []
  restoreVersion: [id: string]
}>()

type MemoryTab = 'long_term' | 'episodes' | 'watchlist' | 'versions'
const tab = ref<MemoryTab>('long_term')

const longTermDraft = ref('')
const longTermPreview = ref(false)
const watchlistDraft = ref('')

watch(() => props.memory?.long_term, (val) => {
  longTermDraft.value = val || ''
}, { immediate: true })

watch(() => props.memory?.watchlist?.content, (val) => {
  watchlistDraft.value = val || ''
}, { immediate: true })

const selectedEpisode = ref<{ date: string; content: string } | null>(null)
const episodeDraft = ref('')
const episodePreview = ref(false)
const episodeLoading = ref(false)
const versionDetail = ref<MemoryVersionDetail | null>(null)
const versionLoading = ref(false)

async function selectEpisode(path: string) {
  const date = path.split('/').pop()?.replace('.md', '') || ''
  if (!date) return
  episodeLoading.value = true
  try {
    const data = await props.loadEpisode(date)
    selectedEpisode.value = data
    episodeDraft.value = data.content
    episodePreview.value = false
  } finally {
    episodeLoading.value = false
  }
}

function saveLongTerm() {
  emit('saveLongTerm', longTermDraft.value)
}

function saveEpisode() {
  if (!selectedEpisode.value) return
  emit('saveEpisode', selectedEpisode.value.date, episodeDraft.value)
}

function saveWatchlist() {
  emit('saveWatchlist', watchlistDraft.value)
}

async function selectVersion(id: string) {
  versionLoading.value = true
  try {
    versionDetail.value = await props.loadVersion(id)
  } finally {
    versionLoading.value = false
  }
}

const sortedEpisodes = computed(() => {
  const eps = props.memory?.episodes || []
  return [...eps].sort((a, b) => b.localeCompare(a))
})

const historyStats = computed(() => props.memory?.history || null)
const runtimeStats = computed(() => props.memory?.runtime || null)
const schedulerMaintenance = computed(() => props.memory?.schedulerMaintenance || null)
const watchlistDecision = computed(() => props.memory?.watchlist?.lastDecision || null)
const versions = computed(() => props.memory?.versions?.versions || [])

function formatBytes(value?: number) {
  const bytes = Math.max(0, Number(value || 0))
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

function formatNumber(value?: number) {
  return Math.max(0, Number(value || 0)).toLocaleString('zh-CN')
}
</script>

<template>
  <div class="panel-content split-panel">
    <div class="panel-toolbar">
      <div class="memory-tabs" role="tablist">
        <button
          class="memory-tab"
          :data-active="tab === 'long_term' ? 'true' : 'false'"
          @click="tab = 'long_term'"
        >
          长期记忆
        </button>
        <button
          class="memory-tab"
          :data-active="tab === 'episodes' ? 'true' : 'false'"
          @click="tab = 'episodes'"
        >
        情景记忆
        </button>
        <button
          class="memory-tab"
          :data-active="tab === 'watchlist' ? 'true' : 'false'"
          @click="tab = 'watchlist'"
        >
          Watchlist
        </button>
        <button
          class="memory-tab"
          :data-active="tab === 'versions' ? 'true' : 'false'"
          @click="tab = 'versions'"
        >
          版本记录
        </button>
      </div>
    </div>

    <div v-if="historyStats" class="memory-stats-grid">
      <div class="memory-stat-card" :class="{ warning: historyStats.needs_rotation }">
        <span>热日志</span>
        <strong>{{ formatBytes(historyStats.active_bytes) }}</strong>
        <small>{{ formatNumber(historyStats.active_lines) }} 行 · seq {{ formatNumber(historyStats.latest_seq) }}</small>
      </div>
      <div class="memory-stat-card">
        <span>冷归档</span>
        <strong>{{ formatBytes(historyStats.archive_bytes) }}</strong>
        <small>{{ formatNumber(historyStats.archive_files) }} 个 gzip 文件</small>
      </div>
      <div class="memory-stat-card">
        <span>最近归档</span>
        <strong>{{ historyStats.last_archive_at ? historyStats.last_archive_at.slice(0, 10) : '暂无' }}</strong>
        <small>{{ historyStats.needs_rotation ? '热日志接近上限' : '容量正常' }}</small>
      </div>
    </div>

    <div v-if="runtimeStats" class="memory-stats-grid">
      <div class="memory-stat-card">
        <span>Runtime 热记录</span>
        <strong>{{ formatBytes(runtimeStats.bytes) }}</strong>
        <small>{{ formatNumber(runtimeStats.events) }} 个事件 · seq {{ formatNumber(runtimeStats.latestSeq) }}</small>
      </div>
      <div class="memory-stat-card">
        <span>活跃 Turn</span>
        <strong>{{ formatNumber(runtimeStats.activeTurns) }}</strong>
        <small>{{ formatNumber(runtimeStats.activeTurnEvents) }} 个可重放事件</small>
      </div>
      <div class="memory-stat-card">
        <span>Runtime 冷归档</span>
        <strong>{{ formatBytes(runtimeStats.archiveBytes) }}</strong>
        <small>{{ formatNumber(runtimeStats.archiveFiles) }} 个 gzip 文件</small>
      </div>
    </div>

    <div v-if="schedulerMaintenance" class="memory-stats-grid">
      <div class="memory-stat-card" :class="{ warning: schedulerMaintenance.lastError }">
        <span>系统维护任务</span>
        <strong>{{ formatNumber(schedulerMaintenance.enabled) }} / {{ formatNumber(schedulerMaintenance.jobs) }}</strong>
        <small>{{ schedulerMaintenance.lastError || '受保护 Scheduler jobs' }}</small>
      </div>
      <div class="memory-stat-card">
        <span>下次维护</span>
        <strong>{{ schedulerMaintenance.nextRunAtMs ? new Date(schedulerMaintenance.nextRunAtMs).toLocaleDateString('zh-CN') : '暂无' }}</strong>
        <small>{{ schedulerMaintenance.nextRunAtMs ? new Date(schedulerMaintenance.nextRunAtMs).toLocaleTimeString('zh-CN', { hour12: false }) : 'Scheduler 未安排' }}</small>
      </div>
    </div>

    <div v-if="!props.memory" class="empty-state illustrated-empty">
      <component :is="emptyIcons.memory" :size="64" :stroke-width="1" />
      <span>暂无记忆数据。</span>
    </div>

    <div v-else-if="tab === 'long_term'" class="editor flex-1">
      <div class="editor-title">
        <span>MEMORY.local.md</span>
        <button class="badge preview-toggle" :class="{ active: longTermPreview }" @click="longTermPreview = !longTermPreview">
          {{ longTermPreview ? '编辑' : '预览' }}
        </button>
      </div>
      <div v-if="longTermPreview" class="skill-preview">
        <MarkdownBlock :content="longTermDraft" />
      </div>
      <textarea v-else v-model="longTermDraft" />
      <div class="editor-actions">
        <span class="status-pill">保存后刷新 Agent 上下文</span>
        <button class="tool-button ink asset-button primary-action" @click="saveLongTerm">
          <component :is="actionIcons.save" class="action-icon" :size="16" />
          <span>保存</span>
        </button>
      </div>
    </div>

    <div v-else-if="tab === 'watchlist'" class="editor flex-1">
      <div class="editor-title">
        <span>memory/watchlist.md</span>
        <button class="badge preview-toggle" @click="emit('checkWatchlist')">手动检查</button>
      </div>
      <div v-if="watchlistDecision" class="memory-stats-grid">
        <div class="memory-stat-card" :class="{ warning: watchlistDecision.action === 'run' }">
          <span>最近决策</span>
          <strong>{{ watchlistDecision.action || 'skip' }}</strong>
          <small>{{ watchlistDecision.reason || '暂无原因' }}</small>
        </div>
        <div class="memory-stat-card">
          <span>决策模型</span>
          <strong>{{ watchlistDecision.modelRole || 'unknown' }}</strong>
          <small>{{ watchlistDecision.provider || '-' }} · {{ watchlistDecision.model || '-' }}</small>
        </div>
      </div>
      <textarea v-model="watchlistDraft" />
      <div class="editor-actions">
        <span class="status-pill">Scheduler 会周期检查 Watchlist</span>
        <button class="tool-button ink asset-button primary-action" @click="saveWatchlist">
          <component :is="actionIcons.save" class="action-icon" :size="16" />
          <span>保存</span>
        </button>
      </div>
    </div>

    <div v-else-if="tab === 'versions'" class="split-body memory-body">
      <div class="resource-list episode-list">
        <div
          v-for="version in versions"
          :key="version.id"
          class="list-item episode-card"
          :class="{ active: versionDetail?.version.id === version.id }"
          @click="selectVersion(version.id)"
        >
          <div class="min-w-0">
            <div class="item-title">{{ version.label || version.relPath }}</div>
            <div class="item-desc">{{ version.target }} · {{ version.reason }}</div>
            <div class="item-desc">{{ new Date(version.createdAt * 1000).toLocaleString('zh-CN', { hour12: false }) }}</div>
          </div>
          <span class="badge">{{ formatBytes(version.bytes) }}</span>
        </div>
        <div v-if="!versions.length" class="empty-note">还没有版本快照。</div>
      </div>

      <div v-if="versionLoading" class="empty-state illustrated-empty">
        <span>加载中...</span>
      </div>
      <div v-else-if="!versionDetail" class="empty-state illustrated-empty">
        <component :is="emptyIcons.memory" :size="64" :stroke-width="1" />
        <span>选择一个版本以查看 diff。</span>
      </div>
      <div v-else class="editor flex-1">
        <div class="editor-title">
          <span>{{ versionDetail.version.relPath }}</span>
          <button class="badge preview-toggle" @click="emit('restoreVersion', versionDetail.version.id)">恢复</button>
        </div>
        <pre class="memory-diff-preview">{{ versionDetail.diff || '当前内容与该版本一致。' }}</pre>
        <div class="editor-actions">
          <span class="status-pill">{{ versionDetail.version.id }}</span>
        </div>
      </div>
    </div>

    <div v-else class="split-body memory-body">
      <div class="resource-list episode-list">
        <div v-for="path in sortedEpisodes" :key="path" class="list-item episode-card" :class="{ active: selectedEpisode?.date === path.split('/').pop()?.replace('.md', '') }" @click="selectEpisode(path)">
          <div class="min-w-0">
            <div class="item-title">{{ path.split('/').pop()?.replace('.md', '') }}</div>
            <div class="item-desc">{{ path }}</div>
          </div>
          <span class="badge">md</span>
        </div>
        <div v-if="!sortedEpisodes.length" class="empty-note">还没有情景记忆。</div>
      </div>

      <div v-if="episodeLoading" class="empty-state illustrated-empty">
        <span>加载中...</span>
      </div>
      <div v-else-if="!selectedEpisode" class="empty-state illustrated-empty">
        <component :is="emptyIcons.memory" :size="64" :stroke-width="1" />
        <span>选择一个情景记忆文件以查看或编辑。</span>
      </div>
      <div v-else class="editor flex-1">
        <div class="editor-title">
          <span>{{ selectedEpisode.date }}.md</span>
          <button class="badge preview-toggle" :class="{ active: episodePreview }" @click="episodePreview = !episodePreview">
            {{ episodePreview ? '编辑' : '预览' }}
          </button>
        </div>
        <div v-if="episodePreview" class="skill-preview">
          <MarkdownBlock :content="episodeDraft" />
        </div>
        <textarea v-else v-model="episodeDraft" />
        <div class="editor-actions">
          <span class="status-pill">{{ selectedEpisode.date }}</span>
          <button class="tool-button ink asset-button primary-action" @click="saveEpisode">
            <component :is="actionIcons.save" class="action-icon" :size="16" />
            <span>保存</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
