<script setup lang="ts">
/**
 * Sidebar foot (dsh sidebar.settings seat): 42px settings row that opens the
 * settings modal, plus the theme toggle. `rail` renders both as 36px circles
 * stacked in the collapsed rail.
 */
import { useTheme } from '../../composables/useTheme'
import { DsDark, DsLight, DsSettings } from '../icons/ds'
import Tooltip from '../ui/Tooltip.vue'
import { useSettingsRoute } from '../settings/useSettingsRoute'

withDefaults(defineProps<{ rail?: boolean }>(), { rail: false })

const { theme, toggle } = useTheme()
const settings = useSettingsRoute()
</script>

<template>
  <div class="sidebar-footer" :data-rail="rail || undefined">
    <Tooltip label="设置" :disabled="!rail" side="right" :delay-ms="500">
      <button
        type="button"
        class="settings"
        aria-label="设置"
        @click="settings.openSettings('general')"
      >
        <DsSettings :size="rail ? 18 : 16" />
        <span v-if="!rail" class="label">设置</span>
      </button>
    </Tooltip>
    <Tooltip
      :label="theme === 'dark' ? '切换浅色' : '切换深色'"
      :side="rail ? 'right' : 'top'"
      :delay-ms="500"
    >
      <button
        type="button"
        class="theme"
        :aria-label="theme === 'dark' ? '切换浅色' : '切换深色'"
        @click="toggle()"
      >
        <component :is="theme === 'dark' ? DsLight : DsDark" :size="16" />
      </button>
    </Tooltip>
  </div>
</template>

<style scoped>
.sidebar-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-1) calc(0px - var(--space-0-5));
}

.sidebar-footer > :first-child {
  flex: 1;
  min-width: 0;
}

.sidebar-footer[data-rail] {
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-2) 0 var(--space-2-5);
}

.sidebar-footer[data-rail] > :first-child {
  flex: none;
}

.settings {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 100%;
  height: 42px;
  padding: 0 var(--space-2-5) 0 var(--space-2);
  border: none;
  border-radius: var(--radius-card);
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  cursor: pointer;
  overflow: hidden;
}

.settings:hover,
.theme:hover {
  background: var(--interactive-bg-hover);
}

[data-rail] .settings {
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: var(--radius-pill);
}

.label {
  overflow: hidden;
  white-space: nowrap;
}

.theme {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
}
</style>
