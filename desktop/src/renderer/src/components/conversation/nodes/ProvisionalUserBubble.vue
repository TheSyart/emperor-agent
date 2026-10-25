<script setup lang="ts">
/**
 * ProvisionalUserBubble — a message inserted into the running turn that its
 * log has not shown yet (BUG-07): the user bubble at once, with
 * 「等这一步结束后加入」 under it. The step under way finishes first; the
 * real bubble replaces this one when the next step takes the message.
 * Display only: no copy, edit or time (it is not in the log yet).
 *
 * Props: prompt (ProvisionalPrompt).
 */
import type { ProvisionalPrompt } from '../../../types'
import { DsClock } from '../../icons/ds'
import ReferencedText from '../parts/ReferencedText.vue'

defineProps<{ prompt: ProvisionalPrompt }>()
</script>

<template>
  <div class="provisional-row" data-provisional-prompt>
    <div class="user-bubble">
      <ReferencedText :text="prompt.content" :references="prompt.references" />
    </div>
    <span class="pending" role="status">
      <DsClock :size="12" aria-hidden="true" />等这一步结束后加入
    </span>
  </div>
</template>

<style scoped>
.provisional-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1-5);
}
/* The same bubble as UserBubble, with a faint outline while it waits. */
.user-bubble {
  max-width: 80%;
  padding: var(--space-2-5) var(--space-4);
  border-radius: var(--r-xl);
  background: rgb(var(--bubble-user));
  box-shadow: inset 0 0 0 1px var(--stroke-2);
  color: rgb(var(--text-1));
  font: var(--type-body) var(--font-sans);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pending {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}
</style>
