<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import TokensPanel from '../components/panels/TokensPanel.vue'
import { actionAssets } from '../assets'

const ctx = useAppContext()
</script>

<template>
  <section class="main-view view-readable">
    <header class="view-head">
      <div class="min-w-0">
        <h1>用量账本</h1>
        <p>按模型、用途、日期统计的 Token 消耗</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.runSafely(() => ctx.refreshMemory(true))">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body">
      <TokensPanel
        :memory="ctx.boot.value?.memory || null"
        @refresh="ctx.runSafely(() => ctx.refreshMemory(true))"
      />
    </div>
  </section>
</template>
