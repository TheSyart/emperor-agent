import { randomUUID } from 'node:crypto'
import {
  Tool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolResult,
} from './base'
import {
  S,
  toolParamsSchema,
  type ParamSchema,
  type ToolParamsSchema,
} from './schema'
import { ToolRegistry } from './registry'
import { TaskKind, TaskStatus, type TaskRecord } from '../tasks/models'
import type { TaskManager } from '../tasks/manager'
import { TaskRuntimeRegistry, type TaskTerminalResult } from '../tasks/runtime'
import { TaskStoreConflictError } from '../tasks/store'
import * as runtimeEvents from '../runtime/events'
import type { SubagentRegistry } from '../subagents/registry'
import type { SubagentSpec } from '../subagents/spec'
import type { SubagentContextMode } from '../subagents/spec'
import type { HookAggregateDecision } from '../hooks/models'
import type { ExecutionEnvironment } from '../environment/snapshot'
import type { RunnerGoalRecordingHost } from '../agent/runner-goal-recording'
import {
  SubagentSupervisor,
  type SubagentExecutionMode,
  type SubagentLaunchResult,
  type SubagentResumeOptions,
} from '../subagents/supervisor'

const PLAN_CONTRACT_FIELDS = [
  'scope_limit',
  'expected_output',
  'evidence_required',
] as const
const EVIDENCE_FILE_RE =
  /(?<![\w/.-])([A-Za-z0-9_./-]+\.(?:py|pyi|ts|tsx|js|jsx|vue|md|rst|json|toml|yaml|yml|txt|css|scss|html)(?::\d+(?:-\d+)?)?)/g

export interface DispatchRunner {
  step(
    history: Array<Record<string, unknown>>,
    opts?: { signal?: AbortSignal | null },
  ): string | Promise<string>
}

export interface DispatchRunnerFactoryArgs {
  spec: SubagentSpec
  subRegistry: ToolRegistry
  task: string
  workspaceRoot?: string | null
  agentId?: string
  taskId?: string
  turnId?: string
  sessionId?: string | null
  executionEnvironment?: ExecutionEnvironment | null
  goalObservationRecorder?: RunnerGoalRecordingHost | null
  expectedGoalId?: string | null
  contextMode?: SubagentContextMode
  parentSystemPrompt?: string | null
}

export interface DispatchSubagentHookHost {
  begin(opts: {
    agentId: string
    agentType: string
    sessionId: string
    cwd: string
  }): Promise<HookAggregateDecision>
  end(agentId: string): void
}

export interface DispatchSubagentToolOptions {
  parentRegistry: ToolRegistry
  subagentRegistry: SubagentRegistry
  runnerFactory: (args: DispatchRunnerFactoryArgs) => DispatchRunner
  taskManager?: TaskManager | null
  taskRuntime?: TaskRuntimeRegistry | null
  supervisor?: SubagentSupervisor | null
  controlManager?: { mode?: string; [key: string]: unknown } | null
  hooks?: DispatchSubagentHookHost | null
}

export class DispatchSubagentTool extends Tool {
  override name = 'dispatch_subagent'
  readonly supportsPlanReadonlyExploration = true
  override exclusive = false
  override requiresRuntimeContext = true
  override concurrencySafe = true
  override evidencePolicy = 'forbidden' as const

  private readonly parentRegistry: ToolRegistry
  private readonly subagentRegistry: SubagentRegistry
  private readonly runnerFactory: (
    args: DispatchRunnerFactoryArgs,
  ) => DispatchRunner
  private readonly taskManager: TaskManager | null
  private readonly taskRuntime: TaskRuntimeRegistry | null
  private readonly supervisor: SubagentSupervisor | null
  private readonly controlManager: {
    mode?: string
    [key: string]: unknown
  } | null
  private readonly hooks: DispatchSubagentHookHost | null

