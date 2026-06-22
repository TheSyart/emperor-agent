<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAppContext } from '../composables/useAppContext'
import { actionIcons } from '../icons'

const ctx = useAppContext()
const draft = ref('')
const petBusy = ref(false)
const desktopPet = computed(() => ctx.boot.value?.desktopPet)

watch(() => ctx.configContent.value, (content) => {
  draft.value = content
}, { immediate: true })

onMounted(() => {
  if (!ctx.configContent.value) {
    void ctx.runSafely(() => ctx.loadConfig())
  }
})

function save() {
  void ctx.runSafely(() => ctx.saveConfig(draft.value))
}

function toggleDesktopPet() {
  if (petBusy.value) return
  petBusy.value = true
  const next = !desktopPet.value?.enabled
  void ctx.runSafely(async () => {
    await ctx.setDesktopPetEnabled(next)
  }).finally(() => {
    petBusy.value = false
  })
}
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>配置文件</h1>
        <p>templates/USER.local.md — 用户偏好与档案</p>
      </div>
      <button class="tool-button asset-button refresh-action" title="刷新" @click="ctx.refreshAll()">
        <component :is="actionIcons.refresh" class="action-icon" :size="16" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <div class="panel-content split-panel compact-split">
        <div class="config-layout">
          <div class="editor flex-1">
            <div class="editor-title">templates/USER.local.md</div>
            <textarea v-model="draft" />
            <div class="editor-actions">
              <span class="status-pill">保存后刷新 Agent 上下文</span>
              <button class="tool-button ink asset-button primary-action" @click="save">
                <component :is="actionIcons.save" class="action-icon" :size="16" />
                <span>保存配置</span>
              </button>
            </div>
          </div>

          <aside class="desktop-pet-card">
            <div class="desktop-pet-head">
              <div>
                <h2>桌宠</h2>
                <p>Electron companion</p>
              </div>
              <span class="team-status-pill" :class="{ working: desktopPet?.running, error: desktopPet?.lastError }">
                {{ desktopPet?.running ? '运行中' : desktopPet?.enabled ? '待启动' : '已关闭' }}
              </span>
            </div>
            <div class="desktop-pet-preview">
              <img src="../../../../../assets/desktop-pet/clawd-tank/clawd-idle-living.svg" alt="" />
            </div>
            <div class="desktop-pet-meta">
              <span>
                <b>PID</b>
                {{ desktopPet?.pid || '-' }}
              </span>
              <span>
                <b>WebUI 启动</b>
                {{ desktopPet?.autoStartWithWebui ? '自动跟随' : '手动' }}
              </span>
            </div>
            <p v-if="desktopPet?.lastError" class="desktop-pet-error">
              {{ desktopPet.lastError }}
            </p>
            <code v-if="desktopPet?.lastError" class="desktop-pet-install">
              {{ desktopPet.installCommand }}
            </code>
            <button
              class="tool-button wide ink"
              :disabled="petBusy"
              @click="toggleDesktopPet"
            >
              {{ petBusy ? '处理中...' : desktopPet?.enabled ? '关闭桌宠' : '开启桌宠' }}
            </button>
          </aside>
        </div>
      </div>
    </div>
  </section>
</template>
