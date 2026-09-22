<script setup lang="ts">
/**
 * Field — label + control + hint / error (dsh plugin fields: 13/20 medium
 * label, 6px gaps, 12/18 tertiary hint; the error replaces the hint in the
 * error label color). Provides the control id and aria wiring to the
 * TextField / TextArea / CodeEditor / Select / SearchField inside it, so
 * `<Field label="URL"><TextField v-model="url" /></Field>` is fully labelled.
 *
 * Props:
 * - label?: visible label (or the `label` slot).
 * - hint?: help text under the control.
 * - error?: validation message; marks the control invalid.
 * - badge?: small neutral badge after the label (e.g. 「已覆盖」).
 * - required?: appends a tertiary「必填」marker.
 * - id?: control id to use (default: generated).
 * Slots: `label`, `badge` (replaces the badge prop, e.g. a reset link),
 * `hint`, default (the control).
 */
import { computed, provide, useSlots } from 'vue'
import StatusBadge from './StatusBadge.vue'
import { FIELD_CONTEXT, settingsId } from './fieldContext'

const props = withDefaults(
  defineProps<{
    label?: string
    hint?: string
    error?: string
    badge?: string
    required?: boolean
    id?: string
  }>(),
  {
    label: undefined,
    hint: undefined,
    error: undefined,
    badge: undefined,
    required: false,
    id: undefined,
  },
)

const slots = useSlots()
const generated = settingsId('ds-settings-field')
const controlId = computed(() => props.id ?? generated)
const hintId = computed(() => `${controlId.value}-hint`)
const hasHint = computed(() => Boolean(props.error || props.hint || slots.hint))

provide(FIELD_CONTEXT, {
  controlId,
  describedBy: computed(() => (hasHint.value ? hintId.value : undefined)),
  invalid: computed(() => Boolean(props.error)),
})
</script>

<template>
  <div class="ds-settings-field" :data-invalid="error ? true : undefined">
    <div v-if="$slots.label || label || $slots.badge || badge" class="head">
      <label v-if="$slots.label || label" class="label" :for="controlId">
        <slot name="label">{{ label }}</slot>
        <span v-if="required" class="required">必填</span>
      </label>
      <span v-if="$slots.badge || badge" class="badges">
        <slot name="badge">
          <StatusBadge tone="neutral">{{ badge }}</StatusBadge>
        </slot>
      </span>
    </div>
    <slot />
    <p
      v-if="hasHint"
      :id="hintId"
      class="hint"
      :role="error ? 'alert' : undefined"
    >
      <template v-if="error">{{ error }}</template>
      <slot v-else name="hint">{{ hint }}</slot>
    </p>
  </div>
</template>

<style scoped>
.ds-settings-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.required {
  margin-left: var(--space-1-5);
  font-size: var(--fs-xxs);
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.badges {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
}

.hint {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.ds-settings-field[data-invalid] .hint {
  color: rgb(var(--state-error-label));
}
</style>
