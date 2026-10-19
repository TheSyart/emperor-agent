<script setup lang="ts">
/**
 * Notice — a tinted bar saying something needs the user (DS-04): an icon,
 * a 13/20 semibold title, a 12/18 line saying what to do, and the buttons
 * that fix it. Show one while the problem lasts; a page that is fine shows
 * none.
 *   tone: neutral | info (a one-time note) | accent | ok | warn (default;
 *         something is missing) | error (an action failed) | attention
 * warn / error announce as role=alert, the others as role=status.
 *
 * Props: tone, title?, description? (or the default slot), icon? (a
 * registry name overriding the tone's glyph).
 * Slots: default (description), `actions` (Button size="sm").
 */
import { computed } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'error' | 'attention' | 'info'
    title?: string
    description?: string
    icon?: string
  }>(),
  { tone: 'warn', title: undefined, description: undefined, icon: undefined },
)

const TONE_ICONS: Record<string, string> = {
  neutral: 'info',
  accent: 'info',
  ok: 'circle-check',
  warn: 'warning',
  error: 'circle-alert',
  attention: 'warning',
  info: 'info',
}

const glyph = computed(() => props.icon ?? TONE_ICONS[props.tone]!)
</script>

<template>
  <div
    class="ds-notice"
    :data-tone="tone"
    :role="tone === 'warn' || tone === 'error' ? 'alert' : 'status'"
  >
    <Icon :name="glyph" size="md" class="icon" />
    <div class="body">
      <p v-if="title" class="title">{{ title }}</p>
      <div v-if="$slots.default || description" class="description">
        <slot>{{ description }}</slot>
      </div>
      <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
    </div>
  </div>
</template>

<style scoped>
.ds-notice {
  --notice-fill: var(--surface-raised);
  --notice-ink: var(--text-2);
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  min-width: 0;
  padding: var(--space-3) var(--space-3-5);
  border-radius: var(--r-md);
  background: rgb(var(--notice-fill));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
}

.ds-notice[data-tone='info'] {
  --notice-fill: var(--info-soft);
  --notice-ink: var(--info);
}

.ds-notice[data-tone='accent'] {
  --notice-fill: var(--accent-soft);
  --notice-ink: var(--text-link);
}

.ds-notice[data-tone='ok'] {
  --notice-fill: var(--ok-soft);
  --notice-ink: var(--state-ok-label);
}

.ds-notice[data-tone='warn'] {
  --notice-fill: var(--warn-soft);
  --notice-ink: var(--state-warn-label);
}

.ds-notice[data-tone='error'] {
  --notice-fill: var(--error-soft);
  --notice-ink: var(--state-error-label);
}

.ds-notice[data-tone='attention'] {
  --notice-fill: var(--attention-soft);
  --notice-ink: var(--attention);
}

.icon {
  flex: none;
  margin-top: 2px;
  color: rgb(var(--notice-ink));
}

.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title {
  margin: 0;
  color: rgb(var(--text-1));
  font: var(--weight-semibold) var(--type-footnote) var(--font-sans);
  overflow-wrap: anywhere;
}

.description {
  color: rgb(var(--text-2));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.title + .description {
  margin-top: 0;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
