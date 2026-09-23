<script setup lang="ts">
/**
 * Sidebar foot: the 设置 row (settings modal) and the light / dark theme
 * toggle. `rail` renders both as 36px circles at the bottom of the
 * collapsed rail, with right-side tooltips. The toggle pins an explicit
 * theme; 跟随系统 is chosen in Settings › 常规.
 */
import { computed } from 'vue'
import { useTheme } from '../../composables/useTheme'
import { DsDark, DsLight, DsSettings } from '../icons/ds'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import Tooltip from '../ui/Tooltip.vue'

withDefaults(defineProps<{ rail?: boolean }>(), { rail: false })

const settings = useSettingsRoute()
const { theme, toggle } = useTheme()

const themeLabel = computed(() =>
  theme.value === 'dark' ? '切换浅色' : '切换深色',
)
const themeIcon = computed(() => (theme.value === 'dark' ? DsLight : DsDark))
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
    <Tooltip :label="themeLabel" :side="rail ? 'right' : 'top'" :delay-ms="500">
      <button
        type="button"
        class="theme"
        :aria-label="themeLabel"
        data-testid="sidebar-theme-toggle"
        @click="toggle()"
      >
        <component :is="themeIcon" :size="rail ? 18 : 16" />
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
  height: calc(var(--space-8) + var(--space-2-5));
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
  width: calc(var(--space-8) + var(--space-1));
  height: calc(var(--space-8) + var(--space-1));
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
  width: calc(var(--space-8) + var(--space-1));
  height: calc(var(--space-8) + var(--space-1));
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.settings:focus-visible,
.theme:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}
</style>
