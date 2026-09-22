<script setup lang="ts">
/**
 * Modal — dsh dialog chrome: mask (mask-1 + 2px blur), radius 24, layer-2
 * surface, lv3 shadow, 16/24 medium title, 28px close button.
 *
 * Props:
 * - open (v-model:open).
 * - title?: header title; description?: 14/22 lead text.
 * - width (default 380): dialog width in px (settings uses 800).
 * - closable (default true): show close button + Esc to close.
 * - closeOnMask (default true).
 * Slots: default (body), `footer` (right-aligned actions), `header`
 * (replaces the title row).
 *
 * Escape goes through the shared modal stack (modalStack.ts): only the
 * topmost open layer reacts, so a Modal opened from inside the settings
 * modal closes by itself. A non-closable top Modal swallows Escape.
 */
import { DsClose } from '../icons/ds'
import { useModalLayer } from './modalStack'

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    width?: number
    closable?: boolean
    closeOnMask?: boolean
  }>(),
  {
    title: undefined,
    description: undefined,
    width: 380,
    closable: true,
    closeOnMask: true,
  },
)

const open = defineModel<boolean>('open', { default: false })

function close() {
  open.value = false
}

useModalLayer(open, () => {
  if (props.closable) close()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ds-modal">
      <div class="mask" @click="closeOnMask ? close() : undefined" />
      <div
        class="dialog ds-fade-in"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :style="{ width: `min(${width}px, 100%)` }"
      >
        <div class="header">
          <slot name="header">
            <h2 class="title">{{ title }}</h2>
          </slot>
          <button
            v-if="closable"
            type="button"
            class="close"
            aria-label="关闭"
            @click="close"
          >
            <DsClose :size="16" />
          </button>
        </div>
        <p v-if="description" class="description">{{ description }}</p>
        <div v-if="$slots.default" class="body"><slot /></div>
        <div v-if="$slots.footer" class="footer"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
}

.mask {
  position: absolute;
  inset: 0;
  background: var(--mask-1);
  backdrop-filter: blur(var(--mask-blur));
}

.dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  padding-bottom: var(--space-6);
  overflow: hidden;
  border: 1px solid var(--border-inverted);
  border-radius: var(--radius-modal);
  background: rgb(var(--bg-layer-2));
  box-shadow: var(--shadow-lv3);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: calc(var(--space-5) + 2px) var(--space-3-5) var(--space-3)
    var(--space-6);
}

.title {
  margin: 0;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.close {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.close:hover {
  background: var(--interactive-bg-hover);
}

.description {
  margin: 0;
  padding: 0 var(--space-6);
  font: var(--font-s);
  color: rgb(var(--label-primary));
}

.body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  margin-top: var(--space-5);
  padding: 0 var(--space-6);
  overflow-y: auto;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-5);
  padding: 0 var(--space-6);
}
</style>
