<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import SchedulerPanel from '../components/panels/SchedulerPanel.vue'
import { actionAssets } from '../assets'

const ctx = useAppContext()
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>定时任务</h1>
        <p>本地定时任务、运行历史与自动化入口</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.refreshAll()">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <SchedulerPanel />
    </div>
  </section>
</template>
