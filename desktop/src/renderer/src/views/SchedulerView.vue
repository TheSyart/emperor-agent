<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import SchedulerPanel from '../components/panels/SchedulerPanel.vue'
import { actionIcons } from '../icons'

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
        <component :is="actionIcons.refresh" class="action-icon" :size="16" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <SchedulerPanel />
    </div>
  </section>
</template>
