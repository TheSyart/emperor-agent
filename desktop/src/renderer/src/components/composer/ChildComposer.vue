<script setup lang="ts">
/**
 * ChildComposer — the composer seat of a subagent's conversation (AGT-10):
 * 「给子智能体发消息」 goes to the child itself (a local subagent's next
 * turn, or Claude Code / Codex: straight in while it runs when it can be
 * steered, else after its turn); 停止 while it runs; below, the parent's
 * name. The way back is the page header (BUG-03), not links here.
 *
 * Props: parentTitle?, running?, stopping?, sending?, steer? (a running
 * child takes the message now), error? (the last send failed), closed?
 * (why it takes no message — it ended, the main conversation is archived),
 * canStop (hide 停止 when there is nothing to stop).
 * Emits: send(text) — the parent clears the draft by calling `clear()`
 * once Core accepted it — and stop.
 */
import { computed, ref } from 'vue'
import Button from '../ui/Button.vue'
import LinkButton from '../ui/LinkButton.vue'
import TextArea from '../ui/TextArea.vue'

const props = withDefaults(
  defineProps<{
    parentTitle?: string
    running?: boolean
    stopping?: boolean
    sending?: boolean
    steer?: boolean
    error?: string
    closed?: string
    canStop?: boolean
  }>(),
  {
    parentTitle: undefined,
    running: false,
    stopping: false,
    sending: false,
    steer: false,
    error: undefined,
    closed: undefined,
    canStop: true,
  },
)
const emit = defineEmits<{
  send: [text: string]
  stop: []
}>()

const draft = ref('')
const canSend = computed(
  () => !props.closed && !props.sending && draft.value.trim().length > 0,
)
const hint = computed(() => {
  if (!props.running) return '它会在下一轮读到这条消息'
  return props.steer
    ? '它正在运行，消息会直接插进去'
    : '它正在运行，消息会在这一轮结束后送达'
})

function submit() {
  if (!canSend.value) return
  emit('send', draft.value.trim())
}
function onKeydown(event: KeyboardEvent) {
  // Enter sends, Shift+Enter breaks the line; never while an IME composes.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

defineExpose({
  clear: () => {
    draft.value = ''
  },
})
</script>

<template>
  <div class="child-composer" data-child-composer>
    <div class="card" :data-closed="closed ? true : undefined">
      <TextArea
        v-model="draft"
        :min-rows="1"
        :max-rows="6"
        placeholder="给子智能体发消息"
        aria-label="给子智能体发消息"
        :disabled="!!closed"
        data-child-input
        @keydown="onKeydown"
      />
      <div class="controls">
        <span class="hint">{{ closed ?? hint }}</span>
        <Button
          v-if="running && canStop"
          size="sm"
          variant="ghost"
          data-stop-child
          :loading="stopping"
          @click="emit('stop')"
          >{{ stopping ? '正在停止…' : '停止' }}</Button
        >
        <Button
          size="sm"
          variant="primary"
          data-child-send
          :disabled="!canSend"
          :loading="sending"
          @click="submit"
          >发送</Button
        >
      </div>
    </div>
    <p v-if="error" class="error" role="alert" data-child-send-error>
      {{ error }}
    </p>
    <div class="links">
      <span v-if="parentTitle" class="parent"
        >父智能体：<strong>{{ parentTitle }}</strong></span
      >
    </div>
  </div>
</template>

<style scoped>
.child-composer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  box-sizing: border-box;
  width: calc(100% - 2 * var(--space-6));
  max-width: var(--composer-card-max);
  margin: 0 auto var(--space-5);
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3) var(--space-2);
  border-radius: var(--radius-card);
  background: rgb(var(--surface-raised));
  box-shadow: var(--elev-1);
}
.card :deep(textarea) {
  resize: none;
  border: none;
  background: transparent;
  padding: var(--space-1) var(--space-1);
  box-shadow: none;
}
.controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.hint {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
}
.error {
  margin: 0;
  font-size: var(--fs-xxs);
  color: rgb(var(--state-error-label));
}
.links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  font-size: var(--fs-xxs);
  color: rgb(var(--text-3));
}
.parent strong {
  color: rgb(var(--text-2));
  font-weight: var(--weight-medium);
}
</style>
