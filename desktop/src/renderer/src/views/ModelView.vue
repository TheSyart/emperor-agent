<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import ModelPanel from '../components/panels/ModelPanel.vue'
import type { ModelConfigPayload } from '../types'

const ctx = useAppContext()

async function onUpdated(payload: ModelConfigPayload): Promise<void> {
  if (ctx.boot.value) {
    ctx.boot.value.modelConfig = payload
    ctx.boot.value.model = payload.current?.modelId || ''
    ctx.boot.value.provider = payload.current?.provider || undefined
    ctx.boot.value.providerLabel = payload.current?.providerLabel || undefined
    if (payload.profileOnboarding) {
      ctx.boot.value.profileOnboarding = payload.profileOnboarding.state
    }
  }
  if (payload.profileOnboarding?.started) {
    await ctx.openProfileInterviewSession(
      payload.profileOnboarding.state.sessionId,
    )
    return
  }
  ctx.showToast('模型配置已更新')
}
</script>

<template>
  <section class="main-view view-readable model-settings-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>模型</h1>
        <p>保存多个标准接口模型，全局只激活一个。</p>
      </div>
    </header>
    <div class="view-body">
      <ModelPanel
        :payload="ctx.boot.value?.modelConfig || null"
        @updated="onUpdated"
        @error="ctx.showToast"
      />
    </div>
  </section>
</template>
