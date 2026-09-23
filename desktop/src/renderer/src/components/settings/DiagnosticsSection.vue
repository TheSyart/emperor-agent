<script setup lang="ts">
/**
 * Settings › 诊断 — an overview first, details on demand:
 * - 概览: the overall state (「运行正常」 / 「有 n 项需要关注」), one Metric
 *   per section (正常 x/y) and the rows that need attention, errors first;
 *   clicking one opens its section card and scrolls to it.
 * - Section cards (collapsed by default): 运行时, 环境工具 (environment
 *   probe), 桌面, 存储路径, 配置. Each header summarises its rows; the body
 *   is compact rows with a status badge. Rows Core returned no data for are
 *   left out (the card says how many); home paths read `~`.
 * Header actions: 刷新 (diagnostics + environment re-detection) and 复制报告
 * (plain-text report of the page).
 */
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import IconButton from '../ui/IconButton.vue'
import { useCopyFeedback } from '../ui/useCopyFeedback'
import { DsCopy, DsFolderOpen, DsWarning } from '../icons/ds'
import {
  Metric,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  StatusBadge,
} from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { core } from '../../api/http'
import { openPath } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import type { DiagnosticsPayload } from '../../types'
import EnvironmentToolsGroup from './diagnostics/EnvironmentToolsGroup.vue'
import {
  OPENABLE_DIAGNOSTIC_PATHS,
  diagnosticReportText,
  diagnosticSections,
  diagnosticSummary,
  shortenHomePaths,
  type DiagnosticIssue,
  type DiagnosticRow,
  type DiagnosticSectionCount,
  type DiagnosticSectionId,
  type DiagnosticTone,
} from './diagnostics/diagnosticsModel'
import {
  environmentDiagnosticItems,
  environmentPlatformLabel,
  type EnvironmentStatusPayload,
} from './diagnostics/environmentModel'

type CardId = DiagnosticSectionId | 'environment'

const CARD_ORDER: readonly CardId[] = [
  'runtime',
  'environment',
  'desktop',
  'paths',
  'config',
]

const METRICS: ReadonlyArray<{ id: CardId; label: string }> = [
  { id: 'runtime', label: '运行时' },
  { id: 'environment', label: '环境工具' },
  { id: 'paths', label: '存储路径' },
  { id: 'config', label: '配置' },
]

const ctx = useAppContext()
const diagnostics = ref<DiagnosticsPayload | null>(
  ctx.boot.value?.diagnostics || null,
)
const loading = ref(false)
const error = ref('')
const environment = ref<EnvironmentStatusPayload | null>(null)
const environmentLoading = ref(false)
const environmentError = ref('')
const openCards = reactive<Partial<Record<CardId, boolean>>>({})

const current = computed(
  () => diagnostics.value || ctx.boot.value?.diagnostics || null,
)
const sections = computed(() => diagnosticSections(current.value))
const environmentItems = computed(() =>
  environmentDiagnosticItems(environment.value),
)
const platform = computed(() =>
  environmentPlatformLabel(environment.value, environmentLoading.value),
)
const summary = computed(() =>
  diagnosticSummary(sections.value, environmentItems.value),
)
const rootPath = computed(() => current.value?.root || '')

const cards = computed(() =>
  CARD_ORDER.map((id) => {
    if (id === 'environment')
      return {
        id,
        title: '环境工具',
        count: summary.value.counts.environment,
        hidden: 0,
        rows: [] as DiagnosticRow[],
      }
    const section = sections.value.find((item) => item.id === id)
    return {
      id,
      title: section?.title ?? id,
      count: summary.value.counts[id],
      hidden: section?.hidden ?? 0,
      rows: section?.rows ?? [],
    }
  }),
)

const { copied, copy } = useCopyFeedback(
  () =>
    diagnosticReportText({
      root: rootPath.value,
      summary: summary.value,
      sections: sections.value,
      environment: environmentItems.value,
      environmentLabel: platform.value,
    }),
  1600,
)

useSettingsHeader({
  actions: () => [
    {
      id: 'copy-report',
      label: copied.value ? '已复制' : '复制报告',
      kind: 'secondary',
      icon: DsCopy,
      title: '复制诊断报告（纯文本）',
      onClick: () => copy(),
    },
    refreshAction(() => refresh(), {
      label: '刷新诊断',
      title: '刷新诊断并重新检测环境',
      busy: loading.value || environmentLoading.value,
    }),
  ],
})

onMounted(() => void refresh())

async function refresh() {
  await Promise.all([refreshDiagnostics(), refreshEnvironment()])
}

async function refreshDiagnostics() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    diagnostics.value = await core('diagnostics.get')
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function refreshEnvironment() {
  if (environmentLoading.value) return
  environmentLoading.value = true
  environmentError.value = ''
  try {
    environment.value = await core('environment.getStatus', {
      forceRefresh: true,
    })
  } catch (cause) {
    environmentError.value = messageOf(cause)
  } finally {
    environmentLoading.value = false
  }
}

