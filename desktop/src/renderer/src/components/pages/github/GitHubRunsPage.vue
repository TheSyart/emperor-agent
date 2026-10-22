<script setup lang="ts">
/**
 * GitHubRunsPage — /github/ci/:owner?/:repo?/:runId?, the GitHub plugin's
 * read-only view of one repository's GitHub Actions runs. The repository is
 * the one in the route, else the last one viewed here, else the current
 * project's github.com `origin`; any `owner/name` can be typed in. Opening
 * a run shows its jobs and steps in place; logs stay on GitHub
 * (在 GitHub 打开). Titles and names from GitHub are plain text.
 *
 * GitHubGate covers the plugin being off and gh being unusable.
 */
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { openLink } from '../../../api/backend'
import {
  listGitHubRuns,
  viewGitHubRun,
  type GitHubRunDetail,
  type GitHubRunListItem,
  type GitHubRunListResult,
} from '../../../api/github'
import { core } from '../../../api/http'
import { useAppContext } from '../../../composables/useAppContext'
import { DsChevronLeft, DsChevronRight, DsGlobe } from '../../icons/ds'
import Button from '../../ui/Button.vue'
import Dot from '../../ui/Dot.vue'
import type { DotState } from '../../ui/dot'
import { EmptyState, Badge, TextField } from '../../settings/ui'
import { refreshAction } from '../../settings/settingsHeader'
import PageShell from '../PageShell.vue'
import { onPageReactivated } from '../pageLifecycle'
import { relativeAgoZh } from '../pulls/pullRequestModel'
import GitHubGate from './GitHubGate.vue'
import GitHubTabs from './GitHubTabs.vue'
import {
  durationZh,
  repoFromParams,
  repoFromRemote,
  repoFromText,
  repoParams,
  runEventLabel,
  runOutcome,
  runRefFromParams,
} from './githubModel'
import { useGitHubAccess } from './useGitHubAccess'

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()
const access = useGitHubAccess()
const { pluginOn, status, busy, ready } = access

const onPage = computed(() => route.name === 'github-ci')
const routeRepo = computed(() =>
  onPage.value ? repoFromParams(route.params) : null,
)
const selected = computed(() =>
  onPage.value ? runRefFromParams(route.params) : null,
)
const lastRepo = ref<string | null>(null)
const projectRepo = ref<string | null>(null)
const repo = computed(
  () => routeRepo.value ?? lastRepo.value ?? projectRepo.value,
)

const repoDraft = ref('')
const repoInvalid = ref(false)
const list = shallowRef<GitHubRunListResult | null>(null)
const listRepo = ref<string | null>(null)
const listLoading = ref(false)
const listError = ref('')
const detail = shallowRef<{ repo: string; run: GitHubRunDetail } | null>(null)
const detailError = ref('')
const now = ref(Date.now())

const rows = computed(() =>
  list.value && listRepo.value === repo.value ? list.value : null,
)
const shown = computed(() => {
  const ref = selected.value
  const loaded = detail.value
  return ref &&
    loaded &&
    loaded.repo === ref.repo &&
    loaded.run.run.id === ref.runId
    ? loaded.run
    : null
})
const shownOutcome = computed(() =>
  shown.value ? runOutcome(shown.value.run) : null,
)

watch(
  routeRepo,
  (value) => {
    if (value) lastRepo.value = value
  },
  { immediate: true },
)
watch(
  repo,
  (value) => {
    repoDraft.value = value ?? ''
    repoInvalid.value = false
  },
  { immediate: true },
)

/** The current project's github.com repository, as the default. */
async function loadProjectRepo(): Promise<void> {
  const sessionId = ctx.sessionId.value
  if (!sessionId) return
  try {
    const remote = await core('git.remote', { sessionId })
    if (sessionId === ctx.sessionId.value)
      projectRepo.value = repoFromRemote(remote)
  } catch {
    // No project, not a git repository, or no origin: no default.
  }
}

