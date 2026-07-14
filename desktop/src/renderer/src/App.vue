<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import SessionSidebar from './components/layout/SessionSidebar.vue'
import ModelSetupRequiredDialog from './components/onboarding/ModelSetupRequiredDialog.vue'
import { shouldShowModelSetupPrompt } from './components/onboarding/modelSetupDialogModel'
import { runInitialStartup } from './appStartup'
import { buildSlashPaletteItems } from './commands'
import { useBootstrap } from './composables/useBootstrap'
import { useRuntime } from './composables/useRuntime'
import { useSession } from './composables/useSession'
import { useTokens } from './composables/useTokens'
import { useSlashCommands } from './composables/useSlashCommands'
import { provideAppContext } from './composables/useAppContext'

const router = useRouter()
const toast = ref('')
let toastTimer: number | undefined
const hideAppSidebar = computed(
  () => router.currentRoute.value.meta?.hideAppSidebar === true,
)
const modelSetupPromptOpen = ref(false)
const modelSetupDismissed = ref(false)

function showToast(message: string) {
  toast.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, 2600)
}

function closeModelSetupPrompt() {
  modelSetupDismissed.value = true
  modelSetupPromptOpen.value = false
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
  startProfileInterview: startProfileInterviewBase,
  skipProfileInterview: skipProfileInterviewBase,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
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

async function openProfileInterviewSession(sessionId: string | null) {
  if (!sessionId) return
  await sessionStore.load()
  await onSessionActivate(sessionId)
  await router.push('/').catch(() => undefined)
}

async function startProfileInterview() {
  const result = await startProfileInterviewBase()
  if (result.started) {
    await openProfileInterviewSession(result.state.sessionId)
    return
  }
  if (result.state.status === 'completed') showToast('个人档案已完成')
  else if (result.state.lastError) showToast(result.state.lastError)
}

async function skipProfileInterview() {
  await skipProfileInterviewBase()
}

const tokensClient = useTokens(showToast)
const {
  data: tokensData,
  loading: tokensLoading,
  load: loadTokens,
} = tokensClient
const slashPaletteItems = computed(() =>
  buildSlashPaletteItems(boot.value?.skills || []),
)
const modelSetupMessage = computed(
  () =>
    boot.value?.modelConfig?.availability?.message ||
    '还没有可用模型，请先配置模型。',
)

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

async function configureModelFromPrompt() {
  modelSetupDismissed.value = true
  modelSetupPromptOpen.value = false
  await router.push('/settings/model').catch(() => undefined)
}

watch(
  () => boot.value?.modelConfig?.availability?.usable,
  () => {
    if (!boot.value) return
    const shouldPrompt = shouldShowModelSetupPrompt(boot.value)
    if (!shouldPrompt) {
      modelSetupPromptOpen.value = false
      modelSetupDismissed.value = false
      return
    }
    if (!modelSetupDismissed.value) modelSetupPromptOpen.value = true
  },
  { immediate: true },
)

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
  openProfileInterviewSession,
  startProfileInterview,
  skipProfileInterview,
  compactMemory,
  loadSkill,
  startNewSkill,
  saveSkill,
  deleteSkill,
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
  tokens: tokensData,
  tokensLoading,
  loadTokens,
})
</script>

<template>
  <div v-if="loading" class="loading-shell">
    <div class="seal">令</div>
    <div class="status-pill">
      <span class="dot busy" />正在连接本地智能体服务
    </div>
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
    <ModelSetupRequiredDialog
      :open="modelSetupPromptOpen"
      :message="modelSetupMessage"
      @close="closeModelSetupPrompt"
      @configure="configureModelFromPrompt"
    />
  </template>

  <div class="toast" :class="{ show: toast }" role="status">{{ toast }}</div>
</template>
