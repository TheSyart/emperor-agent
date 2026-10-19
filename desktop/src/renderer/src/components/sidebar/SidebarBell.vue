<script setup lang="ts">
/**
 * Notification bell (brand row / rail): a dot while anything is unread;
 * the list popover is its own async chunk, fetched on first open.
 */
import { computed, defineAsyncComponent, ref } from 'vue'
import { useNotifications } from '../../composables/useNotifications'
import Dot from '../ui/Dot.vue'
import IconButton from '../ui/IconButton.vue'
import { elementOf } from '../ui/elementOf'
import { SIDEBAR_ICONS } from './sidebarNav'

const NotificationsPopover = defineAsyncComponent(
  () => import('./NotificationsPopover.vue'),
)

withDefaults(defineProps<{ rail?: boolean }>(), { rail: false })

const { unreadCount } = useNotifications()
const open = ref(false)
const anchor = ref<HTMLElement | null>(null)
const label = computed(() =>
  unreadCount.value ? `通知，${unreadCount.value} 条未读` : '通知',
)
</script>

<template>
  <IconButton
    :ref="(c) => (anchor = elementOf(c))"
    class="bell"
    :data-rail="rail || undefined"
    :label="label"
    :tooltip="open ? false : '通知'"
    :side="rail ? 'right' : 'bottom'"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click="open = !open"
  >
    <component :is="SIDEBAR_ICONS.bell" :size="rail ? 18 : 16" />
    <Dot v-if="unreadCount" class="dot" state="error" size="sm" />
  </IconButton>
  <NotificationsPopover v-if="open" v-model:open="open" :anchor="anchor" />
</template>

<style scoped>
.bell {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.bell[data-rail] {
  width: calc(var(--space-8) + var(--space-1));
  height: calc(var(--space-8) + var(--space-1));
  border-radius: var(--radius-pill);
  color: rgb(var(--label-primary));
}

.bell:hover,
.bell[aria-expanded='true'] {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.bell:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.dot {
  position: absolute;
  top: 22%;
  right: 22%;
  box-shadow: 0 0 0 1px rgb(var(--sidebar-fill));
}
</style>
