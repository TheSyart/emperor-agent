<script setup lang="ts">
/**
 * GitReviewPane — the right workspace's 审查 pane: branch / worktree / PR
 * controls, grouped changes with diffs and the commit box.
 *
 * Props:
 * - sessionId, hasProject, agentBusy (disables conflicting Git writes).
 * - focusPaths?: limit the change list to these files (本次任务 filter).
 * - commitFocus?: nonce; a new non-zero value scrolls to the commit box and
 *   focuses it once the status has loaded (requestWorkspace focus 'commit').
 * Emits: commitFocused — that request has been handled.
 */
import type {
  GitFileStatus,
  GitStatusResult,
  GitWorktreeSummary,
  PullRequestSummary,
} from '@emperor/core/api'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  FileDiff,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Workflow,
} from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { core } from '../../api/http'
import {
  gitFileChangeLabel,
  gitTransientLabel,
  filterGitFilesByPaths,
  groupGitFiles,
} from './workspaceModel'

const props = defineProps<{
  sessionId: string
  hasProject: boolean
  agentBusy: boolean
  focusPaths?: string[]
  commitFocus?: number
}>()
const emit = defineEmits<{ commitFocused: [] }>()

const status = ref<GitStatusResult | null>(null)
const loading = ref(false)
const error = ref('')
const diff = ref('')
const diffTruncated = ref(false)
const selectedPath = ref('')
const commitMessage = ref('')
const branchName = ref('')
const compareBase = ref('')
const worktreeName = ref('')
const worktrees = ref<GitWorktreeSummary[]>([])
const ownedWorktrees = ref<GitWorktreeSummary[]>([])
const pullRequest = ref<PullRequestSummary | null>(null)
const pullRequestError = ref('')
const publishPreview = ref<{
  baseRef: string
  branch: string
  headOid: string
  commits: Array<{ oid: string; subject: string }>
  additions: number
  deletions: number
  binary: number
  changedFiles: number
  uncommittedFiles: number
} | null>(null)
const pullRequestTitle = ref('')
const pullRequestBody = ref('')
const pullRequestDraft = ref(true)
const branches = ref<
  Array<{ name: string; head: string; upstream: string | null }>
>([])
const focusFilterActive = ref(Boolean(props.focusPaths?.length))
const paneRoot = ref<HTMLElement | null>(null)
const commitForm = ref<HTMLFormElement | null>(null)
const commitInput = ref<HTMLTextAreaElement | null>(null)
const commitFocusPending = ref(false)
/** Brief accent ring on the commit box after a focus request. */
const commitAttention = ref(false)
let attentionTimer: ReturnType<typeof setTimeout> | undefined
let refreshGeneration = 0
let diffGeneration = 0
let pollTimer: number | undefined

const visibleFiles = computed(() =>
  focusFilterActive.value
    ? filterGitFilesByPaths(status.value?.files ?? [], props.focusPaths || [])
    : (status.value?.files ?? []),
)
const groups = computed(() => groupGitFiles(visibleFiles.value))
const transientLabel = computed(() =>
  status.value ? gitTransientLabel(status.value.repository.transientState) : '',
)
const gitWritesDisabled = computed(
  () =>
    props.agentBusy ||
    loading.value ||
    Boolean(transientLabel.value) ||
    Boolean(status.value?.truncated),
)
const activeWorktree = computed(
  () => ownedWorktrees.value.find((entry) => entry.active) ?? null,
)

onMounted(() => {
  window.addEventListener('focus', refreshOnFocus)
  void refresh()
  pollTimer = window.setInterval(() => {
    if (document.hasFocus() && !loading.value) void refresh()
  }, 5_000)
})
onBeforeUnmount(() => {
  refreshGeneration += 1
  diffGeneration += 1
  window.removeEventListener('focus', refreshOnFocus)
  window.clearInterval(pollTimer)
  clearTimeout(attentionTimer)
})
watch(
  () => props.sessionId,
  () => {
    refreshGeneration += 1
    diffGeneration += 1
    status.value = null
    branches.value = []
    worktrees.value = []
    ownedWorktrees.value = []
    pullRequest.value = null
    pullRequestError.value = ''
    publishPreview.value = null
    selectedPath.value = ''
    diff.value = ''
    diffTruncated.value = false
    compareBase.value = ''
    void refresh()
  },
)
watch(
  () => (props.focusPaths || []).join('\u0000'),
  (paths) => {
    focusFilterActive.value = Boolean(paths)
    selectedPath.value = ''
    diff.value = ''
  },
)

