<script setup lang="ts">
/**
 * 设置 › 用量与费用 (SET-01, preview D): what was spent and every limit on
 * spending, in one place. The main page: a range Segmented (今天 / 7 天 /
 * 30 天 / 全部), four tiles (花费, Token, 群聊, Claude Code、Codex), the
 * spend by source (Chat, Build, Group, 定时任务, Claude Code, Codex), then
 * - 费用上限: Emperor's model per task (the model policy's cap, moved from
 *   模型), Claude Code、Codex per task (moved from 子智能体), and 群聊,
 *   which has no cap of its own;
 * - 防失控: steps per answer (foreground / background), one external run's
 *   longest time, external runs per task, subagents at once and per task,
 *   and how often subagent results may wake a conversation (moved from 高级
 *   and 子智能体 › 高级);
 * - 明细: the sub pages Token 明细 (`page=tokens`, the former 用量 page,
 *   with its own 详细) and 按会话和群查看花费 (`page=sessions`).
 * Defaults (D19): no cost cap anywhere, Claude Code's turns unlimited; the
 * run-time, run-count, step and subagent limits stay. Every control saves at
 * once (useUsageCost).
 */
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  reactive,
  watch,
} from 'vue'
import { useSettingsPages } from './settingsHeader'
import { unpricedUnderCap } from './model/modelListModel'
import { modelEntryLabel } from './model/modelFormModel'
import {
  EmptyState,
  Metric,
  Segmented,
  Select,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
  TextField,
  refreshAction,
  settingsId,
  useSettingsHeader,
} from './ui'
import Button from '../ui/Button.vue'
import UsageSessionsPage from './usage/UsageSessionsPage.vue'
import {
  EXTERNAL_CAP_PRESETS,
  MODEL_CAP_PRESETS,
  USAGE_RANGE_OPTIONS,
  capOptions,
  capValue,
  overviewTiles,
  parseCap,
  sourceRows,
  timeoutOptions,
} from './usage/usageCostModel'
import { createUsageCost, type TaskBudgetKey } from './usage/useUsageCost'
import { useSkinExempt } from '../../skin/skinState'

/** BRD-05 (D8): a skin may not reach this zone. */
const exempt = useSkinExempt()

const TokensSection = defineAsyncComponent(() => import('./TokensSection.vue'))

const { page, open: openPage } = useSettingsPages({
  tokens: 'Token 明细',
  // TokensSection's own sub page: declared here too so a link to it opens.
  details: '详细',
  sessions: '按会话和群查看花费',
})
const u = createUsageCost()
const uid = settingsId('usage-cost')

type NumberKey = TaskBudgetKey | 'maxRunsPerTask'
/** The number fields of 防失控, with their ranges (Core checks again). */
const NUMBER_FIELDS: Record<
  NumberKey,
  { label: string; min: number; max: number }
> = {
  maxSteps: { label: '前台每次回答最多步数', min: 1, max: 10_000 },
  maxBackgroundSteps: { label: '后台每次回答最多步数', min: 1, max: 10_000 },
  maxRunsPerTask: { label: '每个任务最多启动外部运行', min: 1, max: 32 },
  maxActiveAgents: { label: '同时运行的子智能体', min: 1, max: 64 },
  maxTotalAgents: { label: '每个任务最多启动的子智能体', min: 1, max: 1_000 },
  maxNoticeWakes: { label: '子智能体结果最多唤醒次数', min: 0, max: 1_000 },
}
/** Title, description and unit of the single-number rows of 防失控. */
const ROW_TEXT = {
  maxRunsPerTask: {
    title: '每个任务最多启动外部运行',
    description: '一个任务里最多请 Claude Code、Codex 跑几次',
    unit: '次',
  },
  maxActiveAgents: {
    title: '同时运行的子智能体',
    description: '本地子智能体；Claude Code、Codex 各自另算',
    unit: '',
  },
  maxTotalAgents: {
    title: '每个任务最多启动的子智能体',
    description: '一个任务里一共能启动多少个本地子智能体',
    unit: '',
  },
  maxNoticeWakes: {
    title: '子智能体结果最多唤醒次数',
    description: '对话停下后，子智能体的结果最多几次自动叫醒它',
    unit: '次',
  },
} as const
const SINGLE_ROWS = [
  'maxRunsPerTask',
  'maxActiveAgents',
  'maxTotalAgents',
  'maxNoticeWakes',
] as const
const drafts = reactive<Record<NumberKey, string>>({
  maxSteps: '',
  maxBackgroundSteps: '',
  maxRunsPerTask: '',
  maxActiveAgents: '',
  maxTotalAgents: '',
  maxNoticeWakes: '',
})
const fieldError = reactive({ text: '' })

