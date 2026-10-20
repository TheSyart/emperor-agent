/**
 * useGitReview — the 审查 pane's state and Git calls (split out of
 * GitReviewPane, UI-S06).
 *
 * Polling (FIX-05): no timer of its own. While `polling` (the pane is on
 * screen) it is a consumer of the shared workspace snapshot and takes Git
 * status and worktrees from each snapshot; the branch list and the
 * current-branch PR (`gh`) refresh at most once a minute
 * (GIT_REVIEW_SLOW_TTL_MS), the `origin` remote once per session. Hidden, it
 * makes no Git calls. Polls are silent: they never set `loading`.
 *
 * Errors: a failed read (status, diff) is `readError` and clears on the next
 * good read; a failed write is `writeError` and stays until dismissed or the
 * next write starts. Writes carry the status `revision` (expectedRevision),
 * ask first where the 审查 rules always asked, and wait while the agent runs
 * or a Git operation is unfinished (`blockedReason`). A session switch
 * clears every draft and both errors.
 */
import type {
  GitRemoteInfo,
  GitStatusResult,
  GitWorktreeSummary,
  PullRequestSummary,
  WorkspaceSnapshot,
} from '@emperor/core/api'
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type InjectionKey,
} from 'vue'
import { openLink } from '../../api/backend'
import { core } from '../../api/http'
import { confirm, type ConfirmOptions } from '../ui/confirm'
import type { DiffHunk } from '../ui/diffRows'
import { splitPullRequestDiff } from '../pages/pulls/pullDiff'
import { compareBranchLink, type CompareLink } from './environmentModel'
import {
  GIT_CONFIRMS,
  pullRequestProblem,
  reviewGroups,
  type ReviewEntry,
} from './gitReviewModel'
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot'
import {
  GIT_REVIEW_SLOW_TTL_MS,
  filterGitFilesByPaths,
  gitTransientLabel,
} from './workspaceModel'
import { isGitStatus } from './workspaceTypes'

export interface GitReviewProps {
  sessionId: string
  hasProject: boolean
  agentBusy: boolean
  focusPaths?: string[]
}

type Branch = { name: string; head: string; upstream: string | null }

interface WriteOptions {
  /** Read the current-branch PR again afterwards (push, branch switch). */
  pullRequest?: boolean
  /** Run although writes wait (fetch moves no branch). */
  force?: boolean
}

/** The diff open under one row. */
export interface OpenDiff {
  key: string
  loading: boolean
  hunks: DiffHunk[]
  truncated: boolean
  /** Shown instead of hunks (binary, empty). */
  note: string
}

export type GitReview = ReturnType<typeof useGitReview>

/** GitReviewPane provides its review to its parts (menu, list, commit box). */
export const GIT_REVIEW: InjectionKey<GitReview> = Symbol('git-review')

