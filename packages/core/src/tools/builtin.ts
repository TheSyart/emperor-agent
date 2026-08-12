/**
 * RunCommand scaffold + skills。
 */
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { applyUserProfileMarkdownPatch } from '../memory/user-profile'
import type { MemoryVersionStore } from '../memory/versions'
import {
  NodeOwnedProcessRunner,
  type OwnedProcessResult,
  type OwnedProcessRunner,
  type OwnedProcessStatus,
} from '../environment/process-runner'
import type { ProcessContainmentReceipt } from '../environment/sandbox'
import {
  formatWorkspacePolicyError,
  workspacePolicyForTool,
} from '../permissions/workspace-policy'
import { Tool, type ToolResult, type ToolExecutionContext } from './base'
import { S, toolParamsSchema } from './schema'
import { isReadonlyCommand } from './resolvers'
import { canonicalizeExistingPath, pathsEqual } from '../util/paths'
import {
  analyzeShellCommandFailClosed,
  shellCatastrophicDestructionReason,
  shellPrivilegeEscalationReason,
} from '../permissions/shell-ast'

export { GlobTool, GrepTool } from './search'
export { WebFetch } from './web-fetch'

/** 安全策略拒绝文案前缀：execution 引擎据此给 tool_run_failed 打 reason_kind（B4.3）。 */
export const SAFETY_REFUSAL_PREFIX = 'Error: command refused by safety policy'

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
      if (t.work_item === true || t.workItem === true) item.work_item = true
      const ownerPlanId = String(t.owner_plan_id ?? t.ownerPlanId ?? '').trim()
      if (ownerPlanId) item.owner_plan_id = ownerPlanId.slice(0, 96)
      const coveredSteps = (
        Array.isArray(t.covers_plan_step_ids)
          ? t.covers_plan_step_ids
          : Array.isArray(t.coversPlanStepIds)
            ? t.coversPlanStepIds
            : []
      )
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .slice(0, 32)
      if (coveredSteps.length) item.covers_plan_step_ids = coveredSteps
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
  override domainStateMutation = true
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
    '为当前会话中至少三个独立执行单元创建或更新额外工作清单。用户给出多项清单、任务跨多个自然阶段或明确要求 Todo 时才使用；单一任务、一个 PlanStep、两个短步骤、纯问答和一次命令禁止调用。' +
    '更新清单必须与下一步实际工作的工具调用放在同一个响应里并行发出，禁止单独用一整轮只更新清单。每次传入完整 todos 数组并全量覆盖；同一时间最多只能有一个 in_progress 项。' +
    'PlanStep 由 Core 管理，不用 Todo 机械镜像；若 Core 在复杂 Plan 中暴露本工具，只使用稳定 ID plan:<stepId>，不得填写或伪造 planId、planStepId、approvalGeneration。任务真正完成后及时标记 completed；失败或阻塞时保持 in_progress/blocked。该工具不验证实现正确性，也不裁决计划步骤。'
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
          },
          description: '任务项',
        },
        description: '完整任务列表',
      },
    },
    ['todos'],
  )
  override readOnly = false
  override domainStateMutation = true
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

const MAX_OUTPUT_CHARS = 20_000

