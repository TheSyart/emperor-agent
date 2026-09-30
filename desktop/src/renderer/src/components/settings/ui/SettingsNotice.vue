<script setup lang="ts">
/**
 * SettingsNotice — the callout a settings page shows while something needs
 * the user: a tinted card with an icon, a 13/20 semibold title saying what
 * is wrong, a 12/18 line saying what to do, and the buttons that fix it.
 * Pages put it first and only while the problem lasts; a page that is fine
 * shows none.
 *
 * Props:
 * - tone: 'warn' (default; something is missing) | 'error' (an action
 *   failed) | 'info' (a one-time note).
 * - title: what is wrong, in one line.
 * - description?: what to do (or the default slot).
 * Slots: default (description), `actions` (ui/Button size="sm").
 * warn / error announce as role=alert, info as role=status.
 */
import { computed } from 'vue'
import { DsShieldAlert, DsShieldCheck, DsWarning } from '../../icons/ds'

const props = withDefaults(
  defineProps<{
    tone?: 'warn' | 'error' | 'info'
    title: string
    description?: string
  }>(),
  { tone: 'warn', description: undefined },
)

const icon = computed(() =>
  props.tone === 'error'
    ? DsShieldAlert
    : props.tone === 'info'
      ? DsShieldCheck
      : DsWarning,
)
</script>

<template>
  <div
    class="ds-settings-notice"
    :data-tone="tone"
    :role="tone === 'info' ? 'status' : 'alert'"
  >
    <component :is="icon" class="icon" :size="18" aria-hidden="true" />
    <div class="body">
      <p class="title">{{ title }}</p>
      <div v-if="$slots.default || description" class="description">
        <slot>{{ description }}</slot>
      </div>
      <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
    </div>
  </div>
</template>

<style scoped>
.ds-settings-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  min-width: 0;
  padding: var(--space-3-5) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-card);
}

.ds-settings-notice[data-tone='warn'] {
  border-color: rgb(var(--state-warn) / 0.28);
  background: rgb(var(--state-warn-soft));
}

.ds-settings-notice[data-tone='error'] {
  border-color: rgb(var(--state-error) / 0.28);
  background: rgb(var(--state-error-soft));
}

.ds-settings-notice[data-tone='info'] {
  border-color: rgb(var(--accent-fill) / 0.35);
  background: rgb(var(--accent-soft));
}

.icon {
  flex: none;
  margin-top: 1px;
}

.ds-settings-notice[data-tone='warn'] .icon {
  color: rgb(var(--state-warn-label));
}

.ds-settings-notice[data-tone='error'] .icon {
  color: rgb(var(--state-error-label));
}

.ds-settings-notice[data-tone='info'] .icon {
  color: rgb(var(--accent-strong));
}

.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.title {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.description {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
