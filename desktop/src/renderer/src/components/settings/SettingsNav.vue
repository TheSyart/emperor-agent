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
 * Props: active (current section), titleId (id for aria-labelledby),
 * marks? (sections with something new: a 6px gold dot at the cell's end,
 * read out as 「有新版本」 — 子智能体 when Claude Code or Codex can be
 * upgraded, AGT-13).
 * Emits: select(section).
 */
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsModalSection,
} from './settingsSections'

defineProps<{
  active: SettingsModalSection
  titleId: string
  marks?: Partial<Record<SettingsModalSection, boolean>>
}>()
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
          <span v-if="marks?.[key]" class="nav-mark" data-nav-mark
            ><span class="nav-mark-text">，有新版本</span></span
          >
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
  font-weight: var(--weight-semibold);
  color: rgb(var(--text-1));
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
  font-weight: var(--weight-medium);
  color: rgb(var(--text-3));
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
  font-weight: var(--weight-regular);
  color: rgb(var(--text-1));
  text-align: left;
}

.nav-cell:hover:not(.active) {
  background: var(--surface-hover);
}

.nav-cell.active {
  background: rgb(var(--surface-selected));
  font-weight: var(--weight-medium);
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

.nav-mark {
  flex: none;
  width: 6px;
  height: 6px;
  margin-left: var(--space-2);
  border-radius: 50%;
  background: rgb(var(--accent));
}

/* Read out, not shown. */
.nav-mark-text {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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
