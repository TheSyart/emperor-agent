<script setup lang="ts">
/**
 * ProcessGroup — one turn's process as one virtual row (UI-S03, DSH-22).
 * Running, it is a single line: spinner, the current step's verb and object
 * in a neutral shimmer and its number (「正在读取 SettingsView.vue · 第 4
 * 步」), plus the elapsed clock after 15s. Done, it folds to 「已处理 9 步 ·
 * 用时 1 分 12 秒 ›」 (13/20 text-3, text-2 on hover). Either line toggles the
 * step list (CollapseTransition); the open state lives in the timeline's
 * expansion store under the 处理过程 preference's key, so it survives the
 * virtual list and 完成后收起 folds a list opened while the turn ran.
 *
 * The steps are the member rows themselves (ChatNodeSeat, dense), plus the
 * preparing calls (DSH-23).
 *
 * Props: handle (ConversationHandle), row (ProcessRow).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ConversationHandle } from '../../../conversation/store'
import type { ChatNode } from '../../../conversation/types'
import { useUiPreferences } from '../../../composables/useUiPreferences'
import { DsChevronDown } from '../../icons/ds'
import CollapseTransition from '../../motion/CollapseTransition.vue'
import ElapsedClock from '../../ui/ElapsedClock.vue'
import Spinner from '../../ui/Spinner.vue'
import ChatNodeSeat from '../ChatNodeSeat.vue'
import { useChatContext } from '../chatContext'
import {
  processExpansionKey,
  processLiveStep,
  processSummary,
  type ProcessMember,
  type ProcessRow,
} from '../processModel'
import PreparingToolRow from './PreparingToolRow.vue'

const props = defineProps<{ handle: ConversationHandle; row: ProcessRow }>()
const { expansion, actions } = useChatContext()
const { preferences } = useUiPreferences()

const disclosure = computed(() =>
  processExpansionKey(props.row, preferences.value.processDisplay),
)
const open = computed({
  get: () => expansion.get(disclosure.value.key, disclosure.value.fallback),
  set: (value: boolean) => expansion.set(disclosure.value.key, value),
})

/** Members' nodes, read through their per-key refs (live label only). */
const live = computed(() => {
  if (!props.row.live) return null
  const nodes = new Map<string, ChatNode>()
  for (const member of props.row.members) {
    const node = props.handle.node(member.key).value
    if (node !== undefined) nodes.set(member.key, node)
  }
  return processLiveStep(props.row, nodes)
})
const summary = computed(() => processSummary(props.row))

// The clock joins the live line once the process has run for a while.
const CLOCK_AFTER_MS = 15_000
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
watch(
  () => props.row.live,
  (running) => {
    clearInterval(timer)
    timer = running
      ? setInterval(() => {
          now.value = Date.now()
        }, 1000)
      : undefined
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(timer))
const showClock = computed(
  () =>
    props.row.live &&
    props.row.startedAt !== null &&
    now.value - props.row.startedAt >= CLOCK_AFTER_MS,
)

function toggle(): void {
  // A finished group keeps its line in place; a live one keeps following.
  if (!props.row.live) actions.holdRow?.(props.row.id)
  open.value = !open.value
}

function memberKey(member: ProcessMember): string {
  return member.kind === 'preparing'
    ? `${member.key}#${member.index}`
    : `${member.key}${member.reasoningOnly ? ':reasoning' : ''}`
}
</script>

<template>
  <div
    class="chat-seat process-seat"
    :data-chat-anchor-key="row.id"
    data-chat-flow-kind="process"
    :data-chat-turn="row.turn"
  >
    <div
      class="process"
      data-process-group
      :data-live="row.live || undefined"
      :data-open="open || undefined"
    >
      <button
        type="button"
        class="header"
        data-process-header
        :aria-expanded="open"
        @click="toggle"
      >
        <template v-if="live">
          <Spinner size="sm" tone="accent" label="处理中" />
          <span class="live-text">
            <span class="live-label ds-shimmer" data-tone="neutral">{{
              live.label
            }}</span>
            <span class="ordinal">&nbsp;· 第 {{ live.ordinal }} 步</span>
          </span>
          <span v-if="showClock && row.startedAt !== null" class="clock">
            <ElapsedClock :started-at="row.startedAt" />
          </span>
        </template>
        <template v-else>
          <span class="summary">{{ summary }}</span>
          <DsChevronDown :size="12" class="chevron" />
        </template>
      </button>
      <CollapseTransition>
        <div v-if="open" class="body" data-process-body>
          <template v-for="member in row.members" :key="memberKey(member)">
            <PreparingToolRow
              v-if="member.kind === 'preparing'"
              :handle="handle"
              :node-key="member.key"
              :index="member.index"
            />
            <ChatNodeSeat
              v-else
              :handle="handle"
              :node-key="member.key"
              :part="member.reasoningOnly ? 'reasoning' : undefined"
              dense
            />
          </template>
        </div>
      </CollapseTransition>
    </div>
  </div>
</template>

<style scoped>
.chat-seat {
  min-width: 0;
  padding-bottom: var(--space-4);
}

.process {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.header {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--space-1-5);
  max-width: 100%;
  min-height: var(--control-sm);
  padding: 0;
  border: none;
  border-radius: var(--r-xs);
  background: none;
  color: rgb(var(--text-3));
  font: var(--type-footnote) var(--font-sans);
  text-align: start;
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-standard);
}

.header:hover,
.header:focus-visible {
  color: rgb(var(--text-2));
}

.header:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

[data-live] .header {
  gap: var(--space-2);
  color: rgb(var(--text-2));
}

.live-text {
  display: inline-flex;
  min-width: 0;
}

.summary,
.live-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ordinal,
.clock {
  flex: none;
  color: rgb(var(--text-3));
  font-variant-numeric: tabular-nums;
}

.clock {
  color: rgb(var(--text-4));
}

/* Collapsed the chevron points right; open, down. */
.chevron {
  flex: none;
  transform: rotate(-90deg);
  transition: transform var(--motion-fast) var(--ease-standard);
}

[data-open] .chevron {
  transform: none;
}

.body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-top: var(--space-1);
}
</style>