  constructor(opts: DispatchSubagentToolOptions) {
    super()
    this.parentRegistry = opts.parentRegistry
    this.subagentRegistry = opts.subagentRegistry
    this.runnerFactory = opts.runnerFactory
    this.taskManager = opts.taskManager ?? null
    this.taskRuntime =
      opts.taskRuntime ??
      (this.taskManager ? new TaskRuntimeRegistry(this.taskManager) : null)
    this.supervisor =
      opts.supervisor ??
      (this.taskManager && this.taskRuntime
        ? new SubagentSupervisor(this.taskManager, this.taskRuntime)
        : null)
    this.controlManager = opts.controlManager ?? null
    this.hooks = opts.hooks ?? null
  }

  override get description(): string {
    return (
      '派遣一个子代理独立执行只读调研、批量搜索、跨文件查找或试错探索。' +
      '不要委派理解或让子代理自行决定最终实现；主 Agent 必须给出明确范围、期望产物和证据要求。' +
      'fresh 从零上下文开始，必须提供完整 brief；fork 继承经 Core 净化的父系统契约和对话事实，只需聚焦具体子任务；resume 通过 manage_subagent 恢复原 Task。' +
      '计划模式下只允许具备只读探索权限的子代理，并必须填写 scope_limit、expected_output、evidence_required；写入型子代理仍被禁止。' +
      '多项互不依赖的任务可在同一回合并发派遣；失败后诊断原因，不要盲目重复同一派遣。'
    )
  }

  override get parameters() {
    const agentType = {
      ...S('子代理类型，必须是 enum 中列出的可用类型之一'),
      enum: this.subagentRegistry.names({ includeAliases: true }),
    } as ParamSchema
    return toolParamsSchema(
      {
        agent_type: agentType,
        task: S('交代给小太监的差事, 写清要做什么、希望返回什么格式的总结'),
        context_mode: {
          ...S(
            '上下文模式：fresh 从零开始；fork 继承经净化的父上下文。恢复旧 Task 请用 manage_subagent resume。',
          ),
          enum: ['fresh', 'fork'],
          nullable: true,
        } as ParamSchema,
        rationale: {
          ...S('为什么需要派遣该子代理，以及它如何帮助主任务'),
          nullable: true,
        } as ParamSchema,
        known_facts: stringArray(
          'fresh brief 已确认的事实；不要让子代理重复发现这些内容',
        ),
        rejected_approaches: stringArray('已经排除的方案及边界'),
        target_files: stringArray('需要重点读取或修改的相对路径'),
        purpose: {
          ...S('一句话用途标签, 仅用于终端打印'),
          nullable: true,
        } as ParamSchema,
        expected_output: {
          ...S('可选: 希望子代理最终回禀的具体产物或格式'),
          nullable: true,
        } as ParamSchema,
        evidence_required: {
          ...S('可选: 需要子代理提供的证据类型, 如文件路径/行号/URL/命令摘要'),
          nullable: true,
        } as ParamSchema,
        scope_limit: {
          ...S('可选: 明确禁止越界的范围, 如只读/不改文件/只看某目录'),
          nullable: true,
        } as ParamSchema,
        mode: {
          ...S(
            '执行方式：foreground 随父回合等待；background 立即返回 Task ID',
          ),
          enum: ['foreground', 'background'],
          nullable: true,
        } as ParamSchema,
        ttl_ms: {
          type: ['integer', 'null'],
          description: '可选运行时限；超时后 Supervisor 取消 Task',
          minimum: 1,
          maximum: 1800000,
        } as ParamSchema,
        workspace_mode: {
          ...S('workspace 隔离方式；worktree 仅在 capability 可用时允许'),
          enum: ['shared', 'worktree'],
          nullable: true,
        } as ParamSchema,
      },
      ['agent_type', 'task'],
    )
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    const spec = this.subagentRegistry.get(String(args.agent_type ?? ''))
    if (!spec?.planReadonlyExplorer) return false
    return missingPlanContract(args).length === 0
  }

  override isDestructive(args: Record<string, unknown>): boolean {
    return !this.isReadOnly(args)
  }

