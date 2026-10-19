<script setup lang="ts">
/**
 * EmptyState — what a list or pane shows while it has nothing (DS-04).
 *   variant: block   (default) a 20px glyph, a 14/22 medium title, a 12/18
 *                    tertiary description and the actions, centred
 *            inline  one left-aligned line: title, description and an
 *                    optional trailing action (lists, rows, menus)
 *   framed:  a dashed frame (an empty settings list); inside a card the
 *            card is the frame, so it is dropped
 *
 * Props: title, description?, icon? (glyph component, drawn at 20px; 16px
 * inline), variant, framed.
 * Slots: `icon`, `description`, default (actions — Buttons / LinkButtons).
 */
import { computed, type Component } from 'vue'
import { useSurface } from './surface'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    icon?: Component
    variant?: 'block' | 'inline'
    framed?: boolean
  }>(),
  {
    description: undefined,
    icon: undefined,
    variant: 'block',
    framed: false,
  },
)

// Inside a card group the card is the frame: no dashed box of its own.
const surface = useSurface()
const inCard = computed(() => surface.value === 'card')
const shownFramed = computed(() => props.framed && !inCard.value)
</script>

<template>
  <div
    class="ds-empty-state"
    :data-variant="variant"
    :data-framed="shownFramed || undefined"
    :data-in-card="inCard || undefined"
  >
    <span v-if="$slots.icon || icon" class="icon" aria-hidden="true">
      <slot name="icon"
        ><component :is="icon" :size="variant === 'inline' ? 16 : 20"
      /></slot>
    </span>
    <div class="text">
      <span class="title">{{ title }}</span>
      <span v-if="$slots.description || description" class="description">
        <slot name="description">{{ description }}</slot>
      </span>
    </div>
    <div v-if="$slots.default" class="actions"><slot /></div>
  </div>
</template>

<style scoped>
.ds-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-6) var(--space-4);
  border-radius: var(--r-md);
  text-align: center;
}

.ds-empty-state[data-framed] {
  border: 1px dashed var(--stroke-3);
}

.ds-empty-state[data-in-card] {
  padding: var(--space-4);
}

.ds-empty-state[data-variant='inline'] {
  flex-direction: row;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  text-align: left;
}

.ds-empty-state[data-framed][data-variant='inline'] {
  padding: var(--space-3);
}

.ds-empty-state[data-in-card][data-variant='inline'] {
  padding: var(--space-3) var(--space-4);
}

.icon {
  display: inline-flex;
  flex: none;
  color: rgb(var(--text-3));
}

.text {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.ds-empty-state[data-variant='inline'] .text {
  display: block;
  flex: 1;
}

.title {
  color: rgb(var(--text-2));
  font: var(--weight-medium) var(--type-body-sm) var(--font-sans);
}

.description {
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  text-wrap: pretty;
}

.ds-empty-state[data-variant='inline'] .title {
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
}

.ds-empty-state[data-variant='inline'] .description {
  margin-left: var(--space-1-5);
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.ds-empty-state[data-variant='inline'] .actions {
  flex: none;
  margin-top: 0;
}
</style>
