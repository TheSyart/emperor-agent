<script setup lang="ts">
/**
 * StateDot — dsh session/run state indicator.
 *
 * Props:
 * - state: 'ok' | 'warn' | 'error' (solid 6/10 core + 10% halo) |
 *   'ongoing' (gold 3x3 pixel chase).
 * - size (default 10): outer diameter in px.
 * - label?: accessible text; when omitted the dot is aria-hidden.
 */
import { computed } from 'vue'
import {
  CHASE_CELLS,
  chaseDelayMs,
  stateDotClasses,
  type StateDotState,
} from './stateDot'

const props = withDefaults(
  defineProps<{ state: StateDotState; size?: number; label?: string }>(),
  { size: 10, label: undefined },
)

const classes = computed(() => stateDotClasses(props.state))
const px = computed(() => `${props.size}px`)
</script>

<template>
  <svg
    v-if="state === 'ongoing'"
    :class="classes"
    data-state="ongoing"
    :width="size"
    :height="size"
    viewBox="0 0 10 10"
    shape-rendering="crispEdges"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <rect
      v-for="([x, y], index) in CHASE_CELLS"
      :key="`${x}-${y}`"
      class="ds-chase-cell"
      :x="x"
      :y="y"
      width="2"
      height="2"
      :style="{ animationDelay: `${chaseDelayMs(index)}ms` }"
    />
  </svg>
  <span
    v-else
    :class="classes"
    :data-state="state"
    :style="{ width: px, height: px }"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
.ds-state-dot {
  position: relative;
  display: inline-block;
  flex: none;
}

span.ds-state-dot::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.1;
}

span.ds-state-dot::after {
  content: '';
  position: absolute;
  inset: 20%;
  border-radius: 50%;
  background: currentColor;
}

.ds-state-dot--ok {
  color: rgb(var(--ok));
}

.ds-state-dot--warn {
  color: rgb(var(--warn));
}

.ds-state-dot--error {
  color: rgb(var(--danger));
}

.ds-state-dot--ongoing {
  color: rgb(var(--accent-fill));
}

.ds-chase-cell {
  fill: currentColor;
  opacity: 0.15;
  animation: ds-state-chase 1s infinite;
}
</style>