  override async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const agentType = String(args.agent_type ?? '')
    const task = String(args.task ?? '')
    const contextMode = normalizeContextMode(args.context_mode)
    const spec = this.subagentRegistry.get(agentType)
    if (!spec) {
      return `Error: unknown subagent '${agentType}'. Available: ${this.subagentRegistry.names({ includeAliases: true })}`
    }
    const planError = this.planExplorationError(spec, args)
    if (planError) return planError
    if (this.supervisor && this.taskManager) {
      try {
        const launched = await this.launchSupervised(spec, args, ctx)
        if (launched.mode === 'background')
          return `Subagent background task started: ${launched.task.id}. Use manage_subagent with wait/read_output/cancel/resume to control it.`
        const terminal = await this.supervisor.wait<string>(launched.task.id)
        return dispatchTerminalResult(terminal, agentType)
      } catch (error) {
        return `Error: subagent '${agentType}' raised: ${error}`
      }
    }

    const subRegistry = this.registryForSpec(spec)
    const subagentTask = composeSubagentTask(task, {
      contextMode,
      rationale: asOptional(args.rationale),
      knownFacts: asStringArray(args.known_facts),
      rejectedApproaches: asStringArray(args.rejected_approaches),
      targetFiles: asStringArray(args.target_files),
      expectedOutput: asOptional(args.expected_output),
      evidenceRequired: asOptional(args.evidence_required),
      scopeLimit: asOptional(args.scope_limit),
    })
    const workspaceRoot = ctx?.workspaceRoot ?? ctx?.root ?? process.cwd()
    const agentId = `subagent_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const turnId = `subagent_turn_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const history = buildSubagentHistory(
      contextMode,
      ctx?.parentContext,
      subagentTask,
    )
    let taskRecord: TaskRecord | null = null
    let hookScopeStarted = false

