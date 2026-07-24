<script setup lang="ts">
import type {
  GitFileStatus,
  GitStatusResult,
  GitWorktreeSummary,
  PullRequestSummary,
} from '@emperor/core'
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { core } from '../../api/http'
import {
  gitFileChangeLabel,
  gitTransientLabel,
  groupGitFiles,
} from './workspaceModel'

const props = defineProps<{
  sessionId: string
  hasProject: boolean
  agentBusy: boolean
}>()

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
let refreshGeneration = 0
let diffGeneration = 0
let pollTimer: number | undefined

const groups = computed(() => groupGitFiles(status.value?.files ?? []))
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
  <div class="workspace-pane git-review-pane">
    <div class="workspace-pane-heading">
      <div>
        <span class="workspace-eyebrow">Review</span>
        <strong>{{ status?.branch || 'Git working tree' }}</strong>
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

      <form class="git-commit-form" @submit.prevent="commit">
        <textarea
          v-model="commitMessage"
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
