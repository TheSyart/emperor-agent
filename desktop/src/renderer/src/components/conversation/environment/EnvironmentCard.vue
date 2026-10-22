<script setup lang="ts">
/**
 * EnvironmentCard — 环境信息, the chat-tab card floating at the top right of
 * the conversation (async chunk; ConversationView seats it while
 * `frameActions.envCardVisible` on an active chat: beside a wide chat by
 * default until closed by hand, over a narrow one on demand).
 *
 * UI-S05: a read-only summary. Every section is 32px rows; a row opens
 * the place where the work happens (审查, the subagent list, a task's
 * output, a resource, the workbench's 来源 view) and nothing on the card
 * writes. The Git actions
 * (worktree, branches, commit, compare) live in 审查's branch menu.
 *
 * Title: the project name in a Build session, else 环境信息. 「⋯」 holds
 * 复制项目路径, 在访达中显示 (the session's project; unavailable without
 * one) and 隐藏此卡片 (closes it and remembers, like the header toggle).
 *
 * Rows, top to bottom:
 * - Build sessions (git, from the shared workspace snapshot): 「分支 +A −D」
 *   (`git.summary`, opens 审查), plus a warning while a merge or rebase is
 *   unfinished. Other sessions show one muted line.
 * - 计划: the latest `exit_plan_mode` call (conversation/planSummary.ts):
 *   its title and n/m; click reveals its row.
 * - 子智能体 (EnvironmentAgents), 后台任务 (EnvironmentTasks) and the 来源
 *   section (EnvironmentResources, UI-S13: at most three sources and
 *   「查看全部」; no 输出 row — a turn's files are in its files card).
 * The goal is not repeated here (GoalBar shows it).
 *
 * Layout (UI-S16): absolute at the top right of the view area, over the
 * chat's scroller. ConversationView moves the chat clear of it from a 1152px
 * region; narrower it floats over the chat with the deeper dialog shadow
 * (`data-env-overlay`). Its height stops 16 above the bottom of the view
 * area, where the composer stack starts, or above the computer-use preview
 * (`previewLayout.reservedHeight`); the rows scroll inside.
 *
 * Props: sessionId, snapshot (the viewed chat window), build (a Build session
 * bound to a project), agentBusy (a turn runs in it), child (a subagent view),
 * title (the project name; '' for 环境信息).
 * Emits: reveal(nodeKey), open-subagent(sessionId), close.
 */
import Badge from '../../ui/Badge.vue'
import {
  Copy,
  Ellipsis,
  EyeOff,
  FileDiff,
  FolderOpen,
  ListChecks,
  TriangleAlert,
} from 'lucide-vue-next'
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
} from 'vue'
import { openPath } from '../../../api/backend'
import { useAppContext } from '../../../composables/useAppContext'
import {
  PLAN_STATUS_LABEL,
  planSummary,
  type PlanSummary,
} from '../../../conversation/planSummary'
import type { ChatSnapshot } from '../../../conversation/types'
import IconButton from '../../ui/IconButton.vue'
import Menu from '../../ui/Menu.vue'
import MenuItem from '../../ui/MenuItem.vue'
import Avatar from '../../ui/Avatar.vue'
import { pushToast } from '../../ui/toasts'
import { writeClipboard } from '../../ui/useCopyFeedback'
import type { AgentView } from '@emperor/core/api'
import { useWorkspaceSnapshot } from '../../workspace/useWorkspaceSnapshot'
import { gitTransientLabel } from '../../workspace/workspaceModel'
import { requestWorkspace } from '../../workspace/workspaceState'
import { isGitStatus } from '../../workspace/workspaceTypes'
import { previewLayout } from '../computer-use/computerUsePreviewState'
import EnvironmentAgents from './EnvironmentAgents.vue'
import EnvironmentResources from './EnvironmentResources.vue'
import EnvironmentRow from './EnvironmentRow.vue'
import EnvironmentTasks from './EnvironmentTasks.vue'

const props = withDefaults(
  defineProps<{
    sessionId: string
    rootSessionId?: string
    agents?: AgentView[]
    nativeSessionId?: string
    snapshot: ChatSnapshot
    build?: boolean
    agentBusy?: boolean
    child?: boolean
    title?: string
    hasMore?: boolean
  }>(),
  { build: false, agentBusy: false, child: false, title: '', hasMore: false },
)

const emit = defineEmits<{
  reveal: [nodeKey: string]
  'open-subagent': [sessionId: string]
  close: []
}>()

