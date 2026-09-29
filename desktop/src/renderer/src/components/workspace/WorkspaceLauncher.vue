<script setup lang="ts">
/**
 * WorkspaceLauncher — the right workspace's home: one card row per pane
 * (审查 / 终端 / 文件 / 浏览器 / 电脑) with its glyph, label and shortcut chips (from
 * the shortcuts.ts table), vertically centered in the pane at a readable
 * max width. Rows the session cannot use are disabled and say why (no Build
 * project / no git); 浏览器 and 电脑 work for any session.
 *
 * Props: availability (hasProject / snapshotLoaded / hasGit).
 * Emits: open(pane).
 */
import { computed } from 'vue'
import { detectShortcutPlatform, shortcutKeys } from '../../shortcuts'
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

const rows = computed(() =>
  WORKSPACE_PANE_ITEMS.map((item) => ({
    ...item,
    icon: WORKSPACE_PANE_ICONS[item.pane],
    keys: shortcutKeys(item.shortcut, platform),
    reason: workspacePaneDisabledReason(item.pane, props.availability),
  })),
)
</script>

<template>
  <div class="workspace-launcher">
    <nav class="launcher-list" aria-label="打开工作台面板">
      <button
        v-for="row in rows"
        :key="row.pane"
        type="button"
        class="launcher-row"
        :data-pane="row.pane"
        :disabled="Boolean(row.reason)"
        :aria-describedby="
          row.reason ? `launcher-reason-${row.pane}` : undefined
        "
        @click="emit('open', row.pane)"
      >
        <span class="row-icon" aria-hidden="true">
          <component :is="row.icon" :size="16" />
        </span>
        <span class="row-text">
          <span class="row-label">{{ row.label }}</span>
          <span
            v-if="row.reason"
            :id="`launcher-reason-${row.pane}`"
            class="row-reason"
            >{{ row.reason }}</span
          >
        </span>
        <span class="row-keys" aria-hidden="true">
          <kbd v-for="(cap, index) in row.keys" :key="index" class="kbd">{{
            cap
          }}</kbd>
        </span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
/* The rows sit in the middle of the pane (dsh / Codex workspace home). */
.workspace-launcher {
  display: flex;
  box-sizing: border-box;
  min-height: 100%;
  align-items: center;
  justify-content: center;
  padding: var(--space-6) var(--space-4);
}

.launcher-list {
  display: flex;
  width: 100%;
  max-width: 700px;
  flex-direction: column;
  gap: var(--space-2);
}

.launcher-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  box-sizing: border-box;
  width: 100%;
  min-height: calc(var(--space-8) + var(--space-4));
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-2-5);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--duration-ds-fast) ease,
    border-color var(--duration-ds-fast) ease;
}

.launcher-row:hover:not(:disabled) {
  border-color: var(--border-l2);
  background: rgb(var(--bg-layer-2));
}

.launcher-row:active:not(:disabled) {
  background: rgb(var(--bg-layer-3));
}

.launcher-row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.launcher-row:disabled {
  background: transparent;
  cursor: default;
}

.row-icon {
  display: inline-grid;
  flex: none;
  width: var(--space-8);
  height: var(--space-8);
  place-items: center;
  border-radius: var(--radius-row);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}

.launcher-row:disabled .row-icon {
  background: transparent;
  color: rgb(var(--label-caption));
}

.launcher-row:disabled .row-label {
  color: rgb(var(--label-tertiary));
}

.row-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.row-label {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
}

.row-reason {
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-keys {
  display: inline-flex;
  flex: none;
  gap: var(--space-1);
}

.kbd {
  display: inline-grid;
  place-items: center;
  box-sizing: border-box;
  min-width: calc(var(--space-5) + var(--space-0-5));
  height: calc(var(--space-5) + var(--space-0-5));
  padding: 0 var(--space-1);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-xs);
  background: rgb(var(--bg-layer-2));
  color: rgb(var(--label-secondary));
  font: var(--font-xxxs);
}

.launcher-row:disabled .kbd {
  opacity: 0.5;
}
</style>
