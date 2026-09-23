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
  height: 36px;
  padding-left: var(--space-1);
  background: rgb(var(--sidebar-fill));
}

.section-label {
  padding: 0 var(--space-1);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 700;
  cursor: pointer;
}

.section-label:hover {
  color: rgb(var(--label-secondary));
}

.section-label[aria-expanded='false'] {
  color: rgb(var(--label-caption));
}

.section-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
</style>
