<script setup lang="ts">
/**
 * WorkspaceEmpty — what the right workspace shows before any pane has been
 * chosen (UI-S06; there is no launcher home to come back to): a short empty
 * state over four 32px entries (审查 / 终端 / 文件 / 浏览器) with their
 * shortcuts. An entry the session cannot use is disabled and says why in
 * place of its shortcut. Once a pane is picked the workspace reopens on it.
 *
 * Props: availability (hasProject / snapshotLoaded / hasGit).
 * Emits: open(pane).
 */
import { PanelRight } from 'lucide-vue-next'
import { computed } from 'vue'
import { detectShortcutPlatform, shortcutKeys } from '../../shortcuts'
import EmptyState from '../ui/EmptyState.vue'
import Kbd from '../ui/Kbd.vue'
import { WORKSPACE_PANE_ICONS } from './workspaceIcons'
import {
  WORKSPACE_PANE_ITEMS,
  workspacePaneDisabledReason,
  type WorkspaceAvailability,
  type WorkspaceContentPane,
} from './workspacePanes'

const props = defineProps<{ availability: WorkspaceAvailability }>()
const emit = defineEmits<{ open: [pane: WorkspaceContentPane] }>()

const platform = detectShortcutPlatform()

const entries = computed(() =>
  WORKSPACE_PANE_ITEMS.map((item) => ({
    ...item,
    icon: WORKSPACE_PANE_ICONS[item.pane],
    keys: shortcutKeys(item.shortcut, platform),
    reason: workspacePaneDisabledReason(item.pane, props.availability),
  })),
)
</script>

<template>
  <div class="workspace-start">
    <div class="start-inner">
      <EmptyState
        title="选择一个面板"
        description="以后打开工作台，会直接回到上次用的面板"
        :icon="PanelRight"
      />
      <nav class="start-list" aria-label="打开工作台面板">
        <button
          v-for="entry in entries"
          :key="entry.pane"
          type="button"
          class="start-entry"
          :data-pane="entry.pane"
          :disabled="Boolean(entry.reason)"
          :aria-describedby="
            entry.reason ? `workspace-start-${entry.pane}` : undefined
          "
          @click="emit('open', entry.pane)"
        >
          <component
            :is="entry.icon"
            class="entry-icon"
            :size="16"
            aria-hidden="true"
          />
          <span class="entry-label">{{ entry.label }}</span>
          <span
            v-if="entry.reason"
            :id="`workspace-start-${entry.pane}`"
            class="entry-reason"
            >{{ entry.reason }}</span
          >
          <span v-else class="entry-keys" aria-hidden="true">
            <Kbd v-for="(cap, index) in entry.keys" :key="index">{{ cap }}</Kbd>
          </span>
        </button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.workspace-start {
  display: flex;
  box-sizing: border-box;
  min-height: 100%;
  align-items: center;
  justify-content: center;
  padding: var(--space-6) var(--space-4);
}

.start-inner {
  display: flex;
  width: 100%;
  max-width: 300px;
  flex-direction: column;
  gap: var(--space-3);
}

.start-inner :deep(.ds-empty-state) {
  padding: 0;
}

.start-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

.start-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  box-sizing: border-box;
  height: var(--row-h);
  padding: 0 var(--space-2-5);
  border: none;
  border-radius: var(--r-sm);
  outline: none;
  background: transparent;
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.start-entry:hover:not(:disabled) {
  background: var(--surface-hover);
}

.start-entry:active:not(:disabled) {
  background: var(--surface-active);
}

.start-entry:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.55);
}

.start-entry:disabled {
  color: rgb(var(--text-disabled));
  cursor: default;
}

.entry-icon {
  flex: none;
  color: rgb(var(--text-3));
}

.start-entry:disabled .entry-icon {
  color: rgb(var(--text-disabled));
}

.entry-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-keys {
  display: inline-flex;
  flex: none;
  gap: var(--space-0-5);
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.entry-reason {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
