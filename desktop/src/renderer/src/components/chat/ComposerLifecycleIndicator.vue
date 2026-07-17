<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { computed } from 'vue'
import { goalIcons } from '../../icons'

const props = defineProps<{
  kind: 'goal' | 'plan'
  busy: boolean
}>()

const emit = defineEmits<{ dismiss: [] }>()

const label = computed(() => (props.kind === 'goal' ? 'Goal' : 'Plan'))
const dismissLabel = computed(() =>
  props.kind === 'goal' ? '取消 Goal' : '退出 Plan',
)
const dismissTitle = computed(() =>
  props.busy ? '任务运行中，请先停止或暂停' : dismissLabel.value,
)
const mark = computed(() =>
  props.kind === 'goal' ? goalIcons.goal : goalIcons.plan,
)

function dismiss(): void {
  if (props.busy) return
  emit('dismiss')
}
</script>

<template>
  <span
    class="composer-lifecycle-indicator"
    :class="props.kind"
    :data-busy="props.busy"
    role="status"
  >
    <component :is="mark" :size="14" aria-hidden="true" />
    <span>{{ label }}</span>
    <button
      type="button"
      class="composer-lifecycle-dismiss"
      :aria-label="dismissLabel"
      :aria-disabled="props.busy"
      :title="dismissTitle"
      @click="dismiss"
    >
      <X :size="10" aria-hidden="true" />
    </button>
  </span>
</template>

<style scoped>
.composer-lifecycle-indicator {
  position: relative;
  display: inline-flex;
  min-height: 28px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  border-radius: 7px;
  padding: 0 8px;
  color: rgb(var(--fg-muted));
  font-size: 11px;
  font-weight: 620;
}

.composer-lifecycle-indicator.goal {
  background: rgb(var(--accent) / 0.11);
  color: rgb(var(--accent));
}

.composer-lifecycle-indicator.plan {
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
}

.composer-lifecycle-dismiss {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border: 1px solid rgb(var(--border-strong));
  border-radius: 999px;
  background: rgb(var(--bg-elevated));
  box-shadow: 0 3px 10px rgb(0 0 0 / 0.18);
  color: rgb(var(--fg-muted));
  opacity: 0;
  pointer-events: none;
  transform: scale(0.82);
  transition:
    opacity 120ms ease,
    transform 120ms ease,
    color 120ms ease,
    background 120ms ease;
}

.composer-lifecycle-indicator:hover .composer-lifecycle-dismiss,
.composer-lifecycle-indicator:focus-within .composer-lifecycle-dismiss {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
}

.composer-lifecycle-dismiss:hover:not([aria-disabled='true']) {
  background: rgb(var(--danger) / 0.12);
  color: rgb(var(--danger));
}

.composer-lifecycle-dismiss:focus-visible {
  outline: 2px solid rgb(var(--accent) / 0.7);
  outline-offset: 2px;
}

.composer-lifecycle-dismiss[aria-disabled='true'] {
  cursor: not-allowed;
  color: rgb(var(--fg-subtle));
}

.composer-lifecycle-indicator:hover
  .composer-lifecycle-dismiss[aria-disabled='true'],
.composer-lifecycle-indicator:focus-within
  .composer-lifecycle-dismiss[aria-disabled='true'] {
  opacity: 0.58;
}

@media (prefers-reduced-motion: reduce) {
  .composer-lifecycle-dismiss {
    transition: none;
  }
}
</style>
