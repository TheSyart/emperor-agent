<script setup lang="ts">
/**
 * Settings › 高级 — settings most people leave alone (UI-S07): 网络工具 on
 * the main page, and rows into the sub pages Hooks (`page=hooks`,
 * HooksSection), 诊断 (`page=diagnostics`, DiagnosticsSection) and 存储
 * (`page=storage`, StorageSection, KRN-12), which bring their own header
 * actions. Old `?settings=hooks|diagnostics` links land on those sub pages
 * (settingsAlias).
 *
 * 网络工具 (KRN-08, settings.json › webTools): the Agent's two web tools.
 * - 网页读取 (`web_fetch`): public pages as Markdown through main's public
 *   HTTP client; on by default.
 * - 网页搜索 (`web_search`): DeepSeek's official Search API, so it follows
 *   the current model — off and disabled, with the reason, on any other
 *   provider.
 * Switching one off takes the tool out of the Agent's tool list and out of
 * 能力 › 工具: after a change the bootstrap tool list (what that page shows)
 * is reloaded. A failed save leaves the switch where it was and says why.
 *
 * 任务预算 (KRN-03, settings.json › taskBudget): what one task — a message
 * and everything it starts — may take: steps per turn (conversations, and
 * scheduled runs / goal rounds), subagents at once, subagents per task, and
 * how often subagent results may wake an idle conversation. A field saves
 * when it is left or Enter is pressed; a value out of range goes back and
 * says the range. The cost cap stays in 设置 › 模型.
 */
import type { CoreOperationResult } from '@emperor/core/api'
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  reactive,
  ref,
} from 'vue'
import TextField from '../ui/TextField.vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { useSettingsPages } from './settingsHeader'
import {
  refreshAction,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
  Switch,
  useSettingsHeader,
} from './ui'

const HooksSection = defineAsyncComponent(() => import('./HooksSection.vue'))
const DiagnosticsSection = defineAsyncComponent(
  () => import('./DiagnosticsSection.vue'),
)
const StorageSection = defineAsyncComponent(
  () => import('./StorageSection.vue'),
)

type NetworkTools = CoreOperationResult<'tools.networkSettings'>
type Tool = 'webFetch' | 'webSearch'
type TaskBudget = CoreOperationResult<'tasks.budget'>
type BudgetKey = keyof TaskBudget

/** Each budget's label and range (core checks them again). */
const BUDGET_FIELDS: Record<
  BudgetKey,
  { label: string; min: number; max: number }
> = {
  maxSteps: { label: '对话每轮最多步数', min: 1, max: 10_000 },
  maxBackgroundSteps: {
    label: '定时任务与目标每轮最多步数',
    min: 1,
    max: 10_000,
  },
  maxActiveAgents: { label: '同时运行的子智能体', min: 1, max: 64 },
  maxTotalAgents: { label: '每个任务最多启动的子智能体', min: 1, max: 1_000 },
  maxNoticeWakes: { label: '子智能体结果最多唤醒次数', min: 0, max: 1_000 },
}

const ctx = useAppContext()
const { page, open: openPage } = useSettingsPages({
  hooks: 'Hooks',
  diagnostics: '诊断',
  storage: '存储',
})
const status = ref<NetworkTools | null>(null)
const busy = ref<Tool | null>(null)
const error = ref('')
const budget = ref<TaskBudget | null>(null)
const budgetDrafts = reactive<Record<BudgetKey, string>>({
  maxSteps: '',
  maxBackgroundSteps: '',
  maxActiveAgents: '',
  maxTotalAgents: '',
  maxNoticeWakes: '',
})
const budgetBusy = ref(false)
const budgetError = ref('')

const fetchAvailable = computed(() => status.value?.webFetch.available === true)
const fetchOn = computed(
  () => fetchAvailable.value && status.value?.webFetch.enabled === true,
)
const searchAvailable = computed(
  () => status.value?.webSearch.available === true,
)
const searchOn = computed(
  () => searchAvailable.value && status.value?.webSearch.enabled === true,
)

const fetchDescription = computed(() =>
  status.value && !fetchAvailable.value
    ? '当前运行环境没有可用的网络客户端。'
    : 'Agent 用 web_fetch 读取公开网页，转成 Markdown 后交给模型。不带 Cookie 和登录状态，拒绝本机与内网地址，单页最多读取 10 MB；网页内容按不可信内容处理。',
)

