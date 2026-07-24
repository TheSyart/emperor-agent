<script setup lang="ts">
import {
  Bot,
  CircleDot,
  GitBranch,
  GitCompareArrows,
  GitCommitHorizontal,
  GitPullRequest,
  Image,
  ListChecks,
  MonitorCog,
  RefreshCw,
  Target,
  TerminalSquare,
  Users,
  Workflow,
} from 'lucide-vue-next'
import { computed } from 'vue'
import type { WorkspaceSnapshot, WorkspaceSource } from './workspaceTypes'
import { isGitStatus } from './workspaceTypes'
import { environmentSubagentGroups } from './environmentModel'

const props = defineProps<{
  snapshot: WorkspaceSnapshot | null
  sources: WorkspaceSource[]
  loading: boolean
  error: string
  hasProject: boolean
}>()

defineEmits<{
  refresh: []
  openPane: [pane: 'review' | 'terminal' | 'files']
}>()

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
            class="workspace-list-row workspace-feature-row"
            :class="{
              'environment-agent-active': subagentGroups.active.includes(agent),
            }"
          >
            <Bot :size="14" />
            <div>
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
            class="workspace-list-row"
          >
            <CircleDot :size="14" />
            <span>{{
              recordText(process, 'label') || recordText(process, 'id')
            }}</span>
            <span class="workspace-row-value">{{
              recordText(process, 'status')
            }}</span>
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
