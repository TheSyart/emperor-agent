<script setup lang="ts">
import { computed } from 'vue'
import { cloneJson } from '../api/http'
import { useAppContext } from '../composables/useAppContext'
import { useSession } from '../composables/useSession'
import { activeBottomControlPanel } from '../components/chat/bottomControlPanel'
import ActiveAskPanel from '../components/chat/ActiveAskPanel.vue'
import ActivePlanDecisionPanel from '../components/chat/ActivePlanDecisionPanel.vue'
import Composer from '../components/chat/Composer.vue'
import MessageList from '../components/chat/MessageList.vue'
import PendingBar from '../components/chat/PendingBar.vue'
import type { ModelConfigRaw } from '../types'

const ctx = useAppContext()
const sessionStore = useSession()
const modelEntries = computed(
  () => ctx.boot.value?.modelConfig?.config?.models || [],
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

function switchModel(entryName: string) {
  const payload = ctx.boot.value?.modelConfig
  if (!payload?.config || payload.current?.entryName === entryName) return
  const sourceConfig = payload.config
  void ctx.runSafely(async () => {
    const config = cloneJson<ModelConfigRaw>(sourceConfig)
    config.agents = {
      ...(config.agents || {}),
      defaults: {
        ...(config.agents?.defaults || {}),
        model: entryName,
      },
    }
    await ctx.saveModelConfig(config)
  })
}

function setReasoningEffort(level: string | null) {
  const payload = ctx.boot.value?.modelConfig
  const activeName = payload?.current?.entryName
  if (!payload?.config || !activeName) return
  const currentEntry = payload.config.models?.find(
    (entry) => entry.name === activeName,
  )
  const currentValue = normalizeReasoningEffort(
    payload.current?.reasoningEffort ?? currentEntry?.reasoningEffort,
  )
  const nextValue = normalizeReasoningEffort(level)
  if (currentValue === nextValue) return
  const sourceConfig = payload.config
  void ctx.runSafely(async () => {
    const config = cloneJson<ModelConfigRaw>(sourceConfig)
    const entry = config.models?.find(
      (candidate) => candidate.name === activeName,
    )
    if (!entry) return
    entry.reasoningEffort = nextValue || null
    await ctx.saveModelConfig(config)
  })
}

function normalizeReasoningEffort(value?: string | null) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === 'xhigh') return 'max'
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
            ctx.boot.value?.modelConfig?.current?.entryLabel ||
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
              ctx.boot.value?.modelConfig?.current?.supportsVision ?? false
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
