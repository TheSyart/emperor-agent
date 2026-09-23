<script setup lang="ts">
/**
 * EnvironmentCard — 环境信息, the chat-tab card floating at the top right of
 * the conversation (async chunk; ConversationView seats it while
 * `frame.envCardOpen` on an active chat).
 *
 * Rows and their sources:
 * - Build sessions (git, from the shared workspace snapshot): 变更 +A −D
 *   (`git.summary`, opens 审查) · 本地 / worktree ▾ (`git.enterWorktree` /
 *   `git.exitWorktree`) · branch ▾ (`git.branches` / `git.switchBranch`) ·
 *   提交或推送 (审查 focused on the commit box) · 比较分支 ↗ (`git.remote`
 *   → provider compare page through `openExternal`). Writes follow the
 *   审查 pane rules: confirmed, carrying the snapshot's `expectedRevision`,
 *   disabled while the agent runs or a git operation is unfinished.
 *   Other sessions show one muted line instead.
 * - 计划: the latest `exit_plan_mode` call (conversation/planSummary.ts);
 *   click reveals its row.
 * - 子智能体: `tasks.list` of the session, active first; deterministic
 *   `--avatar-*` colors; three shown, 「再显示 n 个」 for the rest; click opens
 *   the child session.
 * - 后台任务: background jobs / workflow runs, only when there are any;
 *   expands to one line each (live first) with 「输出」 (TaskOutputDialog,
 *   `tasks.transcript`) and, while running, 「停止」 (`tasks.cancel`;
 *   a workflow run asks first — its subagents stop with it).
 * - 来源: attachments, 网页搜索, MCP servers, Skills of the loaded window
 *   (sourcesFromSnapshot); three shown, 「查看全部」 lists every one.
 * The goal is not repeated here (GoalBar shows it).
 *
 * Layout: absolute inside the view area. From a 1120px conversation column
 * the chat and the composer make room for it (ConversationView pads them);
 * narrower, it overlays the chat and Escape closes it.
 *
 * Props: sessionId, snapshot (the viewed chat window), build (a Build session
 * bound to a project), agentBusy (a turn runs in it), child (a subagent view).
 * Emits: reveal(nodeKey), open-subagent(sessionId), close.
 */
import {
  ArrowUpRight,
  ChevronDown,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Globe,
  Image,
  Laptop,
  ListChecks,
  Paperclip,
  Plug,
  Plus,
  TriangleAlert,
  Workflow,
  X,
} from 'lucide-vue-next'
import {
  computed,
  defineAsyncComponent,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Component,
} from 'vue'
import { useRouter } from 'vue-router'
import { openExternal } from '../../../api/backend'
import { core } from '../../../api/http'
import { useAppContext } from '../../../composables/useAppContext'
import {
  PLAN_STATUS_LABEL,
  planSummary,
  type PlanSummary,
} from '../../../conversation/planSummary'
import type { ChatSnapshot } from '../../../conversation/types'
import type { RuntimeTaskRecord } from '../../../types'
import { DsSkill } from '../../icons/ds'
import IconButton from '../../ui/IconButton.vue'
import Menu from '../../ui/Menu.vue'
import MenuItem from '../../ui/MenuItem.vue'
import { modalLayerCount } from '../../ui/modalStack'
import {
  avatarToken,
  backgroundTaskLines,
  backgroundTaskSummary,
  backgroundTaskTime,
  compareBranchLink,
  environmentSubagentGroups,
  isLiveTaskStatus,
  SUBAGENT_STATUS_LABEL,
  subagentTaskStatus,
  type BackgroundTaskLine,
  type CompareLink,
  type RemoteInfo,
} from '../../workspace/environmentModel'
import { useWorkspaceSnapshot } from '../../workspace/useWorkspaceSnapshot'
import { gitTransientLabel } from '../../workspace/workspaceModel'
import {
  sourcesFromSnapshot,
  type EnvironmentSource,
  type EnvironmentSourceKind,
  type SourceToolInfo,
} from '../../workspace/workspaceSources'
import {
  openWorkspacePane,
  requestWorkspace,
} from '../../workspace/workspaceState'
import { isGitStatus } from '../../workspace/workspaceTypes'

/**
 * Conversation column width from which the card sits beside the chat
 * (mirrors the `@container conversation (min-width: 1120px)` rule in
 * ConversationView).
 */
const ENV_CARD_INLINE_MIN = 1120
/** Gap (px) kept under a card that runs down beside the padded composer. */
const INLINE_BOTTOM_GAP = 16
const VISIBLE_ROWS = 3
const TaskOutputDialog = defineAsyncComponent(
  () => import('./TaskOutputDialog.vue'),
)

