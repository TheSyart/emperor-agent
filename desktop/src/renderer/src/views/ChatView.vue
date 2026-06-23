<script setup lang="ts">
import { computed } from 'vue'
import { cloneJson } from '../api/http'
import { useAppContext } from '../composables/useAppContext'
import Composer from '../components/chat/Composer.vue'
import MessageList from '../components/chat/MessageList.vue'
import PendingBar from '../components/chat/PendingBar.vue'
import type { ModelConfigRaw } from '../types'

const ctx = useAppContext()
const modelEntries = computed(() => ctx.boot.value?.modelConfig?.config?.models || [])
const currentModel = computed(() => ctx.boot.value?.modelConfig?.current || null)

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
  const currentEntry = payload.config.models?.find((entry) => entry.name === activeName)
  const currentValue = normalizeReasoningEffort(payload.current?.reasoningEffort ?? currentEntry?.reasoningEffort)
  const nextValue = normalizeReasoningEffort(level)
  if (currentValue === nextValue) return
  const sourceConfig = payload.config
  void ctx.runSafely(async () => {
    const config = cloneJson<ModelConfigRaw>(sourceConfig)
    const entry = config.models?.find((candidate) => candidate.name === activeName)
    if (!entry) return
    entry.reasoningEffort = nextValue || null
    await ctx.saveModelConfig(config)
  })
}

function normalizeReasoningEffort(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'xhigh') return 'max'
  return normalized
}
</script>

<template>
  <section class="main-view chat-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>对话</h1>
        <p class="truncate">{{ ctx.runtimeText() }} · {{ ctx.boot.value?.modelConfig?.current?.entryLabel || ctx.boot.value?.model || 'model' }}</p>
      </div>
    </header>

    <div class="chat-body">
      <MessageList :messages="ctx.messages.value" :plans="ctx.planProjection.plans" />

      <div class="chat-bottom-stack">
        <PendingBar :pending="ctx.pending" />
        <div class="composer-wrap">
          <Composer
            :busy="ctx.busy.value"
            :commands="ctx.commands.value"
            :context-used="ctx.boot.value?.context_used ?? 0"
            :context-max="ctx.boot.value?.modelConfig?.current?.contextWindowTokens ?? 0"
            :control-mode="ctx.boot.value?.control?.mode || 'ask_before_edit'"
            :current-model="currentModel"
            :model-entries="modelEntries"
            :supports-vision="ctx.boot.value?.modelConfig?.current?.supportsVision ?? false"
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
