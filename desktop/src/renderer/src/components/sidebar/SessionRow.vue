<script setup lang="ts">
/**
 * One sidebar session row (dsh Rows: 32px, radius 8, 16px status slot, 14/20
 * title, 12/20 tertiary time). Running rows show the gold pixel chase and an
 * "N 个子代理运行中" subline; hover swaps the time for a more-actions button
 * (rename / archive / delete, plus move up/down under manual sort).
 */
import { computed, nextTick, ref } from 'vue'
import { DsMore } from '../icons/ds'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import StateDot from '../ui/StateDot.vue'
import type { SessionRuntimeIndicator } from '../../runtime/sidebarModel'
import { sidebarRelativeTime } from '../../runtime/sidebarModel'
import type { SessionInfo } from '../../types'

const props = withDefaults(
  defineProps<{
    session: SessionInfo
    active?: boolean
    indicator?: SessionRuntimeIndicator
    pendingLabel?: string
    subagents?: number
    nested?: boolean
    canDelete?: boolean
    manual?: boolean
  }>(),
  {
    active: false,
    indicator: null,
    pendingLabel: '',
    subagents: 0,
    nested: false,
    canDelete: true,
    manual: false,
  },
)

const emit = defineEmits<{
  open: []
  rename: [title: string]
  archive: []
  delete: []
  move: [delta: -1 | 1]
}>()

const editing = ref(false)
const draftTitle = ref('')
const input = ref<HTMLInputElement | null>(null)
const menuOpen = ref(false)
const moreButton = ref<HTMLElement | null>(null)

const title = computed(() => props.session.title || '新会话')
const time = computed(() => sidebarRelativeTime(props.session.updated_at))
const stateLabel = computed(() => {
  if (props.indicator === 'running') return '运行中'
  if (props.indicator === 'pending') return props.pendingLabel || '等待操作'
  if (props.indicator === 'attention') return '有新进展'
  return ''
})

function beginRename(): void {
  draftTitle.value = title.value
  editing.value = true
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}

function commitRename(): void {
  if (!editing.value) return
  editing.value = false
  const next = draftTitle.value.trim()
  if (next && next !== title.value) emit('rename', next)
}

function cancelRename(): void {
  editing.value = false
}

defineExpose({ beginRename })
</script>

<template>
  <div
    class="session-row"
    role="button"
    tabindex="0"
    :data-active="active || undefined"
    :data-nested="nested || undefined"
    :data-menu-open="menuOpen || undefined"
    :aria-current="active ? 'page' : undefined"
    :title="title"
    @click="editing ? undefined : emit('open')"
    @keydown.enter.self="emit('open')"
    @dblclick.stop="beginRename"
  >
    <div class="line">
      <span class="slot" aria-hidden="true">
        <StateDot
          v-if="indicator === 'running'"
          state="ongoing"
          :size="10"
          :label="stateLabel"
        />
        <StateDot
          v-else-if="indicator === 'pending'"
          state="warn"
          :size="8"
          :label="stateLabel"
        />
        <StateDot
          v-else-if="indicator === 'attention'"
          state="ok"
          :size="8"
          :label="stateLabel"
        />
      </span>
      <input
        v-if="editing"
        ref="input"
        v-model="draftTitle"
        class="rename"
        aria-label="会话标题"
        @click.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="title">{{ title }}</span>
      <span v-if="!editing" class="time">{{ time }}</span>
      <button
        v-if="!editing"
        ref="moreButton"
        type="button"
        class="more"
        aria-label="会话操作"
        :aria-expanded="menuOpen"
        @click.stop="menuOpen = !menuOpen"
      >
        <DsMore :size="16" />
      </button>
    </div>
    <div v-if="subagents > 0" class="subline">
      {{ subagents }} 个子代理运行中
    </div>
    <div v-else-if="indicator === 'pending' && pendingLabel" class="subline">
      {{ pendingLabel }}
    </div>
  </div>
  <Menu
    v-model:open="menuOpen"
    :anchor="moreButton"
    :width="180"
    label="会话操作"
  >
    <MenuItem @select="beginRename">重命名</MenuItem>
    <template v-if="manual">
      <MenuItem @select="emit('move', -1)">上移</MenuItem>
      <MenuItem @select="emit('move', 1)">下移</MenuItem>
    </template>
    <MenuItem @select="emit('archive')">归档</MenuItem>
    <MenuItem variant="separator" />
    <MenuItem
      danger
      :disabled="!canDelete"
      :description="canDelete ? undefined : '至少保留一个持久化会话'"
      @select="emit('delete')"
    >
      删除
    </MenuItem>
  </Menu>
</template>

<style scoped>
.session-row {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: var(--space-8);
  padding: 0 var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  cursor: pointer;
  user-select: none;
  outline: none;
  animation: ds-fade-in var(--duration-ds) var(--ease-in-out);
}

.session-row[data-nested] {
  padding-left: calc(var(--space-2) + var(--space-5) + 2px);
}

.session-row:hover,
.session-row[data-menu-open],
.session-row[data-active] {
  background: var(--interactive-bg-hover);
}

.session-row[data-active] {
  background: var(--interactive-bg-active);
}

.session-row:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.line {
  display: flex;
  align-items: center;
  height: var(--space-8);
  min-width: 0;
}

.slot {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-5);
}

.title {
  flex: 1;
  min-width: 0;
  margin: 0 var(--space-1-5) 0 var(--space-1);
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--space-5);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row[data-active] .title {
  font-weight: 500;
}

.rename {
  flex: 1;
  min-width: 0;
  margin: 0 var(--space-1-5) 0 var(--space-1);
  padding: 0 var(--space-0-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-xs);
  outline: none;
  background: rgb(var(--bg-layer-2));
  color: inherit;
  font-size: var(--fs-s);
  line-height: var(--space-5);
}

.rename:focus {
  border-color: var(--border-l3);
  box-shadow: none;
}

.time {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--space-5);
  color: rgb(var(--label-tertiary));
}

.more {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.more:hover {
  color: rgb(var(--label-primary));
}

.session-row:hover .more,
.session-row[data-menu-open] .more,
.session-row:focus-within .more {
  display: inline-flex;
}

.session-row:hover .time,
.session-row[data-menu-open] .time,
.session-row:focus-within .time {
  display: none;
}

.subline {
  margin: calc(0px - var(--space-1-5)) 0 var(--space-1-5)
    calc(var(--space-4) + var(--space-1));
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
