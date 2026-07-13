<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAppContext } from '../composables/useAppContext'
import { actionIcons } from '../icons'

const ctx = useAppContext()
const draft = ref('')
const onboarding = computed(() => ctx.boot.value?.profileOnboarding)
const onboardingLabel = computed(() => {
  if (onboarding.value?.status === 'completed') return '已完成'
  if (onboarding.value?.status === 'in_progress') return '访谈进行中'
  if (onboarding.value?.status === 'skipped') return '已跳过'
  return '待补充'
})

watch(
  () => ctx.configContent.value,
  (content) => {
    draft.value = content
  },
  { immediate: true },
)

onMounted(() => {
  if (!ctx.configContent.value) {
    void ctx.runSafely(() => ctx.loadConfig())
  }
})

function save() {
  void ctx.runSafely(() => ctx.saveConfig(draft.value))
}
</script>

<template>
  <section class="main-view">
    <header class="view-head">
      <div class="min-w-0">
        <h1>配置文件</h1>
        <p>memory/profile/USER.local.md — 用户偏好与档案</p>
      </div>
      <button
        class="tool-button asset-button refresh-action"
        title="刷新"
        @click="ctx.refreshAll()"
      >
        <component :is="actionIcons.refresh" class="action-icon" :size="16" />
        <span>刷新</span>
      </button>
    </header>
    <div class="view-body view-body-fill">
      <div class="panel-content split-panel compact-split">
        <div class="config-layout">
          <div class="settings-row config-profile-status">
            <div>
              <strong>个人档案</strong>
              <span>活动文件：memory/profile/USER.local.md</span>
            </div>
            <div class="config-profile-actions">
              <span class="status-pill">{{ onboardingLabel }}</span>
              <button
                v-if="onboarding?.canStart"
                class="tool-button asset-button"
                type="button"
                @click="ctx.runSafely(() => ctx.startProfileInterview())"
              >
                {{ onboarding.status === 'skipped' ? '重新开始' : '开始访谈' }}
              </button>
            </div>
          </div>
          <div class="editor flex-1">
            <div class="editor-title">memory/profile/USER.local.md</div>
            <textarea v-model="draft" />
            <div class="editor-actions">
              <span class="status-pill">保存后刷新 Agent 上下文</span>
              <button
                class="tool-button ink asset-button primary-action"
                @click="save"
              >
                <component
                  :is="actionIcons.save"
                  class="action-icon"
                  :size="16"
                />
                <span>保存配置</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
