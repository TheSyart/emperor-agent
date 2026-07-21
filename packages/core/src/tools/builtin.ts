/**
 * RunCommand scaffold (MIG-TOOL-011) + skills (MIG-TOOL-012)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { applyUserProfileMarkdownPatch } from '../memory/user-profile'
import type { MemoryVersionStore } from '../memory/versions'
import {
  NodeOwnedProcessRunner,
  type OwnedProcessResult,
  type OwnedProcessRunner,
} from '../environment/process-runner'
import type { ProcessContainmentReceipt } from '../environment/sandbox'
import {
  formatWorkspacePolicyError,
  workspacePolicyForTool,
} from '../permissions/workspace-policy'
import { Tool, type ToolResult, type ToolExecutionContext } from './base'
import { S, toolParamsSchema } from './schema'
import { isReadonlyCommand } from './resolvers'
import { pathsEqual } from '../util/paths'

export { GlobTool, GrepTool } from './search'
export { WebFetch } from './web-fetch'

/** 安全策略拒绝文案前缀：execution 引擎据此给 tool_run_failed 打 reason_kind（B4.3）。 */
export const SAFETY_REFUSAL_PREFIX = 'Error: command refused by safety policy'

// ── LoadSkill ──

export interface SkillsLoader {
  getContent(name: string): string | null
  summary(): string
}

type SkillsLoaderProvider =
  SkillsLoader | ((sessionId?: string | null) => SkillsLoader | null)

export class LoadSkill extends Tool {
  override name = 'load_skill'
  override description =
    '按名称加载指定 Skill 的详细知识内容。用户显式选择 Skill 或任务明显匹配某个 Skill 时先调用；不要绕过本工具直接 read_file 读取 SKILL.md。' +
    '加载失败时报告缺失或名称不匹配，不要编造 Skill 内容。'
  override parameters = toolParamsSchema({ name: S('Skill 名称') }, ['name'])
  override readOnly = true
  override evidencePolicy = 'forbidden' as const

  private readonly loaderProvider: SkillsLoaderProvider | null

  constructor(loader?: SkillsLoaderProvider) {
    super()
    this.loaderProvider = loader ?? null
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const name = String(args.name ?? '')
    const loader =
      typeof this.loaderProvider === 'function'
        ? this.loaderProvider(ctx?.sessionId)
        : this.loaderProvider
    if (!loader) return '[ERR] no skills loader configured'
    const c = loader.getContent(name)
    return c ?? `[ERR] skill "${name}" not found`
  }
}

// ── UpdateTodos ──

export interface TodoItem {
  id: number | string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  activeForm?: string
  planStepId?: string
}

const TODO_VALID_STATUS = ['pending', 'in_progress', 'completed', 'blocked']
const TODO_STATUS_ICON: Record<string, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  blocked: '[!]',
}
const TODO_VERIFICATION_PATTERN =
  /\b(verif(?:y|ication)?|test(?:s|ing)?|review(?:er)?)\b|验证|校验|测试|复核/i

function renderTodos(todos: Array<Record<string, unknown>>): string {
  if (!todos.length) return '(当前无待办事项)'
  const lines: string[] = []
  for (const t of todos) {
    const icon = TODO_STATUS_ICON[String(t.status ?? 'pending')] ?? '[?]'
    let label = String(t.content ?? '')
    if (t.status === 'in_progress' && t.active_form)
      label = String(t.active_form ?? '')
    lines.push(`  ${icon} ${t.id}. ${label}`)
  }
  return lines.join('\n')
}

/**
 * 跨用户回合存活的待办列表。对齐 Claude Code TodoWrite/TaskUpdate 语义：
 * update_todos 只维护当前会话清单，不写 PlanStep、不验证实现正确性。
 */
export class TodoStore {
  todos: Array<Record<string, unknown>> = []
  revision = 0
  private readonly onChange:
    ((todos: Array<Record<string, unknown>>) => void) | null

