<script setup lang="ts">
/**
 * Toast — dsh transient notice: fixed, horizontally centered, contrast fill
 * (toast-bg / toast-fg), 14/22, lv3 shadow, auto-dismiss.
 *
 * Props:
 * - open (v-model:open).
 * - message: text.
 * - tone: 'info' | 'warn' | 'error' | 'ok' (leading glyph color).
 * - duration (default 2600 ms; 0 = sticky).
 * - inline?: render in flow instead of fixed (gallery / tests).
 */
import { onBeforeUnmount, watch } from 'vue'
import { DsCheck, DsWarning } from '../icons/ds'

const props = withDefaults(
  defineProps<{
    message: string
    tone?: 'info' | 'warn' | 'error' | 'ok'
    duration?: number
    inline?: boolean
  }>(),
  { tone: 'info', duration: 2600, inline: false },
)

const open = defineModel<boolean>('open', { default: false })
let timer: ReturnType<typeof setTimeout> | undefined

watch(
  () => [open.value, props.message] as const,
  ([value]) => {
    clearTimeout(timer)
    if (value && props.duration > 0)
      timer = setTimeout(() => {
        open.value = false
      }, props.duration)
  },
  { immediate: true },
)

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <div
      v-if="open"
      class="ds-toast"
      :data-inline="inline || undefined"
      :data-tone="tone"
      role="status"
      aria-live="polite"
    >
      <span v-if="tone !== 'info'" class="icon">
        <DsCheck v-if="tone === 'ok'" :size="16" />
        <DsWarning v-else :size="16" />
      </span>
      <span class="text">{{ message }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-toast {
  position: fixed;
  top: calc(var(--space-6) * 5);
  left: 50%;
  z-index: var(--z-lightbox);
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  max-width: min(560px, calc(100vw - var(--space-8) - var(--space-4)));
  padding: var(--space-3) var(--space-4);
  border-radius: calc(var(--radius-card) + 2px);
  background: rgb(var(--toast-bg));
  color: rgb(var(--toast-fg));
  font: var(--font-s);
  box-shadow: var(--shadow-lv3);
  pointer-events: none;
  transform: translateX(-50%);
  animation: ds-rise-in var(--duration-ds) var(--ease-in-out) both;
}

.ds-toast[data-inline] {
  position: relative;
  top: auto;
  left: auto;
  display: inline-flex;
  transform: none;
}

.icon {
  display: grid;
  flex: none;
  place-items: center;
}

[data-tone='warn'] .icon {
  color: rgb(var(--approval-line));
}

[data-tone='error'] .icon {
  color: rgb(var(--danger));
}

[data-tone='ok'] .icon {
  color: rgb(var(--ok));
}

.text {
  min-width: 0;
}
</style>
