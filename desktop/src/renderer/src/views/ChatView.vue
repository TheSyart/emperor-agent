<script setup lang="ts">
import { computed } from 'vue'
import {
  activateModelEntry,
  setModelReasoningEffort,
} from '../api/model'
import { useAppContext } from '../composables/useAppContext'
import { useSession } from '../composables/useSession'
import { activeBottomControlPanel } from '../components/chat/bottomControlPanel'
import ActiveAskPanel from '../components/chat/ActiveAskPanel.vue'
import ActivePlanDecisionPanel from '../components/chat/ActivePlanDecisionPanel.vue'
import Composer from '../components/chat/Composer.vue'
import MessageList from '../components/chat/MessageList.vue'
import PendingBar from '../components/chat/PendingBar.vue'
import type { ModelConfigPayload } from '../types'

const ctx = useAppContext()
const sessionStore = useSession()
const modelEntries = computed(
  () => ctx.boot.value?.modelConfig?.models || [],
)
const currentModel = computed(
  () => ctx.boot.value?.modelConfig?.current || null,
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

function applyModelConfig(payload: ModelConfigPayload): void {
  if (!ctx.boot.value) return
  ctx.boot.value.modelConfig = payload
  ctx.boot.value.model = payload.current?.modelId || ''
  ctx.boot.value.provider = payload.current?.provider || undefined
  ctx.boot.value.providerLabel = payload.current?.providerLabel || undefined
}

function switchModel(entryId: string) {
  const payload = ctx.boot.value?.modelConfig
  if (!payload || payload.current?.entryId === entryId) return
  void ctx.runSafely(async () => {
    applyModelConfig(await activateModelEntry(entryId))
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
    applyModelConfig(
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
            :busy="ctx.busy.value"
            :commands="ctx.commands.value"
            :tools="ctx.boot.value?.tools || []"
            :mcp-content="ctx.mcpContent.value"
            :context-used="ctx.boot.value?.context_used ?? 0"
            :context-max="
              ctx.boot.value?.modelConfig?.current?.contextWindowTokens ?? 0
            "
            :control-mode="ctx.boot.value?.control?.mode || 'ask_before_edit'"
            :current-model="currentModel"
            :model-entries="modelEntries"
            :supports-vision="
              ctx.boot.value?.modelConfig?.current?.capabilities?.vision ?? false
            "
            :send-blocked-reason="sendBlockedReason"
            @set-mode="ctx.setControlMode"
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
