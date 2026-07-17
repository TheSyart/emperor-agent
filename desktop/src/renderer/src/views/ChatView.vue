<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { activateModelEntry, setModelReasoningEffort } from '../api/model'
import { useAppContext } from '../composables/useAppContext'
import { useSession } from '../composables/useSession'
import { activeBottomControlPanel } from '../components/chat/bottomControlPanel'
import ActiveAskPanel from '../components/chat/ActiveAskPanel.vue'
import ActivePlanDecisionPanel from '../components/chat/ActivePlanDecisionPanel.vue'
import Composer from '../components/chat/Composer.vue'
import GoalStatusBar from '../components/chat/GoalStatusBar.vue'
import MessageList from '../components/chat/MessageList.vue'
import PendingBar from '../components/chat/PendingBar.vue'
import type { ModelConfigPayload } from '../types'
import { activeGoalForSession } from '../runtime/selectors'
import { isTerminalGoal, type GoalCardAction } from '../runtime/goalRender'

const ctx = useAppContext()
const sessionStore = useSession()
const modelEntries = computed(() => ctx.boot.value?.modelConfig?.models || [])
const currentModel = computed(
  () => ctx.boot.value?.modelConfig?.current || null,
)
const providerOptions = computed(
  () => ctx.boot.value?.modelConfig?.providerOptions || [],
)
const sendBlockedReason = computed(() => {
  const availability = ctx.boot.value?.modelConfig?.availability
  return availability?.usable === false
    ? availability.message || '还没有可用模型，请先配置模型。'
    : ''
})
const activeBottomControl = computed(() =>
  activeBottomControlPanel(
    ctx.boot.value?.control || null,
    sessionStore.active.value || null,
  ),
)
const showProfileOnboardingPrompt = computed(
  () =>
    ctx.boot.value?.profileOnboarding?.status === 'pending' &&
    !activeBottomControl.value,
)
const activeGoal = computed(() => {
  const projected = activeGoalForSession(
    ctx.goalProjection,
    ctx.sessionId.value,
  )
  if (projected) return projected
  const bootstrapActive = ctx.boot.value?.goals?.active
  return bootstrapActive?.sessionId === ctx.sessionId.value &&
    !ctx.goalProjection.byId[bootstrapActive.id]
    ? bootstrapActive
    : null
})
const goalMutationLocked = computed(() => {
  const goal = activeGoal.value
  return Boolean(
    goal &&
    !isTerminalGoal(goal) &&
    goal.phase !== 'paused' &&
    goal.phase !== 'awaiting_user',
  )
})
const composerBusy = computed(() => ctx.busy.value || goalMutationLocked.value)
const goalCaptureStatus = computed(() =>
  ctx.goalCaptureState.value.sessionId === ctx.sessionId.value
    ? ctx.goalCaptureState.value.status
    : 'idle',
)
const goalActionPending = ref<GoalCardAction | null>(null)
const goalReplacing = ref(false)
const goalReplaceError = ref('')
const goalReplacementDraft = ref('')

watch(
  () => activeGoal.value?.id,
  (goalId) => {
    if (!goalId) return
    goalReplaceError.value = ''
    goalReplacementDraft.value = ''
  },
)

async function runGoalStatusAction(action: GoalCardAction): Promise<void> {
  const goal = activeGoal.value
  if (!goal || goalActionPending.value || goalReplacing.value) return
  goalActionPending.value = action
  try {
    await ctx.runGoalAction(goal.id, action)
  } catch (error) {
    ctx.showToast(error instanceof Error ? error.message : String(error))
  } finally {
    goalActionPending.value = null
  }
}

function activateGoalCapture(): void {
  const result = ctx.armGoalCapture()
  if (!result.ok) ctx.showToast(result.error || 'Goal 待输入状态开启失败。')
}

async function startCapturedGoal(outcome: string): Promise<void> {
  try {
    await ctx.startCapturedGoal(outcome)
  } catch (error) {
    ctx.showToast(error instanceof Error ? error.message : String(error))
  }
}

async function cancelGoalMode(): Promise<void> {
  if (composerBusy.value) return
  if (goalCaptureStatus.value !== 'idle') {
    ctx.cancelGoalCapture()
    return
  }
  if (activeGoal.value) await runGoalStatusAction('cancel')
}

async function replaceGoal(outcome: string): Promise<void> {
  const goal = activeGoal.value
  if (!goal || goalReplacing.value || goalActionPending.value) return
  goalReplacing.value = true
  goalReplaceError.value = ''
  goalReplacementDraft.value = outcome
  try {
    await ctx.replaceGoal(goal.id, outcome)
    goalReplacementDraft.value = ''
  } catch (error) {
    goalReplaceError.value =
      error instanceof Error ? error.message : String(error)
  } finally {
    goalReplacing.value = false
  }
}

async function retryGoalReplacement(): Promise<void> {
  const outcome = goalReplacementDraft.value.trim()
  if (!outcome || goalReplacing.value) return
  goalReplacing.value = true
  try {
    await ctx.startGoal(outcome)
    goalReplaceError.value = ''
    goalReplacementDraft.value = ''
  } catch (error) {
    goalReplaceError.value =
      error instanceof Error ? error.message : String(error)
  } finally {
    goalReplacing.value = false
  }
}

function dismissGoalReplacementError(): void {
  if (goalReplacing.value) return
  goalReplaceError.value = ''
  goalReplacementDraft.value = ''
}

