<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import ModelPanel from '../components/panels/ModelPanel.vue'
import type { ModelConfigRaw } from '../types'

const ctx = useAppContext()

function onSave(config: ModelConfigRaw) {
  void ctx.runSafely(() => ctx.saveModelConfig(config))
}
</script>

<template>
  <section class="main-view view-readable">
    <header class="view-head">
      <div class="min-w-0">
        <h1>模型与厂家</h1>
        <p>多条目管理；激活的条目决定后续主 Agent / 子代理 / 压缩任务用哪份凭证</p>
      </div>
    </header>
    <div class="view-body">
      <ModelPanel
        :payload="ctx.boot.value?.modelConfig || null"
        @save="onSave"
        @error="ctx.showToast"
      />
    </div>
  </section>
</template>
