<script setup lang="ts">
/**
 * GroupLiveBar — the line above the group's composer (GRP-08, 预览 B 第 3
 * 步, D6): who speaks, who waits (「（交办）」 for a task), and on the right
 * how long the turn has run, how many speeches and what it cost. Live
 * while the turn runs (a one-second clock); after it, how it ended. Never
 * a cap or a warning. Nothing before the group's first turn.
 *
 * Props: turn; names (contact id → name); tasks (members queued for a
 * task); speeches (this turn's); endedAt? (an ended turn's last message);
 * clock? (tests).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { liveBarParts, turnRunning, type GroupTurnView } from './groupModel'

const props = withDefaults(
  defineProps<{
    turn: GroupTurnView | null
    names: Readonly<Record<string, string>>
    tasks: readonly string[]
    speeches: number
    endedAt?: number | null
    clock?: () => number
  }>(),
  { endedAt: null, clock: () => Date.now() },
)

const now = ref(props.clock())
let timer: ReturnType<typeof setInterval> | null = null

function stopClock(): void {
  if (timer) clearInterval(timer)
  timer = null
}

watch(
  () => turnRunning(props.turn),
  (running) => {
    now.value = props.clock()
    stopClock()
    if (running) timer = setInterval(() => (now.value = props.clock()), 1000)
  },
  { immediate: true },
)
// A new state or spend shows the time as of now too.
watch(
  () => props.turn,
  () => (now.value = props.clock()),
)
onBeforeUnmount(stopClock)

const parts = computed(() =>
  props.turn
    ? liveBarParts({
        turn: props.turn,
        names: (id) => props.names[id] ?? id,
        tasks: new Set(props.tasks),
        speeches: props.speeches,
        now: now.value,
        endedAt: props.endedAt,
      })
    : null,
)
</script>

<template>
  <div
    v-if="parts"
    class="live-bar"
    data-live-bar
    :data-running="parts.running || undefined"
  >
    <span class="speaking">{{ parts.speaking }}</span>
    <span v-if="parts.queued" class="queued">· {{ parts.queued }}</span>
    <span class="totals" title="只显示，不设上限">{{ parts.totals }}</span>
  </div>
</template>

<style scoped>
.live-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2-5);
  width: 100%;
  max-width: 780px;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}

.live-bar[data-running] .speaking {
  color: rgb(var(--text-2));
}

.totals {
  margin-left: auto;
}
</style>
