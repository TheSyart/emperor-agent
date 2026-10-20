<script setup lang="ts">
/**
 * SettingsLinkRow — a row that opens something (a sub page, a list): the
 * whole row is the button (UI-S07 「行本身可点」). Text on the left like
 * SettingsRow (14/22 medium title, 12/18 tertiary description), an optional
 * value and a chevron on the right. Inside a card group it takes the card
 * row look (12px / 16px padding, inset hairline under every row but the
 * last).
 *
 * Props: title, description?, value? (short text before the chevron).
 * Slots: `description`. Emits: click (native).
 */
import { DsChevronRight } from '../../icons/ds'

defineProps<{ title: string; description?: string; value?: string }>()
</script>

<template>
  <button type="button" class="ds-settings-row ds-settings-link-row">
    <span class="text">
      <span class="title">{{ title }}</span>
      <span v-if="$slots.description || description" class="description">
        <slot name="description">{{ description }}</slot>
      </span>
    </span>
    <span v-if="value" class="value">{{ value }}</span>
    <DsChevronRight class="chevron" :size="14" aria-hidden="true" />
  </button>
</template>

<style scoped>
.ds-settings-link-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: none;
  border-radius: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.ds-settings-link-row:first-child {
  border-top-left-radius: inherit;
  border-top-right-radius: inherit;
}

.ds-settings-link-row:last-child {
  border-bottom-left-radius: inherit;
  border-bottom-right-radius: inherit;
}

.ds-settings-link-row:not(:last-child)::after {
  content: '';
  position: absolute;
  right: var(--space-4);
  bottom: 0;
  left: var(--space-4);
  border-bottom: 1px solid var(--stroke-1);
}

.ds-settings-link-row:hover {
  background: var(--surface-hover);
}

.ds-settings-link-row:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--text-1));
  overflow-wrap: anywhere;
}

.description {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.value {
  flex: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.chevron {
  flex: none;
  color: rgb(var(--text-3));
}
</style>
