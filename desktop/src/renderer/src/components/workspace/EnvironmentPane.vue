<script setup lang="ts">
import {
  Bot,
  CircleDot,
  GitBranch,
  GitCompareArrows,
  GitCommitHorizontal,
  GitPullRequest,
  ExternalLink,
  Image,
  ListChecks,
  MonitorCog,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  Target,
  TerminalSquare,
  Users,
  Workflow,
} from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { core } from '../../api/http'
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

const emit = defineEmits<{
  refresh: []
  openPane: [pane: 'review' | 'terminal' | 'files' | 'browser']
  openPreview: [previewId: string]
}>()

const processBusy = ref('')
const processLogs = ref<Record<string, string>>({})
const processErrors = ref<Record<string, string>>({})

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
const plan = computed(() => props.snapshot?.plan ?? null)
const planSteps = computed(() => {
  const value = plan.value?.steps
  return Array.isArray(value) ? value : []
})
const donePlanSteps = computed(
  () =>
    planSteps.value.filter((step) =>
      ['done', 'completed', 'skipped'].includes(recordText(step, 'status')),
    ).length,
)
const teamMembers = computed(() => {
  const value = props.snapshot?.team?.members
  return Array.isArray(value) ? value : []
})
const subagentGroups = computed(() =>
  environmentSubagentGroups(props.snapshot?.subagents ?? []),
)

function subagentStatusLabel(value: unknown): string {
  const status = recordText(value, 'status')
  if (status === 'running') return '运行中'
  if (status === 'queued' || status === 'pending') return '等待中'
  if (status === 'completed') return '完成'
  if (status === 'cancelled') return '已取消'
  if (status === 'interrupted') return '已中断'
  return status === 'failed' || status === 'error' ? '失败' : status
}

function recordText(value: unknown, key: string): string {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Record<string, unknown>)[key] ?? '')
    : ''
}

