import { inject, provide, type InjectionKey, type Ref } from 'vue'
import type {
  AttachmentRef,
  BootstrapPayload,
  ChatMessage,
  CompactResult,
  ModelConfigRaw,
  PendingState,
  RuntimeStatus,
  TokensPayload,
} from '../types'
import type { SlashCommand } from '../commands'

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
  runtimeText: () => string

  commands: SlashCommand[]

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
  saveMemory: (content: string) => Promise<void>
  loadEpisode: (date: string) => Promise<{ date: string; content: string }>
  saveEpisode: (date: string, content: string) => Promise<void>

  sendMessage: (payload: string | { content: string; attachments?: AttachmentRef[] }) => boolean
  clearChat: () => void
  submitFromComposer: (payload: string | { content: string; attachments?: AttachmentRef[] }) => void

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
