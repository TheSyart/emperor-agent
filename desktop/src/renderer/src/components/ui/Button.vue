<script setup lang="ts">
/**
 * Button — dsh capsule button atom (36px / r18, 14/22; sm = 28px / r14,
 * 12/18). Variants: 'primary' (ink fill), 'accent' (gold fill), 'ghost'
 * (transparent, hover fill), 'outline' (l2 hairline capsule), 'danger'
 * (outline that turns red on hover).
 * Slots: `icon` (16px leading glyph), default (label).
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'accent' | 'ghost' | 'outline' | 'danger'
    size?: 'md' | 'sm'
    disabled?: boolean
    type?: 'button' | 'submit'
  }>(),
  { variant: 'ghost', size: 'md', disabled: false, type: 'button' },
)
</script>

<template>
  <button
    :type="type"
    class="ds-button"
    :data-variant="variant"
    :data-size="size"
    :disabled="disabled"
  >
    <span v-if="$slots.icon" class="icon"><slot name="icon" /></span>
    <slot />
  </button>
</template>

<style scoped>
.ds-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  flex: none;
  height: calc(var(--space-8) + var(--space-1));
  padding: 0 var(--space-3-5);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--duration-ds-fast) ease,
    color var(--duration-ds-fast) ease;
}

.ds-button[data-size='sm'] {
  height: var(--space-7);
  padding: 0 var(--space-2-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.ds-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ds-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.ds-button[data-variant='primary'] {
  background: rgb(var(--button-primary-fill));
  color: rgb(var(--button-primary-fg));
}

.ds-button[data-variant='primary']:hover:not(:disabled) {
  background: rgb(var(--button-primary-hover));
}

.ds-button[data-variant='accent'] {
  background: rgb(var(--accent-fill));
  color: rgb(var(--accent-fg));
}

.ds-button[data-variant='accent']:hover:not(:disabled) {
  background: rgb(var(--accent-hover));
}

.ds-button[data-variant='ghost']:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
}

.ds-button[data-variant='outline'],
.ds-button[data-variant='danger'] {
  border-color: var(--border-l2);
}

.ds-button[data-variant='outline']:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
}

.ds-button[data-variant='danger']:hover:not(:disabled) {
  border-color: transparent;
  background: var(--interactive-bg-hover-danger);
  color: rgb(var(--danger));
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
}
</style>
