<script setup lang="ts">
/**
 * ApprovalPanel — dsh composer takeover for a pending permission ask
 * (`meta.interaction_type === 'permission'`). Amber strip, the reason as the
 * headline, each operation's command/summary in muted mono lines, and a
 * right-aligned action row derived from the permission question's options
 * (deny = danger, last allow = primary). The body scrolls; the action row
 * stays reachable. One-shot: buttons latch after a click until the
 * interaction resolves (re-armed if the send is rejected). Esc cancels.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ControlInteraction } from '../../../types'
import { useAppContext } from '../../../composables/useAppContext'
import Button from '../../ui/Button.vue'
import {
  approvalActions,
  approvalAnswer,
  approvalPresentation,
  riskLabel,
  type ApprovalAction,
} from './approvalModel'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const answered = ref(false)
const root = ref<HTMLElement | null>(null)

const presentation = computed(() => approvalPresentation(props.interaction))
const actions = computed(() => approvalActions(props.interaction))
const multiple = computed(() => presentation.value.operations.length > 1)

watch(
  () => props.interaction.id,
  () => {
    answered.value = false
  },
)

onMounted(() => {
  void nextTick(() => root.value?.focus({ preventScroll: true }))
})

function decide(action: ApprovalAction) {
  if (answered.value) return
  answered.value = true
  const ok = ctx.sendInteractionAnswer(
    props.interaction.id,
    approvalAnswer(props.interaction, action),
  )
  if (!ok) answered.value = false
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}
</script>

<template>
  <div class="frame" data-takeover="approval">
    <section
      ref="root"
      class="card"
      tabindex="-1"
      aria-label="需要你的授权"
      @keydown.esc.prevent="cancel"
    >
      <div class="strip">
        <span class="dot" aria-hidden="true" />
        <span>需要你的授权</span>
        <span v-if="presentation.count > 1" class="count"
          >· {{ presentation.count }} 项操作</span
        >
      </div>
      <div class="body" tabindex="0" role="group" aria-label="授权详情">
        <div class="headline">{{ presentation.headline }}</div>
        <div
          v-for="(operation, index) in presentation.operations"
          :key="index"
          class="operation"
        >
          <div class="meta">
            <template v-if="multiple">{{ index + 1 }}. </template
            >{{ operation.tool }} · {{ riskLabel(operation.risk) }}
          </div>
          <div
            v-if="
              multiple &&
              operation.reason &&
              operation.reason !== presentation.headline
            "
            class="reason"
          >
            {{ operation.reason }}
          </div>
          <div v-if="operation.summary" class="command">
            {{ operation.summary }}
          </div>
          <div v-if="operation.boundary" class="boundary">
            {{ operation.boundary }}
          </div>
        </div>
      </div>
      <div class="actions">
        <Button
          v-for="action in actions"
          :key="action.key"
          :variant="action.variant"
          :data-option-id="action.optionId || undefined"
          :title="action.description || undefined"
          :disabled="answered"
          @click="decide(action)"
        >
          {{ action.label }}
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
  padding: var(--space-2) calc(var(--composer-side-clearance, 16px) + 16px)
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

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  box-sizing: border-box;
  max-height: 336px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-3) var(--space-4) 0;
  outline: none;
}

.headline {
  color: rgb(var(--label-primary));
  font-size: calc(var(--fs-s) + 1px);
  font-weight: 500;
  line-height: 24px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.operation {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

.meta {
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: 20px;
}

.reason {
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: 22px;
  white-space: pre-wrap;
}

.command {
  color: rgb(var(--label-tertiary));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-all;
}

.boundary {
  color: rgb(var(--approval-line));
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
