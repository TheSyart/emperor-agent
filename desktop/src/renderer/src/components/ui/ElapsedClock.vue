<script setup lang="ts">
/**
 * ElapsedClock — tabular-nums elapsed time ("9s", "1m 05s", "1h 02m"),
 * ticking once per second while running.
 *
 * Props:
 * - startedAt: epoch ms the clock counts from.
 * - endedAt?: freeze at this epoch ms (settled turns).
 * - running (default true): tick while true and no endedAt.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { formatElapsed } from './elapsed'

const props = withDefaults(
  defineProps<{ startedAt: number; endedAt?: number; running?: boolean }>(),
  { endedAt: undefined, running: true },
)

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

watch(
  () => props.running && props.endedAt === undefined,
  (ticking) => {
    clearInterval(timer)
    timer = undefined
    now.value = Date.now()
    if (ticking)
      timer = setInterval(() => {
        now.value = Date.now()
      }, 1000)
  },
  { immediate: true },
)

onBeforeUnmount(() => clearInterval(timer))

const text = computed(() =>
  formatElapsed((props.endedAt ?? now.value) - props.startedAt),
)
</script>

<template>
  <span class="ds-elapsed">{{ text }}</span>
</template>

<style scoped>
.ds-elapsed {
  font: var(--font-xs);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--label-caption));
}
</style>
