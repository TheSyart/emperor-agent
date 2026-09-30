<script setup lang="ts">
/**
 * EmptyState — the "nothing here yet" block for lists in settings: a dashed
 * l3 r12 frame (dsh modelEmpty / add slots) with an optional 20px glyph,
 * 14/22 medium secondary title, 12/18 tertiary description and actions.
 *
 * Props:
 * - title: the one-line statement (「暂无归档对话」).
 * - description?: what to do next.
 * - icon?: glyph component (rendered at 20px).
 * - variant: 'dashed' (default, framed) | 'plain' (no frame; inline lists).
 * - compact?: 12px padding, left-aligned single row (inside cards / groups).
 * Slots: `icon`, `description`, default (actions — Buttons).
 */
import { computed, type Component } from 'vue'
import { useSurface } from '../../ui/surface'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    icon?: Component
    variant?: 'dashed' | 'plain'
    compact?: boolean
  }>(),
  {
    description: undefined,
    icon: undefined,
    variant: 'dashed',
    compact: false,
  },
)

// Inside a card group the card is the frame: no dashed box of its own.
const surface = useSurface()
const inCard = computed(() => surface.value === 'card')
const shownVariant = computed(() => (inCard.value ? 'plain' : props.variant))
</script>

<template>
  <div
    class="ds-empty-state"
    :data-variant="shownVariant"
    :data-compact="compact || undefined"
    :data-in-card="inCard || undefined"
  >
    <span v-if="$slots.icon || icon" class="icon" aria-hidden="true">
      <slot name="icon"><component :is="icon" :size="20" /></slot>
    </span>
    <div class="text">
      <div class="title">{{ title }}</div>
      <div v-if="$slots.description || description" class="description">
        <slot name="description">{{ description }}</slot>
      </div>
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
  border: 1px dashed var(--border-l3);
  border-radius: var(--radius-card);
  text-align: center;
}

.ds-empty-state[data-variant='plain'] {
  border: none;
}

.ds-empty-state[data-compact] {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  text-align: left;
}

.ds-empty-state[data-compact][data-variant='plain'] {
  padding: var(--space-3) 0;
}

.ds-empty-state[data-in-card] {
  padding: var(--space-4);
}

.ds-empty-state[data-in-card][data-compact] {
  padding: var(--space-3) var(--space-4);
}

.icon {
  display: inline-flex;
  flex: none;
  color: rgb(var(--label-tertiary));
}

.text {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.ds-empty-state[data-compact] .text {
  flex: 1;
}

.title {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--label-secondary));
}

.ds-empty-state[data-compact] .title {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.description {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  text-wrap: pretty;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.ds-empty-state[data-compact] .actions {
  flex: none;
  margin-top: 0;
}
</style>
