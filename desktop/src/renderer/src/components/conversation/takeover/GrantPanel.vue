<script setup lang="ts">
/**
 * GrantPanel — composer takeover for a Computer Use grant card
 * (`meta.interaction_type === 'computer_use_grant'`). Shows what the Agent
 * wants to do and exactly where (the full URL as plain text), warns on
 * high-impact actions and high-risk apps, labels the Agent's reason as
 * unverified, and lets the user pick one of the scopes Core offered.
 * One-shot like ApprovalPanel; Esc dismisses (Core records a denial).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ControlInteraction } from '../../../types'
import { useAppContext } from '../../../composables/useAppContext'
import Segmented from '../../settings/ui/Segmented.vue'
import Button from '../../ui/Button.vue'
import { GRANT_DENY, grantAnswer, grantPresentation } from './grantModel'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const answered = ref(false)
const root = ref<HTMLElement | null>(null)

const presentation = computed(() => grantPresentation(props.interaction))
const scope = ref(presentation.value.defaultScope)
const background = ref(false)

watch(
  () => props.interaction.id,
  () => {
    answered.value = false
    scope.value = presentation.value.defaultScope
    background.value = false
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
    grantAnswer(
      props.interaction,
      optionId,
      optionId !== GRANT_DENY && background.value,
    ),
  )
  if (!ok) answered.value = false
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}
</script>

<template>
  <div class="frame" data-takeover="grant">
    <section
      ref="root"
      class="card"
      tabindex="-1"
      aria-label="电脑操作授权"
      @keydown.esc.prevent="cancel"
    >
      <div class="strip">
        <span class="dot" aria-hidden="true" />
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
          页面中的另一个网站（例如付款或登录框），需要单独授权。
        </div>
        <div
          v-if="presentation.highImpact"
          class="warning"
          data-testid="grant-high-impact"
        >
          这可能是付款、删除、发送或发布等高影响操作，只能单次允许。请确认目标和内容无误。
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
        <div v-if="presentation.highRiskApp" class="warning">
          向终端或脚本类应用输入等于在命令沙箱之外执行命令，只能允许本次或本任务。
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
        <label v-if="presentation.backgroundOffered" class="background">
          <input v-model="background" type="checkbox" />
          <span>允许在我不在时（定时任务、目标轮次）继续</span>
        </label>
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
          variant="primary"
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
  gap: var(--space-2);
  padding: var(--space-2-5) var(--space-4);
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
  font-weight: 500;
  line-height: 24px;
}

.target {
  color: rgb(var(--label-secondary));
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
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
}

.input-value {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-xs);
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
  color: rgb(var(--label-secondary));
  font-size: var(--fs-s);
  line-height: 22px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.reason-label {
  color: rgb(var(--label-tertiary));
}

.scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.scope-label,
.background {
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: 20px;
}

.background {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: var(--space-1-5);
  cursor: pointer;
}

.background input {
  flex: none;
  width: auto;
  margin: 0;
  accent-color: rgb(var(--accent-primary, var(--approval-line)));
}

.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3-5) var(--space-4);
}
</style>
