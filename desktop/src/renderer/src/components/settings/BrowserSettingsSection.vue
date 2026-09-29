<script setup lang="ts">
/**
 * Settings › 浏览器 — the user's own built-in browser (the workspace 浏览器
 * pane), not the one the Agent drives (电脑操作): whether the pane is
 * available, where a web link clicked in Emperor opens, and the address
 * bar. Its pages are temporary: the session is wiped when the pane closes.
 * Addresses of this machine never go to the system browser (main,
 * link-routing.ts), so they open here or not at all.
 *
 * Changes save at once through `browser.setPreferences`; Core tells every
 * window (`browser_preferences_changed`, useBrowserPreferences).
 */
import type { BrowserPreferences } from '@emperor/core/runtime-contract'
import { ref } from 'vue'
import { useAppContext } from '../../composables/useAppContext'
import { useBrowserPreferences } from '../../composables/useBrowserPreferences'
import {
  Select,
  SettingsRow,
  SettingsSection,
  Switch,
  type SelectOption,
} from './ui'

const ctx = useAppContext()
const { preferences, update } = useBrowserPreferences()
const saving = ref(false)

const LINK_TARGETS: readonly SelectOption<BrowserPreferences['linkTarget']>[] =
  [
    {
      value: 'system',
      label: '系统默认浏览器',
      description: '沿用默认浏览器里的登录状态',
    },
    {
      value: 'builtin',
      label: 'Emperor 内置浏览器',
      description: '在右侧工作台打开，关闭后不保留登录和浏览数据',
    },
  ]

function save(change: Partial<BrowserPreferences>): void {
  if (saving.value) return
  saving.value = true
  void ctx
    .runSafely(() => update(change))
    .finally(() => {
      saving.value = false
    })
}
</script>

<template>
  <SettingsSection
    intro="你自己浏览网页用的内置浏览器。Agent 操作网页用的浏览器在「电脑操作」中设置。"
  >
    <SettingsRow
      title="启用内置浏览器"
      description="在右侧工作台提供「浏览器」面板。关闭后网页链接都用系统浏览器打开，本机地址（localhost）不再打开。"
      label-for="browser-enabled"
    >
      <Switch
        id="browser-enabled"
        :model-value="preferences.enabled"
        :disabled="saving"
        @update:model-value="(value: boolean) => save({ enabled: value })"
      />
    </SettingsRow>
    <SettingsRow
      title="网页链接打开位置"
      description="在会话、Pull Request 等界面中点击的网页链接。本机地址总在内置浏览器中打开。"
      label-for="browser-link-target"
    >
      <Select
        id="browser-link-target"
        size="sm"
        :model-value="preferences.linkTarget"
        :options="LINK_TARGETS"
        :disabled="saving || !preferences.enabled"
        @update:model-value="
          (value?: BrowserPreferences['linkTarget']) =>
            value && save({ linkTarget: value })
        "
      />
    </SettingsRow>
    <SettingsRow
      title="地址栏显示完整网址"
      description="关闭后地址栏只显示网站名，点击地址栏编辑时显示完整网址。"
      label-for="browser-full-url"
    >
      <Switch
        id="browser-full-url"
        :model-value="preferences.showFullUrl"
        :disabled="saving || !preferences.enabled"
        @update:model-value="(value: boolean) => save({ showFullUrl: value })"
      />
    </SettingsRow>
  </SettingsSection>
</template>
