<script setup lang="ts">
/**
 * GitHubIssuesPage — /github/issues/:owner?/:repo?/:number?, the GitHub
 * plugin's read-only Issue view. The list shows the account's open issues
 * (与我相关 / 我的仓库 / 分配给我 / 我创建的 / 提到我 — remembered on this
 * machine — plus search); opening one swaps the list for its detail in
 * place: state, labels,
 * assignees, the body and the latest comments. Bodies render like PR bodies
 * (no raw HTML, links open in the system browser); titles are plain text.
 *
 * GitHubGate covers the plugin being off and gh being unusable.
 */
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { openLink } from '../../../api/backend'
import {
  listGitHubIssues,
  viewGitHubIssue,
  type GitHubIssueDetail,
  type GitHubIssueListFilter,
  type GitHubIssueListItem,
  type GitHubIssueListResult,
} from '../../../api/github'
import { useAppContext } from '../../../composables/useAppContext'
import { DsChevronLeft, DsChevronRight, DsGlobe } from '../../icons/ds'
import Button from '../../ui/Button.vue'
import {
  EmptyState,
  SearchField,
  Segmented,
  StatusBadge,
} from '../../settings/ui'
import { refreshAction } from '../../settings/settingsHeader'
import PageShell from '../PageShell.vue'
import { onPageReactivated } from '../pageLifecycle'
import { relativeAgoZh } from '../pulls/pullRequestModel'
import GitHubGate from './GitHubGate.vue'
import GitHubLabels from './GitHubLabels.vue'
import GitHubTabs from './GitHubTabs.vue'
import {
  ISSUE_FILTERS,
  issueRefFromParams,
  issueStateBadge,
  readIssueFilter,
  repoParams,
  writeIssueFilter,
} from './githubModel'
import { useGitHubAccess } from './useGitHubAccess'

const PullRequestBody = defineAsyncComponent(
  () => import('../pulls/PullRequestBody.vue'),
)

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()
const access = useGitHubAccess()
const { pluginOn, status, busy, ready } = access

const filter = ref<GitHubIssueListFilter>(readIssueFilter())
const query = ref('')
const list = shallowRef<GitHubIssueListResult | null>(null)
const listLoading = ref(false)
const listError = ref('')
const detail = shallowRef<GitHubIssueDetail | null>(null)
const detailError = ref('')
const now = ref(Date.now())

const selected = computed(() =>
  route.name === 'github-issues' ? issueRefFromParams(route.params) : null,
)
const shown = computed(() => {
  const ref = selected.value
  const issue = detail.value
  return ref && issue && issue.repo === ref.repo && issue.number === ref.number
    ? issue
    : null
})
const badge = computed(() =>
  shown.value ? issueStateBadge(shown.value) : null,
)

let listSeq = 0
async function loadList(): Promise<void> {
  if (!ready.value) return
  const seq = ++listSeq
  listLoading.value = true
  listError.value = ''
  try {
    const result = await listGitHubIssues({
      filter: filter.value,
      query: query.value,
    })
    if (seq === listSeq) list.value = result
  } catch (error) {
    if (seq === listSeq) listError.value = access.failure(error)
  } finally {
    if (seq === listSeq) listLoading.value = false
    now.value = Date.now()
  }
}

let detailSeq = 0
async function loadDetail(): Promise<void> {
  const ref = selected.value
  if (!ref || !ready.value) return
  const seq = ++detailSeq
  detailError.value = ''
  try {
    const result = await viewGitHubIssue(ref)
    if (seq === detailSeq) detail.value = result
  } catch (error) {
    if (seq === detailSeq) detailError.value = access.failure(error)
  } finally {
    now.value = Date.now()
  }
}

async function refresh(): Promise<void> {
  await access.checkStatus()
  await (selected.value ? loadDetail() : loadList())
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadList(), 300)
})
watch(filter, (value) => {
  writeIssueFilter(value)
  void loadList()
})
watch(selected, () => void loadDetail())
watch(
  ready,
  (value) => {
    if (!value) return
    void loadList()
    void loadDetail()
  },
  { immediate: true },
)
onPageReactivated(() => (pluginOn.value ? refresh() : undefined))
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

function open(item: GitHubIssueListItem): void {
  void router
    .push({
      name: 'github-issues',
      params: { ...repoParams(item.repo), number: String(item.number) },
    })
    .catch(() => undefined)
}

function back(): void {
  void router.push({ name: 'github-issues' }).catch(() => undefined)
}

function openOnGitHub(url: string): void {
  openLink(url).catch(() => ctx.showToast('无法在浏览器中打开链接'))
}

const actions = computed(() =>
  pluginOn.value ? [refreshAction(refresh, { label: '刷新 Issue' })] : [],
)
</script>

