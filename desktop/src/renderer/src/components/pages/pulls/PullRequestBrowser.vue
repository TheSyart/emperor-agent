<script setup lang="ts">
/**
 * PullRequestBrowser — body of the Pull Request page (inside PageShell, so
 * its refresh action lands in the page header via useSettingsHeader).
 *
 * gh unavailable → PullRequestUnavailable fills the page. Otherwise a
 * resizable list column (width persisted) beside the detail pane. The
 * route params (`/pulls/:owner/:repo/:number`) are the selection, so a PR is
 * deep-linkable and back / forward walk the PRs that were opened; the params
 * are only read while this (kept-alive) page is the active route. Refreshes
 * on activation. Narrow frames (< 720px) show the list or the detail.
 */
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  PULL_REQUEST_QUERY_MAX,
  type PullRequestListFilter,
  type PullRequestListItem,
  type PullRequestRef,
} from '../../../api/pullRequests'
import { useResizable } from '../../../composables/useResizable'
import { refreshAction, useSettingsHeader } from '../../settings/settingsHeader'
import { useSettingsRoute } from '../../settings/useSettingsRoute'
import EmptyState from '../../settings/ui/EmptyState.vue'
import PullRequestDetail from './PullRequestDetail.vue'
import PullRequestList from './PullRequestList.vue'
import PullRequestUnavailable from './PullRequestUnavailable.vue'
import { pullIcons } from './pullIcons'
import {
  applyClientFilters,
  emptyListMessage,
  groupPullRequests,
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  pullKey,
  pullRefFromParams,
  pullRouteParams,
  pullTabLabel,
  readListWidth,
  samePull,
  writeListWidth,
  type PullClientFilter,
  type PullGrouping,
} from './pullRequestModel'
import { usePullRequestBrowser } from './usePullRequestBrowser'

const SEARCH_DEBOUNCE_MS = 300
const NARROW_WIDTH = 720

const route = useRoute()
const router = useRouter()
const { openSettings } = useSettingsRoute()

// ── List inputs ─────────────────────────────────────────────────────────
const filter = ref<PullRequestListFilter>('all')
const searchText = ref('')
const query = ref('')
const clientFilters = ref<PullClientFilter[]>([])
const grouping = ref<PullGrouping>('none')

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchText, (text) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    query.value = text.trim().slice(0, PULL_REQUEST_QUERY_MAX)
  }, SEARCH_DEBOUNCE_MS)
})

// ── Selection (route-driven) ────────────────────────────────────────────
const selected = shallowRef<PullRequestRef | null>(null)
watch(
  () =>
    [
      route.name,
      route.params.owner,
      route.params.repo,
      route.params.number,
    ] as const,
  () => {
    // Kept alive under another route: its params are not ours.
    if (route.name !== 'pulls') return
    const next = pullRefFromParams(route.params)
    if (!samePull(next, selected.value)) selected.value = next
  },
  { immediate: true },
)

function select(item: PullRequestListItem): void {
  if (samePull(item, selected.value)) return
  void router
    .push({ name: 'pulls', params: pullRouteParams(item) })
    .catch(() => undefined)
}

function clearSelection(): void {
  void router.push({ name: 'pulls', params: {} }).catch(() => undefined)
}

// ── Data ────────────────────────────────────────────────────────────────
const browser = usePullRequestBrowser({ filter, query, selected })
const { status, statusLoading, available, list, detail, diff } = browser

const items = computed(() => list.value.data?.items ?? [])
const shownItems = computed(() =>
  applyClientFilters(items.value, clientFilters.value),
)
const groups = computed(() =>
  groupPullRequests(
    shownItems.value,
    grouping.value,
    pullTabLabel(filter.value),
  ),
)
const listLoading = computed(() => list.value.loading && !list.value.data)
const emptyMessage = computed(() =>
  emptyListMessage(filter.value, query.value, clientFilters.value.length > 0),
)
const selectedKey = computed(() =>
  selected.value ? pullKey(selected.value) : null,
)
const selectedItem = computed(
  () => items.value.find((item) => samePull(item, selected.value)) ?? null,
)

watch(
  [available, filter, query],
  () => {
    if (available.value) void browser.ensureList()
  },
  { immediate: true },
)
watch(
  [available, selected],
  () => {
    if (available.value && selected.value)
      void browser.ensureDetail(selected.value)
  },
  { immediate: true },
)

function loadDiff(): void {
  if (selected.value) void browser.ensureDiff(selected.value)
}
function retryDiff(): void {
  if (selected.value) void browser.loadDiff(selected.value)
}
function retryDetail(): void {
  if (selected.value) void browser.loadDetail(selected.value)
}

// ── Header / lifecycle ──────────────────────────────────────────────────
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

function refresh(): Promise<void> {
  now.value = Date.now()
  return browser.refresh()
}

useSettingsHeader({
  actions: () => [refreshAction(refresh, { label: '刷新 Pull Request' })],
})

/** Ages tick once a minute while the page is on screen. */
function startClock(): void {
  clock ??= setInterval(() => {
    now.value = Date.now()
  }, 60_000)
}
function stopClock(): void {
  if (clock) clearInterval(clock)
  clock = null
}

