<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppContext } from '../composables/useAppContext'
import ConfigPanel from '../components/panels/ConfigPanel.vue'
import { actionAssets } from '../assets'

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()

watch(
  () => route.params.path,
  (raw) => {
    const path = Array.isArray(raw) ? raw.join('/') : raw
    if (!path) return
    if (ctx.activeConfig.value === path) return
    void ctx.runSafely(() => ctx.loadConfig(path))
  },
  { immediate: true },
)

function onLoad(path: string) {
  void router.push({ name: 'configs', params: { path } })
}

function onSave(content: string) {
  void ctx.runSafely(() => ctx.saveConfig(content))
}
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>工具与用户配置</h1>
        <p>当前可编辑：templates/TOOL.md、templates/USER.md</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.refreshAll()">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <ConfigPanel
        :configs="ctx.boot.value?.configs || []"
        :active-config="ctx.activeConfig.value"
        :content="ctx.configContent.value"
        @load="onLoad"
        @save="onSave"
      />
    </div>
  </section>
</template>
