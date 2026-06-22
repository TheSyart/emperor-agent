<script setup lang="ts">
import { useAppContext } from '../composables/useAppContext'
import MemoryPanel from '../components/panels/MemoryPanel.vue'
import { actionAssets } from '../assets'

const ctx = useAppContext()

function onSaveLongTerm(content: string) {
  void ctx.runSafely(() => ctx.saveMemory(content))
}

function onSaveEpisode(date: string, content: string) {
  void ctx.runSafely(() => ctx.saveEpisode(date, content))
}

function onSaveWatchlist(content: string) {
  void ctx.runSafely(() => ctx.saveWatchlist(content))
}

function onCheckWatchlist() {
  void ctx.runSafely(() => ctx.checkWatchlist().then(() => ctx.refreshMemory(false)))
}

function onRestoreVersion(id: string) {
  void ctx.runSafely(() => ctx.restoreMemoryVersion(id).then(() => ctx.refreshMemory(false)))
}
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>记忆层 · Memory</h1>
        <p>长期记忆与情景记忆的查看、编辑与管理</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.runSafely(() => ctx.refreshMemory(true))">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body">
      <MemoryPanel
        :memory="ctx.boot.value?.memory || null"
        :load-episode="ctx.loadEpisode"
        :load-version="ctx.loadMemoryVersion"
        @save-long-term="onSaveLongTerm"
        @save-episode="onSaveEpisode"
        @save-watchlist="onSaveWatchlist"
        @check-watchlist="onCheckWatchlist"
        @restore-version="onRestoreVersion"
        @refresh="ctx.runSafely(() => ctx.refreshMemory(true))"
      />
    </div>
  </section>
</template>
