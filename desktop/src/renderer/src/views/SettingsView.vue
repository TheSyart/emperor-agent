<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArchiveRestore,
  Activity,
  Bot,
  Brain,
  Coins,
  Cpu,
  Database,
  Palette,
  Settings,
  SlidersHorizontal,
} from 'lucide-vue-next'
import ConfigsView from './ConfigsView.vue'
import DiagnosticsPanel from '../components/panels/DiagnosticsPanel.vue'
import HooksPanel from '../components/panels/HooksPanel.vue'
import MemoryView from './MemoryView.vue'
import ModelView from './ModelView.vue'
import TokensView from './TokensView.vue'
import { useAppContext } from '../composables/useAppContext'
import { useSession } from '../composables/useSession'
import { useTheme } from '../composables/useTheme'
import type { SessionInfo } from '../types'

const route = useRoute()
const router = useRouter()
const ctx = useAppContext()
const sessions = useSession()
const theme = useTheme()
const archivedSessions = ref<SessionInfo[]>([])
const archivedLoading = ref(false)

const sections = [
  { key: 'general', label: '常规', group: '个人', icon: Settings },
  { key: 'model', label: '模型', group: '个人', icon: Cpu },
  { key: 'memory', label: '记忆', group: '个人', icon: Brain },
  { key: 'tokens', label: 'Token', group: '个人', icon: Coins },
  { key: 'configs', label: '配置', group: '编码', icon: SlidersHorizontal },
  { key: 'hooks', label: 'Hooks', group: '编码', icon: Bot },
  { key: 'diagnostics', label: '诊断', group: '编码', icon: Activity },
  { key: 'appearance', label: '外观', group: '编码', icon: Palette },
  {
    key: 'archived',
    label: '已归档对话',
    group: '已归档',
    icon: ArchiveRestore,
  },
] as const

type SettingsSection = (typeof sections)[number]['key']

const sectionKeys = new Set<string>(sections.map((item) => item.key))
const currentSection = computed<SettingsSection>(() => {
  const raw = Array.isArray(route.params.section)
    ? route.params.section[0]
    : route.params.section
  return sectionKeys.has(String(raw))
    ? (String(raw) as SettingsSection)
    : 'general'
})

