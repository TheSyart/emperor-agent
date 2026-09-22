<script setup lang="ts">
/**
 * TurnStatus — dsh turn activity line: one 26px row with the shimmering
 * status label for the whole running turn (first-token wait, tools,
 * streaming) and the elapsed clock once the turn has run for 15s.
 *
 * Props: label, startedAt (turn/start time; null → mount time).
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import ElapsedClock from '../ui/ElapsedClock.vue'
import Shimmer from '../ui/Shimmer.vue'

const props = defineProps<{ label: string; startedAt: number | null }>()

const CLOCK_AFTER_MS = 15_000
const mountedAt = Date.now()
const anchor = computed(() => props.startedAt ?? mountedAt)
const now = ref(Date.now())
const timer = setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(timer))

const showClock = computed(() => now.value - anchor.value >= CLOCK_AFTER_MS)
</script>

<template>
  <div class="turn-status" role="status" aria-live="polite">
    <Shimmer :text="label" />
    <span v-if="showClock" class="clock">
      <ElapsedClock :started-at="anchor" />
    </span>
  </div>
</template>

<style scoped>
.turn-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  align-self: flex-start;
  height: 26px;
  white-space: nowrap;
}

.clock {
  margin-left: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--label-caption));
}
</style>
