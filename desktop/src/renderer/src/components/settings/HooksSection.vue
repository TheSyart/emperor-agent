<script setup lang="ts">
/**
 * Settings › Hooks — Claude Code `hooks.json`, single column: underline
 * Tabs (配置 / 测试 / 审计) over the active tab view. State and every
 * `hooks.*` Core call live in hooks/hooksController.ts (provided here, read
 * by the tab views); the header refresh reloads config, metadata and audit.
 * Styles stay scoped to this component and its tab views
 * (feature-style-owners.json › hooks).
 */
import Tabs from '../ui/Tabs.vue'
import { DsWarning } from '../icons/ds'
import { EmptyState, SettingsSection } from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import { provideHooksController } from './hooks/hooksController'
import HooksConfigTab from './hooks/HooksConfigTab.vue'
import HooksTestTab from './hooks/HooksTestTab.vue'
import HooksAuditTab from './hooks/HooksAuditTab.vue'

const { tabs, activeTab, loading, error, payload, loadAll } =
  provideHooksController()

useSettingsHeader({
  actions: () => [
    refreshAction(() => loadAll(), {
      title: '刷新 Hooks',
      busy: loading.value,
    }),
  ],
})
</script>

<template>
  <SettingsSection
    class="hooks-section"
    intro="在指定事件发生时自动运行命令：编辑 hooks.json、测试匹配规则、查看运行记录。"
  >
    <Tabs
      v-model="activeTab"
      :tabs="tabs"
      class="hooks-tabs"
      aria-label="Hooks views"
    />

    <div v-if="error" class="hooks-alert" role="alert">
      <DsWarning :size="16" class="alert-glyph" />
      <span>{{ error }}</span>
    </div>

    <EmptyState
      v-if="loading && !payload"
      title="加载 Hooks 中…"
      variant="plain"
      compact
    />
    <HooksConfigTab v-else-if="activeTab === 'config'" />
    <HooksTestTab v-else-if="activeTab === 'test'" />
    <HooksAuditTab v-else />
  </SettingsSection>
</template>

<style scoped>
/* Underline tabs sit on a full-width l2 hairline, like the dsh detail tabs. */
.hooks-tabs {
  margin-bottom: var(--space-1);
  border-bottom: 1px solid var(--border-l2);
}

.hooks-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.alert-glyph {
  flex: none;
  margin-top: var(--space-0-5);
}
</style>