const props = withDefaults(
  defineProps<{
    sessionId: string
    snapshot: ChatSnapshot
    build?: boolean
    agentBusy?: boolean
    child?: boolean
  }>(),
  { build: false, agentBusy: false, child: false },
)

const emit = defineEmits<{
  reveal: [nodeKey: string]
  'open-subagent': [sessionId: string]
  close: []
}>()

const ctx = useAppContext()
const router = useRouter()

// ── placement: beside the chat or overlaying it ────────────────────────
const root = ref<HTMLElement | null>(null)
const overlay = ref(false)
let resizeObserver: ResizeObserver | null = null
/**
 * ConversationView is kept alive: a cached (deactivated) card must neither
 * answer Escape on another page nor keep polling.
 */
const activated = ref(true)
/**
 * Beside the chat the composer stack is padded away from the card, so the
 * card may run down to the column bottom (px; null = the CSS cap above the
 * composer seat, used while overlaying).
 */
const inlineMaxHeight = ref<number | null>(null)

/**
 * Escape closes an open card menu first (focus may still sit on its row),
 * then — only while overlaying the chat and under no modal — the card.
 */
function onKeydown(event: KeyboardEvent): void {
  if (!activated.value || event.key !== 'Escape') return
  if (event.defaultPrevented || event.isComposing) return
  if (worktreeMenu.value || branchMenu.value || sourcesMenu.value) {
    event.preventDefault()
    worktreeMenu.value = false
    branchMenu.value = false
    sourcesMenu.value = false
    return
  }
  if (!overlay.value || modalLayerCount() > 0) return
  event.preventDefault()
  emit('close')
}