// A commit-focus request waits for the status (the form renders with it).
watch(
  () => props.commitFocus,
  (nonce) => {
    if (nonce) commitFocusPending.value = true
  },
  { immediate: true },
)
watch([commitFocusPending, status], () => void revealCommitBox(), {
  flush: 'post',
})

async function revealCommitBox(): Promise<void> {
  if (!commitFocusPending.value || !status.value) return
  await nextTick()
  const root = paneRoot.value
  const form = commitForm.value
  if (!root || !form || !commitFocusPending.value) return
  commitFocusPending.value = false
  // Center the box in the pane's own scroller (never scroll the frame).
  const rootRect = root.getBoundingClientRect()
  const formRect = form.getBoundingClientRect()
  root.scrollTop +=
    formRect.top -
    rootRect.top -
    Math.max(0, rootRect.height - formRect.height) / 2
  commitInput.value?.focus({ preventScroll: true })
  commitAttention.value = true
  clearTimeout(attentionTimer)
  attentionTimer = setTimeout(() => (commitAttention.value = false), 1_600)
  emit('commitFocused')
}

function refreshOnFocus(): void {
  if (!loading.value) void refresh()
}

async function refresh(): Promise<void> {
  if (!props.hasProject || !props.sessionId) {
    status.value = null
    return
  }
  const owner = props.sessionId
  const generation = ++refreshGeneration
  loading.value = true
  error.value = ''
  try {
    const [next, branchPayload, worktreePayload] = await Promise.all([
      core('git.status', { sessionId: owner }),
      core('git.branches', { sessionId: owner }),
      core('git.worktrees', { sessionId: owner }),
    ])
    if (!isCurrentRefresh(owner, generation)) return
    status.value = next
    branches.value = branchPayload.branches
    worktrees.value = worktreePayload.worktrees
    ownedWorktrees.value = worktreePayload.owned
    if (!compareBase.value)
      compareBase.value =
        branchPayload.branches.find((branch) => branch.name !== next.branch)
          ?.name ?? ''
    void refreshPullRequest(owner, generation)
  } catch (cause) {
    if (isCurrentRefresh(owner, generation)) error.value = message(cause)
  } finally {
    if (isCurrentRefresh(owner, generation)) loading.value = false
  }
}

async function refreshPullRequest(
  owner: string,
  generation: number,
): Promise<void> {
  pullRequestError.value = ''
  try {
    const next = await core('git.pullRequest', { sessionId: owner })
    if (!isCurrentRefresh(owner, generation)) return
    pullRequest.value = next
    if (next && !pullRequestTitle.value) pullRequestTitle.value = ''
  } catch (cause) {
    if (!isCurrentRefresh(owner, generation)) return
    pullRequest.value = null
    pullRequestError.value = friendlyPullRequestError(cause)
  }
}

async function showDiff(
  file: GitFileStatus,
  area: 'worktree' | 'staged',
): Promise<void> {
  const owner = props.sessionId
  const generation = ++diffGeneration
  selectedPath.value = file.path
  try {
    if (file.untracked) {
      const preview = await core('files.read', {
        sessionId: owner,
        relativePath: file.path,
      })
      if (isCurrentDiff(owner, generation)) {
        diff.value =
          preview.kind === 'text'
            ? (preview.content ?? '')
            : `[未跟踪的${preview.kind === 'image' ? '图片' : '二进制'}文件 · ${preview.bytes} bytes]`
        diffTruncated.value = preview.truncated
      }
      return
    }
    const result = await core('git.diff', {
      sessionId: owner,
      path: file.path,
      area,
    })
    if (isCurrentDiff(owner, generation)) {
      diff.value = result.content
      diffTruncated.value = result.truncated
    }
  } catch (cause) {
    if (isCurrentDiff(owner, generation)) error.value = message(cause)
  }
}

async function stage(paths: string[]): Promise<void> {
  if (!status.value || gitWritesDisabled.value) return
  await mutate(() =>
    core('git.stage', {
      sessionId: props.sessionId,
      paths,
      expectedRevision: status.value!.revision,
    }),
  )
}

async function unstage(paths: string[]): Promise<void> {
  if (!status.value || gitWritesDisabled.value) return
  await mutate(() =>
    core('git.unstage', {
      sessionId: props.sessionId,
      paths,
      expectedRevision: status.value!.revision,
    }),
  )
}