function recordNumber(value: unknown, key: string): number {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function metadataText(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const metadata = (value as Record<string, unknown>).metadata
  return recordText(metadata, key)
}

function durationLabel(value: unknown): string {
  const startedAt = timestampMs(recordNumber(value, 'started_at'))
  if (!startedAt) return ''
  const endedAt =
    timestampMs(recordNumber(value, 'ended_at')) ||
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

function processDuration(value: unknown): string {
  const started = Date.parse(recordText(value, 'startedAt'))
  if (!Number.isFinite(started)) return ''
  const finished =
    recordNumber(value, 'finishedAt') ||
    props.snapshot?.capturedAt ||
    Date.now()
  const seconds = Math.max(0, Math.floor((finished - started) / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function processPreview(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const preview = (value as Record<string, unknown>).preview
  return preview && typeof preview === 'object' && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : null
}

async function toggleLogs(value: unknown): Promise<void> {
  const processId = recordText(value, 'id')
  const sessionId = props.snapshot?.sessionId || ''
  if (!processId || !sessionId) return
  if (processLogs.value[processId] !== undefined) {
    const next = { ...processLogs.value }
    delete next[processId]
    processLogs.value = next
    return
  }
  try {
    const result = await core('projectProcesses.readOutput', {
      sessionId,
      processId,
      afterSeq: 0,
    })
    processLogs.value = {
      ...processLogs.value,
      [processId]: result.chunks
        .map((chunk) => chunk.data)
        .join('')
        .slice(-8_000),
    }
  } catch (cause) {
    processLogs.value = {
      ...processLogs.value,
      [processId]: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

async function stopProcess(value: unknown): Promise<void> {
  const processId = recordText(value, 'id')
  if (!processId || !props.snapshot?.sessionId) return
  processBusy.value = processId
  clearProcessError(processId)
  try {
    await core('projectProcesses.stop', {
      sessionId: props.snapshot.sessionId,
      processId,
      expectedRevision: recordNumber(value, 'revision'),
    })
    emit('refresh')
  } catch (cause) {
    setProcessError(processId, cause)
  } finally {
    processBusy.value = ''
  }
}

async function restartProcess(value: unknown): Promise<void> {
  const processId = recordText(value, 'id')
  if (!processId || !props.snapshot?.sessionId) return
  if (!window.confirm('重启这个项目进程？')) return
  processBusy.value = processId
  clearProcessError(processId)
  try {
    await core('projectProcesses.restart', {
      sessionId: props.snapshot.sessionId,
      processId,
      expectedRevision: recordNumber(value, 'revision'),
      confirmed: true,
      invocationId: crypto.randomUUID(),
    })
    emit('refresh')
  } catch (cause) {
    setProcessError(processId, cause)
  } finally {
    processBusy.value = ''
  }
}

function clearProcessError(processId: string): void {
  const next = { ...processErrors.value }
  delete next[processId]
  processErrors.value = next
}

function setProcessError(processId: string, cause: unknown): void {
  processErrors.value = {
    ...processErrors.value,
    [processId]: cause instanceof Error ? cause.message : String(cause),
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

      <section v-if="plan || snapshot.goal" class="workspace-section">
        <h3>Plan</h3>
        <div v-if="plan" class="workspace-list-row workspace-feature-row">
          <ListChecks :size="16" />
          <div>
            <strong>{{ recordText(plan, 'title') || '当前计划' }}</strong>
            <span>
              {{ donePlanSteps }}/{{ planSteps.length }} 步 ·
              {{ recordText(plan, 'status') }}
            </span>
          </div>
        </div>
        <div
          v-if="snapshot.goal"
          class="workspace-list-row workspace-feature-row"
        >
          <Target :size="16" />
          <div>
            <strong>{{
              recordText(snapshot.goal, 'outcome') || '当前 Goal'
            }}</strong>
            <span>{{ recordText(snapshot.goal, 'phase') }}</span>
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
            :key="recordText(agent, 'id') || index"
            class="workspace-list-row workspace-feature-row environment-subagent-row"
            :class="{
              'environment-agent-active': subagentGroups.active.includes(agent),
            }"
          >
            <span class="environment-agent-icon">
              <Bot :size="14" />
              <span
                class="environment-agent-dot"
                :data-tone="subagentStatusTone(agent)"
                :title="subagentStatusLabel(agent)"
              />
            </span>
            <div class="environment-agent-copy">
              <strong>{{ recordText(agent, 'title') || 'Subagent' }}</strong>
              <span>
                {{ metadataText(agent, 'agent_type') || 'agent' }} ·
                {{ metadataText(agent, 'workspace_mode') || 'shared' }} ·
                {{ durationLabel(agent) }}
              </span>
            </div>
            <span class="workspace-row-value">
              {{ subagentStatusLabel(agent) }}
            </span>
          </div>
          <div
            v-if="subagentGroups.hiddenCount"
            class="environment-subagent-overflow"
          >
            另有 {{ subagentGroups.hiddenCount }} 条历史记录
          </div>
        </div>
      </section>

      <section v-if="teamMembers.length" class="workspace-section">
        <h3>
          Team
          <span v-if="recordNumber(snapshot.team, 'leadUnread')">
            {{ recordNumber(snapshot.team, 'leadUnread') }} unread
          </span>
        </h3>
        <div class="workspace-list">
          <div
            v-for="(member, index) in teamMembers"
            :key="recordText(member, 'name') || index"
            class="workspace-list-row"
          >
            <Users :size="15" />
            <span>{{ recordText(member, 'name') }}</span>
            <span class="workspace-row-value">
              {{ recordText(member, 'status') || 'idle' }}
            </span>
          </div>
        </div>
      </section>

      <section
        v-if="snapshot.processes.length || snapshot.terminals.length"
        class="workspace-section"
      >
        <h3>Background processes</h3>
        <div class="workspace-list">
          <div
            v-for="(process, index) in snapshot.processes"
            :key="recordText(process, 'id') || index"
            class="environment-process-item"
          >
            <div class="workspace-list-row environment-process-row">
              <CircleDot
                :size="14"
                :data-status="recordText(process, 'status')"
              />
              <div class="environment-process-copy">
                <strong>{{
                  recordText(process, 'label') || recordText(process, 'id')
                }}</strong>
                <span>
                  {{ recordText(process, 'ecosystem') || 'process' }} ·
                  {{ recordText(process, 'status') }} ·
                  {{ recordText(process, 'health') }}
                  <template v-if="processDuration(process)">
                    · {{ processDuration(process) }}
                  </template>
                </span>
              </div>
              <span
                v-if="recordText(process, 'primary') === 'true'"
                class="environment-primary-badge"
                >Preview</span
              >
              <div class="environment-process-actions">
                <button
                  v-if="processPreview(process)?.status === 'ready'"
                  type="button"
                  title="打开预览"
                  aria-label="打开网站预览"
                  @click="
                    $emit(
                      'openPreview',
                      String(processPreview(process)?.id || ''),
                    )
                  "
                >
                  <ExternalLink :size="13" />
                </button>
                <button
                  type="button"
                  title="查看日志"
                  aria-label="查看进程日志"
                  @click="toggleLogs(process)"
                >
                  <ScrollText :size="13" />
                </button>
                <button
                  v-if="
                    ['running', 'starting'].includes(
                      recordText(process, 'status'),
                    )
                  "
                  type="button"
                  title="停止"
                  aria-label="停止项目进程"
                  :disabled="processBusy === recordText(process, 'id')"
                  @click="stopProcess(process)"
                >
                  <Square :size="12" />
                </button>
                <button
                  v-else
                  type="button"
                  title="重启"
                  aria-label="重启项目进程"
                  :disabled="processBusy === recordText(process, 'id')"
                  @click="restartProcess(process)"
                >
                  <RotateCw :size="13" />
                </button>
              </div>
            </div>
            <pre
              v-if="processLogs[recordText(process, 'id')] !== undefined"
              class="environment-process-log"
              >{{ processLogs[recordText(process, 'id')] || '暂无日志' }}</pre>
            <p
              v-if="processErrors[recordText(process, 'id')]"
              class="environment-process-error"
              role="alert"
            >
              {{ processErrors[recordText(process, 'id')] }}
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