  constructor(
    onChange: ((todos: Array<Record<string, unknown>>) => void) | null = null,
  ) {
    this.onChange = onChange
  }

  update(items: Array<Record<string, unknown>>): string {
    const cleaned: Array<Record<string, unknown>> = []
    items.forEach((t, idx) => {
      const i = idx + 1
      const content = String(t.content ?? '').trim()
      if (!content) return
      let status = String(t.status ?? 'pending')
      if (!TODO_VALID_STATUS.includes(status)) status = 'pending'
      const item: Record<string, unknown> = { id: t.id ?? i, content, status }
      const planId = String(t.plan_id ?? t.planId ?? '').trim()
      if (planId) item.plan_id = planId.slice(0, 96)
      const planStepId = String(t.plan_step_id ?? t.planStepId ?? '').trim()
      if (planStepId) item.plan_step_id = planStepId.slice(0, 64)
      const approvalGeneration = Number(
        t.approval_generation ?? t.approvalGeneration,
      )
      if (Number.isInteger(approvalGeneration) && approvalGeneration > 0)
        item.approval_generation = approvalGeneration
      const activeForm = String(t.active_form ?? t.activeForm ?? '').trim()
      if (activeForm) item.active_form = activeForm.slice(0, 240)
      const blockedReason = String(
        t.blocked_reason ?? t.blockedReason ?? '',
      ).trim()
      if (blockedReason) item.blocked_reason = blockedReason.slice(0, 1000)
      cleaned.push(item)
    })

    const inProgressCount = cleaned.filter(
      (t) => t.status === 'in_progress',
    ).length
    if (inProgressCount > 1)
      return 'Error: 同一时间只能有一个 in_progress 任务，请重新规划。'

    this.todos = cleaned
    this.revision += 1
    this.onChange?.(this.todos.map((todo) => ({ ...todo })))
    const completed = this.todos.filter((t) => t.status === 'completed').length
    const pending = this.todos.filter((t) => t.status === 'pending').length
    const summary = `todos updated: total=${this.todos.length}, completed=${completed}, in_progress=${inProgressCount}, pending=${pending}`
    const nudge = todoVerificationNudge(this.todos)
    return summary + '\n\n当前列表：\n' + renderTodos(this.todos) + nudge
  }

  /** Legacy projection helper for old tests/importers only; runner mainline must not call this. */
  syncFromPlanSteps(
    steps: Array<Record<string, unknown>>,
    binding?: { planId: string; approvalGeneration: number },
  ): string {
    const statusMap: Record<string, string> = {
      pending: 'pending',
      active: 'in_progress',
      done: 'completed',
      failed: 'pending',
      blocked: 'pending',
      skipped: 'completed',
    }
    const todos: Array<Record<string, unknown>> = []
    steps.forEach((step, idx) => {
      const index = idx + 1
      const title = String(step.title ?? '').trim()
      if (!title) return
      const item: Record<string, unknown> = {
        id: index,
        ...(binding ? { plan_id: binding.planId } : {}),
        plan_step_id: String(step.id ?? '').trim() || null,
        ...(binding ? { approval_generation: binding.approvalGeneration } : {}),
        content: title,
        status: statusMap[String(step.status ?? 'pending')] ?? 'pending',
      }
      if (step.blocked_reason)
        item.blocked_reason = String(step.blocked_reason ?? '').trim()
      todos.push(item)
    })
    return this.update(todos)
  }

  render(): string {
    return renderTodos(this.todos)
  }
}

function todoVerificationNudge(todos: Array<Record<string, unknown>>): string {
  if (todos.length < 3) return ''
  if (!todos.every((t) => t.status === 'completed')) return ''
  if (
    todos.some((t) => TODO_VERIFICATION_PATTERN.test(String(t.content ?? '')))
  )
    return ''
  return '\n\nNOTE: You just completed 3+ tasks and none of them appears to be verification, test, or review work. Before final reporting, run the relevant checks or use an independent verification reviewer when the change is non-trivial.'
}