const ctx = useAppContext()

/**
 * ConversationView is kept alive: a cached (deactivated) card must neither
 * answer Escape on another page nor keep polling.
 */
const activated = ref(true)

/**
 * Escape closes the open 「⋯」 menu first (focus may still sit on its
 * trigger), without stealing Escape from a modal or the conversation.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!activated.value || event.key !== 'Escape' || !moreMenu.value) return
  if (event.defaultPrevented || event.isComposing) return
  event.preventDefault()
  moreMenu.value = false
}

onActivated(() => {
  activated.value = true
})
onDeactivated(() => {
  activated.value = false
})

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})

// ── git (Build sessions) ────────────────────────────────────────────────
const workspace = useWorkspaceSnapshot({
  active: () => props.build && activated.value,
})
/** The shared snapshot, when it describes this session. */
const workspaceSnapshot = computed(() => {
  const snapshot = workspace.snapshot.value
  return props.build && snapshot?.sessionId === props.sessionId
    ? snapshot
    : null
})
const git = computed(() => {
  const status = workspaceSnapshot.value?.git
  return isGitStatus(status) ? status : null
})
const inWorktree = computed(() =>
  Boolean(workspaceSnapshot.value?.worktrees?.owned?.some((w) => w.active)),
)
const transient = computed(() =>
  git.value ? gitTransientLabel(git.value.repository.transientState) : '',
)
const unavailableLine = computed(() =>
  props.child
    ? '子智能体 · 在父智能体中查看变更与分支'
    : '未绑定项目 · Build 会话可查看变更与分支',
)
const gitLine = computed(() => {
  if (!workspaceSnapshot.value)
    return workspace.error.value
      ? `无法读取工作区：${workspace.error.value}`
      : '正在读取工作区…'
  return git.value ? '' : '项目还不是 Git 仓库'
})
const branchLabel = computed(() => {
  const status = git.value
  if (!status) return ''
  return (
    status.branch || (status.repository.unborn ? '未提交的分支' : '分离 HEAD')
  )
})
const aheadBehind = computed(() => {
  const status = git.value
  if (!status?.upstream) return ''
  return [
    status.ahead ? `${status.ahead}↑` : '',
    status.behind ? `${status.behind}↓` : '',
  ]
    .filter(Boolean)
    .join(' ')
})

function openReview(): void {
  requestWorkspace({ pane: 'review' })
}

// ── plan ────────────────────────────────────────────────────────────────
const plan = computed(() => planSummary(props.snapshot))

function planValue(summary: PlanSummary): string {
  if (summary.status === 'executing')
    return `${summary.steps.done}/${summary.steps.total}`
  return PLAN_STATUS_LABEL[summary.status]
}

// ── 「⋯」 ─────────────────────────────────────────────────────────────────
const moreAnchor = ref<HTMLElement | null>(null)
const moreMenu = ref(false)
const projectPath = computed(() =>
  props.build ? workspace.projectPath.value : '',
)

async function copyProjectPath(): Promise<void> {
  if (!projectPath.value) return
  if (await writeClipboard(projectPath.value))
    pushToast('已复制项目路径', { tone: 'ok' })
  else ctx.showError(new Error('无法写入剪贴板'))
}

async function revealProject(): Promise<void> {
  try {
    await openPath({
      kind: 'diagnostic',
      rowId: 'active-project-path',
      sessionId: props.sessionId,
    })
  } catch (cause) {
    ctx.showError(cause)
  }
}
</script>

