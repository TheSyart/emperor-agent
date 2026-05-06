<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import ToolsPanel from '../components/panels/ToolsPanel.vue'
import { actionAssets } from '../assets'

const ctx = useAppContext()
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>工具权限 · Tools</h1>
        <p>当前注册的内建工具与 MCP 工具</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.refreshAll()">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <ToolsPanel :tools="ctx.boot.value?.tools || []" />
    </div>
  </section>
</template>
