<script setup lang="ts">
/**
 * Dot — a run or connection state as a small dot (DS-04).
 *   state: ok | warn | error | running (gold, pulsing; the one running
 *          indicator a screen shows) | idle (grey) | attention (orange:
 *          an approval or plan waiting for the user)
 *   size:  sm 6 | md 8 (default)
 * `label` names it for assistive technology (role img); without one the
 * dot is decorative. Reduced motion stills the pulse (styles/a11y.css).
 */
import type { DotState } from './dot'

withDefaults(
  defineProps<{ state: DotState; size?: 'sm' | 'md'; label?: string }>(),
  { size: 'md', label: undefined },
)
</script>

<template>
  <span
    class="ds-dot"
    :data-state="state"
    :data-size="size"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
.ds-dot {
  --dot-color: var(--ok);
  display: inline-block;
  flex: none;
  width: var(--dot-md);
  height: var(--dot-md);
  border-radius: var(--r-full);
  background: rgb(var(--dot-color));
}

.ds-dot[data-size='sm'] {
  width: var(--dot-sm);
  height: var(--dot-sm);
}

.ds-dot[data-state='warn'] {
  --dot-color: var(--warn);
}

.ds-dot[data-state='error'] {
  --dot-color: var(--error);
}

.ds-dot[data-state='attention'] {
  --dot-color: var(--attention);
}

.ds-dot[data-state='idle'] {
  --dot-color: var(--text-4);
}

/* The pulse is a fading ring of box-shadow, so the dot needs no position
   of its own and callers may place it absolutely. */
.ds-dot[data-state='running'] {
  --dot-color: var(--accent);
  animation: ds-dot-pulse 1.6s var(--ease-standard) infinite;
}

@keyframes ds-dot-pulse {
  0% {
    box-shadow: 0 0 0 0 rgb(var(--dot-color) / 0.55);
  }

  70%,
  100% {
    box-shadow: 0 0 0 var(--dot-sm) rgb(var(--dot-color) / 0);
  }
}
</style>
