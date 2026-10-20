<script setup lang="ts">
/**
 * SettingsGroup — a titled block inside a SettingsSection: 13/20 semibold
 * subtitle + optional 12/18 tertiary description (outside the card), then
 * its content. A group that follows other content keeps a 20px gap.
 *
 * Props:
 * - title?: subtitle text.
 * - description?: one line under the subtitle.
 * - variant: 'rows' (default; the rows sit in one bordered card, 16px side
 *   padding and inset hairlines, the last row without one) | 'stack'
 *   (cards / tiles 8px apart, no card around them) | 'form' (Fields 16px
 *   apart).
 * - plain?: keep a 'rows' group flat (no card) — for content that brings
 *   its own frame.
 * - fill?: grow into the remaining height of a `fill` SettingsSection (the
 *   content becomes a flex column; give the editor `flex: 1`).
 * Slots: `title`, `description`, `actions` (right of the subtitle — small
 * Buttons / links scoped to the group), default (content).
 *
 * A card group provides the 'card' surface (ui/surface.ts): SettingsRow,
 * EmptyState and Select inside it switch to their card look by themselves.
 * Any other element placed directly in the card gets 12px / 16px margins.
 */
import { computed } from 'vue'
import { provideSurface } from '../../ui/surface'

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    variant?: 'rows' | 'stack' | 'form'
    plain?: boolean
    fill?: boolean
  }>(),
  {
    title: undefined,
    description: undefined,
    variant: 'rows',
    plain: false,
    fill: false,
  },
)

const card = computed(() => props.variant === 'rows' && !props.plain)
provideSurface(() => (card.value ? 'card' : 'panel'))
</script>

<template>
  <div
    class="ds-settings-group"
    :data-variant="variant"
    :data-card="card || undefined"
    :data-fill="fill || undefined"
  >
    <div
      v-if="$slots.title || title || $slots.description || description"
      class="head"
    >
      <div class="head-text">
        <h3 v-if="$slots.title || title" class="title">
          <slot name="title">{{ title }}</slot>
        </h3>
        <p v-if="$slots.description || description" class="description">
          <slot name="description">{{ description }}</slot>
        </p>
      </div>
      <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
    </div>
    <div class="content"><slot /></div>
  </div>
</template>

<style scoped>
.ds-settings-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ds-settings-group:not(:first-child) {
  margin-top: var(--space-5);
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  padding-top: var(--space-2);
}

.head-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.description {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  text-wrap: pretty;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
}

.content {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* Card: the title sits above it, the rows inside it. */
.ds-settings-group[data-card] > .head {
  padding-bottom: var(--space-2);
}

.ds-settings-group[data-card] > .content {
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-card);
  background: rgb(var(--settings-card-fill));
}

.ds-settings-group[data-card] > .content:empty {
  display: none;
}

/* Notes, lists and other custom blocks placed straight in the card. */
.ds-settings-group[data-card]
  > .content
  > :slotted(
    :not(.ds-settings-row, .ds-empty-state, .ds-settings-table, [hidden])
  ) {
  margin: var(--space-3) var(--space-4);
}

.ds-settings-group[data-fill],
.ds-settings-group[data-fill] .content {
  flex: 1 0 auto;
}

.ds-settings-group[data-variant='stack'] .content {
  gap: var(--space-2);
  padding-top: var(--space-3);
}

.ds-settings-group[data-variant='form'] .content {
  gap: var(--space-4);
  padding-top: var(--space-3);
}
</style>
