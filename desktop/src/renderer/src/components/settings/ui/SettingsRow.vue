<script setup lang="ts">
/**
 * SettingsRow — the dsh Setting-Cell: text on the left (14/22 medium title +
 * 12/18 tertiary description), control on the right, 16px vertical
 * padding and an l2 hairline under it (dropped on the last row of its
 * container). The text keeps ≥ 240px: a control that does not fit beside
 * it wraps onto its own line under the text (small ones such as Switch stay
 * inline); under a narrow section container (< 440px, @container) the text
 * drops its trailing air.
 *
 * Inside a card group (the 'card' surface, ui/surface.ts) the row takes the
 * card look: 12px / 16px padding and an inset l1 hairline.
 *
 * Props:
 * - title?: row title.
 * - description?: supporting line(s) under the title.
 * - layout: 'inline' (default; control right) | 'stacked' (control below the
 *   text at full width — choice cubes, lists, editors).
 * - divider (default true): draw the bottom hairline.
 * - labelFor?: id of the control the title labels (renders a <label>).
 * - dense?: 10px vertical padding (list rows: archived sessions, entries).
 * Slots: `leading` (a step marker or icon left of the text; the row then
 * aligns to the top), `eyebrow` (a small label above the title, e.g. ⚠
 * 风险升高), `title`, `description`, `badge` (inline after the title, e.g.
 * a Badge), default (the control / value).
 */
import { computed } from 'vue'
import { useSurface } from '../../ui/surface'

const surface = useSurface()
const inCard = computed(() => surface.value === 'card')

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
    :data-in-card="inCard || undefined"
    :data-leading="$slots.leading ? '' : undefined"
  >
    <div v-if="$slots.leading" class="leading"><slot name="leading" /></div>
    <div
      v-if="
        $slots.eyebrow ||
        $slots.title ||
        title ||
        $slots.description ||
        description
      "
      class="text"
    >
      <div v-if="$slots.eyebrow" class="eyebrow"><slot name="eyebrow" /></div>
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
  border-bottom: 1px solid var(--stroke-2);
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
  font-weight: 500;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.eyebrow {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--state-warn-label));
}

.description {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
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

/* In a card: 16px sides, an inset hairline, less air before the control. */
.ds-settings-row[data-in-card] {
  position: relative;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4);
}

.ds-settings-row[data-in-card][data-dense] {
  padding: var(--space-2-5) var(--space-4);
}

.ds-settings-row[data-in-card][data-divider] {
  border-bottom: none;
}

.ds-settings-row[data-in-card][data-divider]:not(:last-child)::after {
  content: '';
  position: absolute;
  right: var(--space-4);
  bottom: 0;
  left: var(--space-4);
  border-bottom: 1px solid var(--stroke-1);
}

.ds-settings-row[data-in-card] .text {
  padding-right: var(--space-4);
}

/* A step marker or icon left of the text, the row aligned to the top; a
   control that does not fit stays under the text, not under the marker. */
.ds-settings-row[data-leading] {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
}

.leading {
  display: flex;
  align-items: center;
  min-height: var(--lh-s);
}

@container (max-width: 479px) {
  .ds-settings-row[data-leading] {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .ds-settings-row[data-leading] > .control {
    grid-column: 2;
    justify-content: flex-start;
  }
}

/* Very narrow sections: drop the trailing air so the wrap point moves out. */
@container (max-width: 439px) {
  .text {
    flex-basis: 200px;
    padding-right: 0;
  }
}
</style>
