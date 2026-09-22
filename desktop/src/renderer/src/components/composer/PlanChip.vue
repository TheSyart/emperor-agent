<script setup lang="ts">
/**
 * PlanChip — dsh PlanModeControl: while the composer lifecycle is Plan (amber)
 * or Goal capture (gold), a capsule "Plan ×" / "Goal ×" whose click exits the
 * mode (the existing dismissLifecycle flow). Renders nothing otherwise.
 */
import { computed } from 'vue'
import type { ComposerLifecycleMode } from '../../composables/composerLifecycle'
import { DsClose, DsGoal, DsPlan } from '../icons/ds'

const props = defineProps<{ mode: ComposerLifecycleMode; busy?: boolean }>()
const emit = defineEmits<{ dismiss: [] }>()

const label = computed(() => (props.mode === 'goal' ? 'Goal' : 'Plan'))
const dismissLabel = computed(() =>
  props.mode === 'goal' ? '取消 Goal' : '退出 Plan',
)
const title = computed(() =>
  props.busy ? '任务运行中，请先停止或暂停' : dismissLabel.value,
)

function dismiss(): void {
  if (props.busy) return
  emit('dismiss')
}
</script>

<template>
  <button
    v-if="mode"
    type="button"
    class="plan-chip"
    :data-kind="mode"
    :aria-label="dismissLabel"
    :aria-disabled="busy || undefined"
    :title="title"
    @click="dismiss"
  >
    <component
      :is="mode === 'goal' ? DsGoal : DsPlan"
      :size="14"
      aria-hidden="true"
    />
    <span>{{ label }}</span>
    <DsClose :size="12" class="close" aria-hidden="true" />
  </button>
</template>

<style scoped>
.plan-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  height: var(--space-6);
  padding: var(--space-0-5) var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--approval-soft));
  color: rgb(var(--approval-line));
  box-shadow: inset 0 0 0 1px rgb(var(--approval) / 0.3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  cursor: pointer;
}

.plan-chip:hover:not([aria-disabled]) {
  color: rgb(var(--approval-strong));
}

.plan-chip[data-kind='goal'] {
  background: rgb(var(--accent-soft));
  color: rgb(var(--accent-strong));
  box-shadow: inset 0 0 0 1px rgb(var(--accent-fill) / 0.3);
}

.plan-chip[aria-disabled] {
  opacity: 0.6;
  cursor: default;
}

.plan-chip:focus-visible {
  outline: 2px solid rgb(var(--approval-line));
  outline-offset: 2px;
}

.close {
  opacity: 0.8;
}
</style>
