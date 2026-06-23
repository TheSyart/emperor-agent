import { inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type {
  BootstrapPayload,
  ChatMessage,
  ChatSendPayload,
  CompactResult,
  MemoryVersionDetail,
  DesktopPetPayload,
  ModelConfigRaw,
  PendingState,
  RuntimeStatus,
  TokensPayload,
  WatchlistDecision,
} from '../types'
import type { SlashPaletteItem } from '../commands'
import type { PlanProjection } from '../runtime/handlers/plans'

export interface AppContext {
  boot: Ref<BootstrapPayload | null>
  loading: Ref<boolean>
  error: Ref<string>
  activeSkill: Ref<string | null>
  skillContent: Ref<string>
  configContent: Ref<string>

  messages: Ref<ChatMessage[]>
  busy: Ref<boolean>
  status: Ref<RuntimeStatus>
  pending: PendingState
  planProjection: PlanProjection
  runtimeText: () => string

  commands: ComputedRef<SlashPaletteItem[]>

  refreshAll: () => Promise<void>
  refreshMemory: (shouldToast?: boolean) => Promise<void>
  saveModelConfig: (config: ModelConfigRaw) => Promise<void>
  compactMemory: () => Promise<CompactResult>
  loadSkill: (name: string) => Promise<void>
  startNewSkill: (name: string) => void
  saveSkill: (content: string) => Promise<void>
  deleteSkill: (name: string) => Promise<void>
  importSkill: (formData: FormData) => Promise<string>
  loadConfig: () => Promise<void>
  saveConfig: (content: string) => Promise<void>
  mcpContent: Ref<string>
  loadMcpConfig: () => Promise<void>
  saveMcpConfig: (content: string) => Promise<void>
  saveMemory: (content: string) => Promise<void>
  loadEpisode: (date: string) => Promise<{ date: string; content: string }>
  saveEpisode: (date: string, content: string) => Promise<void>
  loadMemoryVersion: (id: string) => Promise<MemoryVersionDetail>
  restoreMemoryVersion: (id: string) => Promise<{ restored: { path: string; content: string }; memory: BootstrapPayload['memory'] }>
  saveWatchlist: (content: string) => Promise<void>
  checkWatchlist: () => Promise<WatchlistDecision>
  setDesktopPetEnabled: (enabled: boolean) => Promise<DesktopPetPayload>

  setControlMode: (mode: 'ask_before_edit' | 'auto' | 'plan') => Promise<{ ok: boolean; error?: string }>
  sendMessage: (payload: string | ChatSendPayload) => boolean
  sendInteractionAnswer: (interactionId: string, answers: Record<string, unknown>) => boolean
  sendPlanComment: (interactionId: string, comment: string) => boolean
  approvePlan: (interactionId: string) => boolean
  cancelInteraction: (interactionId: string) => boolean
  stopActive: () => Promise<boolean>
  clearChat: () => void
  submitFromComposer: (payload: string | ChatSendPayload) => void

  showToast: (message: string) => void
  runSafely: (task: () => Promise<void>) => Promise<void>

  tokens: Ref<TokensPayload | null>
  tokensLoading: Ref<boolean>
  loadTokens: (silent?: boolean) => Promise<void>
}

export const APP_CONTEXT_KEY: InjectionKey<AppContext> = Symbol('emperor-agent:app-context')

export function provideAppContext(context: AppContext) {
  provide(APP_CONTEXT_KEY, context)
}

export function useAppContext(): AppContext {
  const ctx = inject(APP_CONTEXT_KEY)
  if (!ctx) {
    throw new Error('useAppContext() called outside of <App>; provideAppContext must run first.')
  }
  return ctx
}
