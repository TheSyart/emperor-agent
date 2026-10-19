<script setup lang="ts">
/**
 * Settings › 诊断 — a conclusion first, details on demand:
 * - a Notice on top only while a request failed (诊断请求失败,
 *   环境检测失败, or a folder that would not open);
 * - the overview card: the state as badges (「n 项异常」「n 项需要关注」, or
 *   「运行正常」) and one conclusion (「其余都正常」), then the rows that need
 *   attention, errors first; clicking one opens its card and scrolls to it.
 *   No number tiles;
 * - five collapsible cards (collapsed by default), all alike: 运行时,
 *   环境工具 (environment probe), 桌面, 存储路径 (the runtime root first)
 *   and 配置. A card shows a badge beside its title only while something in
 *   it needs attention; its line says how many rows it has (and how many
 *   Core returned no data for, left out). Rows are DiagnosticItems: the
 *   value as plain text, the why only where something needs attention;
 *   home paths read `~`.
 * Header actions: 刷新 (diagnostics + environment re-detection) and 复制报告
 * (plain-text report of the page).
 */
import EmptyState from '../ui/EmptyState.vue'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import IconButton from '../ui/IconButton.vue'
import { useCopyFeedback } from '../ui/useCopyFeedback'
import { DsCopy, DsFolderOpen, DsShieldAlert, DsWarning } from '../icons/ds'
import { SettingsCard, Notice, SettingsSection, Badge } from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { core } from '../../api/http'
import { openPath } from '../../api/backend'
import { useAppContext } from '../../composables/useAppContext'
import type { DiagnosticsPayload } from '../../types'
import DiagnosticItem from './diagnostics/DiagnosticItem.vue'
import EnvironmentToolsGroup from './diagnostics/EnvironmentToolsGroup.vue'
import {
  DIAGNOSTIC_SECTION_TITLES,
  OPENABLE_DIAGNOSTIC_PATHS,
  diagnosticCardDescription,
  diagnosticReportText,
  diagnosticSectionBadges,
  diagnosticSections,
  diagnosticSummary,
  type DiagnosticIssue,
  type DiagnosticRow,
  type DiagnosticSectionId,
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

const ctx = useAppContext()
const diagnostics = ref<DiagnosticsPayload | null>(
  ctx.boot.value?.diagnostics || null,
)
const loading = ref(false)
const error = ref('')
const revealError = ref('')
const environment = ref<EnvironmentStatusPayload | null>(null)
const environmentLoading = ref(false)
const environmentError = ref('')
const openCards = reactive<Partial<Record<CardId, boolean>>>({})

const current = computed(
  () => diagnostics.value || ctx.boot.value?.diagnostics || null,
)
const sections = computed(() =>
  diagnosticSections(current.value, {
    app: {
      service: ctx.runtimeText(),
      model:
        ctx.boot.value?.modelConfig?.current?.modelId ||
        ctx.boot.value?.model ||
        '',
      projects: ctx.boot.value?.projects?.length || 0,
    },
  }),
)
const environmentItems = computed(() =>
  environmentDiagnosticItems(environment.value),
)
const platform = computed(() =>
  environmentPlatformLabel(environment.value, environmentLoading.value),
)
const summary = computed(() =>
  diagnosticSummary(sections.value, environmentItems.value),
)

/** One notice per failed request, on top of the page. */
const notices = computed(() =>
  [
    { id: 'diagnostics', title: '诊断请求失败', detail: error.value },
    { id: 'reveal', title: '没能打开这个位置', detail: revealError.value },
    {
      id: 'environment',
      title: '环境检测失败',
      detail: environmentError.value,
    },
  ].filter((notice) => notice.detail),
)

const cards = computed(() =>
  CARD_ORDER.map((id) => {
    const count = summary.value.counts[id]
    if (id === 'environment')
      return {
        id,
        title: DIAGNOSTIC_SECTION_TITLES.environment,
        badges: diagnosticSectionBadges(count),
        description: diagnosticCardDescription({
          total: count.total,
          hidden: 0,
          prefix: platform.value,
        }),
        rows: [] as DiagnosticRow[],
      }
    const section = sections.value.find((item) => item.id === id)
    const rows = section?.rows ?? []
    return {
      id,
      title: section?.title ?? DIAGNOSTIC_SECTION_TITLES[id],
      badges: diagnosticSectionBadges(count),
      description: diagnosticCardDescription({
        total: count.total,
        hidden: section?.hidden ?? 0,
        runtimeRoot: rows.some((row) => row.id === 'runtime-root'),
      }),
      rows,
    }
  }),
)

const { copied, copy } = useCopyFeedback(
  () =>
    diagnosticReportText({
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
  revealError.value = ''
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

async function reveal(row: DiagnosticRow) {
  if (!openable(row)) return
  revealError.value = ''
  try {
    // Main asks Core where the row's folder is; no path crosses IPC.
    await openPath({
      kind: 'diagnostic',
      rowId: row.id as 'global-state-root' | 'active-project-path',
      sessionId: ctx.sessionId.value || null,
    })
  } catch (cause) {
    revealError.value = messageOf(cause)
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
    <Notice
      v-for="notice in notices"
      :key="notice.id"
      class="diag-notice"
      tone="error"
      :title="notice.title"
      :description="notice.detail"
    />

    <SettingsCard
      class="overview"
      role="region"
      aria-label="诊断概览"
      data-testid="diagnostics-overview"
      :data-tone="summary.tone"
    >
      <p class="summary">
        <Badge
          v-for="badge in summary.badges"
          :key="badge.text"
          :tone="badge.tone"
          :variant="badge.tone === 'ok' ? 'dot-label' : 'soft'"
          >{{ badge.text }}</Badge
        >
        <span class="conclusion">{{ summary.conclusion }}</span>
      </p>
      <ul v-if="summary.issues.length" class="issues" aria-label="需要关注">
        <li
          v-for="issue in summary.issues"
          :key="`${issue.sectionId}-${issue.id}`"
        >
          <button
            type="button"
            class="issue"
            :data-issue="issue.id"
            :data-tone="issue.tone"
            :title="issue.detail"
            @click="focusIssue(issue)"
          >
            <component
              :is="issue.tone === 'error' ? DsShieldAlert : DsWarning"
              :size="16"
              class="issue-glyph"
              aria-hidden="true"
            />
            <span class="issue-text">
              <span class="issue-where"
                >{{ issue.section }} · {{ issue.label }}</span
              >
              <span class="issue-what">{{ issue.value }}</span>
            </span>
            <span class="issue-go" aria-hidden="true">查看</span>
          </button>
        </li>
      </ul>
    </SettingsCard>

    <div class="cards">
      <SettingsCard
        v-for="card in cards"
        :key="card.id"
        v-model:open="openCards[card.id]"
        expandable
        :title="card.title"
        :description="card.description"
        :data-diagnostic-card="card.id"
      >
        <template v-if="card.badges.length" #meta>
          <Badge
            v-for="badge in card.badges"
            :key="badge.text"
            :tone="badge.tone"
            >{{ badge.text }}</Badge
          >
        </template>

        <EnvironmentToolsGroup
          v-if="card.id === 'environment'"
          :status="environment"
          :loading="environmentLoading"
          :error="environmentError"
        />
        <div v-else class="rows">
          <DiagnosticItem
            v-for="row in card.rows"
            :key="row.id"
            :row="row"
            :data-row="row.id"
          >
            <IconButton
              v-if="openable(row)"
              :label="`打开${row.label}`"
              @click="reveal(row)"
            >
              <DsFolderOpen :size="16" />
            </IconButton>
          </DiagnosticItem>
          <EmptyState
            v-if="!card.rows.length"
            variant="inline"
            title="Core 没有返回这一组的数据。"
          />
        </div>
      </SettingsCard>
    </div>
  </SettingsSection>
</template>

<style scoped>
.diag-notice + .diag-notice {
  margin-top: var(--space-2);
}

.overview:not(:first-child) {
  margin-top: var(--space-5);
}

.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
}

.conclusion {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.issues {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* A tinted row per issue; the whole row opens its card. */
.issue {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  width: 100%;
  padding: var(--space-2-5) var(--space-3);
  border: none;
  border-radius: var(--radius-cell);
  background: rgb(var(--state-warn-soft));
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.issue[data-tone='error'] {
  background: rgb(var(--state-error-soft));
}

.issue:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.issue-glyph {
  flex: none;
  color: rgb(var(--state-warn-label));
}

.issue[data-tone='error'] .issue-glyph {
  color: rgb(var(--state-error-label));
}

.issue-text {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 var(--space-2);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.issue-where {
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.issue-what {
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.issue-go {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--accent-strong));
}

.issue:hover .issue-go {
  text-decoration: underline;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  margin-top: var(--space-5);
}

.rows {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>