    try {
      if (this.hooks && spec.definition.hooks.allow.includes('SubagentStart')) {
        const start = await this.hooks.begin({
          agentId,
          agentType: spec.name,
          sessionId: ctx?.sessionId ?? '',
          cwd: workspaceRoot,
        })
        hookScopeStarted = true
        if (start.additionalContext.trim()) {
          history.unshift({
            role: 'system',
            content: `[SubagentStart hook context]\n${start.additionalContext}`,
            ui_hidden: true,
          })
        }
      }
      if (this.taskManager) {
        taskRecord = await this.taskManager.startTaskWithHooks({
          kind: TaskKind.SUBAGENT,
          title: asOptional(args.purpose) || task.slice(0, 80),
          source: 'dispatch_subagent',
          turnId,
          toolCallId: ctx?.parentCallId ?? null,
          sessionId: ctx?.sessionId ?? null,
          metadata: {
            ...agentDefinitionMetadata(spec),
            agent_type: agentType,
            agent_id: agentId,
            turn_id: turnId,
            subagent_name: spec.name,
            plan_readonly_explorer: spec.planReadonlyExplorer,
            scope_limit: asOptional(args.scope_limit) || '',
            expected_output: asOptional(args.expected_output) || '',
            evidence_required: asOptional(args.evidence_required) || '',
            context_mode: contextMode,
          },
        })
        if (!taskRecord)
          return `Error: subagent '${agentType}' task creation denied by hook`
        this.taskManager.appendSidechain(taskRecord.id, history.at(-1)!)
      }

      const runner = this.runnerFactory({
        spec,
        subRegistry,
        task: subagentTask,
        workspaceRoot,
        agentId,
        taskId: taskRecord?.id,
        turnId,
        sessionId: ctx?.sessionId ?? null,
        executionEnvironment: ctx?.executionEnvironment ?? null,
        contextMode,
        parentSystemPrompt:
          contextMode === 'fork' ? (ctx?.parentSystemPrompt ?? null) : null,
      })

      if (this.taskRuntime && this.taskManager && taskRecord) {
        const taskId = taskRecord.id
        const handle = this.taskRuntime.launch({
          task: taskRecord,
          parentSignal: ctx?.signal ?? null,
          execute: ({ signal }) => runner.step(history, { signal }),
          complete: async (final, expectedRevision) => {
            const current = this.taskManager!.store.get(taskId)
            if (!current || current.revision !== expectedRevision)
              throw new TaskStoreConflictError()
            this.taskManager!.appendSidechain(taskId, {
              role: 'assistant',
              content: final,
            })
            return await this.taskManager!.completeTaskWithHooks(taskId, {
              summary: final.slice(0, 500),
              expectedRevision,
            })
          },
          fail: (error, expectedRevision) =>
            this.taskManager!.failTask(taskId, {
              error: String(error),
              expectedRevision,
            }),
        })
        await ctx?.emit?.(
          runtimeEvents.taskStarted(
            this.taskManager.store.get(taskId)?.toRuntimeDict() ??
              taskRecord.toRuntimeDict(),
          ),
        )
        const terminal = await handle.wait()
        await emitTaskTerminal(ctx, terminal)
        return dispatchTerminalResult(terminal, agentType)
      }

      const final = await runner.step(history, {
        signal: ctx?.signal ?? null,
      })
      if (this.taskManager && taskRecord) {
        const terminal = terminalTaskResult(
          this.taskManager.store.get(taskRecord.id),
          agentType,
        )
        if (terminal) return terminal
        this.taskManager.appendSidechain(taskRecord.id, {
          role: 'assistant',
          content: final,
        })
        const completion = await this.taskManager.completeTaskWithHooks(
          taskRecord.id,
          { summary: final.slice(0, 500) },
        )
        if (completion && !completion.committed) {
          return `Error: subagent '${agentType}' completion denied by hook: ${completion.reason}`
        }
      }
      return final
    } catch (error) {
      if (this.taskManager && taskRecord) {
        const terminal = terminalTaskResult(
          this.taskManager.store.get(taskRecord.id),
          agentType,
        )
        if (terminal) return terminal
        this.taskManager.failTask(taskRecord.id, { error: String(error) })
      }
      return `Error: subagent '${agentType}' raised: ${error}`
    } finally {
      if (hookScopeStarted) this.hooks?.end(agentId)
    }
  }

  private planExplorationError(
    spec: SubagentSpec,
    args: Record<string, unknown>,
  ): string {
    if (String(this.controlManager?.mode ?? '') !== 'plan') return ''
    if (!spec.planReadonlyExplorer) {
      return 'Error: Plan mode only allows dispatch_subagent for registry-marked read-only explorer subagents.'
    }
    const missing = missingPlanContract(args)
    if (missing.length) {
      return `Error: Plan mode dispatch_subagent requires explicit ${PLAN_CONTRACT_FIELDS.join(', ')}. Missing: ${missing.join(', ')}.`
    }
    return ''
  }

  private async launchSupervised(
    spec: SubagentSpec,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext | undefined,
    resumeOpts: {
      sourceTaskId?: string | null
      mode?: SubagentExecutionMode
      ttlMs?: number
    } = {},
  ): Promise<SubagentLaunchResult<string>> {
    if (!this.supervisor || !this.taskManager)
      throw new Error('subagent supervisor is unavailable')
    const planError = this.planExplorationError(spec, args)
    if (planError) throw new Error(planError)
    const subRegistry = this.registryForSpec(spec)
    const subagentTask = composeSubagentTask(String(args.task ?? ''), {
      contextMode: normalizeContextMode(args.context_mode),
      rationale: asOptional(args.rationale),
      knownFacts: asStringArray(args.known_facts),
      rejectedApproaches: asStringArray(args.rejected_approaches),
      targetFiles: asStringArray(args.target_files),
      expectedOutput: asOptional(args.expected_output),
      evidenceRequired: asOptional(args.evidence_required),
      scopeLimit: asOptional(args.scope_limit),
    })
    const sourceWorkspace = ctx?.workspaceRoot ?? ctx?.root ?? process.cwd()
    const sessionId = String(ctx?.sessionId ?? '').trim() || 'session:unbound'
    const agentId = `subagent_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const turnId = `subagent_turn_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const contextMode = normalizeContextMode(args.context_mode)
    const history = buildSubagentHistory(
      contextMode,
      ctx?.parentContext,
      subagentTask,
    )
    let hookScopeStarted = false
    if (this.hooks && spec.definition.hooks.allow.includes('SubagentStart')) {
      const start = await this.hooks.begin({
        agentId,
        agentType: spec.name,
        sessionId,
        cwd: sourceWorkspace,
      })
      hookScopeStarted = true
      if (start.additionalContext.trim())
        history.unshift({
          role: 'system',
          content: `[SubagentStart hook context]\n${start.additionalContext}`,
          ui_hidden: true,
        })
    }
    const requestedMode = String(args.mode ?? '')
    const mode =
      resumeOpts.mode ??
      (requestedMode === 'background' ? 'background' : 'foreground')
    const requestedTtl = Number(args.ttl_ms)
    const ttlMs =
      resumeOpts.ttlMs ??
      (Number.isFinite(requestedTtl) && requestedTtl > 0
        ? Math.trunc(requestedTtl)
        : undefined)
    const workspaceMode =
      String(args.workspace_mode ?? '') === 'worktree' ? 'worktree' : 'shared'
    const savedArgs = { ...args }
    let managedTaskId: string | null = null
    try {
      const launched = await this.supervisor.launch<string>({
        title: asOptional(args.purpose) || String(args.task ?? '').slice(0, 80),
        sessionId,
        agentType: spec.name,
        agentId,
        turnId,
        toolCallId: ctx?.parentCallId ?? null,
        parentTaskId: String(ctx?.turnId ?? '').trim() || null,
        parentDepth: Math.max(0, Math.trunc(Number(ctx?.subagentDepth ?? 0))),
        mode,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        workspace: { mode: workspaceMode, root: sourceWorkspace },
        parentSignal: ctx?.signal ?? null,
        resumedFromTaskId: resumeOpts.sourceTaskId ?? null,
        metadata: {
          ...agentDefinitionMetadata(spec),
          subagent_name: spec.name,
          plan_readonly_explorer: spec.planReadonlyExplorer,
          max_turns: spec.maxTurns,
          scope_limit: asOptional(args.scope_limit),
          expected_output: asOptional(args.expected_output),
          evidence_required: asOptional(args.evidence_required),
          context_mode: contextMode,
        },
        execute: async ({ signal, taskId, workspaceRoot }) => {
          managedTaskId = taskId
          this.taskManager!.appendSidechain(taskId, history.at(-1)!)
          const runner = this.runnerFactory({
            spec,
            subRegistry,
            task: subagentTask,
            workspaceRoot,
            agentId,
            taskId,
            turnId,
            sessionId,
            executionEnvironment: ctx?.executionEnvironment ?? null,
            contextMode,
            parentSystemPrompt:
              contextMode === 'fork' ? (ctx?.parentSystemPrompt ?? null) : null,
          })
          return await runner.step(history, { signal })
        },
        complete: async (final, expectedRevision) => {
          const taskId = managedTaskId
          if (!taskId) throw new TaskStoreConflictError()
          const current = this.taskManager!.store.get(taskId)
          if (!current || current.revision !== expectedRevision)
            throw new TaskStoreConflictError()
          this.taskManager!.appendSidechain(taskId, {
            role: 'assistant',
            content: final,
          })
          return await this.taskManager!.completeTaskWithHooks(taskId, {
            summary: final.slice(0, 500),
            expectedRevision,
          })
        },
        fail: (error, expectedRevision) => {
          const taskId = managedTaskId
          if (!taskId) throw new TaskStoreConflictError()
          return this.taskManager!.failTask(taskId, {
            error: String(error),
            expectedRevision,
          })
        },
        notify: ctx?.emit ?? undefined,
        onSettled: () => {
          if (hookScopeStarted) this.hooks?.end(agentId)
          hookScopeStarted = false
        },
        resume: async (source, options: SubagentResumeOptions) =>
          await this.launchSupervised(
            spec,
            savedArgs,
            ctx
              ? {
                  ...ctx,
                  signal: null,
                  parentCallId: source.tool_call_id,
                  subagentDepth: 0,
                }
              : {
                  root: sourceWorkspace,
                  workspaceRoot: sourceWorkspace,
                  arguments: savedArgs,
                  signal: null,
                  parentCallId: source.tool_call_id,
                  sessionId,
                  subagentDepth: 0,
                },
            {
              sourceTaskId: source.id,
              mode:
                options.mode ??
                (source.metadata.subagent_mode === 'background'
                  ? 'background'
                  : 'foreground'),
              ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
            },
          ),
      })
      await ctx?.emit?.(
        runtimeEvents.taskStarted(launched.task.toRuntimeDict()),
      )
      return launched
    } catch (error) {
      if (hookScopeStarted) this.hooks?.end(agentId)
      throw error
    }
  }

  private registryForSpec(spec: SubagentSpec): ToolRegistry {
    const names = new Set(spec.toolNames)
    for (const definition of this.parentRegistry.getDefinitions()) {
      const tool = this.parentRegistry.get(definition.name)
      if (tool && allowedMcpTool(spec, definition.name, tool))
        names.add(definition.name)
    }
    const registry = new ToolRegistry()
    for (const name of names) {
      const tool = this.parentRegistry.get(name)
      if (tool) registry.register(new AgentPolicyTool(tool, spec))
    }
    return registry
  }
}

