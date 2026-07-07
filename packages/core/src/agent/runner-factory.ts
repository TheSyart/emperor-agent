/**
 * runner_factory (MIG-CORE-010)。对齐 Python `agent/runner_factory.py:build_routed_runner`。
 * 按模型路由（main/secondary + fallback）构造 AgentRunner，供子代理/Team 复用。
 */
import type { LLMProvider } from '../providers/base'
import type { ModelRoute } from '../model/router'
import type { PromptContextPlan, PromptSectionInput } from '../prompts/manifest'
import type { ToolRegistry } from '../tools/registry'
import {
  AgentRunner,
  type CompactorLike,
  type ControlManagerRunnerHost,
  type MemoryStoreLike,
  type TodoStoreLike,
  type TokenTrackerLike,
} from './runner'

export function buildRoutedRunner(opts: {
  route: ModelRoute
  registry: ToolRegistry
  systemPrompt: string
  tokenTracker: TokenTrackerLike | null
  usageType: string
  maxTokensCap?: number | null
  memoryStore?: MemoryStoreLike | null
  compactor?: CompactorLike | null
  todoStore?: TodoStoreLike | null
  controlManager?: ControlManagerRunnerHost | null
  maxContext?: number | null
  maxTurns?: number
  workspaceRoot?: string | null
  promptSections?: PromptSectionInput[] | null
  promptContextPlan?: PromptContextPlan | null
  promptSnapshotDir?: string | null
  sessionId?: string | null
  streamingToolExecution?: boolean
}): AgentRunner {
  const snapshot = opts.route.snapshot
  const fallback = opts.route.fallback
  let maxTokens = snapshot.generation.maxTokens
  if (opts.maxTokensCap !== null && opts.maxTokensCap !== undefined) {
    maxTokens = Math.min(opts.maxTokensCap, maxTokens)
  }
  return new AgentRunner({
    provider: snapshot.provider as unknown as LLMProvider,
    model: snapshot.model,
    registry: opts.registry,
    systemPrompt: opts.systemPrompt,
    maxTokens,
    temperature: snapshot.generation.temperature,
    reasoningEffort: snapshot.generation.reasoningEffort,
    providerName: snapshot.providerName,
    modelRole: snapshot.modelRole,
    routeReason: opts.route.reason,
    routeEstimatedTokens: opts.route.estimatedTokens,
    fallbackProvider: fallback ? (fallback.provider as unknown as LLMProvider) : null,
    fallbackModel: fallback ? fallback.model : null,
    fallbackProviderName: fallback ? fallback.providerName : null,
    fallbackGeneration: fallback ? fallback.generation : null,
    fallbackModelRole: fallback ? fallback.modelRole : 'main',
    usageType: opts.usageType,
    memoryStore: opts.memoryStore ?? null,
    tokenTracker: opts.tokenTracker,
    compactor: opts.compactor ?? null,
    todoStore: opts.todoStore ?? null,
    controlManager: opts.controlManager ?? null,
    ...(opts.maxContext !== null && opts.maxContext !== undefined ? { maxContext: opts.maxContext } : {}),
    maxTurns: opts.maxTurns ?? 12,
    workspaceRoot: opts.workspaceRoot ?? null,
    promptSections: opts.promptSections ?? null,
    promptContextPlan: opts.promptContextPlan ?? null,
    promptSnapshotDir: opts.promptSnapshotDir ?? null,
    sessionId: opts.sessionId ?? null,
    streamingToolExecution: opts.streamingToolExecution ?? false,
  })
}
