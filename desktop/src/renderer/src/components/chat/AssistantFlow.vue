<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type {
  AssistantMessage,
  ControlInteraction,
  RuntimePlanRecord,
  ThoughtSegment,
  TurnChangeSnapshot,
} from '../../types'
import { actionIcons, avatarIcons, checkpointIcons } from '../../icons'
import { latestPlanForInteraction } from '../../runtime/handlers/plans'
import MarkdownBlock from './MarkdownBlock.vue'
import TurnChangesCard from './TurnChangesCard.vue'
import ToolGroup from './ToolGroup.vue'
import AskHistoryCard from './AskHistoryCard.vue'
import PlanCard from './PlanCard.vue'
import ThoughtEvent from './ThoughtEvent.vue'
import MediaBlock from './MediaBlock.vue'
import WebsiteCard from './WebsiteCard.vue'
import {
  assistantExecutionDuration,
  projectAssistantFlow,
} from './assistantFlowProjection'
import { durationLabel } from './toolDisplay'

const props = defineProps<{
  message: AssistantMessage
  plans?: RuntimePlanRecord[]
  turnChange?: TurnChangeSnapshot
}>()
const emit = defineEmits<{
  continueExecution: []
  openReview: [paths: string[]]
}>()
const copied = ref(false)
const flowClock = ref(Date.now())
let flowClockTimer: number | undefined

const messageText = computed(() => {
  return props.message.segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.content)
    .join('\n\n')
    .trim()
})

const flowBlocks = computed(() =>
  projectAssistantFlow(props.message, { now: flowClock.value }),
)

/** streaming 末尾的活体状态行:shimmer 动词 + 耗时 + 当前活动(无 token 数据,不展示) */
const liveStatus = computed(() => {
  if (!props.message.streaming) return null
  const elapsedMs = assistantExecutionDuration(props.message, flowClock.value)
  let activity = ''
  for (let index = flowBlocks.value.length - 1; index >= 0; index -= 1) {
    const block = flowBlocks.value[index]
    if (!block) continue
    if (block.kind === 'tool_group' && block.status === 'running') {
      activity = block.title
      break
    }
    if (block.kind === 'thought' && block.segment.status === 'running') {
      activity = block.segment.label || '思考中'
      break
    }
  }
  return {
    elapsed: durationLabel(elapsedMs),
    activity,
  }
})

const terminalLabel = computed(() => {
  if (!props.message.tombstoned) return ''
  if (props.message.terminalReason === 'interjected') return '已被插话替代'
  if (props.message.terminalReason === 'cancelled') return '已取消，内容未提交'
  if (props.message.terminalReason === 'model_failed')
    return '模型失败，内容未提交'
  return '内容已作废'
})

const finalTurnChange = computed<TurnChangeSnapshot | null>(() => {
  const snapshot = props.turnChange
  if (!snapshot || props.message.streaming || props.message.tombstoned)
    return null
  if (
    props.message.segments.some(
      (segment) => 'status' in segment && segment.status === 'error_aborted',
    )
  )
    return null
  return snapshot
})

const fallbackThought = computed<ThoughtSegment>(() => ({
  id: 'fallback-thought',
  type: 'thought',
  status: 'running',
  startedAt: Date.now(),
  label: '等待模型首字',
}))

function planForInteraction(interaction: ControlInteraction) {
  return latestPlanForInteraction(props.plans || [], interaction)
}

/** plan 活动节点的 tone 图标:running 旋转 / success 勾 / error 叹号 / neutral 圆点 */
function planActivityIcon(tone: 'running' | 'success' | 'error' | 'neutral') {
  if (tone === 'running') return checkpointIcons.loading
  if (tone === 'success') return checkpointIcons.ok
  if (tone === 'error') return actionIcons.statusError
  return actionIcons.statusOnline
}

async function copyMessage() {
  const text = messageText.value
  if (!text) return
  await navigator.clipboard?.writeText(text)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1400)
}

function stopFlowClock() {
  if (!flowClockTimer) return
  window.clearInterval(flowClockTimer)
  flowClockTimer = undefined
}

watch(
  () => props.message.streaming,
  (streaming) => {
    if (!streaming) {
      stopFlowClock()
      return
    }
    flowClock.value = Date.now()
    stopFlowClock()
    flowClockTimer = window.setInterval(() => {
      flowClock.value = Date.now()
    }, 500)
  },
  { immediate: true },
)

