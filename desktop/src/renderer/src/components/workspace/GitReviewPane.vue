<script setup lang="ts">
/**
 * GitReviewPane — the right workspace's 审查 pane (UI-S06): a toolbar with
 * the 「分支名 ▾」 menu (every Git action, GitBranchMenu), the sync counts
 * and 刷新; the change list in 已暂存 / 未暂存 (GitChangeList; a click shows
 * a file's diff under it); and a footer with the one-line Pull Request area
 * (GitPullRequestLine) over the commit box (GitCommitBox). State and Git
 * calls live in useGitReview, provided to the parts.
 *
 * Polling (FIX-05): no timer of its own. While it is on screen (`visible`,
 * and active inside WorkspacePanel's KeepAlive) it rides on the shared
 * workspace snapshot; hidden, it makes no Git calls. Polls are silent.
 *
 * Errors: a failed write stays above the list until dismissed (refreshes
 * never clear it); a failed read clears on the next good one. Text boxes
 * are never disabled — only the buttons that act. A session switch clears
 * the commit message, the branch name draft and both errors. The list keeps
 * its scroll position across pane switches.
 *
 * Props:
 * - sessionId, hasProject, agentBusy (Git writes wait while it runs).
 * - visible?: the workspace column is open (default true).
 * - focusPaths?: limit the change list to these files (本次任务 filter).
 * - commitFocus?: nonce; a new non-zero value focuses the commit box once
 *   the status has loaded (requestWorkspace focus 'commit').
 * Emits: commitFocused — that request has been handled.
 */
import { FileDiff, RefreshCw, TriangleAlert, X } from 'lucide-vue-next'
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  provide,
  ref,
  watch,
} from 'vue'
import EmptyState from '../ui/EmptyState.vue'
import IconButton from '../ui/IconButton.vue'
import LinkButton from '../ui/LinkButton.vue'
import Spinner from '../ui/Spinner.vue'
import GitBranchMenu from './GitBranchMenu.vue'
import GitChangeList from './GitChangeList.vue'
import GitCommitBox from './GitCommitBox.vue'
import GitPullRequestLine from './GitPullRequestLine.vue'
import { syncLabel } from './gitReviewModel'
import { GIT_REVIEW, useGitReview } from './useGitReview'

const props = withDefaults(
  defineProps<{
    sessionId: string
    hasProject: boolean
    agentBusy: boolean
    visible?: boolean
    focusPaths?: string[]
    commitFocus?: number
  }>(),
  { visible: true, focusPaths: undefined, commitFocus: undefined },
)
const emit = defineEmits<{ commitFocused: [] }>()

/** Inside WorkspacePanel's KeepAlive: false while another pane shows. */
const activated = ref(true)
/** On screen: the column is open and this pane is the one showing. */
const polling = computed(
  () =>
    props.visible &&
    activated.value &&
    props.hasProject &&
    Boolean(props.sessionId),
)
const review = useGitReview(props, polling)
provide(GIT_REVIEW, review)
const {
  status,
  loading,
  readError,
  writeError,
  groups,
  transientLabel,
  focusFilterActive,
} = review

const scroller = ref<HTMLElement | null>(null)
const commitBox = ref<InstanceType<typeof GitCommitBox> | null>(null)
const commitFocusPending = ref(false)
/** Brief accent ring on the commit box after a focus request. */
const commitAttention = ref(false)
let attentionTimer: ReturnType<typeof setTimeout> | undefined
let scrollTop = 0

const sync = computed(() => syncLabel(status.value))
const warning = computed(() => {
  if (transientLabel.value)
    return `${transientLabel.value}。完成或中止前，分支、worktree 与推送都不可用。`
  if (status.value?.truncated)
    return '改动超过安全解析上限，只显示部分状态；刷新到完整状态前不能写入。'
  return ''
})
const filterCount = computed(() => props.focusPaths?.length ?? 0)

onActivated(() => {
  activated.value = true
  // A detached scroller forgot its offset: put it back.
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scrollTop
  })
})
onDeactivated(() => (activated.value = false))
onBeforeUnmount(() => clearTimeout(attentionTimer))

function rememberScroll(): void {
  scrollTop = scroller.value?.scrollTop ?? 0
}

