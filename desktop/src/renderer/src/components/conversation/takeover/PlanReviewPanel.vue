<script setup lang="ts">
/**
 * PlanReviewPanel — dsh composer takeover for a waiting (non-provisional)
 * plan. Amber strip "计划待确认", the plan markdown scrolling in the body, and
 * a footer with an adjustment comment field plus the decision actions:
 * 继续规划 (sends the comment, enabled once it is non-empty) and 批准并执行.
 * Enter in the comment field sends it (Shift+Enter breaks a line); Esc
 * cancels the interaction.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ControlInteraction } from '../../../types'
import { useAppContext } from '../../../composables/useAppContext'
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import MarkdownBlock from '../../chat/MarkdownBlock.vue'
import { DsClose } from '../../icons/ds'
import {
  planDecisionVisible,
  planDisplayMarkdown,
} from '../../chat/planDisplay'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const comment = ref('')
const busy = ref(false)
const root = ref<HTMLElement | null>(null)

const visible = computed(() => planDecisionVisible(props.interaction))
const markdown = computed(() => planDisplayMarkdown(props.interaction))
const title = computed(() => String(props.interaction.title || '').trim())
const canComment = computed(() => !busy.value && Boolean(comment.value.trim()))

watch(
  () => props.interaction.id,
  () => {
    comment.value = ''
    busy.value = false
  },
)

onMounted(() => {
  void nextTick(() => root.value?.focus({ preventScroll: true }))
})

function settle(send: () => boolean) {
  if (busy.value) return
  busy.value = true
  const ok = send()
  busy.value = false
  if (ok) comment.value = ''
}

function approve() {
  settle(() => ctx.approvePlan(props.interaction.id))
}

function keepPlanning() {
  const text = comment.value.trim()
  if (!text) return
  settle(() => ctx.sendPlanComment(props.interaction.id, text))
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}

function onCommentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  keepPlanning()
}
</script>

<template>
  <div v-if="visible" class="frame" data-takeover="plan">
    <section
      ref="root"
      class="card"
      tabindex="-1"
      :aria-label="title || '计划待确认'"
      @keydown.esc.prevent="cancel"
    >
      <div class="strip">
        <span class="dot" aria-hidden="true" />
        <span class="strip-label">计划待确认</span>
        <IconButton label="忽略" round class="strip-close" @click="cancel">
          <DsClose :size="14" />
        </IconButton>
      </div>
      <div class="body">
        <MarkdownBlock
          v-if="markdown"
          :content="markdown"
          :source-message-id="interaction.id"
        />
        <p v-else class="empty">{{ title || '计划内容为空' }}</p>
      </div>
      <div class="footer">
        <textarea
          v-model="comment"
          class="comment"
          rows="1"
          placeholder="告诉 Emperor 如何调整…"
          aria-label="计划调整意见"
          @keydown="onCommentKeydown"
        />
        <div class="actions">
          <Button
            variant="outline"
            data-action="comment"
            :disabled="!canComment"
            @click="keepPlanning"
          >
            继续规划
          </Button>
          <Button
            variant="primary"
            data-action="approve"
            :disabled="busy"
            @click="approve"
          >
            批准并执行
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.frame {
  display: flex;
  justify-content: center;
  padding: var(--space-1-5) calc(var(--composer-side-clearance, 16px) + 16px)
    var(--space-2-5);
}

.card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  max-width: var(--chat-content-width, 748px);
  max-height: min(60vh, 520px);
  border: 1px solid rgb(var(--approval) / 0.45);
  border-radius: var(--radius-takeover);
  background: rgb(var(--input-major));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--label-primary));
  overflow: hidden;
  outline: none;
}

.strip {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-3) var(--space-1-5) var(--space-4);
  background: rgb(var(--approval-soft));
  color: rgb(var(--approval-line));
  font-size: var(--fs-xs);
  line-height: 18px;
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: rgb(var(--approval-line));
}

.strip-label {
  flex: 1;
  min-width: 0;
}

.strip .strip-close {
  width: 24px;
  height: 24px;
  color: rgb(var(--approval-line));
}

.body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-3) var(--space-4) var(--space-1);
  font-size: var(--fs-s);
  line-height: 22px;
}

.empty {
  margin: 0;
  color: rgb(var(--label-tertiary));
}

.footer {
  display: flex;
  align-items: flex-end;
  flex-shrink: 0;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4) var(--space-3);
}

.comment {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  min-height: 36px;
  max-height: 120px;
  padding: var(--space-1-5) var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: transparent;
  color: rgb(var(--label-primary));
  caret-color: rgb(var(--accent-fill));
  font: inherit;
  font-size: var(--fs-s);
  line-height: 22px;
  resize: none;
  outline: none;
  field-sizing: content;
}

.comment::placeholder {
  color: rgb(var(--label-caption));
}

.comment:focus {
  border-color: rgb(var(--accent-fill));
}

.actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: var(--space-2);
}

@media (max-width: 720px) {
  .body {
    padding: var(--space-2-5) var(--space-3) var(--space-1);
  }

  .footer {
    flex-wrap: wrap;
    padding: var(--space-2) var(--space-3) var(--space-2-5);
  }

  .actions {
    margin-left: auto;
  }
}
</style>
