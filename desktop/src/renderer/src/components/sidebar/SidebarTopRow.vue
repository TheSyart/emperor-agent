<script setup lang="ts">
/**
 * Sidebar top row: collapse toggle, then history back / forward
 * (shell/navHistory; each disabled at its end of the renderer history).
 */
import { useRouter } from 'vue-router'
import { goBack, goForward, useNavHistory } from '../shell/navHistory'
import { DsPanelLeft } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import { SIDEBAR_ICONS } from './sidebarNav'

const emit = defineEmits<{ toggle: [] }>()
const router = useRouter()
const nav = useNavHistory()
</script>

<template>
  <div class="top-row">
    <IconButton label="收起侧栏" @click="emit('toggle')">
      <DsPanelLeft :size="16" />
    </IconButton>
    <IconButton label="后退" :disabled="!nav.canGoBack" @click="goBack(router)">
      <component :is="SIDEBAR_ICONS.back" :size="16" />
    </IconButton>
    <IconButton
      label="前进"
      :disabled="!nav.canGoForward"
      @click="goForward(router)"
    >
      <component :is="SIDEBAR_ICONS.forward" :size="16" />
    </IconButton>
  </div>
</template>

<style scoped>
.top-row {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  height: calc(var(--space-8) + var(--space-1));
}
</style>
