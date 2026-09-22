<script setup lang="ts">
/**
 * Switch — dsh on/off toggle (38×22 pill; off = translucent neutral track
 * so it reads on white and dark panels alike, on = Emperor gold; 16px white
 * thumb slides 16px). role="switch" with
 * aria-checked; Space / Enter toggle (native button).
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
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: var(--interactive-bg-hover-strong);
  cursor: pointer;
  transition:
    background-color var(--duration-ds) ease,
    border-color var(--duration-ds) ease;
}

.ds-switch[data-on] {
  border-color: transparent;
  background: rgb(var(--accent-fill));
}

.ds-switch:disabled {
  opacity: 0.5;
  cursor: default;
}

.ds-switch:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: var(--space-4);
  height: var(--space-4);
  border-radius: var(--radius-pill);
  background: rgb(var(--nb-00));
  box-shadow: var(--shadow-lv1);
  transition: transform var(--duration-ds) var(--ease-in-out);
}

.ds-switch[data-on] .thumb {
  transform: translateX(var(--space-4));
}
</style>
