<script setup lang="ts">
/**
 * 浏览器权限 (PLAN-CAP-001 RV-10) — 设置 › 电脑操作 › Chrome 和 Edge: what
 * Emperor may read from the user's own Chrome or Edge besides its tabs.
 *
 * - 历史记录: 始终询问 (default; a card before each search) / 始终允许 /
 *   从不 (the Agent is not offered the history tool at all). Saved at once
 *   through `computerUse.setExternalBrowserSettings`; a failed save says
 *   why and keeps the old choice.
 *
 * Several root nodes (the group and its error line): the page places them
 * straight into its SettingsSection.
 */
import type {
  ExternalBrowserSettings,
  ExternalHistoryAccess,
} from '@emperor/core/runtime-contract'
import { onMounted, ref, shallowRef } from 'vue'
import { core } from '../../../../api/http'
import { Select, SettingsGroup, SettingsRow, type SelectOption } from '../../ui'

const HISTORY: readonly SelectOption<ExternalHistoryAccess>[] = [
  { value: 'ask', label: '始终询问' },
  { value: 'allow', label: '始终允许' },
  { value: 'never', label: '从不' },
]

const settings = shallowRef<ExternalBrowserSettings | null>(null)
const saving = ref(false)
const error = ref('')

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function setHistory(value: ExternalHistoryAccess | undefined) {
  if (value === undefined || saving.value) return
  saving.value = true
  error.value = ''
  try {
    settings.value = await core('computerUse.setExternalBrowserSettings', {
      history: value,
    })
  } catch (cause) {
    error.value = message(cause)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    settings.value = await core('computerUse.externalBrowserSettings')
  } catch (cause) {
    error.value = message(cause)
  }
})
</script>

<template>
  <SettingsGroup title="浏览器权限" data-group="browser-permissions">
    <SettingsRow
      title="历史记录"
      description="Emperor 读取你的浏览历史前是否要你批准"
      label-for="external-history-access"
    >
      <Select
        id="external-history-access"
        size="sm"
        :model-value="settings?.history ?? 'ask'"
        :options="HISTORY"
        :disabled="settings === null || saving"
        @update:model-value="setHistory"
      />
    </SettingsRow>
  </SettingsGroup>
  <p v-if="error" class="browser-permissions-error" role="alert">
    {{ error }}
  </p>
</template>

<style scoped>
.browser-permissions-error {
  margin: var(--space-2) var(--space-0-5) 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
}
</style>