class AgentPolicyTool extends Tool {
  override readonly name: string
  override readonly description: string
  override readonly parameters: ToolParamsSchema
  private readonly delegate: Tool
  private readonly spec: SubagentSpec

  constructor(delegate: Tool, spec: SubagentSpec) {
    super()
    this.delegate = delegate
    this.spec = spec
    this.name = delegate.name
    this.description = delegate.description
    this.parameters = delegate.parameters
    this.readOnly = delegate.readOnly
    this.exclusive = delegate.exclusive
    this.requiresRuntimeContext = delegate.requiresRuntimeContext
    this.maxResultChars = delegate.maxResultChars
    this.concurrencySafe = delegate.concurrencySafe
    this.evidencePolicy = delegate.evidencePolicy
    this.classifiesStringErrors = delegate.classifiesStringErrors
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return this.delegate.isReadOnly(args)
  }

  override isDestructive(args?: Record<string, unknown>): boolean {
    return this.delegate.isDestructive(args)
  }

  override isConcurrencySafe(args?: Record<string, unknown>): boolean {
    return this.delegate.isConcurrencySafe(args)
  }

  override mutatesWorkspace(args: Record<string, unknown>): boolean {
    return this.delegate.mutatesWorkspace(args)
  }

  override getPath(args: Record<string, unknown>): string | null {
    return this.delegate.getPath?.(args) ?? null
  }

