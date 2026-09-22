<script setup lang="ts">
/**
 * Settings › 配置 — the private user profile (memory/profile/USER.local.md):
 * a status row (profile onboarding state + 开始访谈 / 重新开始 when the
 * profileOnboarding state allows it) over the full-width Markdown editor
 * that fills the remaining height, with one bottom action row (还原 /
 * 保存配置; ⌘S saves). Saving refreshes the Agent context. The header
 * refresh reloads the workbench and the file.
 */
import { computed, onMounted, ref, watch } from 'vue'
import Button from '../ui/Button.vue'
import {
  CodeEditor,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  StatusBadge,
} from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { useAppContext } from '../../composables/useAppContext'

const PROFILE_PATH = 'memory/profile/USER.local.md'

const ctx = useAppContext()
const draft = ref('')
const saving = ref(false)

const onboarding = computed(() => ctx.boot.value?.profileOnboarding)
const onboardingStatus = computed(() => {
  const status = onboarding.value?.status
  if (status === 'completed') return { tone: 'ok' as const, text: '已完成' }
  if (status === 'in_progress')
    return { tone: 'accent' as const, text: '访谈进行中' }
  if (status === 'skipped') return { tone: 'neutral' as const, text: '已跳过' }
  return { tone: 'warn' as const, text: '待补充' }
})
const dirty = computed(() => draft.value !== ctx.configContent.value)

watch(
  () => ctx.configContent.value,
  (content) => {
    draft.value = content
  },
  { immediate: true },
)

onMounted(() => {
  if (!ctx.configContent.value) void ctx.runSafely(() => ctx.loadConfig())
})

useSettingsHeader({
  actions: () => [
    refreshAction(
      () =>
        ctx.runSafely(async () => {
          await ctx.refreshAll()
          await ctx.loadConfig()
        }),
      { title: '刷新配置' },
    ),
  ],
})

function startInterview() {
  void ctx.runSafely(() => ctx.startProfileInterview())
}

function revert() {
  draft.value = ctx.configContent.value
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    await ctx.runSafely(() => ctx.saveConfig(draft.value))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSection fill>
    <SettingsRow
      title="个人档案"
      :description="`活动文件：${PROFILE_PATH}`"
      data-testid="profile-status"
    >
      <StatusBadge :tone="onboardingStatus.tone" dot>
        {{ onboardingStatus.text }}
      </StatusBadge>
      <Button
        v-if="onboarding?.canStart"
        size="sm"
        variant="outline"
        @click="startInterview"
      >
        {{ onboarding.status === 'skipped' ? '重新开始' : '开始访谈' }}
      </Button>
    </SettingsRow>

    <SettingsGroup
      title="USER.local.md"
      description="用户偏好与档案，保存后刷新 Agent 上下文"
      fill
    >
      <template #actions>
        <StatusBadge v-if="dirty" tone="warn" dot>未保存</StatusBadge>
      </template>
      <div class="editor-block">
        <CodeEditor
          v-model="draft"
          language="markdown"
          :aria-label="PROFILE_PATH"
          wrap
          fill
          :min-lines="16"
          @save="save"
        />
        <div class="action-row">
          <Button
            size="sm"
            variant="outline"
            :disabled="saving || !dirty"
            @click="revert"
          >
            还原
          </Button>
          <Button size="sm" variant="primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存配置' }}
          </Button>
        </div>
      </div>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
.editor-block {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding-top: var(--space-3);
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
