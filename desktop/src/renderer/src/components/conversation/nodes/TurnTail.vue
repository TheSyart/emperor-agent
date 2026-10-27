<script setup lang="ts">
/**
 * TurnTail — footer of a completed turn (dsh TurnTailNodeView): one row of
 * actions — copy of the final answer, the caption `14:05 · 用时 12 秒 · 首字
 * 0.8s · 34 tok/s` and the token count — that appears only while the
 * pointer is over the turn (UI-S03: never resident) or a control in it has
 * focus. The row keeps its height, so nothing moves when it appears.
 * Renders nothing when the turn left no text.
 *
 * In a single chat with a contact (GRP-05) the row also has 👍 / 👎 while
 * the contact's personal memory is on: either opens one line for why, and
 * 记下 hands the rating, the line and the reply's id to the chat
 * (`chatContext.feedback`, which writes `contacts.feedback`).
 */
import { computed, nextTick, ref } from 'vue'
import type { TurnTailChatNode } from '../../../conversation/types'
import { DsDislike, DsLike } from '../../icons/ds'
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import Popover from '../../ui/Popover.vue'
import TextField from '../../ui/TextField.vue'
import Tooltip from '../../ui/Tooltip.vue'
import { elementOf } from '../../ui/elementOf'
import { useChatContext } from '../chatContext'
import { formatTokens } from '../chatFormat'
import MessageIconActions from '../parts/MessageIconActions.vue'

const props = defineProps<{ node: TurnTailChatNode }>()
const data = computed(() => props.node.data)
const { hoverTurn, feedback } = useChatContext()
const revealed = computed(() => hoverTurn?.() === data.value.turn)
const usageLabel = computed(() => {
  const usage = data.value.usage
  const parts = [
    `输入 ${formatTokens(usage.inputTokens)}`,
    `输出 ${formatTokens(usage.outputTokens)}`,
  ]
  if (usage.cacheReadTokens > 0)
    parts.push(`缓存命中 ${formatTokens(usage.cacheReadTokens)}`)
  if (usage.reasoningTokens > 0)
    parts.push(`推理 ${formatTokens(usage.reasoningTokens)}`)
  parts.push(`${data.value.steps} 步`)
  return parts.join(' · ')
})

// ── 👍 / 👎 (GRP-05) ───────────────────────────────────────────────────
const rateable = computed(() => feedback?.enabled() === true)
/** Rated here just now; else what the chat recorded before. */
const ratedNow = ref<'up' | 'down' | null>(null)
const rated = computed(
  () => ratedNow.value ?? feedback?.rated(data.value.turn) ?? null,
)
const formOpen = ref(false)
const rating = ref<'up' | 'down'>('up')
const note = ref('')
const sending = ref(false)
const anchors: Record<'up' | 'down', HTMLElement | null> = {
  up: null,
  down: null,
}
const anchor = ref<HTMLElement | null>(null)
const noteField = ref<{ focus: () => void } | null>(null)

function openForm(next: 'up' | 'down') {
  rating.value = next
  note.value = ''
  anchor.value = anchors[next]
  formOpen.value = true
  void nextTick(() => noteField.value?.focus())
}

async function submit() {
  if (!feedback || sending.value) return
  sending.value = true
  try {
    const messageId = data.value.closingMessageId
    const done = await feedback.submit({
      turn: data.value.turn,
      rating: rating.value,
      note: note.value.trim(),
      ...(messageId ? { messageId } : {}),
    })
    if (done) {
      ratedNow.value = rating.value
      formOpen.value = false
    }
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div
    v-if="data.closingText !== null"
    class="turn-tail"
    :data-turn-tail="data.turn"
    :data-revealed="revealed || formOpen || undefined"
    data-time-hover-root
  >
    <MessageIconActions
      :text="data.closingText"
      :time="data.endedAt"
      :run-ms="data.durationMs"
      :ttft-ms="data.ttftMs"
      :tokens-per-second="data.tokensPerSecond"
      clock="end"
    >
      <template v-if="rateable">
        <IconButton
          :ref="(c) => (anchors.up = elementOf(c))"
          label="有帮助"
          side="bottom"
          :active="rated === 'up'"
          :aria-pressed="rated === 'up'"
          @click="openForm('up')"
        >
          <DsLike :size="16" />
        </IconButton>
        <IconButton
          :ref="(c) => (anchors.down = elementOf(c))"
          label="没帮助"
          side="bottom"
          :active="rated === 'down'"
          :aria-pressed="rated === 'down'"
          @click="openForm('down')"
        >
          <DsDislike :size="16" />
        </IconButton>
      </template>
      <Tooltip :label="usageLabel" side="bottom">
        <span class="usage" tabindex="0">{{
          formatTokens(data.usage.inputTokens + data.usage.outputTokens)
        }}</span>
      </Tooltip>
    </MessageIconActions>
    <Popover
      v-if="rateable"
      v-model:open="formOpen"
      :anchor="anchor"
      :label="rating === 'up' ? '这个回答有帮助' : '这个回答没帮助'"
      :width="300"
      align="start"
      data-feedback-form
    >
      <form class="feedback" @submit.prevent="submit">
        <span class="feedback-title">
          {{
            rating === 'up' ? '👍 有帮助' : '👎 没帮助'
          }}，说一句为什么（可以不写）
        </span>
        <TextField
          ref="noteField"
          v-model="note"
          size="sm"
          placeholder="比如：先给结论"
          aria-label="为什么"
        />
        <span class="feedback-hint"
          >会记进这个联系人的个人记忆，只对它生效</span
        >
        <span class="feedback-actions">
          <Button size="sm" @click="formOpen = false">取消</Button>
          <Button size="sm" variant="primary" type="submit" :loading="sending"
            >记下</Button
          >
        </span>
      </form>
    </Popover>
  </div>
</template>

<style scoped>
.turn-tail {
  display: flex;
  flex-direction: column;
  margin-left: calc(0px - var(--space-1-5));
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}

.turn-tail[data-revealed],
.turn-tail:hover,
.turn-tail:focus-within {
  opacity: 1;
}

.usage {
  display: inline-flex;
  align-items: center;
  height: var(--space-7);
  padding: 0 var(--space-1-5);
  border-radius: var(--r-sm);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-3));
  opacity: 0;
  transition: opacity var(--duration-instant) ease;
}

.turn-tail[data-revealed] .usage,
.turn-tail:hover .usage,
.turn-tail:focus-within .usage {
  opacity: 1;
}

.feedback {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.feedback-title {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-1));
}

.feedback-hint {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.feedback-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1-5);
}
</style>
