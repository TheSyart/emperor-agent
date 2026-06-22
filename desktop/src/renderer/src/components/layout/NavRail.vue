<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppContext } from '../../composables/useAppContext'
import { formatCompactNumber } from '../../utils/format'
import { navOrder } from '../../router'
import { actionAssets, brandAssets, navIcon as resolveNavIcon } from '../../assets'

const ctx = useAppContext()
const route = useRoute()

const navItems = computed(() => {
  const hints: Record<(typeof navOrder)[number], string> = {
    chat: '御前对话',
    model: '模型厂家',
    tokens: '用量账本',
    skills: '能力包',
    tools: '工具权限',
    team: '队友协作',
    scheduler: '定时任务',
    configs: '配置文件',
    mcp: '外部工具',
    memory: '记忆层',
  }
  const labels: Record<(typeof navOrder)[number], string> = {
    chat: 'Chat',
    model: 'Model',
    tokens: 'Tokens',
    skills: 'Skills',
    tools: 'Tools',
    team: 'Team',
    scheduler: '定时任务',
    configs: '配置文件',
    mcp: 'MCP',
    memory: 'Memory',
  }
  return navOrder.map((name) => ({
    name,
    to: name === 'chat' ? '/chat' : `/${name}`,
    hint: hints[name],
    label: labels[name],
  }))
})

const counts = computed(() => ({
  providers: ctx.boot.value?.modelConfig?.providerOptions?.length || 0,
  tokens: ctx.boot.value?.memory?.tokenTotals?.total || 0,
  skills: ctx.boot.value?.skills?.length || 0,
  tools: ctx.boot.value?.tools?.length || 0,
}))

const current = computed(() => ctx.boot.value?.modelConfig?.current)
const statusIcon = computed(() => {
  if (ctx.busy.value) return actionAssets.statusBusy
  if (ctx.status.value === 'error') return actionAssets.statusError
  return actionAssets.statusOnline
})
</script>

<template>
  <aside class="nav-rail">
    <div class="brand-panel">
      <div class="brand-main">
        <div class="brand-orb">
          <img class="brand-seal" :src="brandAssets.logoMark" alt="Emperor Agent" width="72" height="72" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="brand-title">Emperor Agent</p>
          <p class="brand-subtitle">本地智能体工作台</p>
        </div>
      </div>
      <div class="brand-model-row">
        <p
          class="brand-provider-pill truncate"
          :title="`${current?.provider || ''} / ${current?.model || ''}`"
        >
          {{ current?.entryLabel || current?.entryName || `${current?.provider || 'provider'} / ${current?.model || 'model'}` }}
        </p>
      </div>
    </div>

    <div class="rail-status">
      <span class="status-pill">
        <img class="status-icon" :src="statusIcon" alt="" width="16" height="16" />
        {{ ctx.runtimeText() }}
      </span>
      <span class="mini-code">single context</span>
    </div>

    <div class="rail-metrics" aria-label="Agent resources">
      <div class="metric"><strong>{{ counts.providers }}</strong><span>Models</span></div>
      <div class="metric"><strong>{{ formatCompactNumber(counts.tokens) }}</strong><span>Tokens</span></div>
      <div class="metric"><strong>{{ counts.skills }}</strong><span>Skills</span></div>
      <div class="metric"><strong>{{ counts.tools }}</strong><span>Tools</span></div>
    </div>

    <nav class="rail-actions" aria-label="Primary navigation">
      <router-link
        v-for="item in navItems"
        :key="item.name"
        :to="item.to"
        class="rail-action"
        :class="{ active: route.name === item.name }"
      >
        <img
          :src="resolveNavIcon(item.name, route.name === item.name)"
          :alt="item.name"
          class="nav-icon"
          width="32"
          height="32"
        />
        <div class="nav-label">
          <span>{{ item.label }}</span>
          <small>{{ item.hint }}</small>
        </div>
      </router-link>
    </nav>

    <div class="rail-footer">
      <button class="tool-button wide asset-button primary-action rail-clear-button" @click="ctx.clearChat()">
        <img class="action-icon" :src="actionAssets.clear" alt="" width="20" height="20" />
        <span>清空当前屏幕</span>
      </button>
      <p>清空只影响网页显示，不会删除运行期记忆。</p>
    </div>
  </aside>
</template>
