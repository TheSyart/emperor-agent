<script setup lang="ts">
/** LinkButton — an inline text action in the link colour (查看详情, 重试). */
withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false })
</script>

<template>
  <button type="button" class="ds-link-button" :disabled="disabled">
    <slot />
  </button>
</template>

<style scoped>
.ds-link-button {
  display: inline;
  padding: 0;
  border: none;
  background: none;
  color: rgb(var(--text-link));
  font: inherit;
  cursor: pointer;
}

.ds-link-button:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ds-link-button:focus-visible {
  outline: none;
  border-radius: var(--r-xs);
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.55);
}

.ds-link-button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
