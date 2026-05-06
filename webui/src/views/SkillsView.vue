<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppContext } from '../composables/useAppContext'
import SkillsPanel from '../components/panels/SkillsPanel.vue'
import { actionAssets } from '../assets'

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()

watch(
  () => route.params.name,
  (raw) => {
    const name = Array.isArray(raw) ? raw[0] : raw
    if (!name) return
    if (ctx.activeSkill.value === name) return
    void ctx.runSafely(() => ctx.loadSkill(name))
  },
  { immediate: true },
)

function onLoad(name: string) {
  void router.push({ name: 'skills', params: { name } })
}

function onNew(name: string) {
  ctx.startNewSkill(name)
  void router.push({ name: 'skills', params: { name } })
}

function onSave(content: string) {
  void ctx.runSafely(() => ctx.saveSkill(content))
}
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>能力包 · Skills</h1>
        <p>查看与编辑当前 Agent 可加载的 SKILL.md</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.refreshAll()">
        <img class="action-icon" :src="actionAssets.refresh" alt="" width="26" height="26" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <SkillsPanel
        :skills="ctx.boot.value?.skills || []"
        :active-skill="ctx.activeSkill.value"
        :content="ctx.skillContent.value"
        @load="onLoad"
        @new="onNew"
        @save="onSave"
      />
    </div>
  </section>
</template>
