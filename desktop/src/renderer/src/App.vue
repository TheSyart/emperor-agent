<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SessionSidebar from './components/layout/SessionSidebar.vue'
import OnboardingWizard from './components/onboarding/OnboardingWizard.vue'
import type { WizardModelSettings } from './components/onboarding/onboardingModel'
import { runInitialStartup } from './appStartup'
import { buildSlashPaletteItems } from './commands'
import { useBootstrap } from './composables/useBootstrap'
import { useRuntime } from './composables/useRuntime'
import { useSession } from './composables/useSession'
import { useTokens } from './composables/useTokens'
import { useSlashCommands } from './composables/useSlashCommands'
import { provideAppContext } from './composables/useAppContext'
import type { ChatSendPayload, CompactResult, ControlPayload, TokenStatsRow } from './types'
import { core } from './api/http'
import { saveOnboardingModelConfig } from './api/model'
import { formatNumber, usageTypeLabel } from './utils/format'

const router = useRouter()
const toast = ref('')
let toastTimer: number | undefined
const hideAppSidebar = computed(() => router.currentRoute.value.meta?.hideAppSidebar === true)
const onboardingOpen = ref(false)

function showToast(message: string) {
  toast.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 2600)
}

function openOnboarding() {
  onboardingOpen.value = true
}

function closeOnboarding() {
  onboardingOpen.value = false
}

const bootstrap = useBootstrap(showToast)
const sessionStore = useSession()
const {
  boot,
  loading,
  error,
  activeSkill,
  skillContent,
  configContent,
  mcpContent,
  loadBootstrap,
  refreshMemory,
  saveModelConfig,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
  importSkill,
  loadConfig,
  saveConfig,
  loadMcpConfig,
  saveMcpConfig,
  saveMemory,
  loadEpisode,
  saveEpisode,
  loadMemoryVersion,
  restoreMemoryVersion,
  saveWatchlist,
  checkWatchlist,
  setDesktopPetEnabled,
} = bootstrap

const runtime = useRuntime({
  boot,
  refreshMemory,
  showToast,
  resolveDraftSession: sessionStore.getSession,
  onSessionCreated: sessionStore.applySessionCreatedEvent,
  onSessionTitleUpdated: sessionStore.applySessionTitleUpdatedEvent,
  onSessionControlPendingChanged: sessionStore.applySessionControlPending,
  refreshSessions: sessionStore.load,
})
const {
  messages,
  busy,
  status,
  switchSession,
  pending,
  planProjection,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  connectSocket,
  sendMessage,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  clearChat,
  addLocalCommand,
  restoreFromHistory,
} = runtime

async function onSessionActivate(id: string) {
  await sessionStore.activate(id)
  switchSession(id)
  if (sessionStore.isDraftSessionId(id)) return
  await bootstrap.loadBootstrap(false, sessionStore.backendSessionId())
  restoreFromHistory(boot.value?.unarchivedHistory || [])
}

const tokensClient = useTokens(showToast)
const { data: tokensData, loading: tokensLoading, load: loadTokens } = tokensClient
const slashPaletteItems = computed(() => buildSlashPaletteItems(boot.value?.skills || []))

onMounted(async () => {
  await runInitialStartup({
    sessionStore,
    bootstrap,
    switchSession,
    restoreFromHistory,
    connectSocket,
  })
})

async function refreshAll() {
  await loadBootstrap(false, sessionStore.backendSessionId())
  if (!error.value) {
    connectSocket()
    showToast('工作台已刷新')
  }
}

async function completeOnboarding(settings: WizardModelSettings) {
  const data = await saveOnboardingModelConfig(settings as unknown as Record<string, unknown>)
  if (boot.value) {
    boot.value.modelConfig = data
    boot.value.model = data.current?.model || boot.value.model
    boot.value.provider = data.current?.provider || boot.value.provider
    boot.value.providerLabel = data.current?.providerLabel || boot.value.providerLabel
  }
  await loadBootstrap(false, sessionStore.backendSessionId())
  if (!error.value) {
    onboardingOpen.value = false
    connectSocket()
    showToast('模型配置已保存')
  }
}

async function runSafely(task: () => Promise<void>) {
  try {
    await task()
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err))
  }
}

const { submitFromComposer, setControlMode } = useSlashCommands({
  boot,
  configContent,
  busy,
  pending,
  routeName: () => router.currentRoute.value.name?.toString() || 'chat',
  runtimeText,
  eventTransportText,
  sendMessage,
  addLocalCommand,
  clearChat,
  stopActive,
  compactMemory,
  restoreMemoryVersion,
  refreshAll,
  showToast,
})


provideAppContext({
  boot,
  loading,
  error,
  activeSkill,
  skillContent,
  configContent,
  mcpContent,
  messages,
  busy,
  status,
  pending,
  planProjection,
  sessionRuntimeStates,
  runtimeText,
  eventTransportText,
  commands: slashPaletteItems,
  refreshAll,
  refreshMemory,
  saveModelConfig,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
  importSkill,
  loadConfig,
  saveConfig,
  loadMcpConfig,
  saveMcpConfig,
  saveMemory,
  loadEpisode,
  saveEpisode,
  loadMemoryVersion,
  restoreMemoryVersion,
  saveWatchlist,
  checkWatchlist,
  setDesktopPetEnabled,
  setControlMode,
  sendMessage,
  sendInteractionAnswer,
  sendPlanComment,
  approvePlan,
  cancelInteraction,
  stopActive,
  clearChat,
  submitFromComposer,
  showToast,
  runSafely,
  openOnboarding,
  tokens: tokensData,
  tokensLoading,
  loadTokens,
})
</script>

<template>
  <div v-if="loading" class="loading-shell">
    <div class="seal">令</div>
    <div class="status-pill"><span class="dot busy" />正在连接本地智能体服务</div>
  </div>

  <div v-else-if="error" class="loading-shell">
    <div class="editor error-panel">
      <div class="editor-title">Web UI 启动失败</div>
      <div class="empty-note">{{ error }}</div>
      <button class="tool-button ink mt-4" @click="refreshAll">重新连接</button>
    </div>
  </div>

  <template v-else>
    <div class="app-shell" :class="{ 'settings-app-shell': hideAppSidebar }">
      <SessionSidebar v-if="!hideAppSidebar" @activate="onSessionActivate" />
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </div>
    <OnboardingWizard :payload="boot" :open="onboardingOpen" :save="completeOnboarding" @close="closeOnboarding" />
  </template>

  <div class="toast" :class="{ show: toast }" role="status">{{ toast }}</div>
</template>
