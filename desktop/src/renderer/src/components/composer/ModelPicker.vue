<script setup lang="ts">
/**
 * ModelPicker — dsh ModelSelect: a 28px trigger (provider logo + model name
 * + caption effort + chevron) opening an upward two-level menu. The root
 * pane has two rows, 「模型 › name」 and 「思考强度 › level」; each drills into
 * its list. The model list is grouped by provider (sticky logo + name
 * headers) with a search box once there are many entries; a model without
 * reasoning choices opens straight on the model list. Escape backs out of a
 * list to the root before closing; ↑ / ↓ move between rows. Selection flows
 * back through the composer controller (switch-model /
 * set-reasoning-effort).
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { ModelEntry, ProviderOption } from '../../types'
import { DsChevronLeft, DsChevronRight, DsThink } from '../icons/ds'
import { groupEntriesByProvider } from '../../model/providerGroups'
import Chip from '../ui/Chip.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import ProviderLogo from '../ui/ProviderLogo.vue'

/** Entries above this count get a search box in the model list. */
const SEARCH_THRESHOLD = 6

const props = defineProps<{
  entries: ModelEntry[]
  activeId: string
  label: string
  reasoningLabel: string
  reasoningValue: string
  reasoningOptions: Array<{ value: string | null; label: string }>
  providerOptions: readonly ProviderOption[]
  disabled?: boolean
  title?: string
}>()

const emit = defineEmits<{
  'select-model': [entryId: string]
  'select-reasoning': [value: string | null]
}>()

type Pane = 'root' | 'model' | 'effort'

const open = ref(false)
const pane = ref<Pane>('root')
const query = ref('')
const anchor = ref<HTMLElement | null>(null)
const panes = ref<HTMLElement | null>(null)

const entries = computed(() => props.entries.filter((entry) => entry.entryId))
const hasEffort = computed(() => props.reasoningOptions.length > 1)
const showEffort = computed(
  () => hasEffort.value && props.reasoningValue !== '',
)
const activeEntry = computed(() =>
  entries.value.find((entry) => entry.entryId === props.activeId),
)
const activeGroup = computed(() =>
  activeEntry.value
    ? groupEntriesByProvider([activeEntry.value], props.providerOptions)[0]
    : undefined,
)
const searchable = computed(() => entries.value.length > SEARCH_THRESHOLD)
const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const visible = needle
    ? entries.value.filter((entry) =>
        `${entryLabel(entry)} ${entry.modelId}`.toLowerCase().includes(needle),
      )
    : entries.value
  return groupEntriesByProvider(visible, props.providerOptions)
})

function entryLabel(entry: ModelEntry): string {
  return entry.effectiveDisplayName || entry.modelId || '模型'
}

function effortSelected(value: string | null): boolean {
  return (value || '') === props.reasoningValue
}

watch(open, (value) => {
  if (!value) return
  query.value = ''
  pane.value = hasEffort.value ? 'root' : 'model'
})

async function show(next: Pane): Promise<void> {
  pane.value = next
  await nextTick()
  focusRow(0)
}

function rows(): HTMLElement[] {
  return [
    ...(panes.value?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled), [data-pane-back], input',
    ) ?? []),
  ]
}

function focusRow(index: number): void {
  const list = rows()
  if (!list.length) return
  list[(index + list.length) % list.length]?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && pane.value !== 'root' && hasEffort.value) {
    // Escape backs out of a drilled list first; the Menu closes on the next.
    event.stopPropagation()
    void show('root')
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const list = rows()
  const current = list.indexOf(document.activeElement as HTMLElement)
  focusRow(event.key === 'ArrowDown' ? current + 1 : Math.max(current, 0) - 1)
}
</script>

