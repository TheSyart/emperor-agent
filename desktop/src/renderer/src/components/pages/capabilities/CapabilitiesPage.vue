<script setup lang="ts">
/**
 * CapabilitiesPage — the /capabilities/:tab(plugins|skills|mcp|tools)? full
 * page (能力). A 插件 / Skills / MCP / 工具 tab strip bound to the route
 * param (router.replace, so tab switches do not pile up history), each tab
 * hosting its section (PluginsSection / SkillsSection / McpSection /
 * ToolsSection, async chunks). The sections publish their header actions
 * through useSettingsHeader, which PageShell renders in the title row, and
 * re-read their data when the kept-alive page is shown again
 * (pages/pageLifecycle.ts).
 *
 * The Skills tab keeps its open Skill in `?skill=`; switching tabs drops
 * that key and keeps any other query key.
 */
import { defineAsyncComponent, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Tabs from '../../ui/Tabs.vue'
import PageShell from '../PageShell.vue'

type CapabilitiesTab = 'plugins' | 'skills' | 'mcp' | 'tools'

const TABS: { id: CapabilitiesTab; label: string }[] = [
  { id: 'plugins', label: '插件' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'tools', label: '工具' },
]

const BODIES: Record<CapabilitiesTab, Component> = {
  plugins: defineAsyncComponent(
    () => import('../../settings/PluginsSection.vue'),
  ),
  skills: defineAsyncComponent(
    () => import('../../settings/SkillsSection.vue'),
  ),
  mcp: defineAsyncComponent(() => import('../../settings/McpSection.vue')),
  tools: defineAsyncComponent(() => import('../../settings/ToolsSection.vue')),
}

const route = useRoute()
const router = useRouter()
const active = ref<CapabilitiesTab>('plugins')

function normalizeTab(value: unknown): CapabilitiesTab {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'skills' || raw === 'mcp' || raw === 'tools' ? raw : 'plugins'
}

// Follow the route only while this page is the route (kept alive otherwise).
watch(
  () => [route.name, route.params.tab] as const,
  ([name, tab]) => {
    if (name === 'capabilities') active.value = normalizeTab(tab)
  },
  { immediate: true },
)

function select(value: string): void {
  const tab = normalizeTab(value)
  if (tab === active.value) return
  const { skill: _skill, ...query } = route.query
  void router
    .replace({
      path: tab === 'plugins' ? '/capabilities' : `/capabilities/${tab}`,
      query,
    })
    .catch(() => undefined)
}
</script>

<template>
  <PageShell title="能力" subtitle="管理插件、Skills、MCP 服务器与工具">
    <template #tabs>
      <Tabs
        :model-value="active"
        :tabs="TABS"
        aria-label="能力分类"
        @update:model-value="select"
      />
    </template>
    <component :is="BODIES[active]" :key="active" />
  </PageShell>
</template>