async function discard(file: GitFileStatus): Promise<void> {
  if (!status.value || gitWritesDisabled.value) return
  if (!window.confirm(`丢弃 ${file.path} 的未提交修改？操作前会保存恢复快照。`))
    return
  await mutate(() =>
    core('git.discard', {
      sessionId: props.sessionId,
      paths: [file.path],
      expectedRevision: status.value!.revision,
      confirmed: true,
    }),
  )
}

async function commit(): Promise<void> {
  if (!status.value || !commitMessage.value.trim() || gitWritesDisabled.value)
    return
  await mutate(async () => {
    const next = await core('git.commit', {
      sessionId: props.sessionId,
      message: commitMessage.value,
      expectedRevision: status.value!.revision,
    })
    commitMessage.value = ''
    return next
  })
}

async function fetchRemote(): Promise<void> {
  if (!window.confirm('从远端获取最新引用？')) return
  await mutate(() =>
    core('git.fetch', { sessionId: props.sessionId, confirmed: true }),
  )
}

async function pull(): Promise<void> {
  if (
    !status.value ||
    gitWritesDisabled.value ||
    !window.confirm('以 fast-forward only 拉取当前分支？')
  )
    return
  await mutate(() =>
    core('git.pull', {
      sessionId: props.sessionId,
      expectedRevision: status.value!.revision,
      confirmed: true,
    }),
  )
}

async function push(): Promise<void> {
  if (
    !status.value ||
    gitWritesDisabled.value ||
    !window.confirm('推送当前分支到远端？')
  )
    return
  await mutate(() =>
    core('git.push', {
      sessionId: props.sessionId,
      expectedRevision: status.value!.revision,
      setUpstream: !status.value?.upstream,
      confirmed: true,
    }),
  )
}

async function createBranch(): Promise<void> {
  const name = branchName.value.trim()
  if (!name || !status.value || gitWritesDisabled.value) return
  await mutate(async () => {
    const next = await core('git.createBranch', {
      sessionId: props.sessionId,
      name,
      expectedRevision: status.value!.revision,
    })
    branchName.value = ''
    return next
  })
}

async function switchBranch(name: string): Promise<void> {
  if (!status.value || gitWritesDisabled.value || name === status.value.branch)
    return
  if (!window.confirm(`切换到分支 ${name}？`)) return
  await mutate(() =>
    core('git.switchBranch', {
      sessionId: props.sessionId,
      name,
      expectedRevision: status.value!.revision,
      confirmed: true,
    }),
  )
}

async function enterWorktree(): Promise<void> {
  const name = worktreeName.value.trim()
  if (!status.value || gitWritesDisabled.value || !name) return
  if (!window.confirm(`创建并进入临时 worktree ${name}？`)) return
  await mutate(async () => {
    const result = await core('git.enterWorktree', {
      sessionId: props.sessionId,
      name,
      expectedRevision: status.value!.revision,
      confirmed: true,
    })
    worktreeName.value = ''
    return result.status
  })
}

async function exitWorktree(action: 'keep' | 'remove'): Promise<void> {
  if (!status.value || gitWritesDisabled.value || !activeWorktree.value) return
  const remove = action === 'remove'
  if (
    !window.confirm(
      remove
        ? `删除 Emperor 创建的 worktree ${activeWorktree.value.path}？存在修改或未推送提交时会拒绝。`
        : '退出当前临时 worktree，并保留其目录和分支？',
    )
  )
    return
  await mutate(async () => {
    const result = await core('git.exitWorktree', {
      sessionId: props.sessionId,
      action,
      discardChanges: false,
      expectedRevision: status.value!.revision,
      confirmed: true,
    })
    return result.status
  })
}

async function previewPullRequest(): Promise<void> {
  if (!status.value || status.value.truncated || transientLabel.value) return
  loading.value = true
  pullRequestError.value = ''
  try {
    publishPreview.value = await core('git.publishPreview', {
      sessionId: props.sessionId,
      ...(compareBase.value ? { baseRef: compareBase.value } : {}),
    })
  } catch (cause) {
    pullRequestError.value = friendlyPullRequestError(cause)
  } finally {
    loading.value = false
  }
}

async function publishPullRequestNow(): Promise<void> {
  if (
    !status.value ||
    gitWritesDisabled.value ||
    !pullRequestTitle.value.trim() ||
    !window.confirm(
      pullRequest.value
        ? `更新 Pull Request #${pullRequest.value.number}？`
        : '发布当前分支的 Pull Request？此操作不会自动提交或推送。',
    )
  )
    return
  loading.value = true
  pullRequestError.value = ''
  try {
    pullRequest.value = await core('git.publishPullRequest', {
      sessionId: props.sessionId,
      title: pullRequestTitle.value.trim(),
      body: pullRequestBody.value,
      draft: pullRequestDraft.value,
      expectedRevision: status.value.revision,
      confirmed: true,
    })
    await refresh()
  } catch (cause) {
    pullRequestError.value = friendlyPullRequestError(cause)
  } finally {
    loading.value = false
  }
}

