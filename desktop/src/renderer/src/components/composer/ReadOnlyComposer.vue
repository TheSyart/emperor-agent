<script setup lang="ts">
/**
 * ReadOnlyComposer — dsh SubagentReadOnlyComposer: a child (subagent)
 * session is inspected, never written to; the composer seat shows a quiet
 * frame pointing back to the parent conversation. While the child runs, a
 * stop button interrupts it (the parent's tool call then settles).
 *
 * Props: parentTitle?, running? (child turn open), stopping? (request sent).
 * Emits: back, stop.
 */
withDefaults(
  defineProps<{
    parentTitle?: string
    running?: boolean
    stopping?: boolean
  }>(),
  { parentTitle: undefined, running: false, stopping: false },
)
const emit = defineEmits<{ back: []; stop: [] }>()
</script>

<template>
  <div class="read-only-composer" role="note">
    <span class="copy"
      >这是子代理会话，只读。<template v-if="parentTitle"
        >在<strong>{{ parentTitle }}</strong
        >中继续对话。</template
      ></span
    >
    <button
      v-if="running"
      type="button"
      class="back stop"
      :disabled="stopping"
      @click="emit('stop')"
    >
      {{ stopping ? '正在停止…' : '停止子代理' }}
    </button>
    <button type="button" class="back" @click="emit('back')">返回父会话</button>
  </div>
</template>

<style scoped>
.read-only-composer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: calc(100% - 2 * var(--space-6));
  max-width: var(--composer-card-max);
  min-height: 54px;
  margin: 0 auto var(--space-5);
  padding: var(--space-2-5) var(--space-4);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

strong {
  margin: 0 var(--space-1);
  color: rgb(var(--label-primary));
  font-weight: 500;
}

.back {
  flex: none;
  height: var(--space-7);
  padding: 0 var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.back:hover {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.stop:hover:not(:disabled) {
  color: rgb(var(--danger));
}

.stop:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
