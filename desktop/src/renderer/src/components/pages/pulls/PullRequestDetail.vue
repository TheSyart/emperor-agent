<script setup lang="ts">
/**
 * PullRequestDetail — the right pane for one PR: header (title, #number,
 * state badge incl. draft, repo, `head → base`, author, age, 在 GitHub 打开),
 * a stats line (+A −D · files · commits · review decision), then two tabs:
 * 概览 (description, checks, changed files) and 查看 diff (lazy). Read-only:
 * no merge / close / checkout here (those stay in 审查).
 *
 * While the detail loads, the header falls back to the list row it was
 * opened from. Loaded lazily: PullRequestBody (markdown) and
 * PullRequestDiff (DiffBlock).
 *
 * Props: pullRef; entry (detail state); diffEntry; listItem?; now; showBack.
 * Emits: retry, load-diff (the diff tab wants its data), retry-diff, back.
 */
import { computed, defineAsyncComponent, inject, ref, watch } from 'vue'
import { openExternal } from '../../../api/backend'
import type {
  PullRequestDetail,
  PullRequestDiffResult,
  PullRequestListItem,
  PullRequestRef,
} from '../../../api/pullRequests'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import Button from '../../ui/Button.vue'
import Tabs from '../../ui/Tabs.vue'
import EmptyState from '../../settings/ui/EmptyState.vue'
import StatusBadge from '../../settings/ui/StatusBadge.vue'
import { checkOutcomeIcons, pullIcons } from './pullIcons'
import {
  checkOutcomeLabel,
  checksSummary,
  countLabel,
  pullKey,
  pullStateBadge,
  relativeAgoZh,
  reviewDecisionLabel,
  sortChecks,
} from './pullRequestModel'
import type { AsyncEntry } from './usePullRequestBrowser'

const PullRequestBody = defineAsyncComponent(
  () => import('./PullRequestBody.vue'),
)
const PullRequestDiff = defineAsyncComponent(
  () => import('./PullRequestDiff.vue'),
)

const props = defineProps<{
  pullRef: PullRequestRef
  entry: AsyncEntry<PullRequestDetail>
  diffEntry: AsyncEntry<PullRequestDiffResult>
  listItem?: PullRequestListItem | null
  now: number
  showBack?: boolean
}>()
const emit = defineEmits<{
  retry: []
  'load-diff': []
  'retry-diff': []
  back: []
}>()

const app = inject(APP_CONTEXT_KEY, null)

type DetailTab = 'overview' | 'diff'
const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'diff', label: '查看 diff' },
]
const tab = ref<DetailTab>('overview')
const focusPath = ref<string | null>(null)

watch(
  () => pullKey(props.pullRef),
  () => {
    tab.value = 'overview'
    focusPath.value = null
  },
)
watch(
  tab,
  (value) => {
    if (value === 'diff') emit('load-diff')
  },
  { immediate: true },
)

function onTab(id: string): void {
  if (id === 'overview' || id === 'diff') tab.value = id
}

function openFile(path: string): void {
  focusPath.value = null
  tab.value = 'diff'
  // Re-set after the tab switch so the diff scrolls even for the same path.
  queueMicrotask(() => {
    focusPath.value = path
  })
}

const data = computed(() => props.entry.data)
/** Header facts: the loaded detail, else the list row, else the ref. */
const head = computed(() => {
  const detail = data.value
  const item = props.listItem
  return {
    title: detail?.title ?? item?.title ?? '',
    number: props.pullRef.number,
    repo: props.pullRef.repo,
    state: detail?.state ?? item?.state ?? 'OPEN',
    isDraft: detail?.isDraft ?? item?.isDraft ?? false,
    author: detail?.author ?? item?.author ?? '',
    updatedAt: detail?.updatedAt ?? item?.updatedAt ?? '',
    headRefName: detail?.headRefName ?? item?.headRefName ?? '',
    baseRefName: detail?.baseRefName ?? '',
    url:
      detail?.url ??
      item?.url ??
      `https://github.com/${props.pullRef.repo}/pull/${props.pullRef.number}`,
  }
})
const badge = computed(() =>
  pullStateBadge(head.value.state, head.value.isDraft),
)
const updated = computed(() => relativeAgoZh(head.value.updatedAt, props.now))
const review = computed(() =>
  reviewDecisionLabel(
    data.value?.reviewDecision ?? props.listItem?.reviewDecision ?? null,
  ),
)
const checks = computed(() => sortChecks(data.value?.checks ?? []))
const checksText = computed(() => checksSummary(data.value?.checks ?? []))

const notFound = computed(
  () => !data.value && props.entry.error?.kind === 'not_found',
)
const failed = computed(() => !data.value && Boolean(props.entry.error))
const loading = computed(() => !data.value && !props.entry.error)

