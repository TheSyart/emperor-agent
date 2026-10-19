<script setup lang="ts">
/**
 * Notification bell at the foot of the rail (UI-S01): a dot while anything
 * is unread; the list popover is its own async chunk, fetched on first open.
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
    size="lg"
    side="right"
    :label="label"
    :tooltip="open ? false : '通知'"
    :active="open"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click="open = !open"
  >
    <component :is="SIDEBAR_ICONS.bell" :size="20" />
    <Dot v-if="unreadCount" class="dot" state="error" size="sm" />
  </IconButton>
  <NotificationsPopover v-if="open" v-model:open="open" :anchor="anchor" />
</template>

<style scoped>
.bell {
  position: relative;
}

.dot {
  position: absolute;
  top: 22%;
  right: 22%;
  box-shadow: 0 0 0 2px rgb(var(--sidebar-fill));
}
</style>