  override getPaths(args: Record<string, unknown>): string[] {
    if (this.delegate.getPaths) return this.delegate.getPaths(args)
    const path = this.delegate.getPath?.(args)
    return path ? [path] : []
  }

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> | ToolExecutionResult {
    const denial = agentPolicyDenial(this.delegate, this.spec, args)
    return denial ?? this.delegate.execute(args, ctx)
  }

  override mapResult(raw: string, ctx: ToolExecutionContext): ToolResult {
    return this.delegate.mapResult(raw, ctx)
  }
}

function agentPolicyDenial(
  tool: Tool,
  spec: SubagentSpec,
  args: Record<string, unknown>,
): string | null {
  const definition = spec.definition
  if (tool.name === 'load_skill') {
    const name = String(args.name ?? '').trim()
    const allowed = definition.skills.allow
    if (!allowed.includes('*') && !allowed.includes(name))
      return `[ERR] AgentDefinition denied Skill: ${safePolicyLabel(name)}`
  }
  if (isMcpTool(tool.name) && !allowedMcpTool(spec, tool.name, tool))
    return `[ERR] AgentDefinition denied MCP tool: ${safePolicyLabel(tool.name)}`
  if (definition.sandbox.process === 'deny' && tool.name === 'run_command')
    return '[ERR] AgentDefinition sandbox denied process execution'
  if (
    definition.sandbox.network === 'deny' &&
    (tool.name === 'web_fetch' || isMcpTool(tool.name))
  )
    return `[ERR] AgentDefinition sandbox denied network tool: ${safePolicyLabel(tool.name)}`
  if (definition.sandbox.filesystem === 'read-only' && tool.isDestructive(args))
    return `[ERR] AgentDefinition read-only sandbox denied destructive tool: ${safePolicyLabel(tool.name)}`
  return null
}