// A commit-focus request waits for the status (the box renders with it).
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
  if (!commitBox.value || !commitFocusPending.value) return
  commitFocusPending.value = false
  commitBox.value.focus()
  commitAttention.value = true
  clearTimeout(attentionTimer)
  attentionTimer = setTimeout(() => (commitAttention.value = false), 1_600)
  emit('commitFocused')
}
</script>

<template>
  <div class="git-review-pane">
    <div class="review-toolbar">
      <GitBranchMenu />
      <span v-if="sync" class="sync" title="与上游相差的提交">{{ sync }}</span>
      <IconButton
        class="refresh"
        label="刷新 Git 状态"
        :disabled="loading"
        @click="review.refresh()"
      >
        <Spinner v-if="loading" size="sm" />
        <RefreshCw v-else :size="16" />
      </IconButton>
    </div>

    <!-- A failed write stays until dismissed (refreshes never clear it). -->
    <div
      v-if="writeError"
      class="review-alert"
      role="alert"
      data-git-write-error
    >
      <span class="alert-text">{{ writeError }}</span>
      <IconButton
        label="关闭错误提示"
        :tooltip="false"
        size="xs"
        @click="writeError = ''"
      >
        <X :size="12" />
      </IconButton>
    </div>

    <div ref="scroller" class="review-scroll" @scroll.passive="rememberScroll">
      <EmptyState
        v-if="!hasProject"
        variant="inline"
        title="当前会话没有 Git 项目。"
      />
      <p v-else-if="readError" class="review-read-error" data-git-read-error>
        {{ readError }}
      </p>
      <template v-if="status">
        <div v-if="focusFilterActive && filterCount" class="task-filter">
          <FileDiff :size="14" aria-hidden="true" />
          <span class="task-filter-text"
            >本次任务 · {{ filterCount }} 个文件</span
          >
          <LinkButton @click="focusFilterActive = false">显示全部</LinkButton>
        </div>
        <p v-if="warning" class="review-warning">
          <TriangleAlert :size="14" aria-hidden="true" />
          <span>{{ warning }}</span>
        </p>
        <GitChangeList v-if="groups.length" />
        <EmptyState
          v-else
          class="review-clean"
          title="没有未提交的改动"
          description="智能体或你修改文件后，改动会出现在这里"
        />
      </template>
      <p v-else-if="loading" class="review-loading">正在读取 Git 状态…</p>
    </div>

    <footer v-if="status" class="review-footer">
      <GitPullRequestLine />
      <GitCommitBox ref="commitBox" :attention="commitAttention" />
    </footer>
  </div>
</template>

<style scoped>
.git-review-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.review-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--control-lg);
  padding: 0 var(--space-2) 0 var(--space-2);
}

.sync {
  flex: none;
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  font-variant-numeric: tabular-nums;
}

.refresh {
  margin-left: auto;
}

.review-alert {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-3) var(--space-2);
  padding: var(--space-1-5) var(--space-1-5) var(--space-1-5) var(--space-2-5);
  border-radius: var(--r-sm);
  color: rgb(var(--error));
  background: rgb(var(--error-soft));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.alert-text {
  flex: 1;
  min-width: 0;
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.review-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-2) var(--space-3);
}

.review-read-error,
.review-warning,
.review-loading {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 var(--space-1) var(--space-2);
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--r-sm);
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.review-read-error {
  color: rgb(var(--error));
  background: rgb(var(--error-soft));
}

.review-warning {
  color: rgb(var(--text-2));
  background: rgb(var(--warn-soft));
}

.review-warning > svg {
  flex: none;
  margin-top: 2px;
  color: rgb(var(--warn));
}

.review-loading {
  color: rgb(var(--text-3));
}

.task-filter {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--row-h);
  margin: 0 0 var(--space-2);
  padding: 0 var(--space-2-5);
  border-radius: var(--r-sm);
  color: rgb(var(--text-2));
  background: rgb(var(--accent-soft));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.task-filter-text {
  flex: 1;
  min-width: 0;
}

.review-clean {
  margin-top: var(--space-6);
}

/* The footer stays put while the list scrolls under its hairline. */
.review-footer {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3) var(--space-3);
  box-shadow: inset 0 0.5px 0 var(--hairline);
}
</style>