interface RunCommandExecutionOutcome {
  status: OwnedProcessStatus
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

function shellMutationPathCandidates(command: string): string[] {
  const analysis = analyzeShellCommandFailClosed(command)
  if (
    analysis.status !== 'parsed' ||
    analysis.reasonCodes.includes('dynamic_expansion')
  )
    return []
  const paths: string[] = []
  const add = (value: unknown) => {
    const path = String(value ?? '').trim()
    if (path && path !== '-' && path !== '/dev/null' && !paths.includes(path))
      paths.push(path)
  }
  for (const node of analysis.commands) {
    for (const redirect of node.redirects) {
      if (
        redirect.operator.includes('>') &&
        redirect.target !== '__SHELL_DYNAMIC__'
      )
        add(redirect.target)
    }
    const executable = basename(String(node.argv[0] ?? ''))
    if (executable === 'curl') {
      for (let index = 1; index < node.argv.length; index += 1) {
        const argument = String(node.argv[index] ?? '')
        if (argument === '-o' || argument === '--output') {
          add(node.argv[index + 1])
          index += 1
        } else if (argument.startsWith('--output=')) {
          add(argument.slice('--output='.length))
        }
      }
      continue
    }
    if (executable === 'wget') {
      for (let index = 1; index < node.argv.length; index += 1) {
        const argument = String(node.argv[index] ?? '')
        if (argument === '-O' || argument === '--output-document') {
          add(node.argv[index + 1])
          index += 1
        } else if (argument.startsWith('--output-document=')) {
          add(argument.slice('--output-document='.length))
        }
      }
      continue
    }
    const positional = node.argv
      .slice(1)
      .filter(
        (argument) =>
          argument &&
          argument !== '--' &&
          !argument.startsWith('-') &&
          argument !== '__SHELL_DYNAMIC__',
      )
    if (
      executable === 'touch' ||
      executable === 'mkdir' ||
      executable === 'rm' ||
      executable === 'rmdir' ||
      executable === 'unlink' ||
      executable === 'tee'
    ) {
      positional.forEach(add)
    } else if (executable === 'mv') {
      positional.forEach(add)
    } else if (executable === 'cp' || executable === 'install') {
      add(positional.at(-1))
    }
  }
  return paths
}

export class RunCommand extends Tool {
  override name = 'run_command'
  override workspaceMutation = true
  override description =
    '在当前工作区终端执行一条 shell 命令并返回输出；权限层会评估联网、动态代码、解释器和远程脚本链，只有明确的系统提权与灾难性磁盘命令会在执行前硬拒绝。' +
    '仅用于测试、构建、git、包管理器或必须由 shell 执行的系统操作；不要用它读写搜文件或向用户输出文本。' +
    '主 Agent 在非 Plan 模式获准后使用宿主环境（真实 HOME、PATH、用户配置和本机网络）；Plan、子代理和其他隔离执行器继续使用 OS sandbox。' +
    '未证明只读的命令在 sandbox backend 不可用时会 fail closed；单条命令超过 120 秒会被硬超时中断。' +
    '复合命令、pipeline 和 command list 的 exit 0 只证明整个 shell list 的最终状态，安装或修改完成后必须另起一次独立 probe。' +
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
    const processExecution = ctx?.processExecution ?? {
      kind: 'sandbox' as const,
    }
    if (
      processExecution.kind === 'host' &&
      (String(ctx?.arguments?.command ?? '') !== command ||
        !ctx?.executionEnvironment)
    )
      return this.policyFailureResult(
        command,
        'Error: authorized host execution is missing trusted command context',
        null,
        'authorization_missing',
      )
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
    const privilegeEscalation = shellPrivilegeEscalationReason(
      analyzeShellCommandFailClosed(command),
    )
    if (privilegeEscalation) {
      const content =
        `${SAFETY_REFUSAL_PREFIX} (privilege escalation command: ${privilegeEscalation})\n` +
        'Administrator credentials, interactive authentication, and system privilege escalation are not supported.'
      return this.policyFailureResult(
        command,
        content,
        null,
        'interactive_auth_required',
      )
    }
    const catastrophicDestruction = shellCatastrophicDestructionReason(
      command,
      analyzeShellCommandFailClosed(command),
    )
    if (catastrophicDestruction) {
      const content =
        `${SAFETY_REFUSAL_PREFIX} (catastrophic operation: ${catastrophicDestruction})\n` +
        '该操作可能破坏磁盘、根文件系统或进程宿主，Emperor 不会执行。'
      return this.policyFailureResult(command, content)
    }
    let outcome: RunCommandExecutionOutcome
    let containment: ProcessContainmentReceipt | null = null
    try {
      const snapshotEnv =
        processExecution.kind === 'host'
          ? ctx?.executionEnvironment?.hostProcessEnv()
          : ctx?.executionEnvironment?.env
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
      const scratchRoot =
        processExecution.kind === 'host'
          ? sessionScratchRoot(ctx, tempRoot)
          : tempRoot
      mkdirSync(scratchRoot, { recursive: true, mode: 0o700 })
      try {
        const shell = commandShell(command)
        const commandEnv =
          processExecution.kind === 'host'
            ? withEmperorCommandShims(env, scratchRoot, command)
            : env
        const owned = await this.ownedRunner.run({
          executable: shell.executable,
          args: shell.args,
          cwd: cwdDecision.realPath,
          env:
            processExecution.kind === 'host'
              ? {
                  ...env,
                  ...commandEnv,
                  PWD: cwdDecision.realPath,
                  TMPDIR: tempRoot,
                  TMP: tempRoot,
                  TEMP: tempRoot,
                  EMPEROR_SCRATCH_DIR: scratchRoot,
                }
              : {
                  ...env,
                  ...commandEnv,
                  GIT_CONFIG_GLOBAL: '/dev/null',
                  NPM_CONFIG_USERCONFIG: '/dev/null',
                  PWD: cwdDecision.realPath,
                  TMPDIR: tempRoot,
                  TMP: tempRoot,
                  TEMP: tempRoot,
                  EMPEROR_SCRATCH_DIR: scratchRoot,
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
            await emitContainmentReceipt(ctx, receipt, processExecution),
          execution:
            processExecution.kind === 'host'
              ? {
                  kind: 'host',
                  authorization: processExecution.authorization,
                }
              : {
                  kind: 'sandbox',
                  policy: {
                    mode: 'required',
                    workspaceRoot: cwdDecision.realPath,
                    stateRoot:
                      ctx?.root &&
                      !pathsEqual(
                        canonicalizeExistingPath(ctx.root),
                        cwdDecision.realPath,
                      )
                        ? ctx.root
                        : null,
                    tempRoot,
                    readOnlyRoots: commandRuntimeReadRoots(commandEnv.PATH),
                    network: 'deny',
                  },
                },
        })
        containment = owned.containment
        if (
          owned.status === 'containment_unavailable' ||
          (processExecution.kind === 'host'
            ? containment.decision !== 'unsandboxed'
            : containment.decision !== 'sandboxed')
        ) {
          const content = `Error: OS sandbox unavailable; command was not started (${containment.backend}: ${containment.reason || containment.capabilityStatus})`
          return this.policyFailureResult(
            command,
            content,
            containment,
            processExecution.kind === 'host'
              ? 'authorization_missing'
              : 'containment_unavailable',
          )
        }
        outcome = ownedProcessOutcome(owned)
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }
    } catch (error) {
      outcome = {
        status: 'spawn_error',
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
        formatProcessStreams(outcome.stdout, outcome.stderr) ||
          '(command completed with no output)',
        containment,
      )
    return this.failedProcessResult(command, outcome, ctx, containment)
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return isReadonlyCommand(String(args.command ?? ''))
  }

  override mutatesWorkspace(args: Record<string, unknown>): boolean {
    return runCommandWorkspaceEffect(String(args.command ?? '')) !== 'none'
  }

  override getPaths(args: Record<string, unknown>): string[] {
    const candidates = shellMutationPathCandidates(String(args.command ?? ''))
    const out: string[] = []
    for (const candidate of candidates) {
      const absolute = resolve(this.workspace, candidate)
      const rel = relative(this.workspace, absolute)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        continue
      if (!out.includes(rel)) out.push(rel)
    }
    return out
  }

  override mapResult(raw: string, ctx: ToolExecutionContext): ToolResult {
    return this.successResult(String(ctx.arguments?.command ?? ''), raw)
  }

  private successResult(
    command: string,
    content: string,
    containment: ProcessContainmentReceipt | null = null,
  ): ToolResult {
    const scope = shellCommandResultScope(command)
    const successScope =
      scope.compound_command &&
      analyzeShellCommandFailClosed(command).features.includes('pipeline') &&
      !commandShellSupportsPipefail()
        ? 'last_pipeline_command'
        : 'process_exit_zero'
    const modelContent = scope.verification_required
      ? `${content}\n\n[verification required] This compound shell result does not prove every step succeeded. Run a separate probe for the intended artifact.`
      : content
    return {
      modelContent,
      displaySummary: `run_command exit 0: ${command.slice(0, 120)}`,
      rawContent: content,
      artifacts: [],
      metadata: {
        tool: 'run_command',
        command,
        exitCode: 0,
        signal: null,
        timedOut: false,
        outcome: 'success',
        progress: content.trim()
          ? scope.evidence_disposition === 'candidate'
            ? 'discovery'
            : 'execution'
          : 'none',
        retryable: false,
        strategy_key: 'run_command:process',
        success_scope: successScope,
        evidence: { exit_code: 0 },
        ...scope,
        ...(containment ? { containment } : {}),
      },
      isError: false,
    }
  }

  private policyFailureResult(
    command: string,
    content: string,
    containment: ProcessContainmentReceipt | null = null,
    commandFailureKind = 'policy_denied',
  ): ToolResult {
    const scope = shellCommandResultScope(command)
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
        command_failure_kind: commandFailureKind,
        outcome: 'failure',
        failure_kind: commandFailureKind,
        retryable: false,
        strategy_key: runCommandFailureStrategyKey(command, commandFailureKind),
        evidence: { exit_code: null },
        ...scope,
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
    const commandFailureKind = cancelled
      ? 'cancelled'
      : timedOut
        ? 'timeout'
        : outcome.status === 'output_limit'
          ? 'output_limit'
          : outcome.status === 'spawn_error'
            ? 'spawn_error'
            : 'process_failed'
    const body = formatProcessStreams(outcome.stdout, outcome.stderr)
    const scope = shellCommandResultScope(command)
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
        command_failure_kind: commandFailureKind,
        outcome: 'failure',
        failure_kind: commandFailureKind,
        retryable: timedOut,
        strategy_key: runCommandFailureStrategyKey(command, commandFailureKind),
        evidence: { exit_code: exitCode, signal },
        ...scope,
        ...(containment ? { containment } : {}),
      },
      isError: true,
    }
  }
}

