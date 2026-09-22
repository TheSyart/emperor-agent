<script setup lang="ts">
/**
 * SettingsGroup — a titled block inside a SettingsSection: 13/20 semibold
 * subtitle + optional 12/18 tertiary description, then its content. A group
 * that follows other content keeps a 16px gap; the last SettingsRow in a
 * group drops its separator so the group ends clean.
 *
 * Props:
 * - title?: subtitle text.
 * - description?: one line under the subtitle.
 * - variant: 'rows' (default; SettingsRows stack flush, each with its own
 *   16px padding + hairline) | 'stack' (cards / tiles 8px apart) | 'form'
 *   (Fields 16px apart).
 * - fill?: grow into the remaining height of a `fill` SettingsSection (the
 *   content becomes a flex column; give the editor `flex: 1`).
 * Slots: `title`, `description`, `actions` (right of the subtitle — small
 * Buttons / links scoped to the group), default (content).
 */
withDefaults(
  defineProps<{
    title?: string
    description?: string
    variant?: 'rows' | 'stack' | 'form'
    fill?: boolean
  }>(),
  { title: undefined, description: undefined, variant: 'rows', fill: false },
)
</script>

<template>
  <div
    class="ds-settings-group"
    :data-variant="variant"
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
  margin-top: var(--space-4);
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