/**
 * 按 Markdown 章节 patch 更新用户偏好档案（USER.local.md）。用于首次运行访谈落盘，
 * 也供日后任意一次"记住我的偏好"请求随时更新——不是仅在 onboarding 期间可用的一次性脚手架。
 * 路径已由调用方（AgentLoop）解析为状态根下的实际文件，工具本身不做路径推导。
 */
export interface UserProfileWriter {
  readUser?(): string
  writeUser(content: string): void
  userFile?: string
  memoryDir?: string
  versions?: MemoryVersionStore
}

export class SaveUserProfileTool extends Tool {
  override name = 'save_user_profile'
  override description =
    '按 Markdown 章节 patch 更新用户偏好档案（称呼/语言/沟通风格/技术水平/工作背景/兴趣/性格等）。' +
    '只提交需要新增或修改的 ## 章节；未提交的章节会保留，但每个已提交章节必须包含该章节需要保留的完整字段。不要凭空丢弃未涉及字段，删除大量内容会被拒绝。'
  override parameters = toolParamsSchema(
    { content: S('包含要更新 ## 章节的用户档案 Markdown 内容') },
    ['content'],
  )
  override readOnly = false
  override evidencePolicy = 'forbidden' as const

  private readonly writer: UserProfileWriter
  private readonly onSaved: (() => void) | null
  private readonly allowExplicitReplace:
    ((currentContent: string) => boolean) | null

  constructor(
    writer: UserProfileWriter,
    onSaved?: (() => void) | null,
    allowExplicitReplace?: ((currentContent: string) => boolean) | null,
  ) {
    super()
    this.writer = writer
    this.onSaved = onSaved ?? null
    this.allowExplicitReplace = allowExplicitReplace ?? null
  }

  execute(args: Record<string, unknown>): string {
    const content = String(args.content ?? '').trimEnd()
    if (!(
      this.writer.readUser &&
      this.writer.userFile &&
      this.writer.versions
    )) {
      return 'Error: save_user_profile rejected: patch-capable writer is required; direct profile overwrite is disabled.'
    }
    const current = this.writer.readUser()
    const result = applyUserProfileMarkdownPatch(
      content,
      {
        targetPath: this.writer.userFile,
        currentContent: current,
        versions: this.writer.versions,
        memoryDir: this.writer.memoryDir ?? null,
      },
      {
        rationale: 'save_user_profile',
        explicitReplace: this.allowExplicitReplace?.(current) ?? false,
      },
    )
    if (result.errors.includes('missing_profile_sections')) {
      return 'Error: save_user_profile rejected: expected Markdown with at least one ## section heading; preserve the existing profile structure and update only relevant sections.'
    }
    if (!result.ok)
      return `Error: save_user_profile rejected: ${result.errors.join(', ')}`
    this.onSaved?.()
    return `已通过 memory patch 保存用户偏好档案（${result.appliedOperations} 个章节，${content.length} 字符输入）。`
  }
}

export class UpdateTodos extends Tool {
  override name = 'update_todos'
  override description =
    '创建或更新当前会话任务清单。更新清单必须与下一步实际工作的工具调用放在同一个响应里并行发出，禁止单独用一整轮只更新清单。每次传入完整 todos 数组并全量覆盖，用于拆解复杂多步骤任务和展示进度；同一时间最多只能有一个 in_progress 项。' +
    '简单或纯问答任务不需要使用。任务真正完成后及时标记 completed；失败、阻塞或部分完成时保持 in_progress/blocked。该工具只维护清单，不验证实现正确性，也不裁决计划步骤。'
  override parameters = toolParamsSchema(
    {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: ['string', 'number'], description: '任务ID' },
            content: S('任务内容'),
            status: S('pending|in_progress|completed|blocked'),
            activeForm: S('进行时标签'),
            planId: S('关联计划；Goal Plan 投影时必填'),
            planStepId: S('关联计划步骤；Goal Plan 投影时必填'),
            approvalGeneration: {
              type: 'integer',
              description: '关联计划的审批代次；Goal Plan 投影时必填',
            },
          },
          description: '任务项',
        },
        description: '完整任务列表',
      },
    },
    ['todos'],
  )
  override readOnly = false
  override evidencePolicy = 'forbidden' as const
  override exclusive = true

  private readonly storeProvider:
    TodoStore | ((sessionId?: string | null) => TodoStore | null)

  constructor(
    store: TodoStore | ((sessionId?: string | null) => TodoStore | null),
  ) {
    super()
    this.storeProvider = store
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const todos = (args.todos as Array<Record<string, unknown>>) ?? []
    const store =
      typeof this.storeProvider === 'function'
        ? this.storeProvider(ctx?.sessionId)
        : this.storeProvider
    if (!store) return 'Error: session todo store is unavailable'
    return store.update(todos)
  }
}

