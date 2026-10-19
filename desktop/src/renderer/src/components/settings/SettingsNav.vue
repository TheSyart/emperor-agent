<script setup lang="ts">
/**
 * SettingsNav — the settings modal's 200px nav on the canvas color (UI-S07):
 * the 16/600 「设置」 title, then four groups (SETTINGS_NAV_GROUPS): 常规
 * alone, then 智能, 操控 and 系统 under 12/500 tertiary labels. A cell is a
 * 32px text row (14/22, r8); the open section takes the selected fill.
 * Inside a `settings-panel` container narrower than 640px the nav folds
 * into a top strip: title + one horizontally scrolling row of cells, the
 * group labels dropped.
 *
 * Props: active (current section), titleId (id for aria-labelledby).
 * Emits: select(section).
 */
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsModalSection,
} from './settingsSections'

defineProps<{ active: SettingsModalSection; titleId: string }>()
const emit = defineEmits<{ select: [section: SettingsModalSection] }>()

const LABELS = Object.fromEntries(
  SETTINGS_SECTIONS.map((section) => [section.key, section.label]),
) as Record<SettingsModalSection, string>
</script>

<template>
  <nav class="settings-nav" aria-label="设置分区">
    <div :id="titleId" class="nav-title">设置</div>
    <div class="nav-list">
      <div
        v-for="group in SETTINGS_NAV_GROUPS"
        :key="group.label ?? 'general'"
        class="nav-group"
        role="group"
        :aria-label="group.label ?? undefined"
      >
        <div v-if="group.label" class="nav-group-label" aria-hidden="true">
          {{ group.label }}
        </div>
        <button
          v-for="key in group.sections"
          :key="key"
          type="button"
          class="nav-cell"
          :class="{ active: key === active }"
          :data-section="key"
          :aria-current="key === active ? 'page' : undefined"
          @click="emit('select', key)"
        >
          <span class="nav-label">{{ LABELS[key] }}</span>
        </button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.settings-nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  width: 200px;
  min-height: 0;
  padding: var(--space-5) var(--space-2) 0;
  box-sizing: border-box;
  overflow-y: auto;
  background: rgb(var(--surface-canvas));
}

.nav-title {
  padding: 0 var(--space-2-5);
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.nav-list {
  display: flex;
  flex-direction: column;
  padding-bottom: var(--space-3);
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.nav-group-label {
  padding: var(--space-3) var(--space-2-5) var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-tertiary));
}

.nav-cell {
  display: flex;
  align-items: center;
  height: var(--space-8);
  padding: 0 var(--space-2-5);
  box-sizing: border-box;
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 400;
  color: rgb(var(--label-primary));
  text-align: left;
}

.nav-cell:hover:not(.active) {
  background: var(--interactive-bg-hover);
}

.nav-cell.active {
  background: rgb(var(--surface-selected));
  font-weight: 500;
}

.nav-cell:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@container settings-panel (max-width: 639px) {
  .settings-nav {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3-5) var(--space-3) var(--space-1);
    overflow-x: auto;
    overflow-y: hidden;
  }

  .nav-title {
    flex: none;
    padding: 0 var(--space-2) 0 var(--space-1-5);
  }

  .nav-list,
  .nav-group {
    flex-direction: row;
    gap: var(--space-1);
    padding-bottom: 0;
  }

  .nav-group-label {
    display: none;
  }

  .nav-cell {
    flex: none;
    padding: 0 var(--space-3);
  }

  .nav-label {
    overflow: visible;
  }
}
</style>
