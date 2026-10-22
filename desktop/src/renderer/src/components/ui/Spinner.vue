<script setup lang="ts">
/**
 * Spinner — the one loading indicator (DS-03 replaces the per-component
 * spin animations). size: sm 14 | md 16; tone: neutral | accent. Under
 * reduced motion it stays still (a static ring).
 */
import { onBeforeUnmount, ref } from 'vue'

withDefaults(
  defineProps<{
    size?: 'sm' | 'md'
    tone?: 'neutral' | 'accent'
    label?: string
  }>(),
  { size: 'md', tone: 'neutral', label: '加载中' },
)

const reduced = ref(false)
const query =
  typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null
reduced.value = query?.matches ?? false
const update = (event: { matches: boolean }) => {
  reduced.value = event.matches
}
query?.addEventListener?.('change', update)
onBeforeUnmount(() => query?.removeEventListener?.('change', update))
</script>

<template>
  <span
    class="ds-spinner"
    role="status"
    :aria-label="label"
    :data-size="size"
    :data-tone="tone"
    :data-static="reduced ? '' : undefined"
  />
</template>

<style scoped>
.ds-spinner {
  display: inline-block;
  flex: none;
  width: var(--icon-md);
  height: var(--icon-md);
  border: 1.5px solid rgb(var(--text-3) / 0.3);
  border-top-color: rgb(var(--text-2));
  border-radius: var(--r-full);
  animation: ds-spinner-turn 0.8s linear infinite;
}

.ds-spinner[data-size='sm'] {
  width: var(--icon-sm);
  height: var(--icon-sm);
}

.ds-spinner[data-tone='accent'] {
  border-color: rgb(var(--accent) / 0.3);
  border-top-color: rgb(var(--accent));
}

.ds-spinner[data-static] {
  animation: none;
}

@keyframes ds-spinner-turn {
  to {
    transform: rotate(360deg);
  }
}
</style>
