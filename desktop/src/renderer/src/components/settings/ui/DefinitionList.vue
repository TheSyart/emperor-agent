<script setup lang="ts">
/**
 * DefinitionList — key/value facts (dsh inventory details): a two-column
 * <dl> grid with a fixed label column (76px default), 6px row / 10px column
 * gaps, 11/17 tertiary terms and 12/17 secondary values that wrap anywhere
 * (paths, URLs, commands never widen the page). Empty values show 「—」.
 *
 * Props:
 * - items: DefinitionItem[] ({ key?, term, value?, mono? }).
 * - labelWidth (default 76): term column width in px.
 * Slots: `value` (scoped: { item }) to render a value (badges, links).
 */
import type { DefinitionItem } from './types'

withDefaults(
  defineProps<{ items: readonly DefinitionItem[]; labelWidth?: number }>(),
  { labelWidth: 76 },
)

function isEmpty(value: DefinitionItem['value']) {
  return value === undefined || value === null || value === ''
}
</script>

<template>
  <dl
    class="ds-definition-list"
    :style="{ '--definition-label-width': `${labelWidth}px` }"
  >
    <div v-for="item in items" :key="item.key ?? item.term" class="entry">
      <dt class="term">{{ item.term }}</dt>
      <dd class="value" :data-mono="item.mono || undefined">
        <slot name="value" :item="item">
          {{ isEmpty(item.value) ? '—' : item.value }}
        </slot>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.ds-definition-list {
  display: grid;
  grid-template-columns: var(--definition-label-width) minmax(0, 1fr);
  gap: var(--space-1-5) var(--space-2-5);
  min-width: 0;
  margin: 0;
}

.entry {
  display: contents;
}

.term {
  min-width: 0;
  font-size: var(--fs-xxxs);
  line-height: calc(var(--lh-xxxs) + 3px);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.value {
  min-width: 0;
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: calc(var(--lh-xxxs) + 3px);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.value[data-mono] {
  font-family: var(--font-mono);
  color: rgb(var(--label-primary));
}
</style>
