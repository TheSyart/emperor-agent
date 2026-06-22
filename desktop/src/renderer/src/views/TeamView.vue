<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import TeamPanel from '../components/panels/TeamPanel.vue'
import { actionIcons } from '../icons'

const ctx = useAppContext()
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>队友协作 · Agent Team</h1>
        <p>Lead 调度，队友执行，Inbox 留痕</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.refreshAll()">
        <component :is="actionIcons.refresh" class="action-icon" :size="16" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <TeamPanel />
    </div>
  </section>
</template>
