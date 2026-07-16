import {
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue'
import type {
  BootstrapPayload,
  ChatMessage,
  ChatSendPayload,
  CompactResult,
  MemoryVersionDetail,
  DesktopPetPayload,
  PendingState,
  RuntimeStatus,
  GoalProjectionState,
  GoalOperationResult,
  TokensPayload,
  WatchlistDecision,
} from '../types'
import type { SlashPaletteItem } from '../commands'
import type { PlanProjection } from '../runtime/handlers/plans'
import type { GoalCardAction } from '../runtime/goalRender'

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
  goalProjection: GoalProjectionState
  sessionId: Ref<string>
  sessionRuntimeStates: Record<string, { running: boolean; attention: boolean }>
  runtimeText: () => string
  eventTransportText: () => string

  commands: ComputedRef<SlashPaletteItem[]>

  refreshAll: () => Promise<void>
  refreshMemory: (shouldToast?: boolean) => Promise<void>
  openProfileInterviewSession: (sessionId: string | null) => Promise<void>
  startProfileInterview: () => Promise<void>
  skipProfileInterview: () => Promise<void>
  compactMemory: () => Promise<CompactResult>
  loadSkill: (name: string) => Promise<void>
  startNewSkill: (name: string) => void
  saveSkill: (content: string) => Promise<void>
  deleteSkill: (name: string) => Promise<void>
  loadConfig: () => Promise<void>
  saveConfig: (content: string) => Promise<void>
  mcpContent: Ref<string>
  loadMcpConfig: () => Promise<void>
  saveMcpConfig: (content: string) => Promise<void>
  saveMemory: (content: string) => Promise<void>
  loadEpisode: (date: string) => Promise<{ date: string; content: string }>
  saveEpisode: (date: string, content: string) => Promise<void>
  loadMemoryVersion: (id: string) => Promise<MemoryVersionDetail>
  restoreMemoryVersion: (id: string) => Promise<{
    restored: { path: string; content: string }
    memory: BootstrapPayload['memory']
  }>
  saveWatchlist: (content: string) => Promise<void>
  checkWatchlist: () => Promise<WatchlistDecision>
  setDesktopPetEnabled: (enabled: boolean) => Promise<DesktopPetPayload>

  setPermissionMode: (
    mode: 'ask_before_edit' | 'accept_edits' | 'auto',
  ) => Promise<{ ok: boolean; error?: string }>
  sendMessage: (payload: string | ChatSendPayload) => boolean
  sendInteractionAnswer: (
    interactionId: string,
    answers: Record<string, unknown>,
  ) => boolean
  sendPlanComment: (interactionId: string, comment: string) => boolean
  approvePlan: (interactionId: string) => boolean
  cancelInteraction: (interactionId: string) => boolean
  stopActive: () => Promise<boolean>
  runGoalAction: (
    goalId: string,
    action: GoalCardAction,
  ) => Promise<GoalOperationResult>
  replaceGoal: (goalId: string, outcome: string) => Promise<GoalOperationResult>
  startGoal: (outcome: string) => Promise<GoalOperationResult>
  clearChat: () => void
  submitFromComposer: (payload: string | ChatSendPayload) => void

  showToast: (message: string) => void
  runSafely: (task: () => Promise<void>) => Promise<void>

  tokens: Ref<TokensPayload | null>
  tokensLoading: Ref<boolean>
  loadTokens: (silent?: boolean) => Promise<void>
}

export const APP_CONTEXT_KEY: InjectionKey<AppContext> = Symbol(
  'emperor-agent:app-context',
)

export function provideAppContext(context: AppContext) {
  provide(APP_CONTEXT_KEY, context)
}

export function useAppContext(): AppContext {
  const ctx = inject(APP_CONTEXT_KEY)
  if (!ctx) {
    throw new Error(
      'useAppContext() called outside of <App>; provideAppContext must run first.',
    )
  }
  return ctx
}
