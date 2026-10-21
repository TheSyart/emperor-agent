<script setup lang="ts">
/**
 * SubagentGroup — the subagents one step sent out, as one virtual row of
 * the flow (UI-S14). One subagent is its row alone; two or more are a
 * group: up to three stacked faces, 「派出 N 个子智能体」 while any is at
 * work (「N 个子智能体」 after) and the count of each status
 * (「8 运行中 · 2 失败 · 1 结果待确认」, done: 「9 完成 · 2 失败 · 用时
 * 6 分 12 秒」). The group is open while any runs and folds by itself once
 * all have ended; after the reader opens or folds it, it stays as they
 * left it (the timeline's expansion store). The head is a button for the
 * keyboard too (Enter / Space).
 *
 * It tells the timeline when it is on screen (the status bar above the
 * composer shows only while no group at work is) and lights up briefly
 * after 「回到列表 ↑」.
 *
 * Props: handle (ConversationHandle), row (AgentsRow).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ConversationHandle } from '../../../conversation/store'
import type { ToolChatNode } from '../../../conversation/types'
import { DsChevronDown } from '../../icons/ds'
import CollapseTransition from '../../motion/CollapseTransition.vue'
import Avatar from '../../ui/Avatar.vue'
import { useAgentTree } from '../../sidebar/agentTree'
import { useChatContext } from '../chatContext'
import type { AgentsRow } from '../processModel'
import {
  subagentAgentId,
  subagentFaces,
  subagentGroupHead,
  subagentRowOf,
} from '../subagentRows'
import ToolCallTree from './ToolCallTree.vue'

const props = defineProps<{ handle: ConversationHandle; row: AgentsRow }>()
const chat = useChatContext()
const agentTree = useAgentTree()
const owner = computed(() => chat.rootSessionId?.() ?? chat.sessionId())

/** The starting calls, read through their per-key refs. */
const nodes = computed<ToolChatNode[]>(() =>
  props.row.members.flatMap((key) => {
    const node = props.handle.node(key).value
    return node?.kind === 'tool' ? [node] : []
  }),
)
const rows = computed(() =>
  nodes.value.map((node) => {
    const id = subagentAgentId(node.data)
    const agent = id ? agentTree.trees[owner.value]?.byId[id] : undefined
    return subagentRowOf(
      node.data,
      agent?.rootSessionId === owner.value ? agent : undefined,
    )
  }),
)
const active = computed(() => rows.value.some((row) => row.active))
const head = computed(() => subagentGroupHead(rows.value))
const faces = computed(() => subagentFaces(rows.value))
const open = computed(() => chat.expansion.get(props.row.id, active.value))

function toggle(): void {
  // A finished group keeps its line in place; a running one follows.
  if (!active.value) chat.actions.holdRow?.(props.row.id)
  chat.expansion.set(props.row.id, !open.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  toggle()
}

const seat = ref<HTMLElement | null>(null)
let release: (() => void) | undefined
watch(
  [seat, () => props.row.id],
  ([element, id]) => {
    release?.()
    release =
      element === null ? undefined : chat.agentRows?.observe(element, id)
  },
  { immediate: true, flush: 'post' },
)
onBeforeUnmount(() => release?.())
const highlighted = computed(
  () => chat.agentRows?.highlighted() === props.row.id,
)
</script>

<template>
  <div
    ref="seat"
    class="agents-seat"
    data-agents-row
    :data-chat-anchor-key="row.id"
    data-chat-flow-kind="agents"
    :data-chat-turn="row.turn"
    :data-highlight="highlighted || undefined"
  >
    <div class="agents-box">
      <ToolCallTree
        v-if="nodes.length === 1"
        :node="nodes[0]!"
        agent-variant="single"
        :step="false"
      />
      <div
        v-else-if="nodes.length > 1"
        class="group"
        data-subagent-group
        :data-open="open || undefined"
      >
        <div
          class="head"
          role="button"
          tabindex="0"
          data-subagent-group-head
          :aria-expanded="open"
          @click="toggle"
          @keydown="onKeydown"
        >
          <span class="faces">
            <template v-for="face in faces" :key="face.key">
              <Avatar
                v-if="face.face.kind === 'sprite'"
                kind="sprite"
                :id="face.face.id || face.key"
                :size="20"
              />
              <span v-else class="logo">
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
          <span class="counts">{{ head.counts }}</span>
          <DsChevronDown :size="12" class="chevron" />
        </div>
        <CollapseTransition>
          <div v-if="open" class="list" data-subagent-group-list>
            <ToolCallTree
              v-for="node in nodes"
              :key="node.key"
              :node="node"
              agent-variant="grouped"
              :step="false"
            />
          </div>
        </CollapseTransition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agents-seat {
  min-width: 0;
  padding-bottom: var(--space-4);
}

/* 「回到列表 ↑」 lights the row up for a moment, then it fades. */
.agents-box {
  min-width: 0;
  margin-inline: calc(-1 * var(--space-2));
  padding-inline: var(--space-2);
  border-radius: var(--radius-row);
  transition: background-color var(--motion-slow) var(--ease-standard);
}

[data-highlight] > .agents-box {
  background-color: rgb(var(--surface-selected));
}

.group {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-inline: calc(-1 * var(--space-2));
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-row);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.head:hover {
  background: var(--surface-hover);
}

.head:focus-visible {
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
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Open, the chevron points up; folded, down. */
.chevron {
  flex: none;
  margin-left: auto;
  color: rgb(var(--text-3));
  transition: transform var(--motion-fast) var(--ease-standard);
}

[data-open] .chevron {
  transform: rotate(180deg);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  margin-left: calc(var(--space-4) + var(--space-0-5));
  padding: var(--space-0-5) 0 var(--space-0-5) var(--space-2);
  border-inline-start: 0.5px solid var(--hairline);
}
</style>