async function applyModelConfig(payload: ModelConfigPayload): Promise<void> {
  if (!ctx.boot.value) return
  ctx.boot.value.modelConfig = payload
  ctx.boot.value.model = payload.current?.modelId || ''
  ctx.boot.value.provider = payload.current?.provider || undefined
  ctx.boot.value.providerLabel = payload.current?.providerLabel || undefined
  if (payload.profileOnboarding) {
    ctx.boot.value.profileOnboarding = payload.profileOnboarding.state
  }
  if (payload.profileOnboarding?.started) {
    await ctx.openProfileInterviewSession(
      payload.profileOnboarding.state.sessionId,
    )
  }
}

function switchModel(entryId: string) {
  const payload = ctx.boot.value?.modelConfig
  if (!payload || payload.current?.entryId === entryId) return
  void ctx.runSafely(async () => {
    await applyModelConfig(await activateModelEntry(entryId))
  })
}

function setReasoningEffort(level: string | null) {
  const payload = ctx.boot.value?.modelConfig
  const activeId = payload?.current?.entryId
  if (!payload || !activeId) return
  const currentEntry = payload.models?.find(
    (entry) => entry.entryId === activeId,
  )
  const currentValue = normalizeReasoningEffort(
    payload.current?.reasoningEffort ?? currentEntry?.reasoningEffort,
  )
  const nextValue = normalizeReasoningEffort(level)
  if (currentValue === nextValue) return
  void ctx.runSafely(async () => {
    await applyModelConfig(
      await setModelReasoningEffort(activeId, nextValue || null),
    )
  })
}

function normalizeReasoningEffort(value?: string | null) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return normalized
}
</script>

<template>
  <section class="main-view chat-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>对话</h1>
        <p class="truncate">
          {{ ctx.runtimeText() }} ·
          {{
            ctx.boot.value?.modelConfig?.current?.displayName ||
            ctx.boot.value?.model ||
            'model'
          }}
        </p>
      </div>
    </header>

    <div class="chat-body">
      <MessageList
        :messages="ctx.messages.value"
        :plans="ctx.planProjection.plans"
      />

      <div class="chat-bottom-stack">
        <div
          v-if="showProfileOnboardingPrompt"
          class="profile-onboarding-banner"
          role="status"
        >
          <div>
            <strong>补充个人偏好</strong>
            <span>用一个简短访谈设置称呼、沟通方式和工作偏好。</span>
          </div>
          <div class="profile-onboarding-actions">
            <button type="button" @click="ctx.skipProfileInterview">
              不再提醒
            </button>
            <button
              type="button"
              class="primary"
              @click="ctx.startProfileInterview"
            >
              开始访谈
            </button>
          </div>
        </div>
        <GoalStatusBar
          v-if="activeGoal && !isTerminalGoal(activeGoal)"
          :goal="activeGoal"
          :action-pending="goalActionPending"
          :replacing="goalReplacing"
          :replace-error="goalReplaceError"
          @action="runGoalStatusAction"
          @edit="replaceGoal"
        />
        <form
          v-else-if="goalReplaceError && goalReplacementDraft"
          class="goal-replacement-recovery"
          @submit.prevent="retryGoalReplacement"
        >
          <div>
            <strong>Goal 替换未完成</strong>
            <span>{{ goalReplaceError }}</span>
          </div>
          <input
            v-model="goalReplacementDraft"
            aria-label="待重试的 Goal Outcome"
            maxlength="4000"
            :disabled="goalReplacing"
          />
          <button type="submit" :disabled="goalReplacing">
            {{ goalReplacing ? '创建中…' : '重新创建 Goal' }}
          </button>
          <button
            type="button"
            :disabled="goalReplacing"
            @click="dismissGoalReplacementError"
          >
            关闭
          </button>
        </form>
        <ActiveAskPanel
          v-if="activeBottomControl?.kind === 'ask'"
          :interaction="activeBottomControl.interaction"
        />
        <ActivePlanDecisionPanel
          v-else-if="activeBottomControl?.kind === 'plan'"
          :interaction="activeBottomControl.interaction"
        />
        <PendingBar v-if="!activeBottomControl" :pending="ctx.pending" />
        <div v-if="!activeBottomControl" class="composer-wrap">
          <Composer
            :busy="composerBusy"
            :goal="activeGoal"
            :goal-capture-status="goalCaptureStatus"
            :commands="ctx.commands.value"
            :tools="ctx.boot.value?.tools || []"
            :mcp-content="ctx.mcpContent.value"
            :context-used="ctx.boot.value?.context_used ?? 0"
            :context-max="
              ctx.boot.value?.modelConfig?.current?.contextWindowTokens ?? 0
            "
            :control="ctx.boot.value?.control || null"
            :current-model="currentModel"
            :model-entries="modelEntries"
            :provider-options="providerOptions"
            :supports-vision="
              ctx.boot.value?.modelConfig?.current?.capabilities?.vision ??
              false
            "
            :send-blocked-reason="sendBlockedReason"
            @set-permission="ctx.setPermissionMode"
            @activate-plan="ctx.setPlanEnabled(true)"
            @activate-goal="activateGoalCapture"
            @exit-plan="ctx.setPlanEnabled(false)"
            @cancel-goal="cancelGoalMode"
            @start-goal="startCapturedGoal"
            @switch-model="switchModel"
            @set-reasoning-effort="setReasoningEffort"
            @send="ctx.submitFromComposer($event)"
            @stop="ctx.stopActive"
            @error="ctx.showToast"
          />
        </div>
      </div>
    </div>
  </section>
</template>