<template>
  <span ref="anchor" class="model-picker">
    <Chip
      chevron
      :active="open"
      :disabled="disabled"
      :title="title"
      aria-haspopup="menu"
      aria-label="模型与思考"
      :aria-expanded="open"
      @click="open = !open"
    >
      <template v-if="activeGroup" #icon>
        <ProviderLogo
          :icon-id="activeGroup.iconId"
          :label="activeGroup.label"
          size="xs"
        />
      </template>
      <span class="name">{{ label }}</span>
      <span v-if="showEffort" class="effort">{{ reasoningLabel }}</span>
    </Chip>
  </span>
  <Menu v-model:open="open" :anchor="anchor" :width="300" label="模型与思考">
    <div ref="panes" class="panes" :data-pane="pane" @keydown="onKeydown">
      <template v-if="pane === 'root'">
        <MenuItem keep-open @select="show('model')">
          <template #icon>
            <ProviderLogo
              v-if="activeGroup"
              :icon-id="activeGroup.iconId"
              :label="activeGroup.label"
              size="xs"
            />
          </template>
          模型
          <template #trailing>
            <span class="cell-value">{{ label }}</span>
            <DsChevronRight :size="14" class="cell-chevron" />
          </template>
        </MenuItem>
        <MenuItem keep-open @select="show('effort')">
          <template #icon><DsThink :size="16" /></template>
          思考强度
          <template #trailing>
            <span class="cell-value">{{ reasoningLabel }}</span>
            <DsChevronRight :size="14" class="cell-chevron" />
          </template>
        </MenuItem>
      </template>

      <template v-else-if="pane === 'model'">
        <div class="pane-head">
          <button
            v-if="hasEffort"
            type="button"
            class="back"
            data-pane-back
            aria-label="返回"
            @click="show('root')"
          >
            <DsChevronLeft :size="14" />
          </button>
          <span class="pane-title">模型 · 下一轮生效</span>
        </div>
        <input
          v-if="searchable"
          v-model="query"
          class="search"
          type="search"
          placeholder="搜索模型"
          aria-label="搜索模型"
          spellcheck="false"
        />
        <section
          v-for="group in groups"
          :key="group.provider"
          class="group"
          role="group"
          :aria-label="group.label"
        >
          <div class="group-title">
            <ProviderLogo
              :icon-id="group.iconId"
              :label="group.label"
              size="xs"
            />
            <span>{{ group.label }}</span>
          </div>
          <MenuItem
            v-for="entry in group.entries"
            :key="entry.entryId"
            :selected="entry.entryId === activeId"
            :description="entry.modelId || '未配置'"
            :disabled="disabled"
            @select="emit('select-model', entry.entryId)"
          >
            {{ entryLabel(entry) }}
          </MenuItem>
        </section>
        <p v-if="!groups.length" class="empty">没有匹配的模型</p>
      </template>

      <template v-else>
        <div class="pane-head">
          <button
            type="button"
            class="back"
            data-pane-back
            aria-label="返回"
            @click="show('root')"
          >
            <DsChevronLeft :size="14" />
          </button>
          <span class="pane-title">思考强度</span>
        </div>
        <div role="group" aria-label="思考强度">
          <MenuItem
            v-for="option in reasoningOptions"
            :key="option.label"
            :selected="effortSelected(option.value)"
            :disabled="disabled"
            @select="emit('select-reasoning', option.value)"
          >
            {{ option.label }}
          </MenuItem>
        </div>
      </template>
    </div>
  </Menu>
</template>

<style scoped>
.model-picker {
  display: inline-flex;
  min-width: 0;
  max-width: min(360px, 45cqw);
}

.model-picker :deep(.ds-chip) {
  max-width: 100%;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.effort {
  margin-left: var(--space-1);
  color: rgb(var(--label-caption));
}

.panes {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.cell-value {
  max-width: calc(var(--space-8) * 4);
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-chevron {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.pane-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--space-7);
  padding: 0 var(--space-2) 0 var(--space-1);
}

.pane-title {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-tertiary));
}

.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-6);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.back:hover {
  background: var(--interactive-bg-hover);
}

.back:focus-visible,
.search:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.search {
  height: var(--space-8);
  margin: 0 var(--space-1) var(--space-1);
  padding: 0 var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.group + .group {
  margin-top: var(--space-1);
}

.group-title {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1-5) var(--space-2-5) var(--space-1);
  background: rgb(var(--menu-fill));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-tertiary));
}

.empty {
  margin: 0;
  padding: var(--space-3) var(--space-2-5);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}
</style>