function allowedMcpTool(
  spec: SubagentSpec,
  toolName: string,
  tool?: Tool,
): boolean {
  if (!isMcpTool(toolName)) return false
  const exactServer = String(
    (tool as { mcpServerName?: unknown } | undefined)?.mcpServerName ?? '',
  ).trim()
  if (exactServer) return spec.definition.mcp.servers.includes(exactServer)
  return spec.definition.mcp.servers.some((server) =>
    toolName.startsWith(`mcp_${server}_`),
  )
}

function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp_')
}

function safePolicyLabel(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 128)
  return cleaned || 'unknown'
}

export function composeSubagentTask(
  task: string,
  opts: {
    contextMode?: SubagentContextMode
    rationale?: string | null
    knownFacts?: string[]
    rejectedApproaches?: string[]
    targetFiles?: string[]
    expectedOutput?: string | null
    evidenceRequired?: string | null
    scopeLimit?: string | null
  } = {},
): string {
  const contextMode = opts.contextMode === 'fork' ? 'fork' : 'fresh'
  const contract: string[] = []
  contract.push(`- 目标: ${task.trim()}`)
  if (opts.rationale) contract.push(`- 原因: ${opts.rationale}`)
  if (opts.knownFacts?.length)
    contract.push(`- 已知事实: ${opts.knownFacts.join('；')}`)
  if (opts.rejectedApproaches?.length)
    contract.push(`- 已排除方案: ${opts.rejectedApproaches.join('；')}`)
  if (opts.targetFiles?.length)
    contract.push(`- 目标文件: ${opts.targetFiles.join('、')}`)
  if (opts.expectedOutput) contract.push(`- 期望产物: ${opts.expectedOutput}`)
  if (opts.evidenceRequired)
    contract.push(`- 证据要求: ${opts.evidenceRequired}`)
  if (opts.scopeLimit) contract.push(`- 范围限制: ${opts.scopeLimit}`)
  contract.push(
    contextMode === 'fork'
      ? '- 只处理本 brief 的聚焦目标；父上下文仅作为事实背景，不得擅自扩展范围。'
      : '- 你从零上下文开始；不得假定看过主对话，缺失事实必须自行用允许的工具核验。',
  )
  contract.push('- 最终只返回可合并的结论和证据，不回放完整工具 transcript。')
  return `## ${contextMode === 'fork' ? 'Fork Agent Task' : 'Fresh Agent Brief'}\n${contract.join('\n')}`
}

export function extractEvidenceRefs(text: string): string[] {
  const refs: string[] = []
  for (const match of String(text || '').matchAll(EVIDENCE_FILE_RE)) {
    const ref = String(match[1] ?? '')
      .trim()
      .replace(/[.,;，。；)]+$/g, '')
    if (!ref || ref.startsWith('http://') || ref.startsWith('https://'))
      continue
    refs.push(ref)
  }
  return dedupe(refs)
}

export function extractEvidenceFiles(evidenceRefs: string[]): string[] {
  return dedupe(
    evidenceRefs
      .filter((ref) => !ref.startsWith('task:'))
      .map((ref) => ref.split(':', 1)[0]!),
  )
}

export function summarizeExploration(text: string, limit = 500): string {
  const summary = String(text || '')
    .trim()
    .split(/\s+/)
    .join(' ')
  return summary.length <= limit
    ? summary
    : `${summary.slice(0, limit - 3).trimEnd()}...`
}

function missingPlanContract(args: Record<string, unknown>): string[] {
  return PLAN_CONTRACT_FIELDS.filter(
    (field) => !String(args[field] ?? '').trim(),
  )
}

function asOptional(value: unknown): string {
  return String(value ?? '').trim()
}

