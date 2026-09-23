<script setup lang="ts">
/**
 * Brand row: the Emperor mark and name (display only), then the
 * conversation search toggle (⌘K) and the notification bell.
 */
import BrandMark from '../brand/BrandMark.vue'
import { DsSearch } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import SidebarBell from './SidebarBell.vue'

defineProps<{ searchActive?: boolean }>()
const emit = defineEmits<{ search: [] }>()
</script>

<template>
  <div class="brand-row">
    <div class="brand" data-testid="sidebar-brand">
      <BrandMark :size="22" />
      <span class="brand-name">Emperor</span>
    </div>
    <!-- mousedown.prevent: a click toggles the capsule instead of blurring
         (and so closing) it first. -->
    <IconButton
      label="搜索"
      :active="searchActive"
      @mousedown.prevent
      @click="emit('search')"
    >
      <DsSearch :size="16" />
    </IconButton>
    <SidebarBell />
  </div>
</template>

<style scoped>
.brand-row {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  height: calc(var(--space-8) + var(--space-2));
  margin-bottom: var(--space-1);
}

.brand {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: var(--space-8);
  margin: 0 auto 0 calc(0px - var(--space-1));
  padding: 0 var(--space-1-5) 0 var(--space-1);
  color: inherit;
  user-select: none;
}

.brand-name {
  overflow: hidden;
  font-size: var(--fs-md);
  font-weight: 600;
  line-height: var(--space-6);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
</style>