function savedNumber(key: NumberKey): number | undefined {
  if (key === 'maxRunsPerTask') return u.executors.value?.limits.maxRunsPerTask
  return u.budget.value?.[key]
}

watch(
  [u.budget, u.executors],
  () => {
    for (const key of Object.keys(NUMBER_FIELDS) as NumberKey[]) {
      const value = savedNumber(key)
      drafts[key] = value === undefined ? '' : String(value)
    }
  },
  { immediate: true },
)

/** A number input may hand back a number: keep the draft as text. */
function setDraft(key: NumberKey, value: unknown) {
  drafts[key] = String(value ?? '')
}

/** Save one number when its field is left (or Enter). */
async function commitNumber(key: NumberKey): Promise<void> {
  const saved = savedNumber(key)
  if (saved === undefined) return
  const text = String(drafts[key]).trim()
  const value = Number(text)
  const field = NUMBER_FIELDS[key]
  if (
    text === '' ||
    !Number.isInteger(value) ||
    value < field.min ||
    value > field.max
  ) {
    fieldError.text = `${field.label}必须是 ${field.min}–${field.max} 之间的整数`
    await nextTick()
    drafts[key] = String(saved)
    return
  }
  fieldError.text = ''
  if (value === saved) return
  if (key === 'maxRunsPerTask')
    await u.changeExecutors((draft) => {
      draft.limits.maxRunsPerTask = value
    })
  else await u.setBudget(key, value)
  if (savedNumber(key) !== value) drafts[key] = String(savedNumber(key) ?? '')
}