async function readyPullRequestNow(): Promise<void> {
  if (
    !status.value ||
    !pullRequest.value ||
    gitWritesDisabled.value ||
    !window.confirm(
      `将 Pull Request #${pullRequest.value.number} 标记为 Ready？`,
    )
  )
    return
  await runPullRequestMutation(() =>
    core('git.readyPullRequest', {
      sessionId: props.sessionId,
      number: pullRequest.value!.number,
      expectedRevision: status.value!.revision,
      confirmed: true,
    }),
  )
}

async function mergePullRequestNow(method: 'merge' | 'squash' | 'rebase') {
  if (
    !status.value ||
    !pullRequest.value ||
    gitWritesDisabled.value ||
    !window.confirm(
      `以 ${method} 合并 Pull Request #${pullRequest.value.number}？必要检查必须已通过。`,
    )
  )
    return
  await runPullRequestMutation(() =>
    core('git.mergePullRequest', {
      sessionId: props.sessionId,
      number: pullRequest.value!.number,
      method,
      deleteBranch: false,
      expectedRevision: status.value!.revision,
      confirmed: true,
    }),
  )
}

async function closePullRequestNow(): Promise<void> {
  if (
    !status.value ||
    !pullRequest.value ||
    gitWritesDisabled.value ||
    !window.confirm(`关闭 Pull Request #${pullRequest.value.number}？`)
  )
    return
  await runPullRequestMutation(() =>
    core('git.closePullRequest', {
      sessionId: props.sessionId,
      number: pullRequest.value!.number,
      expectedRevision: status.value!.revision,
      confirmed: true,
    }),
  )
}

async function runPullRequestMutation(
  action: () => Promise<PullRequestSummary>,
): Promise<void> {
  loading.value = true
  pullRequestError.value = ''
  try {
    pullRequest.value = await action()
  } catch (cause) {
    pullRequestError.value = friendlyPullRequestError(cause)
  } finally {
    loading.value = false
  }
}

async function compareBranch(): Promise<void> {
  if (!compareBase.value) return
  const owner = props.sessionId
  const generation = ++diffGeneration
  const baseRef = compareBase.value
  loading.value = true
  error.value = ''
  try {
    const result = await core('git.compare', {
      sessionId: owner,
      baseRef,
    })
    if (!isCurrentDiff(owner, generation)) return
    selectedPath.value = `${baseRef}...HEAD · ${result.ahead} ahead / ${result.behind} behind`
    diff.value = result.diff
    diffTruncated.value = result.truncated
  } catch (cause) {
    if (isCurrentDiff(owner, generation)) error.value = message(cause)
  } finally {
    if (isCurrentDiff(owner, generation)) loading.value = false
  }
}

async function mutate(action: () => Promise<GitStatusResult>): Promise<void> {
  const owner = props.sessionId
  const generation = ++refreshGeneration
  loading.value = true
  error.value = ''
  try {
    const next = await action()
    const [branchPayload, worktreePayload] = await Promise.all([
      core('git.branches', { sessionId: owner }),
      core('git.worktrees', { sessionId: owner }),
    ])
    if (isCurrentRefresh(owner, generation)) {
      status.value = next
      branches.value = branchPayload.branches
      worktrees.value = worktreePayload.worktrees
      ownedWorktrees.value = worktreePayload.owned
    }
  } catch (cause) {
    if (isCurrentRefresh(owner, generation)) {
      error.value = message(cause)
      await refresh()
    }
  } finally {
    if (isCurrentRefresh(owner, generation)) loading.value = false
  }
}

function isCurrentRefresh(owner: string, generation: number): boolean {
  return props.sessionId === owner && refreshGeneration === generation
}

