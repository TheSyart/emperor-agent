<script setup lang="ts">
/**
 * PullRequestList — the list column of the Pull Request page: 全部 /
 * 正在审查 / 由我创建 tabs (with the gh login), the search field and the
 * filter menu (草稿 / 检查失败 / 需要修改 client filters + grouping), then
 * collapsible groups of rows. ↑/↓/Home/End walk the visible rows (roving
 * tabindex), Enter / Space open one; ↓ from the search field enters the list.
 *
 * Props: groups; loading (first load, no rows yet); error; emptyMessage;
 * selectedKey (`repo#number`); login?; total / shown (search matches vs
 * loaded rows); now (ms, for ages).
 * Models: filter, search (raw text), clientFilters, grouping.
 * Emits: select (item), retry.
 */
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type {
  PullRequestErrorInfo,
  PullRequestListFilter,
  PullRequestListItem,
} from '../../../api/pullRequests'
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import Menu from '../../ui/Menu.vue'
import MenuItem from '../../ui/MenuItem.vue'
import Tabs from '../../ui/Tabs.vue'
import EmptyState from '../../settings/ui/EmptyState.vue'
import SearchField from '../../settings/ui/SearchField.vue'
import PullRequestRow from './PullRequestRow.vue'
import { pullIcons } from './pullIcons'
import {
  isPullFilter,
  pullKey,
  PULL_CLIENT_FILTERS,
  PULL_TABS,
  relativeAgeZh,
  stepIndex,
  visiblePulls,
  type PullClientFilter,
  type PullGroup,
  type PullGrouping,
} from './pullRequestModel'

const props = defineProps<{
  groups: PullGroup[]
  loading: boolean
  error: PullRequestErrorInfo | null
  emptyMessage: string
  selectedKey: string | null
  login?: string
  total: number
  shown: number
  now: number
}>()
const emit = defineEmits<{ select: [item: PullRequestListItem]; retry: [] }>()

const filter = defineModel<PullRequestListFilter>('filter', { required: true })
const search = defineModel<string>('search', { required: true })
const clientFilters = defineModel<PullClientFilter[]>('clientFilters', {
  required: true,
})
const grouping = defineModel<PullGrouping>('grouping', { required: true })

const tabs = PULL_TABS.map((tab) => ({ id: tab.id, label: tab.label }))
function onTab(id: string): void {
  if (isPullFilter(id)) filter.value = id
}

// ── Filter menu ─────────────────────────────────────────────────────────
const filterButton = ref<InstanceType<typeof IconButton> | null>(null)
const filterAnchor = computed(
  () => (filterButton.value?.$el as HTMLElement | undefined) ?? null,
)
const menuOpen = ref(false)
const filtered = computed(() => clientFilters.value.length > 0)
const filterLabel = computed(() =>
  filtered.value ? `筛选（已启用 ${clientFilters.value.length} 项）` : '筛选',
)

function toggleClientFilter(id: PullClientFilter): void {
  clientFilters.value = clientFilters.value.includes(id)
    ? clientFilters.value.filter((value) => value !== id)
    : [...clientFilters.value, id]
}

// ── Groups & keyboard ───────────────────────────────────────────────────
const collapsed = shallowRef<ReadonlySet<string>>(new Set())
function toggleGroup(key: string): void {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

const visible = computed(() => visiblePulls(props.groups, collapsed.value))
const focusKey = computed(() => {
  const keys = visible.value.map(pullKey)
  if (props.selectedKey && keys.includes(props.selectedKey))
    return props.selectedKey
  return keys[0] ?? null
})

const rowsEl = ref<HTMLElement | null>(null)
function focusRow(key: string | null): void {
  if (!key) return
  const row = [
    ...(rowsEl.value?.querySelectorAll<HTMLElement>('[data-pull-row]') ?? []),
  ].find((el) => el.dataset.pullRow === key)
  row?.focus()
  row?.scrollIntoView({ block: 'nearest' })
}

function onRowsKeydown(event: KeyboardEvent): void {
  const keys = visible.value.map(pullKey)
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    '[data-pull-row]',
  )
  const current = target ? keys.indexOf(target.dataset.pullRow ?? '') : -1
  let next = -1
  if (event.key === 'ArrowDown') next = stepIndex(current, 1, keys.length)
  else if (event.key === 'ArrowUp') next = stepIndex(current, -1, keys.length)
  else if (event.key === 'Home') next = keys.length ? 0 : -1
  else if (event.key === 'End') next = keys.length - 1
  else return
  event.preventDefault()
  focusRow(keys[next] ?? null)
}

function enterList(): void {
  focusRow(focusKey.value)
}

// Keep the selected row in view when it changes from outside (deep link).
watch(
  () => props.selectedKey,
  (key) => {
    if (!key) return
    void nextTick(() => {
      const row = rowsEl.value?.querySelector<HTMLElement>(
        `[data-pull-row="${CSS.escape(key)}"]`,
      )
      row?.scrollIntoView({ block: 'nearest' })
    })
  },
)

const showFooter = computed(
  () => !props.loading && props.total > props.shown && props.shown > 0,
)
</script>