function runCommandFailureStrategyKey(
  command: string,
  failureKind: string,
): string {
  const urls = new Set<string>()
  for (const candidate of String(command ?? '').match(
    /https?:\/\/[^\s'"|;&)]+/g,
  ) ?? []) {
    try {
      const url = new URL(candidate)
      url.hash = ''
      urls.add(url.toString())
    } catch {
      // Fall back to command identity when the shell token is not a URL.
    }
  }
  const normalized = urls.size
    ? `external_url:${[...urls].sort().join(',')}`
    : String(command ?? '')
        .trim()
        .replace(/\s+/g, ' ')
  const fingerprint = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 16)
  return `run_command:${failureKind}:${fingerprint}`
}

function shellCommandResultScope(command: string): {
  result_scope: 'shell_command'
  compound_command: boolean
  verification_required: boolean
  workspace_effect: 'none' | 'known_paths' | 'unattributed'
  evidence_disposition: 'none' | 'candidate'
} {
  const analysis = analyzeShellCommandFailClosed(command)
  const compoundFeatures = new Set([
    'pipeline',
    'and',
    'or',
    'sequence',
    'background',
    'subshell',
    'brace_group',
    'control_flow',
  ])
  const compound =
    analysis.commands.length > 1 ||
    analysis.features.some((feature) => compoundFeatures.has(feature))
  const externalCandidate = runCommandProvidesExternalCandidate(command)
  return {
    result_scope: 'shell_command',
    compound_command: compound,
    verification_required: compound || externalCandidate,
    workspace_effect: runCommandWorkspaceEffect(command),
    evidence_disposition: externalCandidate ? 'candidate' : 'none',
  }
}