function openOnGithub(): void {
  openExternal(head.value.url).catch(() =>
    app?.showToast('无法在浏览器中打开 GitHub'),
  )
}
</script>

<template>
  <article class="pr-detail" :aria-busy="entry.loading || undefined">
    <button v-if="showBack" type="button" class="back" @click="emit('back')">
      <component :is="pullIcons.back" :size="14" aria-hidden="true" />
      返回列表
    </button>

    <EmptyState
      v-if="notFound"
      class="detail-state"
      variant="plain"
      title="找不到这个 Pull Request"
      :description="entry.error?.message"
    />
    <EmptyState
      v-else-if="failed && !head.title"
      class="detail-state"
      variant="plain"
      title="无法读取 Pull Request"
      :description="entry.error?.message"
    >
      <Button size="sm" variant="outline" @click="emit('retry')">重试</Button>
    </EmptyState>

    <template v-else>
      <header class="detail-head">
        <div class="title-row">
          <h2 class="detail-title">
            <span v-if="head.title">{{ head.title }}</span>
            <span v-else class="title-skeleton" aria-label="加载中" />
            <span class="number">#{{ head.number }}</span>
          </h2>
          <Button
            class="open-github"
            size="sm"
            variant="outline"
            @click="openOnGithub"
          >
            在 GitHub 打开
            <component :is="pullIcons.external" :size="14" aria-hidden="true" />
          </Button>
        </div>
        <div class="meta-row">
          <StatusBadge :tone="badge.tone" dot data-pr-state>
            {{ badge.label }}
          </StatusBadge>
          <span class="repo">{{ head.repo }}</span>
          <span v-if="head.headRefName" class="branches">
            <code class="ref">{{ head.headRefName }}</code>
            <template v-if="head.baseRefName">
              <span class="arrow" aria-label="合并到">→</span>
              <code class="ref">{{ head.baseRefName }}</code>
            </template>
          </span>
          <span v-if="head.author" class="author">
            {{ head.author
            }}<template v-if="updated"> · 更新于 {{ updated }}</template>
          </span>
        </div>
        <div v-if="data" class="stats-row">
          <span class="add">+{{ data.additions }}</span>
          <span class="del">−{{ data.deletions }}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span>{{ countLabel(data.changedFiles, '文件') }}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span>{{ countLabel(data.commits, '提交') }}</span>
          <template v-if="review">
            <span class="sep" aria-hidden="true">·</span>
            <span
              class="review"
              :data-review="data.reviewDecision ?? undefined"
              >{{ review }}</span
            >
          </template>
        </div>
      </header>

      <Tabs
        class="detail-tabs"
        :tabs="TABS"
        :model-value="tab"
        @update:model-value="onTab"
      />

      <div v-if="tab === 'overview'" class="overview">
        <p v-if="failed" class="inline-error" role="alert">
          {{ entry.error?.message }}
          <button type="button" class="inline-retry" @click="emit('retry')">
            重试
          </button>
        </p>
        <div v-else-if="loading" class="overview-loading" aria-busy="true">
          <span class="bar" />
          <span class="bar bar--short" />
          <span class="bar" />
        </div>

        <template v-if="data">
          <section class="card body-card" aria-label="描述">
            <div class="card-head">
              <span class="card-title">{{ data.author }}</span>
              <span class="card-meta">
                创建于 {{ relativeAgoZh(data.createdAt, now) }}
              </span>
            </div>
            <div class="card-body">
              <PullRequestBody :body="data.body" />
            </div>
          </section>

          <section class="section" aria-labelledby="pr-checks-title">
            <div class="section-head">
              <h3 id="pr-checks-title" class="section-title">检查</h3>
              <span v-if="checksText" class="section-meta">{{
                checksText
              }}</span>
            </div>
            <p v-if="!checks.length" class="section-empty">
              最新提交没有运行检查。
            </p>
            <ul v-else class="rows" data-pr-checks>
              <li
                v-for="(check, index) in checks"
                :key="`${index}:${check.name}`"
                class="row"
                :data-outcome="check.outcome"
              >
                <component
                  :is="checkOutcomeIcons[check.outcome]"
                  :size="16"
                  class="check-icon"
                  aria-hidden="true"
                />
                <span class="row-main">{{ check.name }}</span>
                <span class="row-meta">{{
                  checkOutcomeLabel(check.outcome)
                }}</span>
              </li>
            </ul>
          </section>

          <section class="section" aria-labelledby="pr-files-title">
            <div class="section-head">
              <h3 id="pr-files-title" class="section-title">改动文件</h3>
              <span class="section-meta">
                {{ countLabel(data.changedFiles, '文件') }}
              </span>
            </div>
            <p v-if="!data.files.length" class="section-empty">
              没有文件改动。
            </p>
            <ul v-else class="rows" data-pr-files>
              <li v-for="file in data.files" :key="file.path">
                <button
                  type="button"
                  class="row row--button"
                  :title="`在 diff 中查看 ${file.path}`"
                  @click="openFile(file.path)"
                >
                  <span class="row-main path">{{ file.path }}</span>
                  <span class="row-meta stats">
                    <span class="add">+{{ file.additions }}</span>
                    <span class="del">−{{ file.deletions }}</span>
                  </span>
                </button>
              </li>
            </ul>
            <p
              v-if="data.changedFiles > data.files.length"
              class="section-note"
            >
              只列出前 {{ data.files.length }} 个文件，完整列表见「查看 diff」。
            </p>
          </section>
        </template>
      </div>

      <PullRequestDiff
        v-else
        class="diff-pane"
        :entry="diffEntry"
        :focus-path="focusPath"
        @retry="emit('retry-diff')"
        @open-external="openOnGithub"
      />
    </template>
  </article>