// ── RunCommand ──

const DENY_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\bmkfs\./,
  /\bdd\s+if=/,
  /:\s*\(\s*\)\s*\{/,
  />\s*\/dev\/sda/,
  />\s*\/dev\/nvme/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bpython3?\s+-c\b/,
  /\|.*\bsh\b/,
  /\|.*\bbash\b/,
  // 审计 P1-1：ln -s 是符号链接工作区逃逸（P0-2）的前置步骤；其余解释器的 -e
  // 直接执行任意代码，属于和 python -c 同一类的绕过。
  /\bln\s+-[a-z]*s[a-z]*\b/,
  /\bperl\s+-e\b/,
  /\bruby\s+-e\b/,
  /\bnode\s+-e\b/,
  /\bosascript\s+-e\b/,
]

const MAX_OUTPUT_CHARS = 20_000

interface RunCommandExecutionOutcome {
  stdout: string
  stderr: string
  error:
    | (Error & {
        code?: string | number | null
        signal?: string | null
        killed?: boolean
      })
    | null
}

export class RunCommand extends Tool {
  override name = 'run_command'
  override description =
    '在当前工作区终端执行一条 shell 命令并返回输出；rm -rf /、curl/wget、python -c、管道到 sh/bash 等危险模式会被安全策略直接拒绝。' +
    '仅用于测试、构建、git、包管理器或必须由 shell 执行的系统操作；不要用它读写搜文件或向用户输出文本。' +
    '命令运行在受限的最小环境变量（仅 HOME/PATH/LANG 等）下；OS sandbox 默认只允许 workspace 与隔离临时目录写入并阻断网络。' +
    '未证明只读的命令在 sandbox backend 不可用时会 fail closed；单条命令超过 120 秒会被硬超时中断。' +
    '失败后先阅读 stdout/stderr 诊断根因，不要盲目重试或绕过安全检查。'
  override parameters = toolParamsSchema(
    { command: S('要执行的 shell 命令') },
    ['command'],
  )
  override exclusive = true
  override requiresRuntimeContext = true
  override evidencePolicy = 'eligible' as const
  override maxResultChars = 12_000

  private readonly workspace: string
  private readonly ownedRunner: OwnedProcessRunner