function isCurrentDiff(owner: string, generation: number): boolean {
  return props.sessionId === owner && diffGeneration === generation
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function friendlyPullRequestError(value: unknown): string {
  const text = message(value)
  if (/git_gh_unavailable|GitHub CLI unavailable|GitHub CLI/i.test(text))
    return 'GitHub CLI 尚未通过签名工具目录审核，PR 操作当前不可用。'
  if (/not logged|auth|login/i.test(text))
    return 'GitHub CLI 尚未登录，请先在系统 Terminal 完成 gh auth login。'
  return text
}
</script>

<template>
  <div ref="paneRoot" class="workspace-pane git-review-pane">
    <div class="workspace-pane-heading">
      <div>
        <GitBranch :size="14" class="workspace-eyebrow" aria-hidden="true" />
        <strong>{{ status?.branch || 'Git' }}</strong>
      </div>
      <button
        type="button"
        class="workspace-icon-button"
        aria-label="刷新 Git 状态"
        @click="refresh"
      >
        <RefreshCw :size="15" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <div v-if="!hasProject" class="workspace-empty-state">
      当前会话没有 Git 项目。
    </div>
    <div v-else-if="error" class="workspace-inline-error">{{ error }}</div>
    <template v-if="status">
      <div
        v-if="focusFilterActive && props.focusPaths?.length"
        class="git-task-filter"
      >
        <FileDiff :size="14" />
        <span>本次任务 · {{ props.focusPaths.length }} 个文件</span>
        <button type="button" @click="focusFilterActive = false">
          显示全部
        </button>
      </div>
      <div v-if="transientLabel" class="workspace-inline-warning">
        <ShieldAlert :size="15" />
        <span
          >{{ transientLabel }}。完成或中止该操作前，分支、worktree 与 PR
          写操作保持禁用。</span
        >
      </div>
      <div v-if="status.truncated" class="workspace-inline-warning">
        <ShieldAlert :size="15" />
        <span
          >仓库变更超过安全解析上限，当前只显示部分状态。刷新到完整状态前，所有
          Git 写操作保持禁用。</span
        >
      </div>
      <div class="git-sync-bar">
        <span><ArrowUp :size="13" />{{ status.ahead }}</span>
        <span><ArrowDown :size="13" />{{ status.behind }}</span>
        <button type="button" :disabled="loading" @click="fetchRemote">
          Fetch
        </button>
        <button type="button" :disabled="gitWritesDisabled" @click="pull">
          Pull
        </button>
        <button type="button" :disabled="gitWritesDisabled" @click="push">
          Push
        </button>
      </div>

      <section class="workspace-section git-branch-section">
        <h3>Branches</h3>
        <div class="git-repository-facts">
          <span>{{ status.repository.objectFormat.toUpperCase() }}</span>
          <span v-if="status.repository.unborn">Unborn branch</span>
          <span v-else-if="status.repository.detached">Detached HEAD</span>
          <span v-if="status.repository.defaultBranch">
            default · {{ status.repository.defaultBranch }}
          </span>
        </div>
        <label class="workspace-select-wrap">
          <GitBranch :size="14" />
          <select
            :value="status.branch || ''"
            :disabled="gitWritesDisabled"
            aria-label="切换 Git 分支"
            @change="switchBranch(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="branch in branches"
              :key="branch.name"
              :value="branch.name"
            >
              {{ branch.name }}
            </option>
          </select>
          <ChevronDown :size="13" />
        </label>
        <div class="workspace-inline-form">
          <input
            v-model="branchName"
            placeholder="新分支名称"
            :disabled="gitWritesDisabled"
            @keydown.enter.prevent="createBranch"
          />
          <button
            type="button"
            :disabled="!branchName.trim() || gitWritesDisabled"
            @click="createBranch"
          >
            创建
          </button>
        </div>
        <div class="workspace-inline-form">
          <select v-model="compareBase" aria-label="比较基础分支">
            <option value="">选择比较分支</option>
            <option
              v-for="branch in branches.filter(
                (item) => item.name !== status?.branch,
              )"
              :key="`compare:${branch.name}`"
              :value="branch.name"
            >
              {{ branch.name }}
            </option>
          </select>
          <button type="button" :disabled="!compareBase" @click="compareBranch">
            Compare
          </button>
        </div>
      </section>

      <section class="workspace-section git-worktree-section">
        <h3>
          Worktrees
          <span>{{ worktrees.length }}</span>
        </h3>
        <div v-if="activeWorktree" class="git-worktree-active">
          <Workflow :size="15" />
          <div>
            <strong>{{ activeWorktree.branch || 'Detached worktree' }}</strong>
            <span>{{ activeWorktree.path }}</span>
          </div>
          <button
            type="button"
            :disabled="gitWritesDisabled"
            @click="exitWorktree('keep')"
          >
            保留并退出
          </button>
          <button
            type="button"
            class="danger"
            :disabled="gitWritesDisabled"
            @click="exitWorktree('remove')"
          >
            安全删除
          </button>
        </div>
        <div v-else class="workspace-inline-form">
          <input
            v-model="worktreeName"
            placeholder="临时 worktree 分支名"
            :disabled="gitWritesDisabled"
            @keydown.enter.prevent="enterWorktree"
          />
          <button
            type="button"
            :disabled="!worktreeName.trim() || gitWritesDisabled"
            @click="enterWorktree"
          >
            创建并进入
          </button>
        </div>
        <div v-if="ownedWorktrees.length > 1" class="workspace-list">
          <div
            v-for="worktree in ownedWorktrees.filter((item) => !item.active)"
            :key="worktree.id"
            class="workspace-list-row"
          >
            <Workflow :size="14" />
            <span>{{ worktree.branch || worktree.path }}</span>
            <span class="workspace-row-value">Emperor owned</span>
          </div>
        </div>
      </section>

      <section
        v-for="group in [
          {
            id: 'conflict',
            label: 'Conflicts',
            files: groups.conflict,
            area: 'worktree' as const,
          },
          {
            id: 'staged',
            label: 'Staged',
            files: groups.staged,
            area: 'staged' as const,
          },
          {
            id: 'unstaged',
            label: 'Changes',
            files: groups.unstaged,
            area: 'worktree' as const,
          },
          {
            id: 'untracked',
            label: 'Untracked',
            files: groups.untracked,
            area: 'worktree' as const,
          },
        ]"
        :key="group.id"
        class="workspace-section git-file-group"
      >
        <h3>
          {{ group.label }} <span>{{ group.files.length }}</span>
        </h3>
        <div v-if="group.files.length" class="workspace-list">
          <div
            v-for="file in group.files"
            :key="`${group.id}:${file.path}`"
            class="git-file-row"
          >
            <button
              type="button"
              class="git-file-name"
              @click="showDiff(file, group.area)"
            >
              <FileDiff :size="14" />
              <span>{{ file.path }}</span>
              <small
                v-if="gitFileChangeLabel(file)"
                class="git-file-change-count"
              >
                {{ gitFileChangeLabel(file) }}
              </small>
            </button>
            <button
              v-if="group.id === 'staged'"
              type="button"
              class="workspace-icon-button"
              :disabled="gitWritesDisabled"
              :aria-label="`取消暂存 ${file.path}`"
              @click="unstage([file.path])"
            >
              <Minus :size="13" />
            </button>
            <button
              v-else
              type="button"
              class="workspace-icon-button"
              :disabled="gitWritesDisabled"
              :aria-label="`暂存 ${file.path}`"
              @click="stage([file.path])"
            >
              <Plus :size="13" />
            </button>
            <button
              v-if="group.id === 'unstaged' || group.id === 'untracked'"
              type="button"
              class="workspace-icon-button danger"
              :disabled="gitWritesDisabled"
              :aria-label="`丢弃 ${file.path}`"
              @click="discard(file)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </div>
      </section>

      <pre
        v-if="selectedPath"
        class="git-diff-preview"
      ><code>{{ diff || '没有可显示的差异。' }}</code></pre>
      <p v-if="selectedPath && diffTruncated" class="workspace-muted">
        差异或文件预览超过安全上限，当前内容已截断。
      </p>

      <form
        ref="commitForm"
        class="git-commit-form"
        :data-attention="commitAttention || undefined"
        @submit.prevent="commit"
      >
        <textarea
          ref="commitInput"
          v-model="commitMessage"
          aria-label="提交信息"
          rows="3"
          placeholder="提交信息"
          :disabled="gitWritesDisabled"
        />
        <button
          type="submit"
          :disabled="!commitMessage.trim() || gitWritesDisabled"
        >
          <LoaderCircle v-if="loading" :size="14" class="animate-spin" />
          <Check v-else :size="14" />
          Commit
        </button>
      </form>
      <p v-if="agentBusy" class="workspace-muted">
        Agent 正在写入项目，高冲突 Git 写操作暂时禁用。
      </p>

      <section class="workspace-section git-pull-request-section">
        <h3>
          Pull Request
          <span v-if="pullRequest">#{{ pullRequest.number }}</span>
        </h3>
        <div v-if="pullRequestError" class="workspace-inline-warning">
          {{ pullRequestError }}
        </div>
        <template v-if="pullRequest">
          <div class="git-pr-summary">
            <GitPullRequest :size="16" />
            <div>
              <strong
                >{{ pullRequest.headRefName }} →
                {{ pullRequest.baseRefName }}</strong
              >
              <span>
                {{ pullRequest.state }} ·
                {{ pullRequest.draft ? 'Draft' : 'Ready' }} ·
                {{ pullRequest.mergeable }}
              </span>
              <code>{{ pullRequest.url }}</code>
            </div>
          </div>
          <div class="git-pr-actions">
            <button
              v-if="pullRequest.draft"
              type="button"
              :disabled="gitWritesDisabled"
              @click="readyPullRequestNow"
            >
              Mark ready
            </button>
            <button
              type="button"
              :disabled="gitWritesDisabled"
              @click="mergePullRequestNow('squash')"
            >
              Squash merge
            </button>
            <button
              type="button"
              class="danger"
              :disabled="gitWritesDisabled"
              @click="closePullRequestNow"
            >
              Close
            </button>
          </div>
        </template>
        <button
          type="button"
          class="git-preview-button"
          :disabled="
            loading || Boolean(transientLabel) || Boolean(status.truncated)
          "
          @click="previewPullRequest"
        >
          <GitPullRequest :size="14" />
          生成发布预览
        </button>
        <div v-if="publishPreview" class="git-pr-preview">
          <strong
            >{{ publishPreview.branch }} → {{ publishPreview.baseRef }}</strong
          >
          <span>
            {{ publishPreview.commits.length }} commits ·
            {{ publishPreview.changedFiles }} files · +{{
              publishPreview.additions
            }}
            −{{ publishPreview.deletions }}
            <template v-if="publishPreview.binary">
              · {{ publishPreview.binary }} binary
            </template>
          </span>
          <span v-if="publishPreview.uncommittedFiles">
            另有 {{ publishPreview.uncommittedFiles }} 个未提交文件，不会进入
            PR。
          </span>
        </div>
        <div class="git-pr-editor">
          <input
            v-model="pullRequestTitle"
            placeholder="Pull Request 标题"
            :disabled="gitWritesDisabled"
          />
          <textarea
            v-model="pullRequestBody"
            rows="4"
            placeholder="Pull Request 正文"
            :disabled="gitWritesDisabled"
          />
          <label>
            <input v-model="pullRequestDraft" type="checkbox" />
            Draft
          </label>
          <button
            type="button"
            :disabled="!pullRequestTitle.trim() || gitWritesDisabled"
            @click="publishPullRequestNow"
          >
            {{ pullRequest ? '更新 PR' : '发布 PR' }}
          </button>
        </div>
      </section>
    </template>
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
  align-items: center;
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
  flex: none;
  color: rgb(var(--label-tertiary));
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

