<script setup lang="ts">
/**
 * SettingsRow — the dsh Setting-Cell: text on the left (14/22 title +
 * 13/20 tertiary description), control on the right, 16px vertical
 * padding and an l2 hairline under it (dropped on the last row of its
 * container). The text keeps ≥ 240px: a control that does not fit beside
 * it wraps onto its own line under the text (small ones such as Switch stay
 * inline); under a narrow section container (< 440px, @container) the text
 * drops its 48px trailing air.
 *
 * Props:
 * - title?: row title.
 * - description?: supporting line(s) under the title.
 * - layout: 'inline' (default; control right) | 'stacked' (control below the
 *   text at full width — choice cubes, lists, editors).
 * - divider (default true): draw the bottom hairline.
 * - labelFor?: id of the control the title labels (renders a <label>).
 * - dense?: 10px vertical padding (list rows: archived sessions, entries).
 * Slots: `title`, `description`, `badge` (inline after the title, e.g. a
 * StatusBadge), default (the control / value).
 */
withDefaults(
  defineProps<{
    title?: string
    description?: string
    layout?: 'inline' | 'stacked'
    divider?: boolean
    labelFor?: string
    dense?: boolean
  }>(),
  {
    title: undefined,
    description: undefined,
    layout: 'inline',
    divider: true,
    labelFor: undefined,
    dense: false,
  },
)
</script>

<template>
  <div
    class="ds-settings-row"
    :data-layout="layout"
    :data-divider="divider || undefined"
    :data-dense="dense || undefined"
  >
    <div
      v-if="$slots.title || title || $slots.description || description"
      class="text"
    >
      <div v-if="$slots.title || title || $slots.badge" class="title-line">
        <component
          :is="labelFor ? 'label' : 'div'"
          class="title"
          :for="labelFor"
        >
          <slot name="title">{{ title }}</slot>
        </component>
        <slot name="badge" />
      </div>
      <div v-if="$slots.description || description" class="description">
        <slot name="description">{{ description }}</slot>
      </div>
    </div>
    <div v-if="$slots.default" class="control"><slot /></div>
  </div>
</template>

<style scoped>
.ds-settings-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-4) 0;
}

.ds-settings-row[data-dense] {
  padding: var(--space-2-5) 0;
}

.ds-settings-row[data-divider] {
  border-bottom: 1px solid var(--border-l2);
}

.ds-settings-row:last-child {
  border-bottom: none;
}

.text {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  /* dsh rowText: 48px air before the control */
  padding-right: calc(var(--space-6) * 2);
}

.title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.title {
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 400;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.description {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.control {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
  max-width: 100%;
}

.ds-settings-row[data-layout='stacked'] {
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
  gap: var(--space-2);
}

.ds-settings-row[data-layout='stacked'] .text {
  flex: none;
  padding-right: 0;
}

/* Full-width area: block children (cube rows, lists, editors) span it,
   inline controls flow from the left. */
.ds-settings-row[data-layout='stacked'] .control {
  display: block;
}

/* Very narrow sections: drop the 48px air so the wrap point moves out. */
@container (max-width: 439px) {
  .text {
    flex-basis: 200px;
    padding-right: 0;
  }
}
</style>