// A kept-alive page fires `activated` right after its first mount too.
let skipActivation = true
onMounted(() => {
  void refresh()
  startClock()
})
onActivated(() => {
  startClock()
  if (skipActivation) {
    skipActivation = false
    return
  }
  void refresh()
})
onDeactivated(stopClock)
onBeforeUnmount(() => {
  stopClock()
  if (searchTimer) clearTimeout(searchTimer)
  layoutObserver?.disconnect()
})

// ── Layout: resizable list column, narrow single-pane mode ─────────────
const listWidth = ref(readListWidth())
const resizer = useResizable({
  size: listWidth,
  min: LIST_WIDTH_MIN,
  max: LIST_WIDTH_MAX,
  edge: 'right',
  onCommit: (px) => writeListWidth(px),
})
function resetListWidth(): void {
  listWidth.value = LIST_WIDTH_DEFAULT
  writeListWidth(LIST_WIDTH_DEFAULT)
}

const layout = ref<HTMLElement | null>(null)
const layoutWidth = ref(0)
let layoutObserver: ResizeObserver | null = null
watch(layout, (element) => {
  layoutObserver?.disconnect()
  layoutObserver = null
  if (!element || typeof ResizeObserver === 'undefined') return
  layoutWidth.value = element.getBoundingClientRect().width
  layoutObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (width) layoutWidth.value = width
  })
  layoutObserver.observe(element)
})
const narrow = computed(
  () => layoutWidth.value > 0 && layoutWidth.value < NARROW_WIDTH,
)

const detailPane = ref<HTMLElement | null>(null)
watch(selectedKey, () => {
  detailPane.value?.scrollTo({ top: 0 })
})
</script>

<template>
  <div class="pr-browser">
    <div
      v-if="!status"
      class="pr-connecting"
      role="status"
      :aria-busy="statusLoading"
    >
      正在连接 GitHub CLI…
    </div>

    <PullRequestUnavailable
      v-else-if="!status.available"
      :status="status"
      :busy="statusLoading"
      @retry="refresh"
      @diagnose="openSettings('diagnostics')"
    />

    <div
      v-else
      ref="layout"
      class="pr-layout"
      :data-narrow="narrow || undefined"
      :data-resizing="resizer.resizing.value || undefined"
      :style="{ '--pr-list-width': `${listWidth}px` }"
    >
      <aside
        v-show="!narrow || !selected"
        class="list-col"
        aria-label="Pull Request"
      >
        <PullRequestList
          v-model:filter="filter"
          v-model:search="searchText"
          v-model:client-filters="clientFilters"
          v-model:grouping="grouping"
          :groups="groups"
          :loading="listLoading"
          :error="list.error"
          :empty-message="emptyMessage"
          :selected-key="selectedKey"
          :login="status.login"
          :total="list.data?.total ?? 0"
          :shown="items.length"
          :now="now"
          @select="select"
          @retry="browser.loadList"
        />
        <div
          v-if="!narrow"
          class="resize-handle"
          v-bind="resizer.separatorProps"
          aria-label="调整列表宽度"
          title="拖动调整宽度，双击恢复默认"
          @dblclick="resetListWidth"
        />
      </aside>

      <div v-show="!narrow || selected" ref="detailPane" class="detail-col">
        <PullRequestDetail
          v-if="selected"
          :pull-ref="selected"
          :entry="detail"
          :diff-entry="diff"
          :list-item="selectedItem"
          :now="now"
          :show-back="narrow"
          @retry="retryDetail"
          @load-diff="loadDiff"
          @retry-diff="retryDiff"
          @back="clearSelection"
        />
        <div v-else class="detail-empty">
          <EmptyState
            variant="plain"
            title="选择要查看的 Pull Request"
            description="从左侧列表选择后，可查看描述、检查和改动。"
            :icon="pullIcons.pull"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pr-browser {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.pr-connecting {
  display: grid;
  flex: 1;
  place-items: center;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.pr-layout {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  border-top: 1px solid var(--border-l2);
}

.list-col {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: var(--pr-list-width);
  max-width: 50%;
  min-height: 0;
  border-right: 1px solid var(--border-l2);
}

.pr-layout[data-narrow] .list-col {
  flex: 1;
  width: auto;
  max-width: none;
  border-right: none;
}

.resize-handle {
  position: absolute;
  z-index: var(--z-raised);
  top: 0;
  right: calc(-1 * var(--space-1));
  bottom: 0;
  width: var(--space-2);
  cursor: col-resize;
  touch-action: none;
  outline: none;
}

.resize-handle:hover,
.resize-handle:focus-visible,
.pr-layout[data-resizing] .resize-handle {
  background: linear-gradient(
    90deg,
    transparent calc(50% - 1px),
    rgb(var(--focus-ring) / 0.5) calc(50% - 1px),
    rgb(var(--focus-ring) / 0.5) calc(50% + 1px),
    transparent calc(50% + 1px)
  );
}

.detail-col {
  container: pr-detail / inline-size;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.detail-empty {
  display: grid;
  height: 100%;
  place-items: center;
  padding: var(--space-6);
}

.detail-empty :deep(.ds-empty-state) {
  max-width: 360px;
}
</style>