<template>
  <aside
    class="environment-card"
    :data-session-id="sessionId"
    :style="{ '--env-card-reserve': `${previewLayout.reservedHeight}px` }"
    aria-label="环境信息"
  >
    <header class="card-head">
      <Avatar
        kind="sprite"
        v-if="nativeSessionId"
        :id="nativeSessionId"
        :size="24"
      />
      <h2 class="card-title" :title="title || '环境信息'">
        {{ title || '环境信息' }}
      </h2>
      <span ref="moreAnchor" class="head-anchor">
        <IconButton
          label="更多操作"
          size="sm"
          aria-haspopup="menu"
          :aria-expanded="moreMenu"
          @click="moreMenu = !moreMenu"
        >
          <Ellipsis :size="16" />
        </IconButton>
      </span>
    </header>

    <div class="card-body">
      <div class="section">
        <template v-if="build">
          <p v-if="gitLine" class="muted-line" data-section="git">
            {{ gitLine }}
          </p>
          <div v-else-if="git" class="section" data-section="git">
            <EnvironmentRow
              data-row="branch"
              mono
              :label="branchLabel"
              :title="`${branchLabel} · 在审查中查看改动`"
              @click="openReview"
            >
              <template #lead><FileDiff :size="16" /></template>
              <template #meta>
                <Badge v-if="inWorktree">worktree</Badge>
                <span v-if="aheadBehind" class="ahead">{{ aheadBehind }}</span>
              </template>
              <template #value>
                <span v-if="git.summary.changedFiles" class="changes"
                  ><b>+{{ git.summary.additions }}</b>
                  <i>−{{ git.summary.deletions }}</i></span
                >
                <template v-else>无改动</template>
              </template>
            </EnvironmentRow>
            <p v-if="transient" class="warn-line" role="status">
              <TriangleAlert :size="16" />
              <span>{{ transient }}</span>
            </p>
          </div>
        </template>
        <p v-else class="muted-line" data-section="git">
          {{ unavailableLine }}
        </p>

        <EnvironmentRow
          v-if="plan"
          data-row="plan"
          :label="plan.title"
          shrink-label
          :title="plan.title"
          :value="planValue(plan)"
          :status="plan.status === 'executing' ? 'running' : undefined"
          @click="emit('reveal', plan.key)"
        >
          <template #lead><ListChecks :size="16" /></template>
        </EnvironmentRow>
      </div>

      <EnvironmentAgents
        :root-session-id="rootSessionId || sessionId"
        :agents="agents"
      />
      <EnvironmentTasks
        :session-id="sessionId"
        :snapshot="snapshot"
        :active="activated"
      />
      <EnvironmentResources
        :session-id="sessionId"
        :snapshot="snapshot"
        :has-more="hasMore"
      />
    </div>

    <Menu
      v-model:open="moreMenu"
      :anchor="moreAnchor"
      placement="bottom"
      :width="216"
      label="更多操作"
    >
      <MenuItem :disabled="!projectPath" @select="copyProjectPath">
        复制项目路径
        <template #icon><Copy :size="16" /></template>
      </MenuItem>
      <MenuItem :disabled="!projectPath" @select="revealProject">
        在访达中显示
        <template #icon><FolderOpen :size="16" /></template>
      </MenuItem>
      <MenuItem @select="emit('close')">
        隐藏此卡片
        <template #icon><EyeOff :size="16" /></template>
      </MenuItem>
    </Menu>
  </aside>
</template>

<style scoped>
.environment-card {
  position: absolute;
  top: var(--space-3);
  right: var(--space-4);
  z-index: var(--z-sticky);
  display: flex;
  flex-direction: column;
  width: min(var(--env-card-width, 340px), 100% - 2 * var(--space-4));
  /* 16 above the composer stack (the view area's bottom) or above the
     computer-use preview's reserve. */
  max-height: calc(
    100% - var(--space-3) - max(var(--space-4), var(--env-card-reserve, 0px))
  );
  overflow: hidden;
  border-radius: var(--r-lg);
  background: rgb(var(--env-card-fill));
  box-shadow: var(--env-card-edge);
  color: rgb(var(--text-1));
}

/* Over the chat (no room beside it): the dialog shadow lifts it clear. */
.conversation-root[data-env-overlay] .environment-card {
  box-shadow: var(--elev-3);
}

.card-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2-5) var(--space-2) var(--space-1) var(--space-4);
}

.card-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font: var(--weight-semibold) var(--type-footnote) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-anchor {
  display: inline-flex;
  flex: none;
}

/* Sections 12px apart, rows 2px apart, no rules. */
.card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  padding: var(--space-1) var(--space-2) var(--space-3);
  overflow-y: auto;
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

.muted-line {
  margin: 0;
  padding: var(--space-1-5) var(--space-2);
  color: rgb(var(--text-3));
  font: var(--font-xs);
}

.warn-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-1) var(--space-2);
  color: rgb(var(--warn));
  font: var(--font-xs);
}

.ahead {
  flex: none;
  color: rgb(var(--text-3));
  font: var(--font-xxs);
  font-variant-numeric: tabular-nums;
}

.changes {
  display: inline-flex;
  gap: var(--space-1);
}

.changes b,
.changes i {
  font-style: normal;
  font-weight: var(--weight-medium);
}

.changes b {
  color: rgb(var(--ok));
}

.changes i {
  color: rgb(var(--error));
}
</style>