function runCommandWorkspaceEffect(
  command: string,
): 'none' | 'known_paths' | 'unattributed' {
  if (shellMutationPathCandidates(command).length) return 'known_paths'
  if (isReadonlyCommand(command) || isExternalReadCommand(command))
    return 'none'
  return 'unattributed'
}

function runCommandProvidesExternalCandidate(command: string): boolean {
  const analysis = analyzeShellCommandFailClosed(command)
  if (analysis.status !== 'parsed') return false
  return analysis.commands.some((node) => {
    const executable = basename(String(node.argv[0] ?? '')).toLowerCase()
    const subcommand = String(node.argv[1] ?? '').toLowerCase()
    if (executable === 'curl' || executable === 'wget') return true
    if (executable === 'mcporter') return subcommand === 'call'
    if (executable === 'gh') return ['api', 'search'].includes(subcommand)
    if (
      ['yt-dlp', 'twitter', 'xreach', 'bili', 'rdt', 'opencli'].includes(
        executable,
      )
    )
      return true
    return false
  })
}

function isExternalReadCommand(command: string): boolean {
  const analysis = analyzeShellCommandFailClosed(command)
  if (analysis.status !== 'parsed' || !analysis.commands.length) return false
  if (
    analysis.commands.some((node) =>
      node.redirects.some((redirect) => redirect.operator.includes('>')),
    )
  )
    return false
  const transforms = new Set([
    'awk',
    'cat',
    'cut',
    'grep',
    'head',
    'jq',
    'rg',
    'sed',
    'sort',
    'tail',
    'tr',
    'uniq',
    'wc',
  ])
  let sawExternal = false
  for (const node of analysis.commands) {
    const executable = basename(String(node.argv[0] ?? '')).toLowerCase()
    const subcommand = String(node.argv[1] ?? '').toLowerCase()
    if (executable === 'curl') {
      if (curlWritesFile(node.argv)) return false
      sawExternal = true
      continue
    }
    if (executable === 'wget') {
      if (!wgetWritesStdoutOnly(node.argv)) return false
      sawExternal = true
      continue
    }
    if (executable === 'mcporter' && subcommand === 'call') {
      sawExternal = true
      continue
    }
    if (executable === 'gh' && ['api', 'search'].includes(subcommand)) {
      sawExternal = true
      continue
    }
    if (transforms.has(executable)) continue
    return false
  }
  return sawExternal
}