onActivated(() => {
  activated.value = true
})
onDeactivated(() => {
  activated.value = false
})

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  const host = root.value?.closest<HTMLElement>('.conversation-root')
  if (!host || typeof ResizeObserver === 'undefined') return
  const measure = () => {
    overlay.value = host.clientWidth < ENV_CARD_INLINE_MIN
    const card = root.value
    if (!card || overlay.value) {
      inlineMaxHeight.value = null
      return
    }
    const available =
      host.getBoundingClientRect().bottom -
      card.getBoundingClientRect().top -
      INLINE_BOTTOM_GAP
    inlineMaxHeight.value = Math.max(160, Math.round(available))
  }
  measure()
  resizeObserver = new ResizeObserver(measure)
  resizeObserver.observe(host)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  resizeObserver?.disconnect()
})

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

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
const activeWorktree = computed(
  () =>
    workspaceSnapshot.value?.worktrees?.owned?.find((entry) => entry.active) ??
    null,
)
const transient = computed(() =>
  git.value ? gitTransientLabel(git.value.repository.transientState) : '',
)
const gitBusy = ref(false)
const writesBlockedReason = computed(() => {
  if (!git.value) return '工作区尚未就绪'
  if (props.agentBusy) return '智能体运行中，完成后再操作'
  if (gitBusy.value) return '正在执行 Git 操作…'
  if (transient.value) return transient.value
  if (git.value.truncated) return '改动过多，请在审查中处理'
  return ''
})
const writesDisabled = computed(() => Boolean(writesBlockedReason.value))
const unavailableLine = computed(() =>
  props.child
    ? '子会话 · 在父会话中查看变更与分支'
    : '未绑定项目 · Build 会话可查看变更与分支',
)
const gitLine = computed(() => {
  if (!workspaceSnapshot.value)
    return workspace.error.value
      ? `无法读取工作区：${workspace.error.value}`
      : '正在读取工作区…'
  return git.value ? '' : '项目还不是 Git 仓库'
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

async function runGit(action: () => Promise<unknown>): Promise<void> {
  gitBusy.value = true
  try {
    await action()
  } catch (cause) {
    ctx.showToast(message(cause))
  } finally {
    gitBusy.value = false
    void workspace.refresh()
  }
}

function openReview(): void {
  requestWorkspace({ pane: 'review' })
}

function openCommit(): void {
  requestWorkspace({ pane: 'review', focus: 'commit' })
}

// 本地 / worktree ▾
const worktreeButton = ref<HTMLElement | null>(null)
const worktreeMenu = ref(false)

async function enterWorktree(): Promise<void> {
  const status = git.value
  if (!status || writesDisabled.value || activeWorktree.value) return
  if (!window.confirm('创建并进入临时 worktree？')) return
  await runGit(() =>
    core('git.enterWorktree', {
      sessionId: props.sessionId,
      expectedRevision: status.revision,
      confirmed: true,
    }),
  )
}

async function exitWorktree(action: 'keep' | 'remove'): Promise<void> {
  const status = git.value
  const worktree = activeWorktree.value
  if (!status || !worktree || writesDisabled.value) return
  if (
    !window.confirm(
      action === 'remove'
        ? `删除 Emperor 创建的 worktree ${worktree.path}？存在修改或未推送提交时会拒绝。`
        : '退出当前临时 worktree，并保留其目录和分支？',
    )
  )
    return
  await runGit(() =>
    core('git.exitWorktree', {
      sessionId: props.sessionId,
      action,
      discardChanges: false,
      expectedRevision: status.revision,
      confirmed: true,
    }),
  )
}

// branch ▾
const branchButton = ref<HTMLElement | null>(null)
const branchMenu = ref(false)
const branches = shallowRef<Array<{ name: string; upstream: string | null }>>(
  [],
)
const branchesLoading = ref(false)
const branchesError = ref('')

async function toggleBranchMenu(): Promise<void> {
  branchMenu.value = !branchMenu.value
  if (!branchMenu.value) return
  const owner = props.sessionId
  branchesLoading.value = true
  branchesError.value = ''
  try {
    const result = await core('git.branches', { sessionId: owner })
    if (owner === props.sessionId) branches.value = result.branches
  } catch (cause) {
    if (owner === props.sessionId) branchesError.value = message(cause)
  } finally {
    branchesLoading.value = false
  }
}

async function switchBranch(name: string): Promise<void> {
  const status = git.value
  if (!status || writesDisabled.value || name === status.branch) return
  if (!window.confirm(`切换到分支 ${name}？`)) return
  await runGit(() =>
    core('git.switchBranch', {
      sessionId: props.sessionId,
      name,
      expectedRevision: status.revision,
      confirmed: true,
    }),
  )
}

// 比较分支 ↗
const remote = shallowRef<RemoteInfo | null>(null)
const remoteState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')

watch(
  () => (git.value ? props.sessionId : ''),
  async (owner) => {
    remote.value = null
    remoteState.value = owner ? 'loading' : 'idle'
    if (!owner) return
    try {
      const info = await core('git.remote', { sessionId: owner })
      if (owner !== props.sessionId) return
      remote.value = info
      remoteState.value = 'ready'
    } catch {
      if (owner === props.sessionId) remoteState.value = 'error'
    }
  },
  { immediate: true },
)

const compare = computed<CompareLink>(() => {
  if (remoteState.value === 'error')
    return { url: null, reason: '无法读取远端' }
  if (remoteState.value !== 'ready') return { url: null, reason: '读取远端…' }
  return compareBranchLink({
    remote: remote.value,
    base: git.value?.repository.defaultBranch ?? null,
    head: git.value?.branch ?? null,
  })
})

/** The compare URL, or why there is none. */
const compareHint = computed(() => {
  const link = compare.value
  return link.url === null ? link.reason : link.url
})

async function openCompare(): Promise<void> {
  const url = compare.value.url
  if (!url) return
  try {
    await openExternal(url)
  } catch (cause) {
    ctx.showToast(message(cause))
  }
}

// ── plan ────────────────────────────────────────────────────────────────
const plan = computed(() => planSummary(props.snapshot))

function planValue(summary: PlanSummary): string {
  if (summary.status === 'executing')
    return `${summary.steps.done}/${summary.steps.total}`
  return PLAN_STATUS_LABEL[summary.status]
}

// ── subagents and background tasks (tasks.list) ─────────────────────────
const tasks = shallowRef<RuntimeTaskRecord[]>([])
const showAllSubagents = ref(false)
const backgroundOpen = ref(false)
const showAllBackground = ref(false)
/** The background task whose 「输出」 is open. */
const outputTask = shallowRef<Pick<
  BackgroundTaskLine,
  'id' | 'label' | 'kind'
> | null>(null)
let taskGeneration = 0
let taskTimer: ReturnType<typeof setTimeout> | undefined
let taskPoll: ReturnType<typeof setInterval> | undefined

async function loadTasks(): Promise<void> {
  const owner = props.sessionId
  const generation = ++taskGeneration
  try {
    const list: unknown = await core('tasks.list', { sessionId: owner })
    if (generation === taskGeneration)
      tasks.value = Array.isArray(list) ? (list as RuntimeTaskRecord[]) : []
  } catch {
    // The card stays usable when the task list is unavailable.
    if (generation === taskGeneration) tasks.value = []
  }
}

watch(
  () => props.sessionId,
  () => {
    tasks.value = []
    showAllSubagents.value = false
    backgroundOpen.value = false
    showAllBackground.value = false
    outputTask.value = null
    void loadTasks()
  },
  { immediate: true },
)
// New transcript rows or a settled turn may start or finish a task.
watch(
  () => [props.snapshot.order.length, props.snapshot.running] as const,
  () => {
    clearTimeout(taskTimer)
    taskTimer = setTimeout(() => void loadTasks(), 400)
  },
)
const tasksRunning = computed(
  () =>
    activated.value &&
    tasks.value.some((task) => isLiveTaskStatus(task.status)),
)
watch(
  tasksRunning,
  (running) => {
    clearInterval(taskPoll)
    taskPoll = running
      ? setInterval(() => {
          if (document.hasFocus()) void loadTasks()
        }, 5_000)
      : undefined
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  taskGeneration += 1
  clearTimeout(taskTimer)
  clearInterval(taskPoll)
  clearInterval(clockTimer)
})

const subagents = computed(() =>
  environmentSubagentGroups(
    tasks.value
      .filter((task) => task.kind === 'subagent')
      .map((task) => ({
        id: task.id,
        name: task.description || task.label || '子智能体',
        status: subagentTaskStatus(task),
        started_at: task.started_at,
        ended_at: task.finished_at ?? task.started_at,
        avatar: avatarToken(task.id),
      })),
  ),
)
const visibleSubagents = computed(() =>
  showAllSubagents.value
    ? subagents.value.ordered
    : subagents.value.ordered.slice(0, VISIBLE_ROWS),
)
const hiddenSubagents = computed(() =>
  Math.max(0, subagents.value.ordered.length - VISIBLE_ROWS),
)
const background = computed(() => backgroundTaskSummary(tasks.value))
const backgroundValue = computed(() =>
  background.value.running
    ? `${background.value.running} 个运行中`
    : `${background.value.total} 个已结束`,
)

// 后台任务 ▾: one line per job / workflow run; live ones are always shown.
const backgroundLines = computed(() => backgroundTaskLines(tasks.value))
const backgroundShown = computed(() =>
  Math.max(VISIBLE_ROWS, background.value.running),
)
const visibleBackground = computed(() =>
  showAllBackground.value
    ? backgroundLines.value
    : backgroundLines.value.slice(0, backgroundShown.value),
)
const hiddenBackground = computed(() =>
  Math.max(0, backgroundLines.value.length - backgroundShown.value),
)
/** Elapsed times tick while the list is open and something runs. */
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | undefined
watch(
  () => activated.value && backgroundOpen.value && background.value.running,
  (ticking) => {
    clearInterval(clockTimer)
    now.value = Date.now()
    clockTimer = ticking
      ? setInterval(() => {
          now.value = Date.now()
        }, 1_000)
      : undefined
  },
  { immediate: true },
)

function lineMeta(line: BackgroundTaskLine): string {
  return [
    line.detail,
    backgroundTaskTime(
      {
        status: line.status,
        started_at: line.startedAt,
        finished_at: line.finishedAt,
      },
      now.value,
    ),
  ]
    .filter(Boolean)
    .join(' · ')
}

function lineTitle(line: BackgroundTaskLine): string {
  return [line.label, line.statusLabel, line.error].filter(Boolean).join('\n')
}

const stopping = shallowRef<ReadonlySet<string>>(new Set())

async function stopTask(line: BackgroundTaskLine): Promise<void> {
  if (!line.stoppable || stopping.value.has(line.id)) return
  if (
    line.confirmStop &&
    !window.confirm(
      `停止工作流「${line.label}」？它正在运行的子代理也会一起停止。`,
    )
  )
    return
  stopping.value = new Set([...stopping.value, line.id])
  try {
    await core('tasks.cancel', line.id, {
      reason: 'user_stopped_from_environment_card',
    })
  } catch (cause) {
    ctx.showToast(message(cause))
  }
  await loadTasks()
  const next = new Set(stopping.value)
  next.delete(line.id)
  stopping.value = next
}

const outputLive = computed(() => {
  const id = outputTask.value?.id
  return backgroundLines.value.some((line) => line.id === id && line.live)
})

function openOutput(line: BackgroundTaskLine): void {
  outputTask.value = { id: line.id, label: line.label, kind: line.kind }
}

// ── sources ─────────────────────────────────────────────────────────────
/** `skills.tools` fetched once an MCP call is missing from the boot list. */
const fetchedTools = shallowRef<SourceToolInfo[] | null>(null)
let toolsRequested = false
const toolCatalog = computed<readonly SourceToolInfo[]>(
  () => fetchedTools.value ?? ctx.boot.value?.tools ?? [],
)
const sources = computed(() =>
  sourcesFromSnapshot(props.snapshot, { tools: toolCatalog.value }),
)
// Tool names never change once a row exists: rescan only for new rows.
watch(
  () => props.snapshot.order.length,
  () => {
    const snapshot = props.snapshot
    if (toolsRequested) return
    const known = new Set(toolCatalog.value.map((tool) => tool.name))
    const unresolved = snapshot.order.some((key) => {
      const node = snapshot.nodes.get(key)
      return (
        node?.kind === 'tool' &&
        node.data.name.startsWith('mcp_') &&
        !known.has(node.data.name)
      )
    })
    if (!unresolved) return
    toolsRequested = true
    void core('skills.tools')
      .then((list) => {
        if (Array.isArray(list)) fetchedTools.value = list
      })
      .catch(() => undefined)
  },
  { immediate: true },
)
const sourcesButton = ref<HTMLElement | null>(null)
const sourcesMenu = ref(false)

const SOURCE_ICON: Record<EnvironmentSourceKind, Component> = {
  attachment: Paperclip,
  media: Image,
  web: Globe,
  mcp: Plug,
  skill: DsSkill,
}

const SOURCE_KIND_LABEL: Record<EnvironmentSourceKind, string> = {
  attachment: '附件',
  media: '图片',
  web: '网页',
  mcp: 'MCP',
  skill: 'Skill',
}

function sourceCount(source: EnvironmentSource): string {
  return source.count > 1 ? `×${source.count}` : ''
}

function openSource(source: EnvironmentSource): void {
  if (source.kind === 'mcp')
    void router
      .push({ name: 'capabilities', params: { tab: 'mcp' } })
      .catch(() => undefined)
  else if (source.kind === 'skill' && source.name !== 'Skill')
    void router
      .push({
        name: 'capabilities',
        params: { tab: 'skills' },
        query: { skill: source.name },
      })
      .catch(() => undefined)
}

function connectSource(): void {
  void router
    .push({ name: 'capabilities', params: { tab: 'mcp' } })
    .catch(() => undefined)
}

function openLauncher(): void {
  openWorkspacePane('launcher')
}
</script>

<template>
  <aside
    ref="root"
    class="environment-card"
    :data-overlay="overlay || undefined"
    :data-session-id="sessionId"
    :style="
      inlineMaxHeight === null
        ? undefined
        : { maxHeight: `${inlineMaxHeight}px` }
    "
    aria-label="环境信息"
  >
    <header class="card-head">
      <h2 class="card-title">环境信息</h2>
      <IconButton label="打开工作台" @click="openLauncher">
        <Plus :size="15" />
      </IconButton>
      <IconButton v-if="overlay" label="关闭环境信息" @click="emit('close')">
        <X :size="15" />
      </IconButton>
    </header>

    <div class="card-body">
      <section v-if="build" class="section" data-section="git">
        <p v-if="gitLine" class="muted-line">{{ gitLine }}</p>
        <template v-else-if="git">
          <button
            type="button"
            class="row"
            data-row="changes"
            @click="openReview"
          >
            <FileDiff :size="15" class="row-icon" />
            <span class="row-label">变更</span>
            <span v-if="git.summary.changedFiles" class="row-value changes">
              <b>+{{ git.summary.additions }}</b>
              <i>−{{ git.summary.deletions }}</i>
            </span>
            <span v-else class="row-value">无改动</span>
          </button>
          <button
            ref="worktreeButton"
            type="button"
            class="row"
            data-row="worktree"
            aria-haspopup="menu"
            :aria-expanded="worktreeMenu"
            @click="worktreeMenu = !worktreeMenu"
          >
            <FolderGit2 v-if="activeWorktree" :size="15" class="row-icon" />
            <Laptop v-else :size="15" class="row-icon" />
            <span class="row-label">{{
              activeWorktree ? 'Worktree' : '本地'
            }}</span>
            <span v-if="activeWorktree?.branch" class="row-value">{{
              activeWorktree.branch
            }}</span>
            <ChevronDown :size="14" class="row-caret" />
          </button>
          <button
            ref="branchButton"
            type="button"
            class="row"
            data-row="branch"
            aria-haspopup="menu"
            :aria-expanded="branchMenu"
            @click="toggleBranchMenu"
          >
            <GitBranch :size="15" class="row-icon" />
            <span class="row-label mono">{{
              git.branch ||
              (git.repository.unborn ? '未提交的分支' : '分离 HEAD')
            }}</span>
            <span v-if="aheadBehind" class="row-value">{{ aheadBehind }}</span>
            <ChevronDown :size="14" class="row-caret" />
          </button>
          <p v-if="transient" class="row static warn" role="status">
            <TriangleAlert :size="15" class="row-icon" />
            <span class="row-label">{{ transient }}</span>
          </p>
          <button
            type="button"
            class="row"
            data-row="commit"
            @click="openCommit"
          >
            <GitCommitHorizontal :size="15" class="row-icon" />
            <span class="row-label">提交或推送</span>
          </button>
          <button
            type="button"
            class="row"
            data-row="compare"
            :aria-disabled="!compare.url || undefined"
            :title="compareHint"
            @click="openCompare"
          >
            <GitCompareArrows :size="15" class="row-icon" />
            <span class="row-label">比较分支</span>
            <span v-if="!compare.url" class="row-value">{{ compareHint }}</span>
            <ArrowUpRight v-else :size="14" class="row-caret" />
          </button>
        </template>
      </section>
      <p v-else class="section muted-line" data-section="git">
        {{ unavailableLine }}
      </p>

      <section v-if="plan" class="section" data-section="plan">
        <h3 class="section-head">计划</h3>
        <button
          type="button"
          class="row"
          data-row="plan"
          :title="plan.title"
          @click="emit('reveal', plan.key)"
        >
          <ListChecks :size="15" class="row-icon" />
          <span class="row-label">{{ plan.title }}</span>
          <span class="row-value" :data-status="plan.status">{{
            planValue(plan)
          }}</span>
        </button>
      </section>

      <section
        v-if="subagents.ordered.length"
        class="section"
        data-section="subagents"
      >
        <h3 class="section-head">
          子智能体
          <span v-if="subagents.active.length" class="section-meta"
            >{{ subagents.active.length }} 个运行中</span
          >
        </h3>
        <button
          v-for="agent in visibleSubagents"
          :key="agent.id"
          type="button"
          class="row agent"
          :title="agent.name"
          @click="emit('open-subagent', agent.id)"
        >
          <span
            class="avatar"
            :data-status="agent.status"
            :style="{ background: `rgb(var(${agent.avatar}))` }"
            aria-hidden="true"
          />
          <span class="row-label">{{ agent.name }}</span>
          <span class="row-value" :data-status="agent.status">{{
            SUBAGENT_STATUS_LABEL[agent.status] ?? agent.status
          }}</span>
        </button>
        <button
          v-if="hiddenSubagents"
          type="button"
          class="more"
          :aria-expanded="showAllSubagents"
          @click="showAllSubagents = !showAllSubagents"
        >
          {{ showAllSubagents ? '收起' : `再显示 ${hiddenSubagents} 个` }}
        </button>
      </section>

      <section
        v-if="background.total"
        class="section"
        data-section="background"
      >
        <button
          type="button"
          class="row"
          data-row="background"
          :aria-expanded="backgroundOpen"
          aria-controls="env-card-background"
          @click="backgroundOpen = !backgroundOpen"
        >
          <Workflow :size="15" class="row-icon" />
          <span class="row-label">后台任务</span>
          <span
            class="row-value"
            :data-status="background.running ? 'running' : undefined"
            >{{ backgroundValue }}</span
          >
          <ChevronDown :size="14" class="row-caret" data-turn />
        </button>
        <ul
          v-if="backgroundOpen"
          id="env-card-background"
          class="task-list"
          aria-label="后台任务"
        >
          <li
            v-for="line in visibleBackground"
            :key="line.id"
            class="task-line"
            :data-task-id="line.id"
            :data-kind="line.kind"
            :title="lineTitle(line)"
          >
            <span
              class="task-dot"
              :data-status="line.tone"
              aria-hidden="true"
            />
            <span class="task-label" :class="{ mono: line.kind === 'job' }">{{
              line.label
            }}</span>
            <span class="task-meta">
              <span class="sr-only">{{ line.statusLabel }} · </span
              >{{ lineMeta(line) }}
            </span>
            <button
              type="button"
              class="task-action"
              :aria-label="`查看输出：${line.label}`"
              @click="openOutput(line)"
            >
              输出
            </button>
            <button
              v-if="line.stoppable"
              type="button"
              class="task-action"
              data-action="stop"
              :aria-label="`停止：${line.label}`"
              :disabled="stopping.has(line.id)"
              @click="stopTask(line)"
            >
              {{ stopping.has(line.id) ? '停止中' : '停止' }}
            </button>
          </li>
          <li v-if="hiddenBackground" class="task-more">
            <button
              type="button"
              class="more"
              :aria-expanded="showAllBackground"
              @click="showAllBackground = !showAllBackground"
            >
              {{ showAllBackground ? '收起' : `再显示 ${hiddenBackground} 个` }}
            </button>
          </li>
        </ul>
      </section>

      <section v-if="sources.length" class="section" data-section="sources">
        <h3 class="section-head">
          来源
          <button
            type="button"
            class="section-action"
            aria-label="连接来源"
            title="连接来源"
            @click="connectSource"
          >
            <Plus :size="13" />
          </button>
        </h3>
        <button
          v-for="source in sources.slice(0, VISIBLE_ROWS)"
          :key="source.id"
          type="button"
          class="row"
          :data-kind="source.kind"
          :title="`${SOURCE_KIND_LABEL[source.kind]} · ${source.name}`"
          @click="openSource(source)"
        >
          <component
            :is="SOURCE_ICON[source.kind]"
            :size="15"
            class="row-icon"
          />
          <span class="row-label">{{ source.name }}</span>
          <span v-if="source.count > 1" class="row-value">{{
            sourceCount(source)
          }}</span>
        </button>
        <button
          v-if="sources.length > VISIBLE_ROWS"
          ref="sourcesButton"
          type="button"
          class="more"
          aria-haspopup="menu"
          :aria-expanded="sourcesMenu"
          @click="sourcesMenu = !sourcesMenu"
        >
          查看全部 · {{ sources.length }}
        </button>
      </section>
    </div>

    <Menu
      v-model:open="worktreeMenu"
      :anchor="worktreeButton"
      placement="bottom"
      :width="248"
      label="工作位置"
    >
      <MenuItem variant="label">工作位置</MenuItem>
      <MenuItem
        :selected="!activeWorktree"
        :disabled="Boolean(activeWorktree) && writesDisabled"
        :description="
          activeWorktree ? '退出 worktree，保留其目录和分支' : '项目目录'
        "
        @select="exitWorktree('keep')"
      >
        本地
        <template #icon><Laptop :size="15" /></template>
      </MenuItem>
      <MenuItem
        v-if="activeWorktree"
        selected
        :description="activeWorktree.path"
      >
        Worktree · {{ activeWorktree.branch || '分离 HEAD' }}
        <template #icon><FolderGit2 :size="15" /></template>
      </MenuItem>
      <MenuItem
        v-else
        :disabled="writesDisabled"
        description="创建并进入临时 worktree"
        @select="enterWorktree"
      >
        新建 worktree
        <template #icon><FolderGit2 :size="15" /></template>
      </MenuItem>
      <template v-if="activeWorktree">
        <MenuItem variant="separator" />
        <MenuItem
          danger
          :disabled="writesDisabled"
          description="存在修改或未推送提交时会拒绝"
          @select="exitWorktree('remove')"
        >
          安全删除 worktree
        </MenuItem>
      </template>
      <template v-if="writesBlockedReason" #footer>
        <p class="menu-note">{{ writesBlockedReason }}</p>
      </template>
    </Menu>

    <Menu
      v-model:open="branchMenu"
      :anchor="branchButton"
      placement="bottom"
      :width="248"
      dense
      label="切换分支"
    >
      <MenuItem variant="label">分支</MenuItem>
      <MenuItem v-if="branchesLoading && !branches.length" disabled>
        正在读取分支…
      </MenuItem>
      <p v-else-if="branchesError" class="menu-note">{{ branchesError }}</p>
      <MenuItem
        v-for="branch in branches"
        :key="branch.name"
        :selected="branch.name === git?.branch"
        :disabled="branch.name !== git?.branch && writesDisabled"
        :description="branch.upstream ?? undefined"
        @select="switchBranch(branch.name)"
      >
        {{ branch.name }}
      </MenuItem>
      <template #footer>
        <p v-if="writesBlockedReason" class="menu-note">
          {{ writesBlockedReason }}
        </p>
        <MenuItem @select="openReview">在审查中管理分支</MenuItem>
      </template>
    </Menu>

    <TaskOutputDialog
      v-if="outputTask"
      :key="outputTask.id"
      :task-id="outputTask.id"
      :label="outputTask.label"
      :kind="outputTask.kind"
      :live="outputLive"
      @close="outputTask = null"
    />

    <Menu
      v-model:open="sourcesMenu"
      :anchor="sourcesButton"
      placement="bottom"
      :width="248"
      dense
      label="全部来源"
    >
      <MenuItem variant="label">全部来源 · {{ sources.length }}</MenuItem>
      <MenuItem
        v-for="source in sources"
        :key="source.id"
        :description="SOURCE_KIND_LABEL[source.kind]"
        @select="openSource(source)"
      >
        {{ source.name }}
        <template #icon>
          <component :is="SOURCE_ICON[source.kind]" :size="15" />
        </template>
        <template #trailing>
          <span class="menu-count">{{ source.count }}</span>
        </template>
      </MenuItem>
    </Menu>
  </aside>
</template>

<style scoped>
.environment-card {
  position: absolute;
  top: var(--space-3);
  right: var(--space-4);
  z-index: var(--z-raised);
  display: flex;
  flex-direction: column;
  width: min(var(--env-card-width, 340px), 100% - 2 * var(--space-4));
  max-height: calc(100% - var(--space-3) - var(--space-8) - var(--space-6));
  overflow: hidden;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-1));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--label-primary));
}

