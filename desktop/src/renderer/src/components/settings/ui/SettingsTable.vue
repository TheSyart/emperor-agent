<script setup lang="ts">
/**
 * SettingsTable — settings laid out in columns (e.g. 智能体权限: 网站或模式 ·
 * 浏览 · 下载), placed in a card group like rows. A tinted header row names
 * the columns; each SettingsTableRow lines its cells up under them (CSS
 * subgrid), with an l1 hairline between rows.
 *
 * Props:
 * - columns: { key, label, width? }[] — width is a grid track size
 *   (default minmax(0, 1fr); e.g. '28px' for a remove button column).
 * - ariaLabel?: the table's accessible name.
 * Slots: default (SettingsTableRow children).
 */
import { computed } from 'vue'
import type { SettingsTableColumn } from './types'

const props = withDefaults(
  defineProps<{ columns: SettingsTableColumn[]; ariaLabel?: string }>(),
  { ariaLabel: undefined },
)

const template = computed(() =>
  props.columns.map((column) => column.width ?? 'minmax(0, 1fr)').join(' '),
)
</script>

<template>
  <div
    class="ds-settings-table"
    role="table"
    :aria-label="ariaLabel"
    :style="{ gridTemplateColumns: template }"
  >
    <div class="head" role="row">
      <div
        v-for="column in columns"
        :key="column.key"
        class="th"
        role="columnheader"
      >
        {{ column.label }}
      </div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.ds-settings-table {
  display: grid;
  min-width: 0;
}

.head {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
}

.th {
  min-width: 0;
  padding: var(--space-2-5) var(--space-3) var(--space-2-5) 0;
  background: var(--interactive-bg-hover);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.th:first-child {
  padding-left: var(--space-4);
}

/* The header tint follows the card's rounded top when the table opens it. */
.ds-settings-table:first-child .th:first-child {
  border-top-left-radius: calc(var(--radius-card) - 1px);
}

.ds-settings-table:first-child .th:last-child {
  border-top-right-radius: calc(var(--radius-card) - 1px);
}
</style>
