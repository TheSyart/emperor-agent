<script setup lang="ts">
/**
 * ConversationHeader — dsh conversation header (padding 12 28 0 20, l2
 * hairline): breadcrumb row (project / ancestors / current title; ancestor
 * crumbs navigate) plus the details-column toggle, then the Chat |
 * Trajectory tab strip (13/16 medium, gap 36, 2px gold bar).
 */
import { PanelRight } from 'lucide-vue-next'
import IconButton from '../ui/IconButton.vue'
import type { HeaderCrumb } from './conversationModel'

defineProps<{
  crumbs: HeaderCrumb[]
  tab: 'chat' | 'trajectory'
  detailsOpen: boolean
  tabsDisabled?: boolean
}>()

const emit = defineEmits<{
  navigate: [sessionId: string]
  tab: [tab: 'chat' | 'trajectory']
  'toggle-details': []
}>()

const tabs = [
  { id: 'chat', label: 'Chat' },
  { id: 'trajectory', label: 'Trajectory' },
] as const
</script>

<template>
  <header class="conversation-header">
    <div class="title-row">
      <nav class="crumbs" aria-label="会话路径">
        <template v-for="(crumb, index) in crumbs" :key="crumb.id">
          <span v-if="index > 0" class="sep" aria-hidden="true">/</span>
          <button
            v-if="crumb.sessionId && !crumb.current"
            type="button"
            class="crumb"
            :data-subagent="crumb.subagent || undefined"
            :title="crumb.label"
            @click="emit('navigate', crumb.sessionId)"
          >
            {{ crumb.label }}
          </button>
          <span
            v-else
            class="crumb"
            :data-current="crumb.current || undefined"
            :data-subagent="crumb.subagent || undefined"
            :title="crumb.label"
            :aria-current="crumb.current ? 'page' : undefined"
            >{{ crumb.label }}</span
          >
        </template>
      </nav>
      <div class="actions">
        <slot name="actions" />
        <IconButton
          :label="detailsOpen ? '收起详情栏' : '打开详情栏'"
          :active="detailsOpen"
          @click="emit('toggle-details')"
        >
          <PanelRight :size="16" />
        </IconButton>
      </div>
    </div>
    <div class="tabs" role="tablist" aria-label="会话视图">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        role="tab"
        class="tab"
        :aria-selected="tab === item.id"
        :disabled="tabsDisabled && item.id !== tab"
        @click="emit('tab', item.id)"
      >
        {{ item.label }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.conversation-header {
  position: relative;
  flex: none;
  padding: var(--space-3) var(--space-7) 0 var(--space-5);
}

.conversation-header::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 1px;
  background: var(--border-l2);
  pointer-events: none;
}

.title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-8);
}

.crumbs {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.sep {
  flex: none;
  color: rgb(var(--label-caption));
  font-size: var(--fs-s);
  line-height: var(--space-5);
}

.crumb {
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-card);
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-s);
  line-height: var(--space-5);
  text-overflow: ellipsis;
  white-space: nowrap;
}

button.crumb {
  cursor: pointer;
}

button.crumb:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}

.crumb[data-subagent] {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.crumb[data-current] {
  flex: 0 1 auto;
  max-width: none;
  color: rgb(var(--label-primary));
  font-weight: 500;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
}

.tabs {
  position: relative;
  z-index: var(--z-raised);
  display: flex;
  gap: calc(var(--space-8) + var(--space-1));
  margin-top: var(--space-1);
  padding-left: var(--space-2);
}

.tab {
  position: relative;
  padding: 0 0 11px;
  border: none;
  background: transparent;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--space-4);
  font-weight: 500;
  cursor: pointer;
}

.tab:hover:not(:disabled) {
  color: rgb(var(--label-secondary));
}

.tab:disabled {
  color: rgb(var(--label-dimmed));
  cursor: default;
}

.tab::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background: transparent;
}

.tab[aria-selected='true'] {
  color: rgb(var(--accent-strong));
}

.tab[aria-selected='true']::after {
  background: rgb(var(--accent-fill));
}

.tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
  border-radius: var(--radius-xs);
}
</style>
