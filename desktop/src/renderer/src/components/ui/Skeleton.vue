<script setup lang="ts">
/**
 * Skeleton — loading placeholder: a text line, a block or a circle. Under
 * reduced motion styles/a11y.css collapses the pulse, like every animation.
 */
withDefaults(
  defineProps<{
    shape?: 'line' | 'block' | 'circle'
    width?: string
    height?: string
  }>(),
  { shape: 'line', width: '', height: '' },
)
</script>

<template>
  <span
    class="ds-skeleton"
    aria-hidden="true"
    :data-shape="shape"
    :style="{
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    }"
  />
</template>

<style scoped>
.ds-skeleton {
  display: block;
  background: var(--skeleton-bg);
  border-radius: var(--r-xs);
  animation: ds-skeleton-pulse 1.6s ease-in-out infinite;
}

.ds-skeleton[data-shape='line'] {
  width: 100%;
  height: 0.8em;
}

.ds-skeleton[data-shape='block'] {
  width: 100%;
  height: var(--control-lg);
  border-radius: var(--r-sm);
}

.ds-skeleton[data-shape='circle'] {
  width: var(--control-md);
  height: var(--control-md);
  border-radius: var(--r-full);
}

@keyframes ds-skeleton-pulse {
  50% {
    opacity: 0.55;
  }
}
</style>