/* Beside the chat it may run past the composer seat (padded away from it),
   so it stacks above the seat's fade. */
.environment-card:not([data-overlay]) {
  z-index: var(--z-sticky);
}

.environment-card[data-overlay] {
  border-color: var(--border-l2);
  box-shadow: var(--shadow-lv3);
}

.card-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  padding: var(--space-2) var(--space-2) var(--space-1) var(--space-3-5);
}

.card-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
}

.card-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0 var(--space-1-5) var(--space-2);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: var(--space-1) 0;
}

.section + .section {
  border-top: 1px solid var(--border-l1);
}

.section-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-1) var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
}

.section-meta {
  margin-left: auto;
  font-weight: 400;
}

.section-action {
  display: inline-grid;
  width: var(--space-5);
  height: var(--space-5);
  margin-left: auto;
  place-items: center;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.section-action:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  min-height: var(--space-8);
  margin: 0;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: left;
}

button.row {
  cursor: pointer;
}

button.row:hover {
  background: var(--interactive-bg-hover);
}

button.row:focus-visible,
.more:focus-visible,
.section-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

button.row[aria-disabled='true'] {
  cursor: default;
}

button.row[aria-disabled='true']:hover {
  background: transparent;
}

button.row[aria-disabled='true'] .row-label {
  color: rgb(var(--label-tertiary));
}

