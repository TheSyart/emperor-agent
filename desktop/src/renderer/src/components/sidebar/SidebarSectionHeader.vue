<script setup lang="ts">
/**
 * Sticky section heading of the session list (置顶 / 项目 / 对话): the
 * label toggles the section open; the default slot holds trailing actions.
 */
defineProps<{ label: string }>()
const collapsed = defineModel<boolean>('collapsed', { default: false })
</script>

<template>
  <header class="section-header">
    <button
      type="button"
      class="section-label"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      {{ label }}
    </button>
    <div v-if="$slots.default" class="section-actions"><slot /></div>
  </header>
</template>

<style scoped>
.section-header {
  position: sticky;
  top: 0;
  z-index: var(--z-raised);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  height: var(--space-7);
  padding-left: var(--space-1);
  background: rgb(var(--surface-canvas));
}

.section-label {
  padding: 0 var(--space-1);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  cursor: pointer;
}

.section-label:hover {
  color: rgb(var(--label-secondary));
}

.section-label[aria-expanded='false'] {
  color: rgb(var(--label-caption));
}

/* Trailing actions (+, ⋯) only while the header is hovered or focused, or
   their menu is open (UI-S11). */
.section-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  opacity: 0;
  transition: opacity var(--duration-ds) var(--ease-in-out);
}

.section-header:hover .section-actions,
.section-header:focus-within .section-actions,
.section-actions:has([aria-expanded='true']) {
  opacity: 1;
}
</style>
