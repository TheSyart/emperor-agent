<script setup lang="ts">
/**
 * An upgrade in progress under its row (AGT-13): an indeterminate bar, and
 * with 查看过程 the command and its output as Core cleaned them (no
 * credentials, ~ for home). Also the 查看过程 of a failed upgrade.
 *
 * Props: log (lines), bar (show the bar), showLog, label (the bar's name:
 * 升级进度, or 退回进度 for a rollback).
 */
withDefaults(
  defineProps<{
    log: readonly string[]
    bar?: boolean
    showLog?: boolean
    label?: string
  }>(),
  { label: '升级进度' },
)
</script>

<template>
  <div class="upgrade-progress" data-upgrade-progress-area>
    <div
      v-if="bar"
      class="bar"
      role="progressbar"
      :aria-label="label"
      data-upgrade-progress
    >
      <span class="fill" />
    </div>
    <pre v-if="showLog" class="log" data-upgrade-log>{{ log.join('\n') }}</pre>
  </div>
</template>

<style scoped>
.upgrade-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.bar {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--surface-hover-strong);
}

.fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent));
  /* Reduced motion (a11y.css): one 1ms pass, then it rests at the start. */
  animation: upgrade-slide 1.4s ease-in-out infinite;
}

@keyframes upgrade-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(270%);
  }
}

.log {
  max-height: 160px;
  margin: 0;
  overflow: auto;
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-sunken));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  color: rgb(var(--text-2));
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