function stringArray(description: string): ParamSchema {
  return {
    type: 'array',
    description,
    items: S(description),
    nullable: true,
  } as ParamSchema
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return dedupe(
    value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, 32),
  )
}

function normalizeContextMode(
  value: unknown,
): Exclude<SubagentContextMode, 'resume'> {
  return String(value ?? '').trim() === 'fork' ? 'fork' : 'fresh'
}

function buildSubagentHistory(
  mode: Exclude<SubagentContextMode, 'resume'>,
  parentContext: Array<Record<string, unknown>> | undefined,
  task: string,
): Array<Record<string, unknown>> {
  const focusedTask = { role: 'user', content: task }
  if (mode !== 'fork') return [focusedTask]
  return [...normalizeForkParentContext(parentContext), focusedTask]
}

function normalizeForkParentContext(
  parentContext: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(parentContext)) return []
  const normalized: Array<Record<string, unknown>> = []
  for (const message of parentContext.slice(-48)) {
    const role = String(message.role ?? '')
    if (role !== 'user' && role !== 'assistant') continue
    if (message.ui_hidden === true) continue
    if (role === 'assistant' && Array.isArray(message.tool_calls)) continue
    const content = String(message.content ?? '').trim()
    if (!content || content.startsWith('[CONTROL:')) continue
    normalized.push({
      role,
      content: content.length > 8_000 ? `${content.slice(0, 8_000)}…` : content,
    })
  }
  return normalized.slice(-24)
}

function agentDefinitionMetadata(spec: SubagentSpec): Record<string, unknown> {
  return {
    agent_definition_revision: spec.revision,
    agent_source_id: spec.source.id,
    agent_source_kind: spec.source.kind,
    agent_source_trust: spec.source.trust,
  }
}

function terminalTaskResult(
  record: TaskRecord | null | undefined,
  agentType: string,
): string {
  if (!record) return ''
  if (record.status === TaskStatus.CANCELLED) {
    const reason = String(record.progress.reason ?? 'cancelled')
    return `Error: subagent '${agentType}' task cancelled: ${reason}`
  }
  if (
    record.status === TaskStatus.COMPLETED ||
    record.status === TaskStatus.FAILED
  ) {
    return `Error: subagent '${agentType}' task already ${record.status}; result ignored.`
  }
  return ''
}

function dispatchTerminalResult(
  terminal: TaskTerminalResult<string> | undefined,
  agentType: string,
): string {
  if (!terminal)
    return `Error: subagent '${agentType}' task ended without a terminal result.`
  if (terminal.status === TaskStatus.COMPLETED)
    return String(terminal.value ?? terminal.record.progress.summary ?? '')
  if (terminal.status === TaskStatus.CANCELLED) {
    const reason = terminal.reason ?? terminal.record.progress.reason
    return `Error: subagent '${agentType}' task cancelled: ${String(reason ?? 'cancelled')}`
  }
  if (terminal.status === TaskStatus.INTERRUPTED)
    return `Error: subagent '${agentType}' task interrupted: ${String(terminal.error ?? terminal.record.progress.reason ?? 'runtime interrupted')}`
  return `Error: subagent '${agentType}' raised: ${String(terminal.error ?? terminal.record.progress.error ?? terminal.status)}`
}

async function emitTaskTerminal(
  ctx: ToolExecutionContext | undefined,
  terminal: TaskTerminalResult<string> | undefined,
): Promise<void> {
  if (!ctx?.emit || !terminal) return
  const task = terminal.record.toRuntimeDict()
  if (terminal.status === TaskStatus.COMPLETED) {
    await ctx.emit(runtimeEvents.taskDone(task))
    return
  }
  if (terminal.status === TaskStatus.CANCELLED) {
    await ctx.emit(
      runtimeEvents.taskCancelled(task, {
        reason:
          terminal.reason ?? String(terminal.record.progress.reason ?? ''),
      }),
    )
    return
  }
  await ctx.emit(
    runtimeEvents.taskError(task, {
      error: String(
        terminal.error ??
          terminal.record.progress.error ??
          terminal.record.progress.reason ??
          terminal.status,
      ),
    }),
  )
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const text = String(item || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}