function curlWritesFile(argv: readonly string[]): boolean {
  return argv.some(
    (argument) =>
      argument === '-o' ||
      argument === '-O' ||
      argument === '--output' ||
      argument === '--remote-name' ||
      argument.startsWith('--output='),
  )
}

function wgetWritesStdoutOnly(argv: readonly string[]): boolean {
  return argv.some(
    (argument, index) =>
      argument === '-qO-' ||
      argument === '-O-' ||
      argument === '--output-document=-' ||
      ((argument === '-O' || argument === '--output-document') &&
        argv[index + 1] === '-'),
  )
}

function formatProcessStreams(stdout: string, stderr: string): string {
  const out = stdout.trim()
  const err = stderr.trim()
  if (out && err) return `stdout:\n${out}\n\nstderr:\n${err}`
  return out || err
}

function commandShell(command: string): {
  executable: string
  args: string[]
} {
  if (process.platform === 'win32') {
    return {
      executable: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    }
  }
  const executable = existsSync('/bin/bash')
    ? '/bin/bash'
    : existsSync('/bin/zsh')
      ? '/bin/zsh'
      : '/bin/sh'
  return executable === '/bin/sh'
    ? { executable, args: ['-c', command] }
    : { executable, args: ['-o', 'pipefail', '-c', command] }
}

function commandShellSupportsPipefail(): boolean {
  return (
    process.platform !== 'win32' &&
    (existsSync('/bin/bash') || existsSync('/bin/zsh'))
  )
}

