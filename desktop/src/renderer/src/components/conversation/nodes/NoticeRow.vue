<script setup lang="ts">
/**
 * NoticeRow — dsh turn-positioned notice (TurnErrorItem): 10px state dot,
 * a 600-weight colored title, the secondary message, and an optional mono
 * code on the right. Shared by turn error / max-tokens / cost cap rows.
 *
 * Props: state ('error' | 'warn'), title, message, code?.
 */
import StateDot from '../../ui/StateDot.vue'

defineProps<{
  state: 'error' | 'warn'
  title: string
  message: string
  code?: string
}>()
</script>

<template>
  <div class="notice" role="status" :data-state="state">
    <StateDot :state="state" class="notice-dot" />
    <div class="copy">
      <span class="title">{{ title }}</span>
      <span class="message">{{ message }}</span>
      <slot />
    </div>
    <code v-if="code" class="code">{{ code }}</code>
  </div>
</template>

<style scoped>
.notice {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: start;
  padding: var(--space-0-5) 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.notice-dot {
  margin-top: calc(var(--space-1) + 1px);
}

.copy {
  min-width: 0;
  overflow-wrap: anywhere;
}

.title {
  margin-right: var(--space-1-5);
  font-weight: 600;
}

[data-state='error'] .title {
  color: rgb(var(--danger));
}

[data-state='warn'] .title {
  color: rgb(var(--warn));
}

.message {
  color: rgb(var(--label-secondary));
}

.code {
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
}
</style>