onBeforeUnmount(stopFlowClock)
</script>

<template>
  <article class="message-row assistant">
    <div class="flow-body timeline-flow">
      <div v-if="messageText" class="assistant-toolbar">
        <div class="message-meta assistant">
          <span aria-hidden="true">
            <component
              :is="avatarIcons.eunuch"
              class="assistant-mini-avatar"
              :size="16"
            />
          </span>
          <small>李 · 回奏</small>
        </div>
        <button class="copy-message-button" type="button" @click="copyMessage">
          <component :is="actionIcons.copy" class="action-icon" :size="14" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
      </div>
      <div v-else class="assistant-toolbar ghost">
        <div class="message-meta assistant">
          <span aria-hidden="true">
            <component
              :is="avatarIcons.eunuch"
              class="assistant-mini-avatar"
              :size="16"
            />
          </span>
          <small>李 · 候旨</small>
        </div>
      </div>

      <div
        class="assistant-timeline-shell"
        :class="{
          streaming: props.message.streaming,
          tombstoned: props.message.tombstoned,
        }"
      >
        <ThoughtEvent
          v-if="!flowBlocks.length && props.message.streaming"
          :segment="fallbackThought"
        />
        <template v-for="block in flowBlocks" :key="block.id">
          <ThoughtEvent
            v-if="block.kind === 'thought'"
            :segment="block.segment"
            :execution-duration-ms="block.executionDurationMs"
          />
          <div
            v-else-if="block.kind === 'text'"
            class="timeline-node text-node"
            :class="{ streaming: block.streaming }"
          >
            <MarkdownBlock
              :content="block.content"
              :source-message-id="props.message.id"
            />
          </div>
          <ToolGroup v-else-if="block.kind === 'tool_group'" :block="block" />
          <MediaBlock v-else-if="block.kind === 'media'" :items="block.items" />
          <WebsiteCard
            v-else-if="block.kind === 'website'"
            :preview-id="block.previewId"
            :title="block.title"
            :status="block.status"
          />
          <div
            v-else-if="block.kind === 'plan_activity'"
            class="timeline-node plan-activity-node"
            :data-tone="block.segment.tone"
          >
            <component
              :is="planActivityIcon(block.segment.tone)"
              :size="14"
              class="plan-activity-icon"
              aria-hidden="true"
            />
            <span class="plan-activity-label">{{ block.segment.label }}</span>
            <strong v-if="block.segment.detail">{{
              block.segment.detail
            }}</strong>
            <ul
              v-if="block.segment.nextActions?.length"
              class="plan-activity-actions"
            >
              <li v-for="action in block.segment.nextActions" :key="action">
                {{ action }}
              </li>
            </ul>
            <button
              v-if="block.segment.action === 'continue'"
              type="button"
              class="plan-activity-continue"
              @click="emit('continueExecution')"
            >
              继续执行
            </button>
          </div>
          <div
            v-else-if="block.kind === 'control' && block.segment.type === 'ask'"
            class="timeline-node control-node"
          >
            <AskHistoryCard :interaction="block.segment.interaction" />
          </div>
          <div
            v-else-if="
              block.kind === 'control' && block.segment.type === 'plan'
            "
            class="timeline-node control-node"
          >
            <PlanCard
              :interaction="block.segment.interaction"
              :plan="planForInteraction(block.segment.interaction)"
            />
          </div>
        </template>
        <div v-if="liveStatus" class="timeline-node run-status-node">
          <span class="run-status-verb shimmer-text">执行中…</span>
          <span v-if="liveStatus.elapsed" class="run-status-stats">{{
            liveStatus.elapsed
          }}</span>
          <span v-if="liveStatus.activity" class="run-status-activity">{{
            liveStatus.activity
          }}</span>
        </div>
        <div v-if="finalTurnChange" class="timeline-node changes-summary-node">
          <TurnChangesCard
            :snapshot="finalTurnChange"
            @open-review="emit('openReview', $event)"
          />
        </div>
      </div>
      <div v-if="terminalLabel" class="assistant-terminal-state" role="status">
        {{ terminalLabel }}
      </div>
    </div>
  </article>
</template>
