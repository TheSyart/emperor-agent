<script setup lang="ts">
/**
 * PluginRow — one plugin in the 插件 list: a full-width button with the
 * logo, the display name, source and state badges, and a one-line short
 * description; the trailing chevron shows it opens the detail. Rows sit in
 * the section's bordered list and draw their own hairline.
 *
 * Props: plugin (list summary). Emits: select.
 */
import { computed } from 'vue'
import { DsChevronRight } from '../../icons/ds'
import { Badge } from '../ui'
import {
  activationState,
  scopeLabel,
  type PluginSummary,
} from './pluginInstall'
import Avatar from '../../ui/Avatar.vue'
import { pluginSourceTag } from './pluginsModel'

const props = defineProps<{ plugin: PluginSummary }>()
const emit = defineEmits<{ select: [] }>()

const state = computed(() => activationState(props.plugin))
const showScope = computed(
  () => props.plugin.scope !== 'managed' && props.plugin.scope !== 'user',
)
</script>

<template>
  <li class="plugin-row-item">
    <button
      type="button"
      class="plugin-row"
      :data-plugin-id="plugin.pluginId"
      :data-plugin-scope="plugin.scope"
      @click="emit('select')"
    >
      <Avatar
        kind="logo"
        :label="plugin.displayName"
        :src="plugin.logo"
        :size="28"
      />
      <span class="main">
        <span class="title-line">
          <span class="name">{{ plugin.displayName }}</span>
          <Badge>{{ pluginSourceTag(plugin) }}</Badge>
          <Badge v-if="showScope">{{ scopeLabel(plugin.scope) }}</Badge>
          <Badge :tone="state.tone" variant="dot-label">{{
            state.label
          }}</Badge>
        </span>
        <span class="description" :title="plugin.description || undefined">
          {{ plugin.description || '没有描述' }}
        </span>
      </span>
      <DsChevronRight :size="14" class="chevron" aria-hidden="true" />
    </button>
  </li>
</template>

<style scoped>
.plugin-row-item {
  min-width: 0;
  list-style: none;
}

.plugin-row-item + .plugin-row-item {
  border-top: 1px solid var(--stroke-2);
}

.plugin-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  padding: var(--space-2-5) var(--space-3) var(--space-2-5) var(--space-4);
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.plugin-row:hover {
  background: var(--surface-hover);
}

.plugin-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.name {
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.description {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron {
  flex: none;
  color: rgb(var(--text-3));
}
</style>