let listSeq = 0
async function loadList(): Promise<void> {
  const target = repo.value
  if (!ready.value || !target) return
  const seq = ++listSeq
  listLoading.value = true
  listError.value = ''
  try {
    const result = await listGitHubRuns({ repo: target })
    if (seq === listSeq) {
      list.value = result
      listRepo.value = target
    }
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
    const result = await viewGitHubRun(ref)
    if (seq === detailSeq) detail.value = { repo: ref.repo, run: result }
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

watch(repo, () => void loadList())
watch(selected, () => void loadDetail())
watch(
  ready,
  (value) => {
    if (!value) return
    void loadProjectRepo()
    void loadList()
    void loadDetail()
  },
  { immediate: true },
)
watch(
  () => ctx.sessionId.value,
  () => {
    if (ready.value) void loadProjectRepo()
  },
)
onPageReactivated(() => (pluginOn.value ? refresh() : undefined))

function applyRepo(): void {
  const next = repoFromText(repoDraft.value)
  repoInvalid.value = next === null
  if (!next) return
  if (next === repo.value) {
    void loadList()
    return
  }
  void router
    .push({ name: 'github-ci', params: repoParams(next) })
    .catch(() => undefined)
}

function useProjectRepo(): void {
  if (!projectRepo.value) return
  void router
    .push({ name: 'github-ci', params: repoParams(projectRepo.value) })
    .catch(() => undefined)
}

function open(item: GitHubRunListItem): void {
  if (!repo.value) return
  void router
    .push({
      name: 'github-ci',
      params: { ...repoParams(repo.value), runId: String(item.id) },
    })
    .catch(() => undefined)
}

function back(): void {
  const current = selected.value?.repo ?? repo.value
  void router
    .push(
      current
        ? { name: 'github-ci', params: repoParams(current) }
        : { name: 'github-ci' },
    )
    .catch(() => undefined)
}

function openOnGitHub(url: string): void {
  openLink(url).catch(() => ctx.showToast('无法在浏览器中打开链接'))
}

function runMeta(run: GitHubRunListItem): string {
  return [
    run.runNumber ? `${run.name} #${run.runNumber}` : run.name,
    run.branch,
    runEventLabel(run.event),
    run.actor,
  ]
    .filter(Boolean)
    .join(' · ')
}

const actions = computed(() =>
  pluginOn.value ? [refreshAction(refresh, { label: '刷新运行记录' })] : [],
)

/** A step's outcome as a Dot (no outcome yet: idle). */
function stepDot(tone: string): DotState {
  return tone === 'ok' || tone === 'error' || tone === 'warn' ? tone : 'idle'
}
</script>

<template>
  <PageShell title="GitHub" :actions="actions">
    <template v-if="pluginOn" #tabs>
      <GitHubTabs active="github-ci" />
    </template>

    <GitHubGate
      :plugin-on="pluginOn"
      :status="status"
      :busy="busy"
      subject="CI 运行记录"
      @retry="refresh"
    >
      <div
        v-if="selected"
        class="run-detail"
        :data-run-detail="`${selected.repo}/${selected.runId}`"
      >
        <div class="bar">
          <Button size="sm" variant="ghost" class="back" @click="back">
            <template #icon><DsChevronLeft :size="14" /></template>
            全部运行
          </Button>
          <Button
            v-if="shown"
            size="sm"
            variant="secondary"
            @click="openOnGitHub(shown.run.url)"
          >
            <template #icon><DsGlobe :size="14" /></template>
            在 GitHub 打开
          </Button>
        </div>
        <EmptyState
          v-if="detailError && !shown"
          title="无法读取这次运行"
          :description="detailError"
          framed
        >
          <Button size="sm" variant="secondary" @click="loadDetail"
            >重试</Button
          >
        </EmptyState>
        <p v-else-if="!shown" class="hint" role="status">正在读取…</p>
        <template v-else>
          <header class="head">
            <h2 class="title">{{ shown.run.title || shown.run.name }}</h2>
            <div class="meta">
              <Badge
                v-if="shownOutcome"
                :tone="shownOutcome.tone"
                variant="dot-label"
              >
                {{ shownOutcome.label }}
              </Badge>
              <span>{{ selected.repo }}</span>
              <span>
                {{ runMeta(shown.run) }} ·
                {{ relativeAgoZh(shown.run.createdAt, now) }}
              </span>
            </div>
          </header>
          <p v-if="!shown.jobs.length" class="hint">这次运行没有作业。</p>
          <ol v-else class="jobs">
            <li
              v-for="job in shown.jobs"
              :key="job.id"
              class="job"
              :data-job="job.id"
            >
              <div class="job-head">
                <Badge :tone="runOutcome(job).tone" variant="dot-label">
                  {{ runOutcome(job).label }}
                </Badge>
                <span class="job-name">{{ job.name }}</span>
                <span
                  v-if="durationZh(job.startedAt, job.completedAt)"
                  class="job-time"
                >
                  {{ durationZh(job.startedAt, job.completedAt) }}
                </span>
                <Button
                  v-if="job.url"
                  size="sm"
                  variant="ghost"
                  class="job-link"
                  title="在 GitHub 打开这个作业的日志"
                  @click="openOnGitHub(job.url)"
                >
                  日志
                </Button>
              </div>
              <ol v-if="job.steps.length" class="steps">
                <li
                  v-for="step in job.steps"
                  :key="step.number"
                  class="step"
                  :data-outcome="runOutcome(step).tone"
                >
                  <Dot size="sm" :state="stepDot(runOutcome(step).tone)" />
                  <span class="step-name">{{ step.name }}</span>
                  <span class="step-outcome">{{ runOutcome(step).label }}</span>
                </li>
              </ol>
            </li>
          </ol>
        </template>
      </div>

      <div v-else class="run-list">
        <form class="repo-bar" @submit.prevent="applyRepo">
          <TextField
            v-model="repoDraft"
            class="repo-field"
            size="sm"
            monospace
            placeholder="owner/name"
            aria-label="仓库"
            :invalid="repoInvalid"
            spellcheck="false"
            autocomplete="off"
          />
          <Button size="sm" variant="secondary" type="submit">查看</Button>
          <Button
            v-if="projectRepo && projectRepo !== repo"
            size="sm"
            variant="ghost"
            @click="useProjectRepo"
          >
            当前项目：{{ projectRepo }}
          </Button>
        </form>
        <p v-if="repoInvalid" class="error" role="alert">
          请输入 owner/name 形式的仓库名。
        </p>
        <EmptyState
          v-if="!repo"
          title="选择一个仓库"
          description="输入 GitHub 仓库（owner/name），查看它的 Actions 运行记录。"
          variant="inline"
        />
        <template v-else>
          <p v-if="listError" class="error" role="alert">{{ listError }}</p>
          <p v-if="listLoading && !rows" class="hint" role="status">
            正在读取…
          </p>
          <EmptyState
            v-else-if="rows && !rows.items.length"
            title="没有运行记录"
            description="这个仓库还没有 GitHub Actions 运行记录，或没有启用 Actions。"
            variant="inline"
          />
          <ul
            v-else-if="rows"
            class="rows"
            :aria-busy="listLoading || undefined"
          >
            <li v-for="item in rows.items" :key="item.id">
              <button
                type="button"
                class="row"
                :data-run="item.id"
                @click="open(item)"
              >
                <span class="outcome">
                  <Badge :tone="runOutcome(item).tone" variant="dot-label">
                    {{ runOutcome(item).label }}
                  </Badge>
                </span>
                <span class="main">
                  <span class="row-title">{{ item.title || item.name }}</span>
                  <span class="row-meta">
                    {{ runMeta(item) }} ·
                    {{ relativeAgoZh(item.createdAt, now) }}
                  </span>
                </span>
                <DsChevronRight :size="14" class="chevron" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <p v-if="rows && rows.total > rows.items.length" class="hint">
            共 {{ rows.total }} 次，只显示最近 {{ rows.items.length }} 次。
          </p>
        </template>
      </div>
    </GitHubGate>
  </PageShell>
</template>

<style scoped>
.run-list,
.run-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding-top: var(--space-1);
}

.repo-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
}

.repo-field {
  flex: 1;
  min-width: 180px;
  max-width: 320px;
}

.rows,
.jobs {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow: hidden;
  list-style: none;
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-card);
  background: rgb(var(--surface-overlay));
}

.rows > li + li,
.jobs > li + li {
  border-top: 1px solid var(--stroke-2);
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
  background: var(--surface-hover);
}

.row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

/* One column wide enough for the longest outcome, so titles line up. */
.outcome {
  display: flex;
  flex: none;
  width: 76px;
}

.main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.row-title,
.job-name {
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-medium);
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.title {
  margin: 0;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.row-meta,
.meta,
.hint,
.error,
.job-time {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
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
  color: rgb(var(--text-3));
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

.head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.job {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2-5) var(--space-4);
}

.job-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.job-name {
  flex: 1;
}

.job-time {
  flex: none;
}

.job-link {
  flex: none;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0 0 0 var(--space-1);
  list-style: none;
}

.step {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.step-name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.step-outcome {
  flex: none;
  color: rgb(var(--text-3));
}
</style>