const searchDescription = computed(() => {
  const search = status.value?.webSearch
  if (!search) return ''
  if (!search.available)
    return `需要模型使用 DeepSeek 官方 API（api.deepseek.com）才能搜索${
      search.model ? `；当前模型「${search.model}」不提供` : ''
    }。`
  if (search.provider === 'deepseek')
    return 'Agent 用 web_search 通过 DeepSeek 官方 Search API 搜索，使用当前模型的 API Key，按次计费；切换到其他供应商的模型时自动停用。'
  return 'Agent 用 web_search 通过应用提供的搜索服务查找网页。'
})

async function load(): Promise<void> {
  await Promise.all([loadNetwork(), loadBudget()])
}

async function loadNetwork(): Promise<void> {
  try {
    status.value = await core('tools.networkSettings')
    error.value = ''
  } catch (cause) {
    error.value = `读取网络工具设置失败：${message(cause)}`
  }
}

async function loadBudget(): Promise<void> {
  try {
    const loaded = await core('tasks.budget')
    if (typeof loaded?.maxSteps === 'number') showBudget(loaded)
    budgetError.value = ''
  } catch (cause) {
    budgetError.value = `读取任务预算失败：${message(cause)}`
  }
}

function showBudget(value: TaskBudget): void {
  budget.value = value
  for (const key of Object.keys(BUDGET_FIELDS) as BudgetKey[])
    budgetDrafts[key] = String(value[key])
}

/** Save one budget when its field is left (or Enter): at once, no 保存. */
async function commitBudget(key: BudgetKey): Promise<void> {
  const current = budget.value
  if (current === null || budgetBusy.value) return
  // A number input's v-model may hand back a number.
  const text = String(budgetDrafts[key]).trim()
  const value = Number(text)
  const field = BUDGET_FIELDS[key]
  if (
    text === '' ||
    !Number.isInteger(value) ||
    value < field.min ||
    value > field.max
  ) {
    budgetError.value = `${field.label}必须是 ${field.min}–${field.max} 之间的整数`
    await revertDraft(key, current[key])
    return
  }
  if (value === current[key]) {
    budgetDrafts[key] = String(value)
    return
  }
  budgetBusy.value = true
  try {
    showBudget(await core('tasks.setBudget', { [key]: value }))
    budgetError.value = ''
  } catch (cause) {
    budgetError.value = `保存失败：${message(cause)}`
    await revertDraft(key, current[key])
  } finally {
    budgetBusy.value = false
  }
}

/**
 * Put a field back to its saved value. The typed value renders first: the
 * field would otherwise keep showing it (its model did not change).
 */
async function revertDraft(key: BudgetKey, value: number): Promise<void> {
  await nextTick()
  budgetDrafts[key] = String(value)
}

async function set(tool: Tool, enabled: boolean): Promise<void> {
  if (busy.value !== null || !status.value) return
  busy.value = tool
  try {
    status.value = await core('tools.setNetworkSettings', { [tool]: enabled })
    error.value = ''
    await reloadTools()
  } catch (cause) {
    error.value = `保存失败：${message(cause)}`
  } finally {
    busy.value = null
  }
}