const tiles = computed(() =>
  u.summary.value ? overviewTiles(u.summary.value) : [],
)
const sources = computed(() =>
  u.summary.value ? sourceRows(u.summary.value) : [],
)
const updated = computed(() =>
  u.generatedAt.value
    ? `更新于 ${u.generatedAt.value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : '',
)

const modelCap = computed(
  () => u.model.value?.policy?.cost.maxUsdPerAgentTurn ?? null,
)
const modelCapOptions = computed(() =>
  capOptions(MODEL_CAP_PRESETS, modelCap.value),
)
const unpriced = computed(() =>
  u.model.value ? unpricedUnderCap(u.model.value).map(modelEntryLabel) : [],
)
const externalCap = computed(
  () => u.executors.value?.limits.estimatedBudgetUsd ?? null,
)
const externalCapOptions = computed(() =>
  capOptions(EXTERNAL_CAP_PRESETS, externalCap.value),
)
const runTimeoutOptions = computed(() =>
  timeoutOptions(u.executors.value?.limits.runTimeoutMs),
)
const runTimeout = computed(() =>
  String(Math.round((u.executors.value?.limits.runTimeoutMs ?? 0) / 60_000)),
)
const claudeTurns = computed(() => u.executors.value?.limits.claudeMaxTurns)

function setModelCap(value: string | null | undefined) {
  const cap = parseCap(value)
  if (cap !== undefined) void u.setModelCap(cap)
}
function setExternalCap(value: string | null | undefined) {
  const cap = parseCap(value)
  if (cap === undefined || (cap !== null && cap > 1000)) return
  void u.changeExecutors((draft) => {
    draft.limits.estimatedBudgetUsd = cap
  })
}
function setRunTimeout(value: string | null | undefined) {
  const minutes = Number(value)
  if (!(minutes >= 1 && minutes <= 120)) return
  void u.changeExecutors((draft) => {
    draft.limits.runTimeoutMs = minutes * 60_000
  })
}
/** A turn cap saved before 0.3 made it unlimited (SET-01): clear it. */
function clearClaudeTurns() {
  void u.changeExecutors((draft) => {
    delete draft.limits.claudeMaxTurns
  })
}

watch(u.range, () => void u.loadSummary())

useSettingsHeader({
  actions: () =>
    page.value === 'tokens' || page.value === 'details'
      ? []
      : [
          refreshAction(() => u.load(), {
            title: '刷新用量与费用',
            busy: u.loadingSummary.value,
          }),
        ],
})

onMounted(() => void u.load())
</script>

<template>
  <TokensSection
    v-if="page === 'tokens' || page === 'details'"
    :style="exempt"
  />
  <UsageSessionsPage
    v-else-if="page === 'sessions'"
    :style="exempt"
    :usage="u"
    @range="u.range.value = $event"
  />
  <SettingsSection v-else :style="exempt">
    <div class="usage-cost" data-testid="usage-cost">
      <div class="toolbar">
        <span class="updated">{{ updated }}</span>
        <Segmented
          v-model="u.range.value"
          :options="USAGE_RANGE_OPTIONS"
          aria-label="统计范围"
        />
      </div>

      <div class="metrics" data-testid="usage-metrics">
        <template v-if="tiles.length">
          <Metric
            v-for="tile in tiles"
            :key="tile.key"
            :label="tile.label"
            :value="tile.value"
            :hint="tile.hint"
            :data-metric="tile.key"
          />
        </template>
        <template v-else>
          <Metric v-for="n in 4" :key="n" label="…" />
        </template>
      </div>

      <SettingsGroup title="按来源" variant="stack" data-testid="usage-sources">
        <ul v-if="sources.length" class="bars" aria-label="按来源的花费">
          <li
            v-for="row in sources"
            :key="row.key"
            class="bar"
            :data-source="row.key"
          >
            <span class="name"
              ><i class="swatch" :style="{ background: row.color }" />{{
                row.label
              }}</span
            >
            <span class="track" aria-hidden="true"
              ><i :style="{ width: `${row.width}%`, background: row.color }"
            /></span>
            <span
              class="value"
              :title="row.partial ? '部分调用缺少单价，实际更多' : undefined"
              >{{ row.value }}{{ row.partial ? ' 起' : '' }}</span
            >
          </li>
        </ul>
        <EmptyState
          v-else-if="u.summary.value"
          title="这段时间没有花费"
          description="发出消息、运行定时任务或子智能体后，这里按来源显示花费。"
        />
      </SettingsGroup>

      <SettingsGroup
        title="费用上限"
        description="花到上限就停下这一个任务。默认都不限制，只显示花了多少。"
        data-testid="usage-caps"
      >
        <SettingsRow title="Emperor 的模型 · 每个任务">
          <template #description>
            <span
              >一个任务 =
              你发一条消息引出的全部工作，含它启动的本地子智能体</span
            >
            <span
              v-for="name in unpriced"
              :key="name"
              class="warn"
              data-unpriced
              >「{{ name }}」没有单价，费用上限对它不生效</span
            >
          </template>
          <Select
            :model-value="capValue(modelCap)"
            :options="modelCapOptions"
            size="sm"
            data-model-cap
            aria-label="Emperor 的模型每个任务的费用上限"
            :disabled="u.busy.value || !u.model.value"
            @update:model-value="setModelCap"
          />
        </SettingsRow>
        <SettingsRow
          title="Claude Code、Codex · 每个任务"
          description="按 API 计费时的估算；用订阅额度时不计费用"
        >
          <Select
            :model-value="capValue(externalCap)"
            :options="externalCapOptions"
            size="sm"
            data-external-cap
            aria-label="Claude Code、Codex 每个任务的费用上限"
            :disabled="u.busy.value || !u.executors.value"
            @update:model-value="setExternalCap"
          />
        </SettingsRow>
        <SettingsRow
          title="群聊"
          description="群聊没有本轮额度：不限发言次数、轮数和费用。群里每位成员的每次发言单独按上面两行计算"
        >
          <span class="fixed">不设上限</span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="防失控"
        description="这些不是费用，是防止一次回答卡住、无休止地调用工具。在群聊里，按每位成员的每次发言单独计算。"
        data-testid="usage-guards"
      >
        <SettingsRow
          title="一次回答最多调用工具"
          description="一次模型请求加它调用的工具算一步。达到后这次回答停下，并告诉 agent 和你"
        >
          <div class="pair">
            <label class="lab" :for="`${uid}-steps`">前台</label>
            <TextField
              :id="`${uid}-steps`"
              :model-value="drafts.maxSteps"
              @update:model-value="setDraft('maxSteps', $event)"
              class="num"
              type="number"
              min="1"
              size="sm"
              data-budget="maxSteps"
              :disabled="u.busy.value || !u.budget.value"
              @change="commitNumber('maxSteps')"
              @keydown.enter="commitNumber('maxSteps')"
            />
            <label class="lab" :for="`${uid}-bg-steps`">后台</label>
            <TextField
              :id="`${uid}-bg-steps`"
              :model-value="drafts.maxBackgroundSteps"
              @update:model-value="setDraft('maxBackgroundSteps', $event)"
              class="num"
              type="number"
              min="1"
              size="sm"
              data-budget="maxBackgroundSteps"
              :disabled="u.busy.value || !u.budget.value"
              @change="commitNumber('maxBackgroundSteps')"
              @keydown.enter="commitNumber('maxBackgroundSteps')"
            />
          </div>
        </SettingsRow>
        <SettingsRow title="Claude Code、Codex 每次运行">
          <template #description>
            <span v-if="claudeTurns"
              >最长时长；Claude Code 每次运行最多 {{ claudeTurns }} 轮（0.3
              起默认不限制）</span
            >
            <span v-else>最长时长；Claude Code 每次运行的轮数不限制</span>
          </template>
          <div class="pair">
            <Button
              v-if="claudeTurns"
              size="sm"
              data-clear-turns
              :disabled="u.busy.value"
              @click="clearClaudeTurns"
              >轮数改为不限制</Button
            >
            <Select
              :model-value="runTimeout"
              :options="runTimeoutOptions"
              size="sm"
              data-run-timeout
              aria-label="Claude Code、Codex 每次运行的最长时长"
              :disabled="u.busy.value || !u.executors.value"
              @update:model-value="setRunTimeout"
            />
          </div>
        </SettingsRow>
        <SettingsRow
          v-for="key in SINGLE_ROWS"
          :key="key"
          :title="ROW_TEXT[key].title"
          :description="ROW_TEXT[key].description"
          :label-for="`${uid}-${key}`"
        >
          <TextField
            :id="`${uid}-${key}`"
            :model-value="drafts[key]"
            @update:model-value="setDraft(key, $event)"
            class="num"
            type="number"
            :min="String(NUMBER_FIELDS[key].min)"
            :max="String(NUMBER_FIELDS[key].max)"
            size="sm"
            :data-budget="key"
            :disabled="u.busy.value || savedNumber(key) === undefined"
            @change="commitNumber(key)"
            @keydown.enter="commitNumber(key)"
          >
            <template v-if="ROW_TEXT[key].unit" #trailing
              ><span class="unit">{{ ROW_TEXT[key].unit }}</span></template
            >
          </TextField>
        </SettingsRow>
        <p v-if="fieldError.text" class="error" role="alert">
          {{ fieldError.text }}
        </p>
      </SettingsGroup>

      <SettingsGroup title="明细">
        <SettingsLinkRow
          title="Token 明细"
          description="趋势、模型排行、缓存、活跃度"
          data-testid="usage-tokens-link"
          @click="openPage('tokens')"
        />
        <SettingsLinkRow
          title="按会话和群查看花费"
          description="哪个会话、哪个群花得最多"
          data-testid="usage-sessions-link"
          @click="openPage('sessions')"
        />
      </SettingsGroup>

      <p v-if="u.error.value" class="error" role="alert">{{ u.error.value }}</p>
    </div>
  </SettingsSection>
</template>

<style scoped>
.usage-cost {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.updated {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--text-3));
  font-variant-numeric: tabular-nums;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}

.bars {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  list-style: none;
  border-radius: var(--radius-row);
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.bar {
  display: grid;
  grid-template-columns: minmax(0, 7.5rem) minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: rgb(var(--text-1));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.swatch {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.track {
  height: 6px;
  border-radius: 999px;
  background: rgb(var(--text-1) / 0.06);
  overflow: hidden;
}

.track i {
  display: block;
  height: 100%;
  border-radius: 999px;
}

.value {
  min-width: 4.5rem;
  text-align: right;
  color: rgb(var(--text-1));
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.warn {
  display: block;
  color: rgb(var(--state-warn-label));
}

.fixed {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.pair {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.lab {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.num {
  width: calc(var(--space-8) * 2.5);
}

.unit {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.error {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}

@media (max-width: 720px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
