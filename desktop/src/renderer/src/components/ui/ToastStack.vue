<script setup lang="ts">
/**
 * ToastStack — the on-screen part of the toast queue (toasts.ts), mounted
 * once in App.vue. Up to three toasts stack at the top centre on the
 * inverted toast fill; the rest wait. Info / ok / warn toasts leave after
 * 4 s; an error toast stays, announces itself (role="alert") and offers
 * 「复制详情」 (message, code, error id, time, stack) and a close button.
 * The stack is `data-overlay-keep`, so an open dialog does not make it
 * inert and an error raised from inside a dialog can still be copied.
 */
import { ref } from 'vue'
import { DsCheck, DsClose, DsWarning } from '../icons/ds'
import { writeClipboard } from './useCopyFeedback'
import { dismissToast, visibleToasts, type ToastItem } from './toasts'

const copiedId = ref<number | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyDetail(item: ToastItem): Promise<void> {
  if (!(await writeClipboard(item.detail ?? item.message))) return
  copiedId.value = item.id
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedId.value = null
  }, 1500)
}
</script>

<template>
  <Teleport to="body">
    <div class="ds-toast-stack" data-overlay-keep>
      <div
        v-for="item in visibleToasts"
        :key="item.id"
        class="ds-toast"
        :data-tone="item.tone"
        :data-sticky="item.sticky || undefined"
        :role="item.tone === 'error' ? 'alert' : 'status'"
        :aria-live="item.tone === 'error' ? 'assertive' : 'polite'"
      >
        <span v-if="item.tone !== 'info'" class="icon" aria-hidden="true">
          <DsCheck v-if="item.tone === 'ok'" :size="16" />
          <DsWarning v-else :size="16" />
        </span>
        <span class="text">{{ item.message }}</span>
        <template v-if="item.sticky">
          <button
            v-if="item.tone === 'error'"
            type="button"
            class="toast-action"
            @click="copyDetail(item)"
          >
            {{ copiedId === item.id ? '已复制' : '复制详情' }}
          </button>
          <button
            type="button"
            class="toast-close"
            aria-label="关闭"
            @click="dismissToast(item.id)"
          >
            <DsClose :size="14" />
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-toast-stack {
  position: fixed;
  top: calc(var(--space-6) * 5);
  left: 50%;
  z-index: var(--z-lightbox);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  width: min(560px, calc(100vw - var(--space-8) - var(--space-4)));
  pointer-events: none;
  transform: translateX(-50%);
}

.ds-toast {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  box-sizing: border-box;
  max-width: 100%;
  padding: var(--space-3) var(--space-4);
  border-radius: calc(var(--radius-card) + 2px);
  background: rgb(var(--toast-bg));
  color: rgb(var(--toast-fg));
  font: var(--font-s);
  box-shadow: var(--shadow-lv3);
  animation: ds-rise-in var(--duration-ds) var(--ease-in-out) both;
}

.ds-toast[data-sticky] {
  padding-right: var(--space-2);
  pointer-events: auto;
}

.icon {
  display: grid;
  flex: none;
  place-items: center;
}

[data-tone='warn'] .icon {
  color: rgb(var(--warn));
}

[data-tone='error'] .icon {
  color: rgb(var(--error));
}

[data-tone='ok'] .icon {
  color: rgb(var(--ok));
}

.text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.toast-action,
.toast-close {
  flex: none;
  border: none;
  background: transparent;
  color: rgb(var(--toast-fg));
  cursor: pointer;
}

.toast-action {
  height: var(--control-xs);
  padding: 0 var(--space-2);
  border-radius: var(--r-xs);
  font: var(--font-s);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.toast-close {
  display: inline-grid;
  place-items: center;
  width: var(--control-xs);
  height: var(--control-xs);
  padding: 0;
  border-radius: var(--r-xs);
  opacity: 0.7;
}

.toast-action:hover,
.toast-close:hover {
  background: rgb(var(--toast-fg) / 0.12);
  opacity: 1;
}

.toast-action:focus-visible,
.toast-close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.55);
}
</style>