.workspace-icon-button.danger:hover:not(:disabled) {
  color: rgb(var(--danger));
  background: var(--interactive-bg-hover-danger);
}

.workspace-icon-button:disabled {
  cursor: default;
  opacity: 0.4;
}

/* Form controls: override the global base look with dsh tokens. */
.git-review-pane :is(input:not([type='checkbox']), select, textarea) {
  width: 100%;
  min-width: 0;
  padding: var(--space-1-5) var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  background: rgb(var(--input-major));
  box-shadow: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.git-review-pane :is(input:not([type='checkbox']), select, textarea):focus {
  border-color: var(--border-l4);
  box-shadow: none;
}

.git-review-pane .git-commit-form textarea {
  transition: box-shadow var(--duration-ds-slow) var(--ease-out);
}

.git-review-pane .git-commit-form[data-attention] textarea {
  border-color: rgb(var(--accent-fill) / 0.7);
  box-shadow: 0 0 0 3px rgb(var(--accent-fill) / 0.25);
}

.git-review-pane :is(input, textarea)::placeholder {
  color: rgb(var(--label-tertiary));
}

.git-review-pane :is(input, select, textarea):disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.git-review-pane input[type='checkbox'] {
  width: auto;
  accent-color: rgb(var(--accent-fill));
}

/* Secondary buttons (sync, forms, PR, worktree): outlined pills. */
.git-sync-bar button,
.workspace-inline-form button,
.git-commit-form button,
.git-worktree-active button,
.git-pr-actions button,
.git-preview-button,
.git-pr-editor button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  background: transparent;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: nowrap;
}