.row.warn,
.row.warn .row-icon {
  color: rgb(var(--state-warn-label));
}

.row-icon {
  flex: none;
  color: rgb(var(--label-secondary));
}

.row-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-label.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
}

.row-value {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-value[data-status='running'],
.row-value[data-status='executing'],
.row-value[data-status='reviewing'] {
  color: rgb(var(--accent-strong));
}

.row-value[data-status='done'],
.row-value[data-status='completed'] {
  color: rgb(var(--state-ok-label));
}

.row-value[data-status='failed'] {
  color: rgb(var(--state-error-label));
}

.row-caret {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.row-caret[data-turn] {
  transition: transform var(--duration-ds-fast) var(--ease-in-out);
}

.row[aria-expanded='true'] .row-caret[data-turn] {
  transform: rotate(180deg);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: var(--space-7);
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-row);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

/* In the row-icon column, so labels line up with 后台任务. */
.task-dot {
  flex: none;
  width: var(--space-1-5);
  height: var(--space-1-5);
  margin: 0 calc((15px - var(--space-1-5)) / 2);
  border-radius: var(--radius-pill);
  background: rgb(var(--label-tertiary));
}

.task-dot[data-status='running'] {
  background: rgb(var(--accent-strong));
  animation: env-card-pulse 1.6s ease-in-out infinite;
}

.task-dot[data-status='completed'] {
  background: rgb(var(--state-ok-label));
}

.task-dot[data-status='failed'] {
  background: rgb(var(--state-error-label));
}

.task-dot[data-status='cancelled'] {
  opacity: 0.55;
}

.task-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-label.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
}

.task-meta {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-action {
  flex: none;
  padding: var(--space-0-5) var(--space-1-5);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-secondary));
  font: inherit;
  cursor: pointer;
}

