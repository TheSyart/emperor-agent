<script setup lang="ts">
/**
 * GrantPanel — composer takeover for a Computer Use grant card
 * (`meta.interaction_type === 'computer_use_grant'`). Shows what the Agent
 * wants to do and exactly where (the full URL as plain text), warns on
 * high-impact actions and high-risk apps, labels the Agent's reason as
 * unverified, and allows or refuses this one action (Core offers only
 * 「本次」: the AI drives continuously and only high-impact actions and
 * credential fills ask, 2026-09-29). A scope picker appears only if Core
 * ever offers more than one. One-shot like ApprovalPanel; Esc folds the
 * card, it never denies.
 */
import { foldOnEscape } from './takeoverModel'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ControlInteraction } from '../../../types'
import { useAppContext } from '../../../composables/useAppContext'
import Segmented from '../../ui/Segmented.vue'
import Button from '../../ui/Button.vue'
import Dot from '../../ui/Dot.vue'
import { GRANT_DENY, grantAnswer, grantPresentation } from './grantModel'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const answered = ref(false)
const root = ref<HTMLElement | null>(null)

const presentation = computed(() => grantPresentation(props.interaction))
const scope = ref(presentation.value.defaultScope)

watch(
  () => props.interaction.id,
  () => {
    answered.value = false
    scope.value = presentation.value.defaultScope
  },
)

onMounted(() => {
  void nextTick(() => root.value?.focus({ preventScroll: true }))
})

function send(optionId: string) {
  if (answered.value || optionId === '') return
  answered.value = true
  const ok = ctx.sendInteractionAnswer(
    props.interaction.id,
    grantAnswer(props.interaction, optionId, false),
  )
  if (!ok) answered.value = false
}
</script>

<template>
  <div class="frame" data-takeover="grant">
    <section
      ref="root"
      class="card"
      tabindex="-1"
      aria-label="电脑操作授权"
      @keydown="foldOnEscape($event, props.interaction.id)"
    >
      <div class="strip">
        <Dot state="attention" />
        <span>电脑操作授权</span>
        <span v-if="presentation.tool" class="tool"
          >· {{ presentation.tool }}</span
        >
      </div>
      <div class="body" tabindex="0" role="group" aria-label="授权详情">
        <div class="headline">{{ presentation.headline }}</div>
        <div class="target" data-testid="grant-target">
          {{ presentation.target }}
        </div>
        <div
          v-if="presentation.embeddedIn"
          class="reason"
          data-testid="grant-embedded-in"
        >
          这是嵌入在
          {{ presentation.embeddedIn }}
          页面中的另一个网站（例如付款或登录框）。
        </div>
        <div
          v-if="presentation.highImpact"
          class="warning"
          data-testid="grant-high-impact"
        >
          这可能是付款、删除、发送或发布等高影响操作，只允许这一次。请确认目标和内容无误。
        </div>
        <div v-if="presentation.input" class="input" data-testid="grant-input">
          <span class="input-label">{{
            presentation.input.kind === 'text' ? '将输入' : '将按下'
          }}</span>
          <pre class="input-value">{{ presentation.input.value }}</pre>
          <span
            v-if="presentation.input.submits"
            class="warning"
            data-testid="grant-input-submits"
            >含回车：命令或表单会立即执行、提交。</span
          >
        </div>
        <div v-if="presentation.reason" class="reason">
          <span class="reason-label">来自 Agent，未经验证：</span
          >{{ presentation.reason }}
        </div>
        <div v-if="presentation.scopes.length > 1" class="scope">
          <span class="scope-label">授权范围</span>
          <Segmented
            v-model="scope"
            :options="presentation.scopes"
            aria-label="授权范围"
          />
        </div>
      </div>
      <div class="actions">
        <Button
          variant="danger"
          data-option-id="deny"
          :disabled="answered"
          @click="send(GRANT_DENY)"
        >
          拒绝
        </Button>
        <Button
          variant="secondary"
          :data-option-id="scope"
          :disabled="answered || scope === ''"
          @click="send(scope)"
        >
          允许
        </Button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-2)
    calc(var(--composer-side-clearance, var(--space-4)) + var(--space-4))
    var(--space-3);
}

.card {
  width: 100%;
  max-width: var(--chat-content-width, 748px);
  border: 1px solid rgb(var(--attention) / 0.45);
  border-radius: var(--radius-takeover);
  background: rgb(var(--input-major));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--text-1));
  overflow: hidden;
  outline: none;
}

.strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2-5) var(--space-4);
  background: rgb(var(--attention-soft));
  color: rgb(var(--approval-line));
  font-size: var(--fs-xs);
  line-height: 18px;
}

.tool {
  font-family: var(--font-mono);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  box-sizing: border-box;
  max-height: 336px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-3) var(--space-4) 0;
  outline: none;
}

.headline {
  font-size: calc(var(--fs-s) + 1px);
  font-weight: var(--weight-medium);
  line-height: 24px;
}

.target {
  color: rgb(var(--text-2));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-all;
}

.input {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.input-label {
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}

.input-value {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--r-xs);
  background: rgb(var(--code-block-bg));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.warning {
  color: rgb(var(--approval-line));
  font-size: var(--fs-xs);
  line-height: 20px;
}

.reason {
  color: rgb(var(--text-2));
  font-size: var(--fs-s);
  line-height: 22px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.reason-label {
  color: rgb(var(--text-3));
}

.scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.scope-label {
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: 20px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3-5) var(--space-4);
}
</style>
