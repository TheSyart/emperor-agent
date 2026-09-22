<script setup lang="ts">
/**
 * SettingsNav — the settings modal's 188px nav rail (dsh .Setting-nav):
 * 16/24 medium title, then a 4px-gap stack of 40px cells (16px glyph + 14/22
 * label, r12; hover / active fills from the sidebar item tokens). Inside a
 * `settings-panel` container narrower than 640px the rail folds into a top
 * strip: title + a horizontally scrolling row of 32px cells.
 *
 * Props: active (current section), titleId (id for aria-labelledby).
 * Emits: select(section).
 */
import { SETTINGS_SECTIONS, type SettingsSectionKey } from './settingsSections'
import { SETTINGS_SECTION_ICONS } from './settingsIcons'

defineProps<{ active: SettingsSectionKey; titleId: string }>()
const emit = defineEmits<{ select: [section: SettingsSectionKey] }>()
</script>

<template>
  <nav class="settings-nav" aria-label="设置分区">
    <div :id="titleId" class="nav-title">设置</div>
    <div class="nav-list">
      <button
        v-for="item in SETTINGS_SECTIONS"
        :key="item.key"
        type="button"
        class="nav-cell"
        :class="{ active: item.key === active }"
        :data-section="item.key"
        :aria-current="item.key === active ? 'page' : undefined"
        @click="emit('select', item.key)"
      >
        <component
          :is="SETTINGS_SECTION_ICONS[item.key]"
          class="nav-icon"
          :size="16"
          :stroke-width="1.6"
        />
        <span class="nav-label">{{ item.label }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.settings-nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: calc(var(--space-4) + 2px);
  width: 188px;
  min-height: 0;
  padding: calc(var(--space-5) + 2px) var(--space-3) 0;
  box-sizing: border-box;
  overflow-y: auto;
}

.nav-title {
  padding: 0 var(--space-3);
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.nav-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-bottom: var(--space-3);
}

.nav-cell {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: calc(var(--space-2) + 1px) var(--space-4) calc(var(--space-2) + 1px)
    var(--space-3);
  box-sizing: border-box;
  border: none;
  border-radius: var(--radius-card);
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
  background: rgb(var(--sidebar-item-active));
}

.nav-cell:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.nav-icon {
  flex: none;
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

  .nav-list {
    flex-direction: row;
    padding-bottom: 0;
  }

  .nav-cell {
    flex: none;
    gap: var(--space-1-5);
    height: var(--space-8);
    padding: 0 var(--space-3) 0 var(--space-2-5);
  }

  .nav-label {
    overflow: visible;
  }
}
</style>