.task-action:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
}

.task-action:not([data-action='stop']):hover {
  color: rgb(var(--label-primary));
}

.task-action[data-action='stop'] {
  color: rgb(var(--state-error-label));
}

.task-action:disabled {
  color: rgb(var(--label-tertiary));
  cursor: default;
}

.task-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.task-more {
  display: flex;
}

.changes {
  display: inline-flex;
  gap: var(--space-1-5);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.changes b {
  color: rgb(var(--state-ok-label));
  font-weight: 500;
}

.changes i {
  color: rgb(var(--state-error-label));
  font-style: normal;
}

.avatar {
  position: relative;
  flex: none;
  width: var(--space-4);
  height: var(--space-4);
  margin: 0 calc(var(--space-0-5) / 2);
  border-radius: var(--radius-pill);
  box-shadow: inset 0 0 0 1px var(--border-l2);
}

.avatar[data-status='running']::after {
  content: '';
  position: absolute;
  inset: calc(1px - var(--space-1));
  border: 1.5px solid rgb(var(--accent-strong) / 0.8);
  border-radius: var(--radius-pill);
  animation: env-card-pulse 1.6s ease-in-out infinite;
}

.avatar[data-status='failed'],
.avatar[data-status='cancelled'] {
  opacity: 0.55;
}

@keyframes env-card-pulse {
  50% {
    opacity: 0.35;
  }
}

.more {
  align-self: flex-start;
  margin: var(--space-0-5) 0 0 var(--space-8);
  padding: var(--space-0-5) var(--space-1-5);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.more:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.muted-line {
  margin: 0;
  padding: var(--space-2) var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.menu-note {
  margin: 0;
  padding: var(--space-1-5) var(--space-2-5);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.menu-count {
  flex: none;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}
</style>
