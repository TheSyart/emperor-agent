<script setup lang="ts">
/** Kbd — a keyboard shortcut label (⌘K, ⇧⌘D). */
</script>

<template>
  <kbd class="ds-kbd"><slot /></kbd>
</template>

<style scoped>
.ds-kbd {
  font-family: var(--font-sans);
  font-size: inherit;
  letter-spacing: 0.02em;
  font-feature-settings: 'tnum';
}
</style>
