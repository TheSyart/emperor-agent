<script setup lang="ts">
import {
  Bot,
  CircleDot,
  GitBranch,
  GitCompareArrows,
  GitCommitHorizontal,
  GitPullRequest,
  Image,
  MonitorCog,
  RefreshCw,
  ScrollText,
  Square,
  Target,
  TerminalSquare,
  Workflow,
} from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { core } from '../../api/http'
import type { RuntimeTaskRecord } from '../../types'
import type { WorkspaceSnapshot, WorkspaceSource } from './workspaceTypes'
import { isGitStatus } from './workspaceTypes'
import {
  environmentSubagentGroups,
  subagentStatusTone,
} from './environmentModel'

const props = defineProps<{
  snapshot: WorkspaceSnapshot | null
  sources: WorkspaceSource[]
  loading: boolean
  error: string
  hasProject: boolean
}>()

defineEmits<{
  refresh: []
  openPane: [pane: 'review' | 'terminal' | 'files' | 'browser']
}>()

const tasks = ref<RuntimeTaskRecord[]>([])
const taskBusy = ref('')
const transcripts = ref<Record<string, string>>({})
const taskErrors = ref<Record<string, string>>({})

const git = computed(() =>
  isGitStatus(props.snapshot?.git) ? props.snapshot?.git : null,
)
const changedLines = computed(() => {
  return {
    additions: git.value?.summary?.additions ?? 0,
    deletions: git.value?.summary?.deletions ?? 0,
  }
})
const activeWorktree = computed(
  () => props.snapshot?.worktrees?.owned?.find((entry) => entry.active) ?? null,
)
const latestReceipt = computed(
  () => props.snapshot?.gitReceipts?.at(-1) ?? null,
)
const latestPullRequest = computed(() => {
  const receipts = props.snapshot?.gitReceipts ?? []
  return [...receipts].reverse().find((receipt) => receipt.pullRequest) ?? null
})
const subagentTasks = computed(() =>
  tasks.value
    .filter((task) => task.kind === 'subagent')
    .map((task) => ({
      ...task,
      title: task.description || task.label,
      ended_at: task.finished_at,
      status: taskStatus(task.status),
    })),
)
const jobTasks = computed(() =>
  tasks.value.filter((task) => task.kind === 'job'),
)
const workflowTasks = computed(() =>
  tasks.value.filter((task) => task.kind === 'workflow'),
)
const subagentGroups = computed(() =>
  environmentSubagentGroups(subagentTasks.value),
)

watch(
  () => [props.snapshot?.sessionId, props.snapshot?.capturedAt] as const,
  ([sessionId]) => void loadTasks(sessionId || ''),
  { immediate: true },
)

async function loadTasks(sessionId: string): Promise<void> {
  if (!sessionId) {
    tasks.value = []
    return
  }
  try {
    tasks.value = await core('tasks.list', { sessionId })
  } catch {
    // The environment pane stays usable when the task list is unavailable.
    tasks.value = []
  }
}

/** Kernel statuses (`completed` / `failed` / `killed` / stop reasons) → pane tones. */
function taskStatus(value: string): string {
  if (value === 'running' || value === 'completed' || value === 'failed')
    return value
  if (value === 'killed' || value === 'interrupted' || value === 'aborted')
    return 'cancelled'
  if (value === 'end_turn' || value === 'done' || value === 'stop')
    return 'completed'
  return value || 'running'
}

function subagentStatusLabel(value: unknown): string {
  const status = recordText(value, 'status')
  if (status === 'running') return '运行中'
  if (status === 'queued' || status === 'pending') return '等待中'
  if (status === 'completed') return '完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'interrupted') return '已中断'
  return status === 'failed' || status === 'error' ? '失败' : status
}

/** Workflow-run statuses (`running` / `completed` / `cancelled` / `error` / `interrupted`). */
function workflowStatusLabel(status: string): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'interrupted') return '已中断'
  return status === 'error' ? '失败' : status
}

function workflowSummary(task: RuntimeTaskRecord): string {
  const rounds = Number(task.rounds ?? 0)
  const unit = task.workflow_tool === 'ralph' ? '轮' : '个代理'
  return [
    task.workflow_tool === 'ralph' ? 'ralph' : 'workflow',
    `${rounds} ${unit}`,
    task.status === 'running' ? task.current_phase || '' : '',
    durationLabel(task),
  ]
    .filter(Boolean)
    .join(' · ')
}

