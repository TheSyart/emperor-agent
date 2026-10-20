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
 *
 * Focus (useFocusTrap): opening moves focus to the first control in the
 * dialog (`data-autofocus` wins; the close button only when nothing else
 * can take it), Tab stays inside, the page behind is inert, and closing
 * returns focus to the element that opened it.
 */
import { ref } from 'vue'
import { DsClose } from '../icons/ds'
import IconButton from './IconButton.vue'
import { useModalLayer } from './modalStack'
import { provideSurface } from './surface'
import { useFocusTrap } from './useFocusTrap'

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
const overlay = ref<HTMLElement | null>(null)
const dialog = ref<HTMLElement | null>(null)

function close() {
  open.value = false
}

useModalLayer(open, () => {
  if (props.closable) close()
})
useFocusTrap(dialog, open, { layer: () => overlay.value })

// A dialog opened from a settings card is its own surface.
provideSurface(() => 'panel')
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="overlay" class="ds-modal">
      <div class="mask" @click="closeOnMask ? close() : undefined" />
      <div
        ref="dialog"
        class="dialog ds-fade-in"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        :style="{ width: `min(${width}px, 100%)` }"
      >
        <div class="header">
          <slot name="header">
            <h2 class="title">{{ title }}</h2>
          </slot>
          <IconButton
            v-if="closable"
            class="close"
            label="关闭"
            :tooltip="false"
            data-dismiss
            @click="close"
          >
            <DsClose :size="16" />
          </IconButton>
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
  background: var(--scrim);
  backdrop-filter: blur(var(--mask-blur));
}

.dialog {
  position: relative;
  outline: none;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  padding-bottom: var(--space-6);
  overflow: hidden;
  border: 1px solid var(--stroke-inverted);
  border-radius: var(--radius-modal);
  background: rgb(var(--surface-raised));
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