/** 能力 › 工具 reads the bootstrap list. */
async function reloadTools(): Promise<void> {
  try {
    const tools = await core('skills.tools')
    if (ctx.boot.value) ctx.boot.value.tools = tools
  } catch {
    // The page reloads its list when it is opened again.
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// A sub page brings its own actions.
useSettingsHeader({
  actions: () =>
    page.value === null
      ? [refreshAction(() => load(), { label: '刷新网络工具与任务预算' })]
      : [],
})

onMounted(() => void load())
</script>

<template>
  <HooksSection v-if="page === 'hooks'" />
  <DiagnosticsSection v-else-if="page === 'diagnostics'" />
  <StorageSection v-else-if="page === 'storage'" />
  <SettingsSection v-else>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <SettingsGroup
      title="网络工具"
      description="关闭后，对应工具不再出现在 Agent 的工具列表和「能力 › 工具」里。"
      data-group="network-tools"
    >
      <SettingsRow
        title="网页读取"
        :description="fetchDescription"
        label-for="web-tools-fetch"
      >
        <Switch
          id="web-tools-fetch"
          data-tool="web_fetch"
          :model-value="fetchOn"
          :disabled="!fetchAvailable || busy !== null"
          @update:model-value="(value: boolean) => set('webFetch', value)"
        />
      </SettingsRow>
      <SettingsRow
        title="网页搜索"
        :description="searchDescription"
        label-for="web-tools-search"
      >
        <Switch
          id="web-tools-search"
          data-tool="web_search"
          :model-value="searchOn"
          :disabled="!searchAvailable || busy !== null"
          @update:model-value="(value: boolean) => set('webSearch', value)"
        />
      </SettingsRow>
    </SettingsGroup>
    <p v-if="budgetError" class="error" role="alert">{{ budgetError }}</p>
    <SettingsGroup
      v-if="budget"
      title="任务预算"
      description="一个任务从你发出一条消息开始，包括它启动的全部子智能体与后台任务。费用上限在「模型」里设置，同样按整个任务计算（含子智能体与失败的请求）。"
      data-group="task-budget"
    >
      <SettingsRow
        title="每轮最多步数"
        description="一次模型请求加上它调用的工具算一步。达到后本轮停止，并告诉 Agent 和你。"
      >
        <div class="budget-pair">
          <label class="budget-label" for="task-budget-steps">对话</label>
          <TextField
            id="task-budget-steps"
            v-model="budgetDrafts.maxSteps"
            class="budget-field"
            data-budget="maxSteps"
            type="number"
            min="1"
            inputmode="numeric"
            size="sm"
            :disabled="budgetBusy"
            @change="commitBudget('maxSteps')"
            @keydown.enter="commitBudget('maxSteps')"
          />
          <label class="budget-label" for="task-budget-background-steps"
            >定时任务与目标</label
          >
          <TextField
            id="task-budget-background-steps"
            v-model="budgetDrafts.maxBackgroundSteps"
            class="budget-field"
            data-budget="maxBackgroundSteps"
            type="number"
            min="1"
            inputmode="numeric"
            size="sm"
            :disabled="budgetBusy"
            @change="commitBudget('maxBackgroundSteps')"
            @keydown.enter="commitBudget('maxBackgroundSteps')"
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="同时运行的子智能体"
        description="更多的子智能体排队，等有空位再开始。"
        label-for="task-budget-active"
      >
        <TextField
          id="task-budget-active"
          v-model="budgetDrafts.maxActiveAgents"
          class="budget-field"
          data-budget="maxActiveAgents"
          type="number"
          min="1"
          inputmode="numeric"
          size="sm"
          :disabled="budgetBusy"
          @change="commitBudget('maxActiveAgents')"
          @keydown.enter="commitBudget('maxActiveAgents')"
        />
      </SettingsRow>
      <SettingsRow
        title="每个任务最多启动的子智能体"
        description="超过后，再启动子智能体会被拒绝。"
        label-for="task-budget-total"
      >
        <TextField
          id="task-budget-total"
          v-model="budgetDrafts.maxTotalAgents"
          class="budget-field"
          data-budget="maxTotalAgents"
          type="number"
          min="1"
          inputmode="numeric"
          size="sm"
          :disabled="budgetBusy"
          @change="commitBudget('maxTotalAgents')"
          @keydown.enter="commitBudget('maxTotalAgents')"
        />
      </SettingsRow>
      <SettingsRow
        title="子智能体结果最多唤醒次数"
        description="对话空闲时，子智能体的结果会唤醒它继续。超过次数后，结果留到下一步再读。"
        label-for="task-budget-wakes"
      >
        <TextField
          id="task-budget-wakes"
          v-model="budgetDrafts.maxNoticeWakes"
          class="budget-field"
          data-budget="maxNoticeWakes"
          type="number"
          min="0"
          inputmode="numeric"
          size="sm"
          :disabled="budgetBusy"
          @change="commitBudget('maxNoticeWakes')"
          @keydown.enter="commitBudget('maxNoticeWakes')"
        />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="自动化与排查" data-group="advanced-pages">
      <SettingsLinkRow
        title="Hooks"
        description="在指定事件发生时自动运行命令：编辑 hooks.json、测试匹配、查看运行记录"
        data-advanced-page="hooks"
        @click="openPage('hooks')"
      />
      <SettingsLinkRow
        title="诊断"
        description="运行时、环境、存储路径与配置的状态；出问题时复制报告"
        data-advanced-page="diagnostics"
        @click="openPage('diagnostics')"
      />
      <SettingsLinkRow
        title="存储"
        description="会话、附件、溢出文件等各占多少磁盘空间；清理不再需要的文件"
        data-advanced-page="storage"
        @click="openPage('storage')"
      />
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.error {
  margin: 0 0 var(--space-3);
  font: var(--font-sm);
  color: rgb(var(--state-error-label));
}

.budget-pair {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.budget-label {
  font: var(--font-xs);
  color: rgb(var(--text-2));
  white-space: nowrap;
}

.budget-field {
  width: calc(var(--space-8) * 2.5);
}
</style>