const groupedSections = computed(() => {
  const groups = new Map<string, (typeof sections)[number][]>()
  for (const section of sections) {
    groups.set(section.group, [...(groups.get(section.group) || []), section])
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
})

const sectionViews: Partial<Record<SettingsSection, Component>> = {
  model: ModelView,
  memory: MemoryView,
  tokens: TokensView,
  configs: ConfigsView,
  hooks: HooksPanel,
  diagnostics: DiagnosticsPanel,
}

const activeView = computed(() => sectionViews[currentSection.value])

watch(
  currentSection,
  (section) => {
    if (section === 'archived') void loadArchived()
  },
  { immediate: true },
)

onMounted(() => {
  if (!sectionKeys.has(String(route.params.section || 'general'))) {
    void router.replace('/settings/general')
  }
})

function go(section: SettingsSection) {
  void router.push(`/settings/${section}`)
}

async function loadArchived() {
  archivedLoading.value = true
  try {
    archivedSessions.value = (await sessions.loadArchived()).filter(
      (session) => session.archived_at,
    )
  } finally {
    archivedLoading.value = false
  }
}

async function restoreArchived(id: string) {
  const ok = await sessions.archive(id, false)
  if (ok) {
    archivedSessions.value = archivedSessions.value.filter(
      (session) => session.id !== id,
    )
    ctx.showToast('已恢复会话')
  }
}

async function deleteArchived(id: string) {
  const ok = await sessions.remove(id)
  if (ok)
    archivedSessions.value = archivedSessions.value.filter(
      (session) => session.id !== id,
    )
}
</script>

<template>
  <section class="settings-shell">
    <aside class="settings-sidebar">
      <button class="settings-back" @click="router.push('/chat')">
        ← 返回应用
      </button>
      <div class="settings-search">搜索设置...</div>
      <template v-for="group in groupedSections" :key="group.group">
        <div class="settings-group-label">{{ group.group }}</div>
        <button
          v-for="item in group.items"
          :key="item.key"
          class="settings-nav-item"
          :class="{ active: currentSection === item.key }"
          @click="go(item.key)"
        >
          <component :is="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </button>
      </template>
    </aside>

    <main class="settings-content">
      <component v-if="activeView" :is="activeView" />

      <section
        v-else-if="currentSection === 'general'"
        class="main-view view-readable settings-simple-view"
      >
        <header class="view-head">
          <div>
            <h1>常规</h1>
            <p>当前本地 Agent 的运行状态与基础信息</p>
          </div>
        </header>
        <div class="view-body">
          <div class="settings-list">
            <div class="settings-row">
              <Bot :size="18" />
              <div>
                <strong>运行状态</strong>
                <span>当前本地 Agent 服务状态</span>
              </div>
              <code>{{ ctx.runtimeText() }}</code>
            </div>
            <div class="settings-row">
              <Cpu :size="18" />
              <div>
                <strong>当前模型</strong>
                <span>所有 Agent 工作负载共用的激活模型</span>
              </div>
              <code>{{
                ctx.boot.value?.modelConfig?.current?.modelId ||
                ctx.boot.value?.model ||
                '未配置'
              }}</code>
            </div>
            <div class="settings-row">
              <Database :size="18" />
              <div>
                <strong>已绑定项目</strong>
                <span>Build 模式可用的本地项目数量</span>
              </div>
              <code>{{ ctx.boot.value?.projects?.length || 0 }}</code>
            </div>
          </div>
        </div>
      </section>

      <section
        v-else-if="currentSection === 'appearance'"
        class="main-view view-readable settings-simple-view"
      >
        <header class="view-head">
          <div>
            <h1>外观</h1>
            <p>主题只影响本地桌面端显示</p>
          </div>
        </header>
        <div class="view-body">
          <div class="settings-list">
            <button
              class="settings-row selectable"
              :class="{ active: theme.theme.value === 'dark' }"
              @click="theme.set('dark')"
            >
              <Palette :size="18" />
              <div>
                <strong>深色</strong>
                <span>Codex 风格默认</span>
              </div>
              <code>{{ theme.theme.value === 'dark' ? '当前' : '切换' }}</code>
            </button>
            <button
              class="settings-row selectable"
              :class="{ active: theme.theme.value === 'light' }"
              @click="theme.set('light')"
            >
              <Palette :size="18" />
              <div>
                <strong>浅色</strong>
                <span>高亮环境</span>
              </div>
              <code>{{ theme.theme.value === 'light' ? '当前' : '切换' }}</code>
            </button>
          </div>
        </div>
      </section>

      <section v-else class="main-view view-readable settings-simple-view">
        <header class="view-head">
          <div>
            <h1>已归档对话</h1>
            <p>恢复后会重新出现在主侧边栏</p>
          </div>
        </header>
        <div class="view-body">
          <div v-if="archivedLoading" class="empty-note">加载归档对话中...</div>
          <div v-else-if="!archivedSessions.length" class="empty-note">
            暂无归档对话。
          </div>
          <div v-else class="archived-session-list">
            <div
              v-for="session in archivedSessions"
              :key="session.id"
              class="archived-session-row"
            >
              <div>
                <strong>{{ session.title }}</strong>
                <span>{{
                  session.project_name || session.updated_at?.slice(0, 10)
                }}</span>
              </div>
              <div class="archived-session-actions">
                <button
                  class="tool-button"
                  @click="restoreArchived(session.id)"
                >
                  恢复
                </button>
                <button
                  class="tool-button danger"
                  @click="deleteArchived(session.id)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </section>
</template>