async function reveal(target: string) {
  if (!target) return
  error.value = ''
  try {
    await openPath(target)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

/** Open the issue's card and bring it into view. */
async function focusIssue(issue: DiagnosticIssue) {
  openCards[issue.sectionId] = true
  await nextTick()
  document
    .querySelector(`[data-diagnostic-card="${issue.sectionId}"]`)
    ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function badgeTone(tone: DiagnosticTone | 'running') {
  if (tone === 'muted') return 'neutral' as const
  if (tone === 'running') return 'accent' as const
  return tone
}

function countTone(count: DiagnosticSectionCount) {
  return count.error ? 'error' : count.warn ? 'warn' : 'ok'
}

function countBadge(count: DiagnosticSectionCount): string {
  if (!count.total) return '无数据'
  if (count.error) return `${count.error} 项异常`
  if (count.warn) return `${count.warn} 项需关注`
  return '正常'
}

function cardDescription(
  id: CardId,
  count: DiagnosticSectionCount,
  hidden: number,
) {
  return [
    id === 'environment' ? platform.value : '',
    `${count.total} 项`,
    hidden ? `另有 ${hidden} 项未返回数据` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function openable(row: DiagnosticRow) {
  return Boolean(row.path) && OPENABLE_DIAGNOSTIC_PATHS.has(row.id)
}

function messageOf(cause: unknown): string {
  const value = cause as { message?: unknown }
  return typeof value?.message === 'string' ? value.message : String(cause)
}
</script>

<template>
  <SettingsSection>
    <template v-if="rootPath" #intro>
      运行根目录 ·
      <code class="intro-path" :title="rootPath">
        {{ shortenHomePaths(rootPath) }}
      </code>
    </template>

    <div v-if="error" class="diag-alert" role="alert">
      <DsWarning :size="16" class="alert-glyph" />
      <span><strong>诊断请求失败</strong> {{ error }}</span>
    </div>

    <section
      class="overview"
      :data-tone="summary.tone"
      aria-label="诊断概览"
      data-testid="diagnostics-overview"
    >
      <div class="overview-head">
        <span class="overview-dot" aria-hidden="true" />
        <h3 class="headline">{{ summary.headline }}</h3>
      </div>
      <div class="metrics">
        <Metric
          v-for="metric in METRICS"
          :key="metric.id"
          :label="metric.label"
          :value="`${summary.counts[metric.id].ok}/${summary.counts[metric.id].total}`"
          :tone="
            summary.counts[metric.id].total
              ? countTone(summary.counts[metric.id])
              : 'default'
          "
          :hint="countBadge(summary.counts[metric.id])"
        />
      </div>
      <ul v-if="summary.issues.length" class="issues" aria-label="需要关注">
        <li
          v-for="issue in summary.issues"
          :key="`${issue.sectionId}-${issue.id}`"
        >
          <button
            type="button"
            class="issue"
            :data-issue="issue.id"
            @click="focusIssue(issue)"
          >
            <StatusBadge :tone="issue.tone" dot class="issue-badge">
              {{ issue.value }}
            </StatusBadge>
            <span class="issue-label">{{ issue.label }}</span>
            <span class="issue-detail" :title="issue.detail">
              {{ issue.detail }}
            </span>
          </button>
        </li>
      </ul>
    </section>

    <div class="cards">
      <SettingsCard
        v-for="card in cards"
        :key="card.id"
        v-model:open="openCards[card.id]"
        expandable
        variant="outline"
        :title="card.title"
        :description="cardDescription(card.id, card.count, card.hidden)"
        :data-diagnostic-card="card.id"
      >
        <template #meta>
          <StatusBadge
            :tone="card.count.total ? countTone(card.count) : 'neutral'"
            dot
          >
            {{ countBadge(card.count) }}
          </StatusBadge>
        </template>

        <EnvironmentToolsGroup
          v-if="card.id === 'environment'"
          :status="environment"
          :loading="environmentLoading"
          :error="environmentError"
        />
        <div v-else class="rows">
          <SettingsRow
            v-for="row in card.rows"
            :key="row.id"
            dense
            :title="row.label"
            :data-row="row.id"
          >
            <template #description>
              <span class="detail" :title="row.path || row.detail">
                {{ row.detail }}
              </span>
            </template>
            <StatusBadge
              :tone="badgeTone(row.tone)"
              dot
              class="value"
              :title="row.value"
            >
              {{ row.value }}
            </StatusBadge>
            <IconButton
              v-if="openable(row)"
              :label="`打开${row.label}`"
              @click="reveal(row.path || '')"
            >
              <DsFolderOpen :size="16" />
            </IconButton>
          </SettingsRow>
          <p v-if="!card.rows.length" class="empty">
            Core 没有返回这一组的数据。
          </p>
        </div>
      </SettingsCard>
    </div>
  </SettingsSection>
</template>

<style scoped>
.intro-path {
  font: var(--font-code-small);
  overflow-wrap: anywhere;
}

.diag-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.alert-glyph {
  flex: none;
  margin-top: var(--space-0-5);
}

.overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-3-5) var(--space-4);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-3));
}

.overview[data-tone='warn'] {
  border-color: rgb(var(--state-warn) / 0.4);
}

.overview[data-tone='error'] {
  border-color: rgb(var(--state-error) / 0.45);
}

.overview-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.overview-dot {
  flex: none;
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-pill);
  background: rgb(var(--state-ok));
}

.overview[data-tone='warn'] .overview-dot {
  background: rgb(var(--state-warn));
}

.overview[data-tone='error'] .overview-dot {
  background: rgb(var(--state-error));
}

.headline {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.issues {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border-l2);
}

.issue {
  display: grid;
  grid-template-columns: auto minmax(0, max-content) minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--space-8);
  padding: var(--space-1) var(--space-1-5);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.issues li:first-child .issue {
  margin-top: var(--space-2);
}

.issue:hover {
  background: var(--interactive-bg-hover);
}

.issue:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.issue-badge {
  max-width: calc(var(--space-8) * 5);
}

.issue-label {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-primary));
  white-space: nowrap;
}

.issue-detail {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.rows {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* One or two lines of detail; the full text (or path) is the tooltip. */
.detail {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}

/* Right-aligned value badge: never wider than the control column. */
.value {
  max-width: calc(var(--space-8) * 6);
}

.empty {
  margin: 0;
  padding: var(--space-2) 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

@container settings-panel (max-width: 560px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .issue {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .issue-detail {
    grid-column: 1 / -1;
  }
}
</style>