.git-sync-bar button:hover:not(:disabled),
.workspace-inline-form button:hover:not(:disabled),
.git-commit-form button:hover:not(:disabled),
.git-worktree-active button:hover:not(:disabled),
.git-pr-actions button:hover:not(:disabled),
.git-preview-button:hover:not(:disabled),
.git-pr-editor button:hover:not(:disabled) {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.git-worktree-active button.danger:hover:not(:disabled),
.git-pr-actions button.danger:hover:not(:disabled) {
  color: rgb(var(--danger));
  background: var(--interactive-bg-hover-danger);
}

.git-sync-bar button:disabled,
.workspace-inline-form button:disabled,
.git-commit-form button:disabled,
.git-worktree-active button:disabled,
.git-pr-actions button:disabled,
.git-preview-button:disabled,
.git-pr-editor button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.git-sync-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2) var(--space-3);
}

.git-sync-bar span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-0-5);
  padding: var(--space-1) var(--space-1-5);
  color: rgb(var(--label-tertiary));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.workspace-section {
  padding: var(--space-3) var(--space-2);
  border-top: 1px solid var(--border-l1);
}

.workspace-section h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
}

.git-repository-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}

.git-repository-facts span {
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  color: rgb(var(--label-tertiary));
  background: var(--interactive-bg-hover);
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
}

