<script setup lang="ts">
/**
 * 浏览器权限 (PLAN-CAP-001 RV-10) — 设置 › 电脑操作 › Chrome 和 Edge: what
 * Emperor may read from the user's own Chrome or Edge besides its tabs.
 *
 * - 历史记录: 始终询问 (default; a card before each search) / 始终允许 /
 *   从不 (the Agent is not offered the history tool at all).
 * - 启用站点工具 (WebMCP, RV-11): while today's browsers do not offer it
 *   (`siteToolsAvailable` false) the row says 不可用 and why, and the switch
 *   stays off and disabled — no make-believe switch.
 *
 * Changes are saved at once through `computerUse.setExternalBrowserSettings`;
 * a failed save says why and keeps the old choice.
 *
 * Several root nodes (the group and its error line): the page places them
 * straight into its SettingsSection.
 */
import type {
  ExternalBrowserSettingsView,
  ExternalHistoryAccess,
} from '@emperor/core/runtime-contract'
import { computed, onMounted, ref, shallowRef } from 'vue'
import { core } from '../../../../api/http'
import {
  Select,
  SettingsGroup,
  SettingsRow,
  StatusBadge,
  Switch,
  type SelectOption,
} from '../../ui'

const HISTORY: readonly SelectOption<ExternalHistoryAccess>[] = [
  { value: 'ask', label: '始终询问' },
  { value: 'allow', label: '始终允许' },
  { value: 'never', label: '从不' },
]

const settings = shallowRef<ExternalBrowserSettingsView | null>(null)
const saving = ref(false)
const error = ref('')

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const siteToolsDescription = computed(() => {
  const reason = settings.value?.siteToolsReason
  return `让 Emperor 发现并调用网站公开的站点工具（WebMCP）。${reason ? `${reason}。` : ''}`
})

async function save(
  patch: { history: ExternalHistoryAccess } | { siteTools: boolean },
) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    settings.value = await core('computerUse.setExternalBrowserSettings', patch)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    saving.value = false
  }
}

function setHistory(value: ExternalHistoryAccess | undefined) {
  if (value !== undefined) void save({ history: value })
}

function setSiteTools(value: boolean | undefined) {
  if (value !== undefined && settings.value?.siteToolsAvailable)
    void save({ siteTools: value })
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
    <SettingsRow
      title="启用站点工具"
      :description="siteToolsDescription"
      label-for="external-site-tools"
      data-row="site-tools"
    >
      <template v-if="settings && !settings.siteToolsAvailable" #badge>
        <StatusBadge>不可用</StatusBadge>
      </template>
      <Switch
        id="external-site-tools"
        :model-value="settings?.siteTools === true"
        :disabled="!settings?.siteToolsAvailable || saving"
        @update:model-value="setSiteTools"
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
