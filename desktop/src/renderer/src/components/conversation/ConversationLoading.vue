<script setup lang="ts">
import Spinner from '../ui/Spinner.vue'
</script>

<template>
  <div
    class="conversation-loading"
    role="status"
    aria-busy="true"
    aria-label="正在读取会话记录"
  >
    <div class="skeleton" aria-hidden="true">
      <div class="question shape" />
      <div class="answer">
        <div class="line shape" />
        <div class="line shape" />
        <div class="line shape" />
      </div>
    </div>
    <span class="label"><Spinner size="sm" />正在读取会话记录…</span>
  </div>
</template>

<style scoped>
.conversation-loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding-block: var(--space-6);
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.shape {
  background: var(--skeleton-bg);
  animation: conversation-loading-pulse 1.4s ease-in-out infinite alternate;
}
.question {
  width: 55%;
  height: calc(var(--space-8) + var(--space-2));
  margin-inline-start: auto;
  border-radius: var(--radius-card);
}
.answer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.line {
  height: var(--space-3);
  border-radius: var(--radius-pill);
}
.line:first-child {
  width: 82%;
}
.line:last-child {
  width: 58%;
}
.label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
@keyframes conversation-loading-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}
</style>