function sessionScratchRoot(
  ctx: ToolExecutionContext | undefined,
  fallback: string,
): string {
  const sessionId = String(ctx?.sessionId ?? '').trim()
  const stateRoot = String(ctx?.root ?? '').trim()
  if (!stateRoot || !/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) return fallback
  return join(resolve(stateRoot), 'sessions', sessionId, 'scratch')
}

/**
 * Some third-party CLIs resolve configuration relative to cwd. mcporter is one
 * of them: without --config it reads and may create ./config/mcporter.json,
 * which would pollute whichever project happens to be active. Keep the model's
 * command unchanged (and therefore keep its permission fingerprint valid), but
 * resolve the real executable from the trusted turn PATH and place a
 * session-owned shim in front of it. Nested tools such as agent-reach inherit
 * the same PATH, so their mcporter probes use Emperor Home as well.
 */
function withEmperorCommandShims(
  env: Record<string, string>,
  scratchRoot: string,
  command: string,
): Record<string, string> {
  const environmentRoot = String(env.EMPEROR_ENVIRONMENT_DIR ?? '').trim()
  const pathValue = String(env.PATH ?? '').trim()
  if (!environmentRoot || !pathValue) return env
  const executable = resolveExecutableOnPath('mcporter', pathValue)
  if (!executable) return env

  const configPath = join(
    resolve(environmentRoot),
    'data',
    'mcporter',
    'mcporter.json',
  )
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  if (commandMayUseMcporter(command)) ensureManagedMcporterConfig(configPath)
  const shimRoot = join(scratchRoot, '.command-shims')
  mkdirSync(shimRoot, { recursive: true, mode: 0o700 })

  if (process.platform === 'win32') {
    const shim = join(shimRoot, 'mcporter.cmd')
    writeFileSync(
      shim,
      `@echo off\r\n"${executable.replaceAll('"', '""')}" --config "${configPath.replaceAll('"', '""')}" %*\r\n`,
      { mode: 0o700 },
    )
  } else {
    const shim = join(shimRoot, 'mcporter')
    writeFileSync(
      shim,
      `#!/bin/sh\nexec ${shellSingleQuote(executable)} --config ${shellSingleQuote(configPath)} "$@"\n`,
      { mode: 0o700 },
    )
    chmodSync(shim, 0o700)
  }
  return { ...env, PATH: `${shimRoot}${delimiter}${pathValue}` }
}

function commandMayUseMcporter(command: string): boolean {
  const analysis = analyzeShellCommandFailClosed(command)
  if (analysis.status !== 'parsed') return false
  return analysis.commands.some((entry) => {
    const executable = basename(String(entry.argv[0] ?? '')).toLowerCase()
    return executable === 'mcporter' || executable === 'agent-reach'
  })
}

function ensureManagedMcporterConfig(configPath: string): void {
  if (existsSync(configPath)) return
  const initialConfig = {
    mcpServers: {
      exa: { baseUrl: 'https://mcp.exa.ai/mcp' },
    },
  }
  try {
    writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function resolveExecutableOnPath(
  name: string,
  pathValue: string,
): string | null {
  const suffixes =
    process.platform === 'win32'
      ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : ['']
  for (const entry of pathValue.split(delimiter)) {
    const root = entry.trim()
    if (!root) continue
    for (const suffix of suffixes) {
      const candidate = join(root, `${name}${suffix}`)
      try {
        const canonical = realpathSync(candidate)
        if (!statSync(canonical).isFile()) continue
        if (process.platform !== 'win32') accessSync(canonical, constants.X_OK)
        return canonical
      } catch {
        // Keep scanning the trusted PATH snapshot.
      }
    }
  }
  return null
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function ownedProcessOutcome(
  result: OwnedProcessResult,
): RunCommandExecutionOutcome {
  if (result.status === 'completed' && result.exitCode === 0)
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: null,
    }
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
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error,
  }
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
  processExecution: NonNullable<ToolExecutionContext['processExecution']>,
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
    execution_boundary: processExecution.kind,
    authorization_source:
      processExecution.kind === 'host'
        ? processExecution.authorization.source
        : undefined,
  })
}