  constructor(
    root: string,
    options: {
      readonly ownedRunner?: OwnedProcessRunner
    } = {},
  ) {
    super()
    this.workspace = root
    this.ownedRunner = options.ownedRunner ?? new NodeOwnedProcessRunner()
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const command = String(args.command ?? '')
    const workspace = ctx?.workspaceRoot ?? ctx?.root ?? this.workspace
    const cwdDecision = workspacePolicyForTool(ctx, this.workspace).resolvePath(
      '.',
      'execute',
      { baseRoot: workspace },
    )
    if (!cwdDecision.allowed) {
      const content = `Error: command cwd blocked by workspace policy: ${formatWorkspacePolicyError(cwdDecision)}`
      return this.policyFailureResult(command, content)
    }
    for (const pat of DENY_PATTERNS) {
      if (pat.test(command)) {
        const content =
          `${SAFETY_REFUSAL_PREFIX} (matches dangerous pattern: ${pat})\n` +
          '替代方案：改用具备明确安全边界的专用工具；若确需执行，请说明影响并请求用户明确批准。不要重试同类命令或尝试绕过安全检查。'
        return this.policyFailureResult(command, content)
      }
    }
    let outcome: RunCommandExecutionOutcome
    let containment: ProcessContainmentReceipt | null = null
    try {
      const snapshotEnv = ctx?.executionEnvironment?.env
      const env: Record<string, string> = snapshotEnv
        ? {
            ...snapshotEnv,
            LANG: snapshotEnv.LANG ?? 'C.UTF-8',
            TERM: snapshotEnv.TERM ?? 'dumb',
          }
        : {
            HOME: process.env.HOME ?? '',
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            TERM: 'dumb',
            USER: process.env.USER ?? '',
          }
      const tempRoot = mkdtempSync(join(tmpdir(), 'emperor-command-'))
      try {
        const owned = await this.ownedRunner.run({
          executable:
            process.platform === 'win32'
              ? process.env.ComSpec || 'cmd.exe'
              : '/bin/sh',
          args:
            process.platform === 'win32'
              ? ['/d', '/s', '/c', command]
              : ['-c', command],
          cwd: cwdDecision.realPath,
          env: {
            ...env,
            TMPDIR: tempRoot,
            TMP: tempRoot,
            TEMP: tempRoot,
          },
          timeoutMs: 120_000,
          maxOutputBytes: MAX_OUTPUT_CHARS * 4,
          owner: {
            kind: ctx?.taskId ? 'task' : 'session',
            id: String(
              ctx?.taskId || ctx?.sessionId || ctx?.turnId || 'unbound-session',
            ),
            sessionId: ctx?.sessionId ?? null,
          },
          ...(ctx?.signal ? { signal: ctx.signal } : {}),
          onContainment: async (receipt) =>
            await emitContainmentReceipt(ctx, receipt),
          containment: {
            mode: 'required',
            workspaceRoot: cwdDecision.realPath,
            stateRoot:
              ctx?.root && !pathsEqual(ctx.root, cwdDecision.realPath)
                ? ctx.root
                : null,
            tempRoot,
            readOnlyRoots: commandRuntimeReadRoots(env.PATH),
            network: 'deny',
          },
        })
        containment = owned.containment
        if (
          owned.status === 'containment_unavailable' ||
          containment.decision !== 'sandboxed'
        ) {
          const content = `Error: OS sandbox unavailable; command was not started (${containment.backend}: ${containment.reason || containment.capabilityStatus})`
          return this.policyFailureResult(command, content, containment)
        }
        outcome = ownedProcessOutcome(owned)
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }
    } catch (error) {
      outcome = {
        stdout: '',
        stderr: '',
        error:
          error instanceof Error
            ? error
            : new Error('command execution failed'),
      }
    }
    if (outcome.error === null)
      return this.successResult(
        command,
        outcome.stdout.trim() || '(command completed with no output)',
        containment,
      )
    return this.failedProcessResult(command, outcome, ctx, containment)
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return isReadonlyCommand(String(args.command ?? ''))
  }

  override mapResult(raw: string, ctx: ToolExecutionContext): ToolResult {
    return this.successResult(String(ctx.arguments?.command ?? ''), raw)
  }

  private successResult(
    command: string,
    content: string,
    containment: ProcessContainmentReceipt | null = null,
  ): ToolResult {
    return {
      modelContent: content,
      displaySummary: `run_command exit 0: ${command.slice(0, 120)}`,
      rawContent: content,
      artifacts: [],
      metadata: {
        tool: 'run_command',
        command,
        exitCode: 0,
        signal: null,
        timedOut: false,
        ...(containment ? { containment } : {}),
      },
      isError: false,
    }
  }