.workspace-select-wrap {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--label-secondary));
}

.workspace-select-wrap select {
  flex: 1;
  appearance: none;
  padding-right: var(--space-6);
}

.workspace-select-wrap > svg:last-child {
  position: absolute;
  right: var(--space-2);
  pointer-events: none;
}

.workspace-inline-form {
  display: flex;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.workspace-inline-form :is(input, select) {
  flex: 1;
}

.git-worktree-active,
.git-pr-summary {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2-5);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  color: rgb(var(--label-secondary));
}

.git-worktree-active > div,
.git-pr-summary > div {
  display: flex;
  min-width: 0;
  flex: 1 1 60%;
  flex-direction: column;
  gap: var(--space-0-5);
}

.git-worktree-active strong,
.git-worktree-active span,
.git-pr-summary strong,
.git-pr-summary span,
.git-pr-summary code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-worktree-active strong,
.git-pr-summary strong {
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
}

.git-worktree-active span,
.git-pr-summary span,
.git-pr-summary code {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
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

.workspace-list-row > span:not(.workspace-row-value) {
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-row-value {
  flex: none;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.git-file-group h3 span,
.git-worktree-section h3 span,
.git-pull-request-section h3 span {
  font-family: var(--font-mono);
}

.git-file-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
}

.git-file-name {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  text-align: left;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.git-file-name:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.git-file-name > svg {
  flex: none;
}

.git-file-name span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-file-change-count {
  flex: none;
  color: rgb(var(--label-tertiary));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.git-diff-preview {
  max-height: 320px;
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  overflow: auto;
  border-radius: var(--radius-card);
  color: rgb(var(--label-secondary));
  background: rgb(var(--code-block-bg));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  white-space: pre;
}

.git-commit-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: 0 var(--space-2);
}

.git-commit-form textarea {
  min-height: 68px;
  resize: vertical;
}

.git-commit-form button {
  align-self: flex-end;
  color: rgb(var(--accent-fg));
  border-color: transparent;
  background: rgb(var(--accent-fill));
}

.git-commit-form button:hover:not(:disabled) {
  color: rgb(var(--accent-fg));
  background: rgb(var(--accent-hover));
}

.git-task-filter {
  display: flex;
  min-height: var(--space-8);
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-1) 0;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--radius-row);
  color: rgb(var(--label-secondary));
  background: rgb(var(--accent-soft));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.git-task-filter span {
  min-width: 0;
  flex: 1;
}

.git-task-filter button {
  flex: none;
  color: rgb(var(--accent-strong));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.git-task-filter button:hover,
.git-task-filter button:focus-visible {
  color: rgb(var(--label-primary));
}

.git-pr-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin-top: var(--space-2);
}

.git-preview-button {
  margin-top: var(--space-2);
}

.git-pr-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-left: 2px solid rgb(var(--accent-fill) / 0.65);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.git-pr-preview strong {
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
}

.git-pr-editor {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.git-pr-editor > input:not([type]),
.git-pr-editor textarea {
  grid-column: 1 / -1;
  resize: vertical;
}

.git-pr-editor label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.workspace-muted,
.workspace-empty-state {
  margin: 0;
  padding: var(--space-2);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.workspace-empty-state {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.workspace-inline-error,
.workspace-inline-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-1) 0;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--radius-row);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.workspace-inline-error {
  color: rgb(var(--danger));
  background: rgb(var(--danger-soft));
}

.workspace-inline-warning {
  color: rgb(var(--label-secondary));
  background: rgb(var(--warn-soft));
}

.workspace-inline-warning > svg {
  flex: none;
  color: rgb(var(--warn));
}
</style>
