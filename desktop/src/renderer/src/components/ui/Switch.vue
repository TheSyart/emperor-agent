<script setup lang="ts">
/**
 * Switch — on/off toggle (DS-04: 38×22 pill; off = translucent neutral
 * track so it reads on white and dark panels alike, on = Emperor gold, one
 * of the few places gold is used; a 16px white thumb slides 16px).
 * role="switch" with aria-checked; Space / Enter toggle (native button);
 * focus draws --focus-ring.
 *
 * Props:
 * - modelValue (v-model): boolean.
 * - disabled?.
 * - ariaLabel?: accessible name when no visible label points here
 *   (SettingsRow `labelFor` + `id`, or aria-labelledby as an attribute).
 * - id?.
 * Emits: update:modelValue, change(value).
 */
const props = withDefaults(
  defineProps<{ disabled?: boolean; ariaLabel?: string; id?: string }>(),
  { disabled: false, ariaLabel: undefined, id: undefined },
)

const model = defineModel<boolean>({ default: false })
const emit = defineEmits<{ change: [value: boolean] }>()

function toggle() {
  if (props.disabled) return
  model.value = !model.value
  emit('change', model.value)
}
</script>

<template>
  <button
    :id="id"
    type="button"
    role="switch"
    class="ds-switch"
    :aria-checked="model"
    :aria-label="ariaLabel"
    :data-on="model || undefined"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="thumb" aria-hidden="true" />
  </button>
</template>

<style scoped>
.ds-switch {
  position: relative;
  flex: none;
  width: calc(var(--space-8) + var(--space-1-5));
  height: calc(var(--space-5) + 2px);
  padding: 0;
  border: none;
  border-radius: var(--r-full);
  outline: none;
  background: var(--surface-hover-strong);
  cursor: pointer;
  transition: background-color var(--motion-base) var(--ease-standard);
}

.ds-switch[data-on] {
  background: rgb(var(--accent));
}

.ds-switch:disabled {
  opacity: 0.5;
  cursor: default;
}

.ds-switch:focus-visible {
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.thumb {
  position: absolute;
  top: calc(var(--space-1) - 1px);
  left: calc(var(--space-1) - 1px);
  width: var(--space-4);
  height: var(--space-4);
  border-radius: var(--r-full);
  background: rgb(var(--switch-thumb));
  box-shadow: 0 1px 2px rgb(var(--shadow-color) / 0.2);
  transition: transform var(--motion-base) var(--ease-standard);
}

.ds-switch[data-on] .thumb {
  transform: translateX(var(--space-4));
}
</style>