function recordText(value: unknown, key: string): string {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Record<string, unknown>)[key] ?? '')
    : ''
}

function durationLabel(task: RuntimeTaskRecord): string {
  const startedAt = timestampMs(Number(task.started_at || 0))
  if (!startedAt) return ''
  const endedAt =
    timestampMs(Number(task.finished_at || 0)) ||
    props.snapshot?.capturedAt ||
    startedAt
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function timestampMs(value: number): number {
  if (!value) return 0
  return value < 1_000_000_000_000 ? value * 1000 : value
}

async function toggleTranscript(taskId: string): Promise<void> {
  if (!taskId) return
  if (transcripts.value[taskId] !== undefined) {
    const next = { ...transcripts.value }
    delete next[taskId]
    transcripts.value = next
    return
  }
  try {
    const result = await core('tasks.transcript', taskId, { limit: 200 })
    transcripts.value = {
      ...transcripts.value,
      [taskId]: result.entries
        .map((entry) =>
          entry.role === 'output'
            ? entry.content
            : `${entry.role}: ${entry.content}`,
        )
        .join('\n\n')
        .slice(-8_000),
    }
  } catch (cause) {
    transcripts.value = {
      ...transcripts.value,
      [taskId]: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

async function cancelTask(taskId: string): Promise<void> {
  if (!taskId) return
  taskBusy.value = taskId
  const next = { ...taskErrors.value }
  delete next[taskId]
  taskErrors.value = next
  try {
    await core('tasks.cancel', taskId, {})
    await loadTasks(props.snapshot?.sessionId || '')
  } catch (cause) {
    taskErrors.value = {
      ...taskErrors.value,
      [taskId]: cause instanceof Error ? cause.message : String(cause),
    }
  } finally {
    taskBusy.value = ''
  }
}
</script>

<template>
  <div class="workspace-pane environment-pane">
    <div class="workspace-pane-heading">
      <div>
        <strong>Environment</strong>
        <span v-if="snapshot?.project.name" class="workspace-eyebrow">{{
          snapshot.project.name
        }}</span>
      </div>
      <button
        type="button"
        class="workspace-icon-button"
        aria-label="刷新环境信息"
        :disabled="loading"
        @click="$emit('refresh')"
      >
        <RefreshCw :size="15" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <div v-if="!hasProject" class="workspace-empty-state">
      当前会话未绑定项目
    </div>
    <div v-else-if="error" class="workspace-inline-error">{{ error }}</div>

    <template v-if="snapshot">
      <section class="workspace-section environment-git-section">
        <div v-if="git" class="workspace-list">
          <button
            type="button"
            class="workspace-list-row environment-action-row"
            @click="$emit('openPane', 'review')"
          >
            <GitCommitHorizontal :size="15" />
            <span>Changes</span>
            <span class="workspace-row-value change-count">
              <em>{{ git.summary.changedFiles }}</em>
              <b>+{{ changedLines.additions }}</b>
              <i>−{{ changedLines.deletions }}</i>
            </span>
          </button>
          <div class="workspace-list-row">
            <MonitorCog :size="15" />
            <span>Local</span>
            <span class="workspace-row-value"
              >{{ git.ahead }}↑ {{ git.behind }}↓</span
            >
          </div>
          <div class="workspace-list-row">
            <GitBranch :size="15" />
            <span>{{ git.branch || 'Detached HEAD' }}</span>
            <span class="workspace-row-value">{{ git.head?.slice(0, 8) }}</span>
          </div>
          <div
            v-if="git.repository.transientState !== 'none'"
            class="workspace-list-row environment-warning-row"
          >
            <Workflow :size="15" />
            <span>{{ git.repository.transientState }}</span>
            <span class="workspace-row-value">in progress</span>
          </div>
          <div v-if="activeWorktree" class="workspace-list-row">
            <Workflow :size="15" />
            <span>{{ activeWorktree.branch || '临时 worktree' }}</span>
            <span class="workspace-row-value">active</span>
          </div>
          <button
            type="button"
            class="workspace-list-row environment-action-row"
            @click="$emit('openPane', 'review')"
          >
            <GitCommitHorizontal :size="15" />
            <span>Commit or push</span>
          </button>
          <button
            type="button"
            class="workspace-list-row environment-action-row"
            @click="$emit('openPane', 'review')"
          >
            <GitCompareArrows :size="15" />
            <span>Compare branch</span>
            <span class="workspace-row-value">↗</span>
          </button>
          <button
            v-if="latestPullRequest?.pullRequest"
            type="button"
            class="workspace-list-row environment-action-row"
            @click="$emit('openPane', 'review')"
          >
            <GitPullRequest :size="15" />
            <span>PR #{{ latestPullRequest.pullRequest.number }}</span>
            <span class="workspace-row-value">{{
              latestPullRequest.pullRequest.state
            }}</span>
          </button>
          <div v-else-if="latestReceipt" class="workspace-list-row">
            <CircleDot :size="14" />
            <span>{{ latestReceipt.action }}</span>
            <span class="workspace-row-value">receipt</span>
          </div>
        </div>
        <div v-else class="workspace-muted">未初始化 Git 仓库</div>
      </section>

      <section v-if="snapshot.goal" class="workspace-section">
        <h3>Goal</h3>
        <div class="workspace-list-row workspace-feature-row">
          <Target :size="16" />
          <div>
            <strong>{{
              recordText(snapshot.goal, 'objective') || '当前 Goal'
            }}</strong>
            <span>{{ recordText(snapshot.goal, 'phase') }}</span>
          </div>
        </div>
      </section>

      <section v-if="workflowTasks.length" class="workspace-section">
        <h3>Workflows</h3>
        <div class="workspace-list">
          <div
            v-for="run in workflowTasks"
            :key="run.id"
            class="environment-process-item"
          >
            <div class="workspace-list-row environment-process-row">
              <Workflow :size="14" :data-status="run.status" />
              <div class="environment-process-copy">
                <strong>{{ run.label || run.id }}</strong>
                <span>{{ workflowSummary(run) }}</span>
              </div>
              <span class="workspace-row-value">
                {{ workflowStatusLabel(run.status) }}
              </span>
              <div class="environment-process-actions">
                <button
                  type="button"
                  title="查看记录"
                  aria-label="查看工作流记录"
                  @click="toggleTranscript(run.id)"
                >
                  <ScrollText :size="13" />
                </button>
                <button
                  v-if="run.status === 'running'"
                  type="button"
                  title="停止"
                  aria-label="停止工作流"
                  :disabled="taskBusy === run.id"
                  @click="cancelTask(run.id)"
                >
                  <Square :size="12" />
                </button>
              </div>
            </div>
            <pre
              v-if="transcripts[run.id] !== undefined"
              class="environment-process-log"
              >{{ transcripts[run.id] || '暂无记录' }}</pre>
            <p
              v-if="taskErrors[run.id]"
              class="environment-process-error"
              role="alert"
            >
              {{ taskErrors[run.id] }}
            </p>
          </div>
        </div>
      </section>

      <section
        v-if="
          subagentGroups.active.length ||
          subagentGroups.recent.length ||
          subagentGroups.completedCount
        "
        class="workspace-section environment-subagents"
      >
        <h3>
          <span>Subagents</span>
          <span class="environment-section-summary">
            <template v-if="subagentGroups.active.length">
              {{ subagentGroups.active.length }} 运行中
            </template>
            <template v-if="subagentGroups.completedCount">
              {{ subagentGroups.completedCount }} 已完成
            </template>
            <template v-if="subagentGroups.failedCount">
              {{ subagentGroups.failedCount }} 失败
            </template>
          </span>
        </h3>
        <div class="workspace-list">
          <div
            v-for="(agent, index) in [
              ...subagentGroups.active,
              ...subagentGroups.recent,
            ]"
            :key="agent.id || index"
            class="workspace-list-row workspace-feature-row environment-subagent-row"
            :class="{
              'environment-agent-active': subagentGroups.active.includes(agent),
            }"
          >
            <span class="environment-agent-icon">
              <Bot :size="14" />
              <span
                class="environment-agent-dot"
                :class="{
                  'animate-pulse-seal': subagentStatusTone(agent) === 'running',
                }"
                :data-tone="subagentStatusTone(agent)"
                :title="subagentStatusLabel(agent)"
              />
            </span>
            <div class="environment-agent-copy">
              <strong>{{ agent.title || 'Subagent' }}</strong>
              <span>
                {{ agent.mode || 'agent' }} ·
                {{ durationLabel(agent) }}
              </span>
            </div>
            <span class="workspace-row-value">
              {{ subagentStatusLabel(agent) }}
            </span>
            <div class="environment-process-actions">
              <button
                type="button"
                title="查看记录"
                aria-label="查看子代理记录"
                @click="toggleTranscript(agent.id)"
              >
                <ScrollText :size="13" />
              </button>
              <button
                v-if="agent.status === 'running'"
                type="button"
                title="中断"
                aria-label="中断子代理"
                :disabled="taskBusy === agent.id"
                @click="cancelTask(agent.id)"
              >
                <Square :size="12" />
              </button>
            </div>
          </div>
          <template
            v-for="agent in [
              ...subagentGroups.active,
              ...subagentGroups.recent,
            ]"
            :key="`transcript:${agent.id}`"
          >
            <pre
              v-if="transcripts[agent.id] !== undefined"
              class="environment-process-log"
              >{{ transcripts[agent.id] || '暂无记录' }}</pre>
          </template>
          <div
            v-if="subagentGroups.hiddenCount"
            class="environment-subagent-overflow"
          >
            另有 {{ subagentGroups.hiddenCount }} 条历史记录
          </div>
        </div>
      </section>

      <section
        v-if="jobTasks.length || snapshot.terminals.length"
        class="workspace-section"
      >
        <h3>Background jobs</h3>
        <div class="workspace-list">
          <div
            v-for="job in jobTasks"
            :key="job.id"
            class="environment-process-item"
          >
            <div class="workspace-list-row environment-process-row">
              <CircleDot :size="14" :data-status="job.status" />
              <div class="environment-process-copy">
                <strong>{{ job.label || job.id }}</strong>
                <span>
                  {{ job.job_kind || 'job' }} · {{ job.status }}
                  <template v-if="job.exit_code != null">
                    · exit {{ job.exit_code }}
                  </template>
                  <template v-if="durationLabel(job)">
                    · {{ durationLabel(job) }}
                  </template>
                </span>
              </div>
              <div class="environment-process-actions">
                <button
                  type="button"
                  title="查看输出"
                  aria-label="查看后台任务输出"
                  @click="toggleTranscript(job.id)"
                >
                  <ScrollText :size="13" />
                </button>
                <button
                  v-if="job.status === 'running'"
                  type="button"
                  title="停止"
                  aria-label="停止后台任务"
                  :disabled="taskBusy === job.id"
                  @click="cancelTask(job.id)"
                >
                  <Square :size="12" />
                </button>
              </div>
            </div>
            <pre
              v-if="transcripts[job.id] !== undefined"
              class="environment-process-log"
              >{{ transcripts[job.id] || '暂无输出' }}</pre>
            <p
              v-if="taskErrors[job.id]"
              class="environment-process-error"
              role="alert"
            >
              {{ taskErrors[job.id] }}
            </p>
          </div>
          <div
            v-for="(terminal, index) in snapshot.terminals"
            :key="recordText(terminal, 'id') || index"
            class="workspace-list-row"
          >
            <TerminalSquare :size="14" />
            <span>{{
              recordText(terminal, 'title') || `Terminal ${index + 1}`
            }}</span>
            <span class="workspace-row-value">PTY</span>
          </div>
        </div>
      </section>
    </template>

    <section v-if="sources.length" class="workspace-section">
      <h3>Sources</h3>
      <div v-if="sources.length" class="workspace-list">
        <div
          v-for="source in sources.slice(0, 3)"
          :key="source.id"
          class="workspace-list-row"
        >
          <Image :size="14" />
          <span class="workspace-source-name">{{ source.name }}</span>
        </div>
      </div>
      <button
        v-if="sources.length > 3"
        type="button"
        class="workspace-view-all"
        @click="$emit('openPane', 'files')"
      >
        View all · {{ sources.length }}
      </button>
    </section>
  </div>