export function injectGitReview(): GitReview {
  const review = inject(GIT_REVIEW, null)
  if (!review) throw new Error('A 审查 part needs GitReviewPane around it')
  return review
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

export function useGitReview(
  props: GitReviewProps,
  polling: ComputedRef<boolean>,
) {
  const workspace = useWorkspaceSnapshot({ active: () => polling.value })
  const status = ref<GitStatusResult | null>(null)
  /** Generation of the user-visible refresh in flight (0: none). */
  const loadingToken = ref(0)
  const loading = computed(() => loadingToken.value !== 0)
  /** A Git write is in flight. */
  const writing = ref(false)
  const readError = ref('')
  const writeError = ref('')
  const branches = shallowRef<Branch[]>([])
  const ownedWorktrees = shallowRef<GitWorktreeSummary[]>([])
  const pullRequest = shallowRef<PullRequestSummary | null>(null)
  const pullRequestError = ref('')
  const remote = shallowRef<GitRemoteInfo | null>(null)
  const remoteState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const diff = shallowRef<OpenDiff | null>(null)
  const commitMessage = ref('')
  const branchDraft = ref('')
  const focusFilterActive = ref(Boolean(props.focusPaths?.length))
  let refreshGeneration = 0
  let diffGeneration = 0
  let pullRequestCheckedAt = 0
  let branchesCheckedAt = 0

  const visibleFiles = computed(() =>
    focusFilterActive.value
      ? filterGitFilesByPaths(status.value?.files ?? [], props.focusPaths || [])
      : (status.value?.files ?? []),
  )
  const groups = computed(() => reviewGroups(visibleFiles.value))
  const transientLabel = computed(() =>
    status.value
      ? gitTransientLabel(status.value.repository.transientState)
      : '',
  )
  const activeWorktree = computed(
    () => ownedWorktrees.value.find((entry) => entry.active) ?? null,
  )
  /** Why Git writes wait now ('' when they can run). */
  const blockedReason = computed(() => {
    if (props.agentBusy) return '智能体运行中，完成后再操作 Git'
    if (writing.value) return '正在执行 Git 操作…'
    if (loading.value) return '正在读取 Git 状态…'
    if (transientLabel.value)
      return `${transientLabel.value}，完成或中止前不能写入`
    if (status.value?.truncated) return '改动过多，只显示了部分状态'
    return ''
  })
  const writesDisabled = computed(
    () => !status.value || Boolean(blockedReason.value),
  )
  const compare = computed<CompareLink>(() => {
    if (remoteState.value === 'error')
      return { url: null, reason: '无法读取远端' }
    if (remoteState.value !== 'ready') return { url: null, reason: '读取远端…' }
    return compareBranchLink({
      remote: remote.value,
      base: status.value?.repository.defaultBranch ?? null,
      head: status.value?.branch ?? null,
    })
  })
  /** 提交并推送 is offered once a remote is known. */
  const canPush = computed(
    () => Boolean(status.value?.upstream) || Boolean(remote.value?.name),
  )

  onMounted(() => {
    if (polling.value) void refresh()
  })
  onBeforeUnmount(() => {
    refreshGeneration += 1
    diffGeneration += 1
  })
  // Back on screen: catch up quietly (a first load shows the spinner).
  watch(polling, (on, was) => {
    if (on && !was) void refresh({ silent: Boolean(status.value) })
  })
  watch(workspace.snapshot, (next) => applySnapshot(next))
  watch(
    () => props.sessionId,
    () => {
      refreshGeneration += 1
      diffGeneration += 1
      status.value = null
      loadingToken.value = 0
      writing.value = false
      readError.value = ''
      writeError.value = ''
      branches.value = []
      ownedWorktrees.value = []
      pullRequest.value = null
      pullRequestError.value = ''
      remote.value = null
      remoteState.value = 'idle'
      pullRequestCheckedAt = 0
      branchesCheckedAt = 0
      diff.value = null
      // Drafts belong to the session they were written in.
      commitMessage.value = ''
      branchDraft.value = ''
      if (polling.value) void refresh()
    },
  )
  watch(
    () => (props.focusPaths || []).join('\u0000'),
    (paths) => {
      focusFilterActive.value = Boolean(paths)
      diff.value = null
    },
  )

  /**
   * Read status, branches and worktrees. `silent` (catching up when the pane
   * shows again, after a failed write) leaves `loading` alone.
   */
  async function refresh(options: { silent?: boolean } = {}): Promise<void> {
    if (!props.hasProject || !props.sessionId) {
      status.value = null
      return
    }
    const owner = props.sessionId
    const generation = ++refreshGeneration
    if (!options.silent) loadingToken.value = generation
    try {
      const [next, branchPayload, worktreePayload] = await Promise.all([
        core('git.status', { sessionId: owner }),
        core('git.branches', { sessionId: owner }),
        core('git.worktrees', { sessionId: owner }),
      ])
      if (!isCurrentRefresh(owner, generation)) return
      status.value = next
      readError.value = ''
      applyBranches(branchPayload.branches)
      ownedWorktrees.value = worktreePayload.owned
      void refreshPullRequest(owner, { force: !options.silent })
      if (remoteState.value === 'idle') void refreshRemote(owner)
    } catch (cause) {
      if (isCurrentRefresh(owner, generation)) readError.value = message(cause)
    } finally {
      if (loadingToken.value === generation) loadingToken.value = 0
    }
  }

  /** A shared snapshot poll landed: take its status, quietly. */
  function applySnapshot(next: WorkspaceSnapshot | null): void {
    // A write in flight brings its own status; a user refresh its own too.
    if (!next || !polling.value || writing.value || loading.value) return
    if (workspace.sessionId.value !== props.sessionId) return
    if (!isGitStatus(next.git)) {
      if (next.git && 'error' in next.git) readError.value = next.git.error
      return
    }
    const previous = status.value
    status.value = next.git
    readError.value = ''
    ownedWorktrees.value = next.worktrees?.owned ?? []
    const owner = props.sessionId
    if (
      !previous ||
      previous.head !== next.git.head ||
      previous.branch !== next.git.branch ||
      Date.now() - branchesCheckedAt >= GIT_REVIEW_SLOW_TTL_MS
    )
      void refreshBranches(owner)
    void refreshPullRequest(owner)
  }

  function applyBranches(list: Branch[]): void {
    branches.value = list
    branchesCheckedAt = Date.now()
  }

  async function refreshBranches(owner: string): Promise<void> {
    branchesCheckedAt = Date.now()
    try {
      const payload = await core('git.branches', { sessionId: owner })
      if (owner === props.sessionId) applyBranches(payload.branches)
    } catch {
      // The list stays as it was; the next refresh tries again.
    }
  }

  async function refreshRemote(owner: string): Promise<void> {
    remoteState.value = 'loading'
    try {
      const info = await core('git.remote', { sessionId: owner })
      if (owner !== props.sessionId) return
      remote.value = info
      remoteState.value = 'ready'
    } catch {
      if (owner === props.sessionId) remoteState.value = 'error'
    }
  }

  /** The current-branch PR (`gh`): at most once a minute unless forced. */
  async function refreshPullRequest(
    owner: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (
      !options.force &&
      Date.now() - pullRequestCheckedAt < GIT_REVIEW_SLOW_TTL_MS
    )
      return
    pullRequestCheckedAt = Date.now()
    try {
      const next = await core('git.pullRequest', { sessionId: owner })
      if (owner !== props.sessionId) return
      pullRequest.value = next
      pullRequestError.value = ''
    } catch (cause) {
      if (owner !== props.sessionId) return
      pullRequest.value = null
      pullRequestError.value = pullRequestProblem(cause)
    }
  }

  /** A row clicked: show its diff under it, or hide the one shown. */
  async function toggleDiff(entry: ReviewEntry): Promise<void> {
    if (diff.value?.key === entry.key) {
      diffGeneration += 1
      diff.value = null
      return
    }
    const owner = props.sessionId
    const generation = ++diffGeneration
    const { file, area, key } = entry
    const open = (patch: Partial<OpenDiff>) => {
      if (owner === props.sessionId && generation === diffGeneration)
        diff.value = {
          key,
          loading: false,
          hunks: [],
          truncated: false,
          note: '',
          ...patch,
        }
    }
    open({ loading: true })
    try {
      if (file.untracked) {
        const preview = await core('files.read', {
          sessionId: owner,
          relativePath: file.path,
        })
        if (preview.kind !== 'text')
          return open({
            note: `未跟踪的${preview.kind === 'image' ? '图片' : '二进制'}文件`,
          })
        const content = preview.content ?? ''
        return open({
          hunks: content
            ? [{ path: file.path, oldText: null, newText: content }]
            : [],
          truncated: preview.truncated,
          note: content ? '' : '空文件',
        })
      }
      if (file.binary) return open({ note: '二进制文件，没有可显示的差异' })
      const result = await core('git.diff', {
        sessionId: owner,
        path: file.path,
        area,
      })
      const hunks = splitPullRequestDiff(result.content)[0]?.hunks ?? []
      open({
        hunks,
        truncated: result.truncated,
        note: hunks.length ? '' : '没有可显示的差异',
      })
    } catch (cause) {
      if (owner === props.sessionId && generation === diffGeneration) {
        diff.value = null
        readError.value = message(cause)
      }
    }
  }

  /** Ask first (when `ask` is given), then run the Git write. */
  async function guarded(
    ask: ConfirmOptions | null,
    action: (revision: string) => Promise<GitStatusResult>,
    options: WriteOptions = {},
  ): Promise<boolean> {
    if (!status.value || (!options.force && writesDisabled.value)) return false
    if (ask && !(await confirm(ask))) return false
    return mutate(action, options)
  }
  const session = () => ({ sessionId: props.sessionId })

  /** Stage or unstage files (one row, or a whole group). */
  const stage = (paths: string[]) =>
    guarded(null, (expectedRevision) =>
      core('git.stage', { ...session(), paths, expectedRevision }),
    )
  const unstage = (paths: string[]) =>
    guarded(null, (expectedRevision) =>
      core('git.unstage', { ...session(), paths, expectedRevision }),
    )
  const discard = (path: string) =>
    guarded(GIT_CONFIRMS.discard(path), (expectedRevision) =>
      core('git.discard', {
        ...session(),
        paths: [path],
        expectedRevision,
        confirmed: true,
      }),
    )
  const pull = () =>
    guarded(GIT_CONFIRMS.pull, (expectedRevision) =>
      core('git.pull', { ...session(), expectedRevision, confirmed: true }),
    )
  const pushNow = (ask: ConfirmOptions | null) =>
    guarded(
      ask,
      (expectedRevision) =>
        core('git.push', {
          ...session(),
          expectedRevision,
          setUpstream: !status.value?.upstream,
          confirmed: true,
        }),
      { pullRequest: true },
    )
  const push = () => pushNow(GIT_CONFIRMS.push)
  const enterWorktree = () =>
    activeWorktree.value
      ? Promise.resolve(false)
      : guarded(GIT_CONFIRMS.enterWorktree, async (expectedRevision) => {
          const result = await core('git.enterWorktree', {
            ...session(),
            expectedRevision,
            confirmed: true,
          })
          return result.status
        })

  /** Fetch writes no branch: it waits only for a read or write in flight. */
  function fetchRemote(): Promise<boolean> {
    if (writing.value || loading.value) return Promise.resolve(false)
    return guarded(
      GIT_CONFIRMS.fetch,
      () => core('git.fetch', { ...session(), confirmed: true }),
      { force: true },
    )
  }

  function commit(): Promise<boolean> {
    const message = commitMessage.value
    if (!message.trim()) return Promise.resolve(false)
    return guarded(null, async (expectedRevision) => {
      const next = await core('git.commit', {
        ...session(),
        message,
        expectedRevision,
      })
      commitMessage.value = ''
      return next
    })
  }

  async function commitAndPush(): Promise<void> {
    if (!commitMessage.value.trim() || writesDisabled.value) return
    if (!(await confirm(GIT_CONFIRMS.commitAndPush))) return
    if (await commit()) await pushNow(null)
  }

  async function createBranch(): Promise<boolean> {
    const name = branchDraft.value.trim()
    if (!name) return false
    const created = await guarded(null, (expectedRevision) =>
      core('git.createBranch', { ...session(), name, expectedRevision }),
    )
    if (created) branchDraft.value = ''
    return created
  }

  function switchBranch(name: string): Promise<boolean> {
    if (name === status.value?.branch) return Promise.resolve(false)
    return guarded(
      GIT_CONFIRMS.switchBranch(name),
      (expectedRevision) =>
        core('git.switchBranch', {
          ...session(),
          name,
          expectedRevision,
          confirmed: true,
        }),
      { pullRequest: true },
    )
  }

  function exitWorktree(action: 'keep' | 'remove'): Promise<boolean> {
    const worktree = activeWorktree.value
    if (!worktree) return Promise.resolve(false)
    return guarded(
      action === 'remove'
        ? GIT_CONFIRMS.removeWorktree(worktree.path)
        : GIT_CONFIRMS.exitWorktree,
      async (expectedRevision) => {
        const result = await core('git.exitWorktree', {
          ...session(),
          action,
          discardChanges: false,
          expectedRevision,
          confirmed: true,
        })
        return result.status
      },
    )
  }

  async function openUrl(url: string | null): Promise<void> {
    if (!url) return
    try {
      await openLink(url)
    } catch (cause) {
      writeError.value = message(cause)
    }
  }

  /**
   * Run a Git write against the status revision. Its error stays on screen
   * (the refresh after it never clears it); a success also refreshes the
   * shared snapshot, so a poll that read the repository before the write
   * cannot land after it.
   */
  async function mutate(
    action: (revision: string) => Promise<GitStatusResult>,
    options: WriteOptions = {},
  ): Promise<boolean> {
    const current = status.value
    if (!current) return false
    const owner = props.sessionId
    const generation = ++refreshGeneration
    writing.value = true
    writeError.value = ''
    try {
      const next = await action(current.revision)
      const [branchPayload, worktreePayload] = await Promise.all([
        core('git.branches', { sessionId: owner }),
        core('git.worktrees', { sessionId: owner }),
      ])
      if (isCurrentRefresh(owner, generation)) {
        status.value = next
        applyBranches(branchPayload.branches)
        ownedWorktrees.value = worktreePayload.owned
      }
      if (owner === props.sessionId) {
        void workspace.refresh({ force: true })
        if (options.pullRequest) void refreshPullRequest(owner, { force: true })
      }
      return true
    } catch (cause) {
      if (owner !== props.sessionId) return false
      writeError.value = message(cause)
      // The repository may have moved (a stale revision): read it again.
      await refresh({ silent: true })
      return false
    } finally {
      if (owner === props.sessionId) writing.value = false
    }
  }

  function isCurrentRefresh(owner: string, generation: number): boolean {
    return props.sessionId === owner && refreshGeneration === generation
  }

  return {
    status,
    loading,
    writing,
    readError,
    writeError,
    branches,
    activeWorktree,
    pullRequest,
    pullRequestError,
    compare,
    canPush,
    diff,
    groups,
    transientLabel,
    blockedReason,
    writesDisabled,
    commitMessage,
    branchDraft,
    focusFilterActive,
    refresh,
    toggleDiff,
    stage,
    unstage,
    discard,
    commit,
    commitAndPush,
    fetchRemote,
    pull,
    push,
    createBranch,
    switchBranch,
    enterWorktree,
    exitWorktree,
    openUrl,
  }
}