<template>
  <div class="pr-list">
    <div class="list-head">
      <Tabs
        class="list-tabs"
        :tabs="tabs"
        :model-value="filter"
        @update:model-value="onTab"
      />
      <span v-if="login" class="login" :title="`GitHub 账户：${login}`">
        @{{ login }}
      </span>
    </div>

    <div class="list-tools" @keydown.down.prevent="enterList">
      <SearchField
        v-model="search"
        class="list-search"
        size="sm"
        placeholder="搜索 Pull Request"
      />
      <IconButton
        ref="filterButton"
        :label="filterLabel"
        :active="filtered || menuOpen"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <component :is="pullIcons.filter" :size="16" />
        <span v-if="filtered" class="filter-badge" aria-hidden="true" />
      </IconButton>
      <Menu
        v-model:open="menuOpen"
        :anchor="filterAnchor"
        placement="bottom"
        :width="200"
        dense
        label="筛选 Pull Request"
      >
        <MenuItem variant="label">筛选</MenuItem>
        <MenuItem
          v-for="option in PULL_CLIENT_FILTERS"
          :key="option.id"
          keep-open
          :selected="clientFilters.includes(option.id)"
          :data-filter-option="option.id"
          @select="toggleClientFilter(option.id)"
        >
          {{ option.label }}
        </MenuItem>
        <MenuItem variant="separator" />
        <MenuItem variant="label">分组</MenuItem>
        <MenuItem
          keep-open
          :selected="grouping === 'none'"
          @select="grouping = 'none'"
        >
          不分组
        </MenuItem>
        <MenuItem
          keep-open
          :selected="grouping === 'repo'"
          @select="grouping = 'repo'"
        >
          按仓库
        </MenuItem>
        <template v-if="filtered">
          <MenuItem variant="separator" />
          <MenuItem @select="clientFilters = []">清除筛选</MenuItem>
        </template>
      </Menu>
    </div>

    <div
      ref="rowsEl"
      class="list-body"
      aria-label="Pull Request 列表"
      role="region"
      @keydown="onRowsKeydown"
    >
      <div v-if="loading" class="skeleton" aria-busy="true" aria-label="加载中">
        <div v-for="index in 6" :key="index" class="skeleton-row">
          <span class="bar bar--glyph" />
          <span class="bars">
            <span class="bar bar--title" />
            <span class="bar bar--meta" />
          </span>
        </div>
      </div>

      <EmptyState
        v-else-if="error && !groups.length"
        variant="plain"
        title="无法读取 Pull Request"
        :description="error.message"
      >
        <Button size="sm" variant="outline" @click="emit('retry')">
          重试
        </Button>
      </EmptyState>

      <EmptyState
        v-else-if="!groups.length"
        class="list-empty"
        variant="plain"
        :title="emptyMessage"
      />

      <template v-else>
        <p v-if="error" class="inline-error" role="alert">
          {{ error.message }}
          <button type="button" class="inline-retry" @click="emit('retry')">
            重试
          </button>
        </p>
        <section
          v-for="group in groups"
          :key="group.key"
          class="group"
          :data-group="group.key"
        >
          <button
            type="button"
            class="group-head"
            :aria-expanded="!collapsed.has(group.key)"
            tabindex="-1"
            @click="toggleGroup(group.key)"
          >
            <span class="group-label">{{ group.label }}</span>
            <component
              :is="
                collapsed.has(group.key) ? pullIcons.expand : pullIcons.collapse
              "
              :size="14"
              class="group-chevron"
              aria-hidden="true"
            />
            <span class="group-count">{{ group.items.length }}</span>
          </button>
          <div v-if="!collapsed.has(group.key)" class="group-rows" role="list">
            <div
              v-for="item in group.items"
              :key="pullKey(item)"
              role="listitem"
            >
              <PullRequestRow
                :item="item"
                :age="relativeAgeZh(item.updatedAt, now)"
                :selected="pullKey(item) === selectedKey"
                :focusable="pullKey(item) === focusKey"
                @select="emit('select', item)"
              />
            </div>
          </div>
        </section>
        <p v-if="showFooter" class="list-foot">
          显示前 {{ shown }} 个，共 {{ total }} 个
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pr-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.list-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border-l1);
}

.list-tabs {
  flex: 1;
  min-width: 0;
}

.login {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-caption));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-3) var(--space-3) var(--space-2) var(--space-4);
}

.list-search {
  flex: 1;
  min-width: 0;
}

.list-tools :deep(.ds-icon-button) {
  position: relative;
}

.filter-badge {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  width: var(--space-1-5);
  height: var(--space-1-5);
  border-radius: var(--radius-pill);
  background: rgb(var(--accent-fill));
}

.list-body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--space-2) var(--space-4);
  overflow-x: hidden;
  overflow-y: auto;
  outline: none;
}

.group + .group {
  margin-top: var(--space-2);
}

.group-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  height: var(--space-7);
  padding: 0 var(--space-2-5);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.group-head:hover {
  color: rgb(var(--label-secondary));
}

.group-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-chevron {
  flex: none;
}

.group-count {
  margin-left: auto;
  color: rgb(var(--label-caption));
  font-variant-numeric: tabular-nums;
}

.group-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

.list-foot {
  margin: var(--space-3) 0 0;
  padding: 0 var(--space-2-5);
  color: rgb(var(--label-caption));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.inline-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  padding: var(--space-2) var(--space-2-5);
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

.list-empty {
  padding-top: var(--space-8);
}

.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2-5);
}

.skeleton-row {
  display: flex;
  gap: var(--space-2-5);
  padding: var(--space-1) 0;
}

.bars {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1-5);
}

.bar {
  display: block;
  height: var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--skeleton-bg);
}

.bar--glyph {
  flex: none;
  width: var(--space-4);
  height: var(--space-4);
}

.bar--title {
  width: 80%;
}

.bar--meta {
  width: 55%;
  height: var(--space-2-5);
}
</style>