</template>

<style scoped>
.workspace-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: auto;
  padding: var(--space-3) var(--space-3) var(--space-4);
}

.workspace-pane-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-1);
  padding-left: var(--space-2);
}

.workspace-pane-heading > div {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: var(--space-2);
}

.workspace-pane-heading strong {
  overflow: hidden;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-eyebrow {
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-icon-button {
  display: inline-grid;
  width: var(--space-7);
  height: var(--space-7);
  flex: none;
  place-items: center;
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
}

.workspace-icon-button:hover:not(:disabled) {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.workspace-icon-button:disabled {
  cursor: default;
  opacity: 0.4;
}

.workspace-section {
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border-l1);
}

.workspace-section:first-of-type {
  border-top: 0;
}

.workspace-section h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0 0 var(--space-1);
  padding: var(--space-1) var(--space-2) 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
}

.environment-section-summary {
  display: inline-flex;
  gap: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-weight: 400;
}

.workspace-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.workspace-list-row {
  display: flex;
  min-width: 0;
  min-height: var(--space-8);
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.workspace-list-row > svg {
  flex: none;
  color: rgb(var(--label-secondary));
}

.workspace-list-row
  > span:not(.workspace-row-value):not(.environment-agent-icon) {
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-row-value {
  display: inline-flex;
  flex: none;
  gap: var(--space-1);
  color: rgb(var(--label-tertiary));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.environment-action-row {
  width: 100%;
  text-align: left;
}

.environment-action-row:hover {
  background: var(--interactive-bg-hover);
}

.change-count b {
  color: rgb(var(--ok));
  font-weight: 500;
}

.change-count i {
  color: rgb(var(--danger));
  font-style: normal;
}

.change-count em {
  color: rgb(var(--label-tertiary));
  font-style: normal;
}

.environment-warning-row {
  color: rgb(var(--warn));
}

.workspace-feature-row > div {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.workspace-feature-row strong,
.workspace-feature-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-feature-row strong {
  font-weight: 500;
}

.workspace-feature-row span {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.environment-subagents .workspace-feature-row {
  min-height: calc(var(--space-8) + var(--space-0-5));
}

.environment-subagent-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
}

.environment-subagent-row .environment-agent-icon {
  width: 18px;
  min-width: 18px;
  flex: none;
}

.environment-agent-copy {
  min-width: 0;
}

.environment-subagent-row > .workspace-row-value {
  justify-self: end;
}

.environment-agent-active {
  background: rgb(var(--warn) / 0.055);
  box-shadow: inset 2px 0 0 rgb(var(--warn) / 0.52);
}

.environment-agent-icon {
  position: relative;
  display: inline-grid;
  width: 18px;
  height: 18px;
  flex: none;
  place-items: center;
  color: rgb(var(--label-secondary));
}

.environment-agent-dot {
  position: absolute;
  right: calc(var(--space-1-5) / -2);
  bottom: calc(var(--space-1-5) / -2);
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgb(var(--label-tertiary));
  box-shadow: 0 0 0 2px rgb(var(--bg-base));
}

.environment-agent-dot[data-tone='running'] {
  background: rgb(var(--warn));
}

.environment-agent-dot[data-tone='pending'] {
  background: rgb(var(--accent));
}

.environment-agent-dot[data-tone='completed'] {
  background: rgb(var(--ok));
}

.environment-agent-dot[data-tone='failed'] {
  background: rgb(var(--danger));
}

.environment-agent-dot[data-tone='cancelled'] {
  background: rgb(var(--label-tertiary));
}

.environment-subagent-overflow {
  padding: var(--space-1) var(--space-2) 1px var(--space-7);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.environment-process-item {
  min-width: 0;
  border-radius: var(--radius-row);
}

.environment-process-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 2px;
}

.environment-process-copy strong,
.environment-process-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.environment-process-copy strong {
  font-weight: 500;
}

.environment-process-copy span {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.environment-process-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-ds-fast) ease;
}

.environment-process-row:hover .environment-process-actions,
.environment-process-row:focus-within .environment-process-actions,
.environment-subagent-row:hover .environment-process-actions,
.environment-subagent-row:focus-within .environment-process-actions {
  opacity: 1;
}

.environment-process-actions button {
  display: grid;
  width: var(--space-6);
  height: var(--space-6);
  place-items: center;
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
}

.environment-process-actions button:hover:not(:disabled) {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.environment-process-log {
  max-height: 140px;
  margin: 2px var(--space-2) var(--space-2) var(--space-7);
  padding: var(--space-2) var(--space-2-5);
  overflow: auto;
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  background: rgb(var(--code-block-bg));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: pre-wrap;
  word-break: break-word;
}

.environment-process-error {
  margin: var(--space-1) var(--space-2) var(--space-2) var(--space-7);
  color: rgb(var(--danger));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.workspace-muted,
.workspace-empty-state {
  padding: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.workspace-inline-error {
  margin: var(--space-2) 0;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--danger));
  background: rgb(var(--danger-soft));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.workspace-source-name {
  color: rgb(var(--label-secondary));
}

.workspace-view-all {
  margin-top: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.workspace-view-all:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}
</style>