</template>

<style scoped>
.pr-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  box-sizing: border-box;
  width: 100%;
  max-width: 960px;
  min-width: 0;
  margin: 0 auto;
  padding: var(--space-5) var(--space-6) var(--space-8);
}

.back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  cursor: pointer;
}

.detail-state {
  padding-top: var(--space-8);
}

.detail-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  min-width: 0;
}

.detail-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: rgb(var(--label-primary));
  font-size: var(--fs-md);
  line-height: var(--lh-base);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.number {
  margin-left: var(--space-1-5);
  color: rgb(var(--label-tertiary));
  font-weight: 400;
}

.title-skeleton {
  display: inline-block;
  width: 60%;
  height: var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--skeleton-bg);
  vertical-align: middle;
}

.open-github {
  flex: none;
}

.meta-row,
.stats-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5) var(--space-2);
  min-width: 0;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.stats-row {
  gap: var(--space-1-5);
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.repo {
  color: rgb(var(--label-primary));
  font-weight: 500;
}

.branches {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  max-width: 100%;
}

.ref {
  min-width: 0;
  overflow: hidden;
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
  font: var(--font-code-small);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arrow {
  color: rgb(var(--label-tertiary));
}

.author {
  color: rgb(var(--label-tertiary));
}

.sep {
  color: rgb(var(--label-caption));
}

.add {
  color: rgb(var(--state-ok-label));
}

.del {
  color: rgb(var(--state-error-label));
}

.review[data-review='APPROVED'] {
  color: rgb(var(--state-ok-label));
}

.review[data-review='CHANGES_REQUESTED'] {
  color: rgb(var(--state-error-label));
}

.review[data-review='REVIEW_REQUIRED'] {
  color: rgb(var(--state-warn-label));
}

.detail-tabs {
  border-bottom: 1px solid var(--border-l2);
}

.overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  min-width: 0;
}

.overview-loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
}

.bar {
  display: block;
  width: 100%;
  height: var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--skeleton-bg);
}

.bar--short {
  width: 60%;
}

.card {
  min-width: 0;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
}

.card-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-l1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.card-title {
  color: rgb(var(--label-primary));
  font-weight: 600;
}

.card-meta {
  color: rgb(var(--label-tertiary));
}

.card-body {
  padding: var(--space-3) var(--space-4) var(--space-4);
  min-width: 0;
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.section-title {
  margin: 0;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 600;
}

.section-meta,
.section-note,
.section-empty {
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  list-style: none;
  overflow: hidden;
}

.rows > li + li {
  border-top: 1px solid var(--border-l1);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: var(--space-8);
  padding: var(--space-1-5) var(--space-3);
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.row--button {
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.row--button:hover {
  background: var(--interactive-bg-hover);
}

.row--button:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.row-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path {
  font: var(--font-code-small);
}

.row-meta {
  flex: none;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.stats {
  display: inline-flex;
  gap: var(--space-1-5);
  font-variant-numeric: tabular-nums;
}

.check-icon {
  flex: none;
}

.row[data-outcome='success'] .check-icon {
  color: rgb(var(--state-ok-label));
}

.row[data-outcome='failure'] .check-icon,
.row[data-outcome='failure'] .row-meta {
  color: rgb(var(--state-error-label));
}

.row[data-outcome='pending'] .check-icon {
  color: rgb(var(--state-warn-label));
}

.row[data-outcome='neutral'] .check-icon {
  color: rgb(var(--label-tertiary));
}

.inline-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.inline-retry {
  flex: none;
  margin-left: auto;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 500;
  text-decoration: underline;
  cursor: pointer;
}

@container pr-detail (max-width: 559px) {
  .pr-detail {
    padding: var(--space-4) var(--space-4) var(--space-6);
  }

  .title-row {
    flex-direction: column;
    gap: var(--space-2);
  }
}
</style>
