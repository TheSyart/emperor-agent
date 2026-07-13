<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import ModelPanel from '../components/panels/ModelPanel.vue'
import type { ModelConfigRaw } from '../types'

const ctx = useAppContext()

function onSave(config: ModelConfigRaw) {
  void ctx.runSafely(() => ctx.saveModelConfig(config))
}

function onRefresh() {
  void ctx.runSafely(() => ctx.refreshAll())
}
</script>

<template>
  <section class="main-view view-readable model-settings-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>模型配置</h1>
        <p>管理服务商凭证与主、次模型</p>
      </div>
    </header>
    <div class="view-body">
      <ModelPanel
        :payload="ctx.boot.value?.modelConfig || null"
        @save="onSave"
        @error="ctx.showToast"
        @refresh="onRefresh"
      />
    </div>
  </section>
</template>
