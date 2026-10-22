<script setup lang="ts">
/**
 * SubagentDock — the subagent status bar above the composer (UI-S14), next
 * to the todo dock. ConversationView shows it while subagents of the viewed
 * conversation are at work and none of their groups is on screen, and
 * drops it once nothing runs. One line: up to three stacked faces,
 * 「N 个子智能体运行中」 with the other counts, 「回到列表 ↑」 (scrolls the
 * conversation back to the group and lights it up) and a chevron. The line
 * opens the list upward — the same subagent rows as in the conversation,
 * scrolling past about seven — and a row opens its subagent. Esc folds it.
 *
 * Props: rows (the dock's rows, those at work first), target (the group
 * 「回到列表 ↑」 goes to; null: none loaded), rootSessionId (run pages).
 * Emits: open(row), reveal(groupId).
 */
import { computed, ref } from 'vue'
import { DsChevronDown } from '../icons/ds'
import CollapseTransition from '../motion/CollapseTransition.vue'
import Avatar from '../ui/Avatar.vue'
import SubagentRow from '../conversation/nodes/SubagentRow.vue'
import {
  subagentDockHead,
  subagentFaces,
  subagentHref,
  type SubagentRowView,
} from '../conversation/subagentRows'

const props = defineProps<{
  rows: readonly SubagentRowView[]
  target: string | null
  rootSessionId: string
}>()
const emit = defineEmits<{
  open: [row: SubagentRowView]
  reveal: [groupId: string]
}>()

const expanded = ref(false)
const head = computed(() => subagentDockHead(props.rows))
const faces = computed(() => subagentFaces(props.rows))

function toggle(): void {
  expanded.value = !expanded.value
}

function pressed(event: KeyboardEvent, action: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  action()
}

function reveal(): void {
  if (props.target !== null) emit('reveal', props.target)
}

function open(row: SubagentRowView, event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  emit('open', row)
}
</script>

<template>
  <section
    class="subagent-dock"
    aria-label="子智能体"
    data-subagent-dock
    :data-open="expanded || undefined"
    @keydown.esc="expanded = false"
  >
    <CollapseTransition>
      <div
        v-if="expanded"
        id="subagent-dock-list"
        class="list"
        data-subagent-dock-list
      >
        <SubagentRow
          v-for="row in rows"
          :key="row.key"
          :row="row"
          :href="subagentHref(row, rootSessionId)"
          @open="open(row, $event)"
        />
      </div>
    </CollapseTransition>
    <div class="head">
      <div
        class="toggle"
        role="button"
        tabindex="0"
        data-subagent-dock-toggle
        aria-controls="subagent-dock-list"
        :aria-expanded="expanded"
        @click="toggle"
        @keydown="pressed($event, toggle)"
      >
        <span class="faces">
          <template v-for="face in faces" :key="face.key">
            <Avatar
              v-if="face.face.kind === 'sprite'"
              kind="sprite"
              :id="face.face.id || face.key"
              :size="20"
              data-subagent-dock-face
            />
            <span v-else class="logo" data-subagent-dock-face>
              <Avatar
                kind="logo"
                :icon-id="face.face.backend"
                :label="face.source"
                :size="16"
                :data-agent-logo="face.face.backend"
              />
            </span>
          </template>
        </span>
        <span class="title">{{ head.title }}</span>
        <span v-if="head.counts" class="counts">{{ head.counts }}</span>
      </div>
      <span
        v-if="target"
        class="jump"
        role="button"
        tabindex="0"
        data-subagent-dock-jump
        @click="reveal"
        @keydown="pressed($event, reveal)"
        >回到列表 ↑</span
      >
      <DsChevronDown
        :size="12"
        class="chevron"
        aria-hidden="true"
        @click="toggle"
      />
    </div>
  </section>
</template>

<style scoped>
.subagent-dock {
  box-sizing: border-box;
  display: flex;
  flex: none;
  flex-direction: column;
  width: calc(100% - 2 * var(--composer-clearance) - 4 * var(--dock-inset));
  max-width: calc(var(--composer-card-max) - 4 * var(--dock-inset));
  margin: 0 auto;
  overflow: hidden;
  border-radius: var(--radius-card);
  background: rgb(var(--tip-fill));
  box-shadow: 0 0 0 0.5px var(--hairline);
}

/* About seven rows, then the list scrolls. */
.list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 196px;
  padding: var(--space-1-5) var(--space-1-5) var(--space-0-5);
  overflow-y: auto;
  border-bottom: 0.5px solid var(--hairline);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-1-5) var(--space-3);
}

.toggle {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  line-height: var(--space-6);
  cursor: pointer;
}

.toggle:focus-visible,
.jump:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.faces {
  display: inline-flex;
  flex: none;
  align-items: center;
}

.faces > * + * {
  margin-left: calc(-1 * var(--space-1-5));
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.title {
  flex: none;
  color: rgb(var(--text-1));
  font-weight: var(--weight-medium);
}

.counts {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jump {
  flex: none;
  border-radius: var(--r-xs);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.jump:hover {
  color: rgb(var(--text-1));
}

/* Folded the chevron points up (the list opens upward); open, down. */
.chevron {
  flex: none;
  color: rgb(var(--text-3));
  cursor: pointer;
  transform: rotate(180deg);
  transition: transform var(--motion-fast) var(--ease-standard);
}

[data-open] .chevron {
  transform: none;
}
</style>