  private policyFailureResult(
    command: string,
    content: string,
    containment: ProcessContainmentReceipt | null = null,
  ): ToolResult {
    return {
      modelContent: content,
      displaySummary: `run_command exit non-zero: ${command.slice(0, 120)}`,
      rawContent: content,
      artifacts: [],
      metadata: {
        tool: 'run_command',
        command,
        exitCode: null,
        signal: null,
        timedOut: false,
        ...(containment ? { containment } : {}),
      },
      isError: true,
    }
  }

  private failedProcessResult(
    command: string,
    outcome: RunCommandExecutionOutcome,
    ctx?: ToolExecutionContext,
    containment: ProcessContainmentReceipt | null = null,
  ): ToolResult {
    const error = outcome.error!
    const cancelled = error.name === 'AbortError' || ctx?.signal?.aborted
    const timedOut = error.code === 'ETIMEDOUT' || error.killed === true
    const exitCode =
      typeof error.code === 'number' &&
      Number.isInteger(error.code) &&
      error.code >= 0
        ? error.code
        : null
    const signal = typeof error.signal === 'string' ? error.signal : null
    const body = outcome.stdout || outcome.stderr
    let content: string
    if (cancelled) content = 'Error: command cancelled'
    else if (timedOut) content = 'Error: command timed out after 120 seconds'
    else if (body && exitCode !== null)
      content = `Error (exit ${exitCode}):\n${body}`.trim()
    else if (body) content = `Error: ${error.message}\n${body}`.trim()
    else content = `Error: ${error.message}`
    return {
      modelContent: content.slice(0, MAX_OUTPUT_CHARS),
      displaySummary: timedOut
        ? `run_command timed out: ${command.slice(0, 120)}`
        : `run_command failed: ${content.slice(0, 160)}`,
      rawContent: content.slice(0, MAX_OUTPUT_CHARS),
      artifacts: [],
      metadata: {
        tool: 'run_command',
        command,
        exitCode,
        signal,
        timedOut,
        ...(containment ? { containment } : {}),
      },
      isError: true,
    }
  }
}

function ownedProcessOutcome(
  result: OwnedProcessResult,
): RunCommandExecutionOutcome {
  if (result.status === 'completed' && result.exitCode === 0)
    return { stdout: result.stdout, stderr: result.stderr, error: null }
  const error = new Error(
    result.error ||
      (result.status === 'timeout'
        ? 'command timed out'
        : result.status === 'cancelled'
          ? 'command cancelled'
          : result.status === 'output_limit'
            ? 'command output limit exceeded'
            : result.exitCode !== null
              ? `command exited with code ${result.exitCode}`
              : 'command spawn failed'),
  ) as Error & {
    code?: string | number | null
    signal?: string | null
    killed?: boolean
  }
  if (result.status === 'cancelled') error.name = 'AbortError'
  if (result.status === 'timeout') {
    error.code = 'ETIMEDOUT'
    error.killed = true
  } else if (result.exitCode !== null) error.code = result.exitCode
  if (result.signal) error.signal = result.signal
  return { stdout: result.stdout, stderr: result.stderr, error }
}

function commandRuntimeReadRoots(pathValue: string | undefined): string[] {
  const roots = [dirname(process.execPath)]
  for (const entry of String(pathValue ?? '').split(delimiter)) {
    const value = entry.trim()
    if (value) roots.push(value)
  }
  return [...new Set(roots)]
}

async function emitContainmentReceipt(
  ctx: ToolExecutionContext | undefined,
  receipt: ProcessContainmentReceipt,
): Promise<void> {
  if (!ctx?.emit) return
  await ctx.emit({
    event: 'process_containment',
    id: ctx.parentCallId ?? undefined,
    backend: receipt.backend,
    decision: receipt.decision,
    capability_status: receipt.capabilityStatus,
    filesystem: receipt.filesystem,
    network: receipt.network,
    process_tree: receipt.processTree,
    policy_hash: receipt.policyHash,
    reason: receipt.reason || undefined,
  })
}