<template>
  <PageShell title="GitHub" :actions="actions">
    <template v-if="pluginOn" #tabs>
      <GitHubTabs active="github-issues" />
    </template>

    <GitHubGate
      :plugin-on="pluginOn"
      :status="status"
      :busy="busy"
      subject="Issue"
      @retry="refresh"
    >
      <div
        v-if="selected"
        class="issue-detail"
        :data-issue-detail="`${selected.repo}#${selected.number}`"
      >
        <div class="bar">
          <Button size="sm" variant="ghost" class="back" @click="back">
            <template #icon><DsChevronLeft :size="14" /></template>
            全部 Issue
          </Button>
          <Button
            v-if="shown"
            size="sm"
            variant="outline"
            @click="openOnGitHub(shown.url)"
          >
            <template #icon><DsGlobe :size="14" /></template>
            在 GitHub 打开
          </Button>
        </div>
        <EmptyState
          v-if="detailError && !shown"
          title="无法读取这个 Issue"
          :description="detailError"
        >
          <Button size="sm" variant="outline" @click="loadDetail">重试</Button>
        </EmptyState>
        <p v-else-if="!shown" class="hint" role="status">正在读取…</p>
        <template v-else>
          <header class="head">
            <h2 class="title">{{ shown.title }}</h2>
            <div class="meta">
              <StatusBadge v-if="badge" :tone="badge.tone" dot>
                {{ badge.label }}
              </StatusBadge>
              <span>{{ shown.repo }}#{{ shown.number }}</span>
              <span>
                {{ shown.author }} 创建于
                {{ relativeAgoZh(shown.createdAt, now) }}
              </span>
              <span v-if="shown.assignees.length">
                负责人：{{ shown.assignees.join('、') }}
              </span>
            </div>
            <GitHubLabels :labels="shown.labels" />
          </header>
          <PullRequestBody :body="shown.body" />
          <section class="comments" data-issue-comments>
            <h3 class="section-title">
              评论
              <span class="count">{{ shown.commentCount }}</span>
            </h3>
            <p v-if="shown.commentCount > shown.comments.length" class="hint">
              只显示最近 {{ shown.comments.length }} 条，其余在 GitHub 上查看。
            </p>
            <ol v-if="shown.comments.length" class="comment-list">
              <li
                v-for="(comment, index) in shown.comments"
                :key="`${comment.createdAt}:${index}`"
                class="comment"
              >
                <p class="comment-meta">
                  {{ comment.author }} ·
                  {{ relativeAgoZh(comment.createdAt, now) }}
                </p>
                <PullRequestBody :body="comment.body" />
              </li>
            </ol>
            <p v-else class="hint">还没有评论</p>
          </section>
        </template>
      </div>

      <div v-else class="issue-list">
        <div class="toolbar">
          <Segmented
            v-model="filter"
            :options="ISSUE_FILTERS"
            aria-label="Issue 范围"
          />
          <SearchField
            v-model="query"
            class="search"
            placeholder="搜索 Issue"
          />
        </div>
        <p v-if="listError" class="error" role="alert">{{ listError }}</p>
        <p v-if="listLoading && !list" class="hint" role="status">正在读取…</p>
        <EmptyState
          v-else-if="list && !list.items.length"
          :title="query.trim() ? '没有匹配的开放 Issue' : '没有开放的 Issue'"
          :description="
            filter === 'involved'
              ? '别人在你名下仓库里开的 Issue，在「我的仓库」里查看。'
              : undefined
          "
          variant="plain"
          compact
        />
        <ul v-else-if="list" class="rows" :aria-busy="listLoading || undefined">
          <li v-for="item in list.items" :key="`${item.repo}#${item.number}`">
            <button
              type="button"
              class="row"
              :data-issue="`${item.repo}#${item.number}`"
              @click="open(item)"
            >
              <span class="main">
                <span class="row-title">{{ item.title }}</span>
                <span class="row-meta">
                  {{ item.repo }}#{{ item.number }} · {{ item.author }} · 更新于
                  {{ relativeAgoZh(item.updatedAt, now) }}
                  <template v-if="item.commentCount">
                    · {{ item.commentCount }} 条评论
                  </template>
                </span>
                <GitHubLabels :labels="item.labels" />
              </span>
              <DsChevronRight :size="14" class="chevron" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-if="list && list.total > list.items.length" class="hint">
          共 {{ list.total }} 个，只显示最近更新的
          {{ list.items.length }} 个；可以搜索缩小范围。
        </p>
      </div>
    </GitHubGate>
  </PageShell>
</template>

<style scoped>
.issue-list,
.issue-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding-top: var(--space-1);
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.search {
  flex: 1;
  min-width: 180px;
}

.rows {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow: hidden;
  list-style: none;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-3));
}

.rows > li + li {
  border-top: 1px solid var(--border-l2);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  padding: var(--space-2-5) var(--space-3) var(--space-2-5) var(--space-4);
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--interactive-bg-hover);
}

.row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.row-title {
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.title {
  margin: 0;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 600;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.row-meta,
.meta,
.hint,
.comment-meta,
.error {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.error {
  color: rgb(var(--state-error-label));
}

.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.chevron {
  flex: none;
  color: rgb(var(--label-caption));
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.back {
  margin-left: calc(var(--space-2) * -1);
}

.head,
.comments {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.comments {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l2);
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.count {
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.comment-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.comment {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
}
</style>
