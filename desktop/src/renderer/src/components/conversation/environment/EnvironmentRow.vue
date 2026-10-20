<script setup lang="ts">
/**
 * One summary row of the environment card (UI-S05): a lead (icon or a
 * stack of faces), the label, an optional meta slot and the value, and a
 * caret when the row opens a list in place (`expanded`) or a menu (`menu`,
 * with `expanded` as the menu's open state). 32px, no rule between rows.
 */
import { ChevronDown } from 'lucide-vue-next'

withDefaults(
  defineProps<{
    label?: string
    value?: string
    /** `running` lifts the value one text step (no gold: GoalBar and the
     *  sidebar carry the running indicator). */
    status?: string
    /** Undefined: a plain row with no caret (not cast to false). */
    expanded?: boolean
    menu?: boolean
    mono?: boolean
  }>(),
  { expanded: undefined },
)
</script>

<template>
  <button
    type="button"
    class="env-row"
    :aria-expanded="expanded"
    :aria-haspopup="menu ? 'menu' : undefined"
  >
    <span class="lead"><slot name="lead" /></span>
    <span class="label" :class="{ mono }"
      ><slot name="label">{{ label }}</slot></span
    >
    <slot name="meta" />
    <span v-if="value || $slots.value" class="value" :data-status="status"
      ><slot name="value">{{ value }}</slot></span
    >
    <ChevronDown
      v-if="expanded !== undefined"
      :size="14"
      class="caret"
      :data-open="expanded || undefined"
    />
  </button>
</template>

<style scoped>
.env-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: var(--row-h);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  text-align: left;
  cursor: pointer;
}

.env-row:hover,
.env-row[aria-expanded='true'] {
  background: var(--surface-hover);
}

.env-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.lead {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: var(--icon-md);
  color: rgb(var(--text-3));
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.label.mono {
  font: var(--font-code-small);
}

.value {
  flex: none;
  color: rgb(var(--text-3));
  font-variant-numeric: tabular-nums;
}

.value[data-status='running'] {
  color: rgb(var(--text-2));
}

.caret {
  flex: none;
  color: rgb(var(--text-3));
  transition: transform var(--motion-fast) var(--ease-standard);
}

.caret[data-open] {
  transform: rotate(180deg);
}
</style>
