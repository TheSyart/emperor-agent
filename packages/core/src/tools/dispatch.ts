import { Tool, type ToolExecutionContext } from './base'
import { S, toolParamsSchema, type ParamSchema } from './schema'
import { ToolRegistry } from './registry'
import { TaskKind, TaskStatus, type TaskRecord } from '../tasks/models'
import type { TaskManager } from '../tasks/manager'
import type { SubagentRegistry } from '../subagents/registry'
import type { SubagentSpec } from '../subagents/spec'

const PLAN_CONTRACT_FIELDS = ['scope_limit', 'expected_output', 'evidence_required'] as const
const EVIDENCE_FILE_RE = /(?<![\w/.-])([A-Za-z0-9_./-]+\.(?:py|pyi|ts|tsx|js|jsx|vue|md|rst|json|toml|yaml|yml|txt|css|scss|html)(?::\d+(?:-\d+)?)?)/g

export interface DispatchRunner {
  step(history: Array<Record<string, unknown>>): string | Promise<string>
}

export interface DispatchRunnerFactoryArgs {
  spec: SubagentSpec
  subRegistry: ToolRegistry
  task: string
  workspaceRoot?: string | null
}

export interface DispatchSubagentToolOptions {
  parentRegistry: ToolRegistry
  subagentRegistry: SubagentRegistry
  runnerFactory: (args: DispatchRunnerFactoryArgs) => DispatchRunner
  taskManager?: TaskManager | null
  controlManager?: { mode?: string; [key: string]: unknown } | null
}

export class DispatchSubagentTool extends Tool {
  override name = 'dispatch_subagent'
  override exclusive = false
  override requiresRuntimeContext = true
  override concurrencySafe = true

  private readonly parentRegistry: ToolRegistry
  private readonly subagentRegistry: SubagentRegistry
  private readonly runnerFactory: (args: DispatchRunnerFactoryArgs) => DispatchRunner
  private readonly taskManager: TaskManager | null
  private readonly controlManager: { mode?: string; [key: string]: unknown } | null

  constructor(opts: DispatchSubagentToolOptions) {
    super()
    this.parentRegistry = opts.parentRegistry
    this.subagentRegistry = opts.subagentRegistry
    this.runnerFactory = opts.runnerFactory
    this.taskManager = opts.taskManager ?? null
    this.controlManager = opts.controlManager ?? null
  }

  override get description(): string {
    return (
      '派遣一个子代理独立执行只读调研、批量搜索、跨文件查找或试错探索。' +
      '不要委派理解或让子代理自行决定最终实现；主 Agent 必须给出明确范围、期望产物和证据要求。' +
      '子代理使用独立上下文，完成后只回传总结，避免污染主上下文。' +
      '计划模式下只允许具备只读探索权限的子代理，并必须填写 scope_limit、expected_output、evidence_required；写入型子代理仍被禁止。' +
      '多项互不依赖的任务可在同一回合并发派遣；失败后诊断原因，不要盲目重复同一派遣。'
    )
  }

  override get parameters() {
    const agentType = {
      ...S('子代理类型，必须是 enum 中列出的可用类型之一'),
      enum: this.subagentRegistry.names({ includeAliases: true }),
    } as ParamSchema
    return toolParamsSchema({
      agent_type: agentType,
      task: S('交代给小太监的差事, 写清要做什么、希望返回什么格式的总结'),
      purpose: { ...S('一句话用途标签, 仅用于终端打印'), nullable: true } as ParamSchema,
      expected_output: { ...S('可选: 希望子代理最终回禀的具体产物或格式'), nullable: true } as ParamSchema,
      evidence_required: { ...S('可选: 需要子代理提供的证据类型, 如文件路径/行号/URL/命令摘要'), nullable: true } as ParamSchema,
      scope_limit: { ...S('可选: 明确禁止越界的范围, 如只读/不改文件/只看某目录'), nullable: true } as ParamSchema,
    }, ['agent_type', 'task'])
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    const spec = this.subagentRegistry.get(String(args.agent_type ?? ''))
    if (!spec?.planReadonlyExplorer) return false
    return missingPlanContract(args).length === 0
  }

  override isDestructive(args: Record<string, unknown>): boolean {
    return !this.isReadOnly(args)
  }

  override async execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<string> {
    const agentType = String(args.agent_type ?? '')
    const task = String(args.task ?? '')
    const spec = this.subagentRegistry.get(agentType)
    if (!spec) {
      return `Error: unknown subagent '${agentType}'. Available: ${this.subagentRegistry.names({ includeAliases: true })}`
    }
    const planError = this.planExplorationError(spec, args)
    if (planError) return planError

    const subRegistry = new ToolRegistry()
    for (const toolName of spec.toolNames) {
      const tool = this.parentRegistry.get(toolName)
      if (tool) subRegistry.register(tool)
    }
    const subagentTask = composeSubagentTask(task, {
      expectedOutput: asOptional(args.expected_output),
      evidenceRequired: asOptional(args.evidence_required),
      scopeLimit: asOptional(args.scope_limit),
    })
    const runner = this.runnerFactory({ spec, subRegistry, task: subagentTask, workspaceRoot: ctx?.workspaceRoot ?? ctx?.root ?? null })
    const history = [{ role: 'user', content: subagentTask }]
    let taskRecord: TaskRecord | null = null

    if (this.taskManager) {
      taskRecord = this.taskManager.startTask({
        kind: TaskKind.SUBAGENT,
        title: asOptional(args.purpose) || task.slice(0, 80),
        source: 'dispatch_subagent',
        toolCallId: ctx?.parentCallId ?? null,
        sessionId: ctx?.sessionId ?? null,
        metadata: {
          agent_type: agentType,
          subagent_name: spec.name,
          plan_readonly_explorer: spec.planReadonlyExplorer,
          scope_limit: asOptional(args.scope_limit) || '',
          expected_output: asOptional(args.expected_output) || '',
          evidence_required: asOptional(args.evidence_required) || '',
        },
      })
      this.taskManager.appendSidechain(taskRecord.id, history[0]!)
    }

    try {
      const final = await runner.step(history)
      if (this.taskManager && taskRecord) {
        const terminal = terminalTaskResult(this.taskManager.store.get(taskRecord.id), agentType)
        if (terminal) return terminal
        this.taskManager.appendSidechain(taskRecord.id, { role: 'assistant', content: final })
        this.taskManager.completeTask(taskRecord.id, { summary: final.slice(0, 500) })
      }
      return final
    } catch (error) {
      if (this.taskManager && taskRecord) {
        const terminal = terminalTaskResult(this.taskManager.store.get(taskRecord.id), agentType)
        if (terminal) return terminal
        this.taskManager.failTask(taskRecord.id, { error: String(error) })
      }
      return `Error: subagent '${agentType}' raised: ${error}`
    }
  }

  private planExplorationError(spec: SubagentSpec, args: Record<string, unknown>): string {
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
}

export function composeSubagentTask(task: string, opts: {
  expectedOutput?: string | null
  evidenceRequired?: string | null
  scopeLimit?: string | null
} = {}): string {
  const contract: string[] = []
  if (opts.expectedOutput) contract.push(`- 期望产物: ${opts.expectedOutput}`)
  if (opts.evidenceRequired) contract.push(`- 证据要求: ${opts.evidenceRequired}`)
  if (opts.scopeLimit) contract.push(`- 范围限制: ${opts.scopeLimit}`)
  contract.push('- 最终回禀必须包含: 结论、证据、风险、建议下一步。')
  return `${task.trimEnd()}\n\n## 差事契约\n${contract.join('\n')}`
}

export function extractEvidenceRefs(text: string): string[] {
  const refs: string[] = []
  for (const match of String(text || '').matchAll(EVIDENCE_FILE_RE)) {
    const ref = String(match[1] ?? '').trim().replace(/[.,;，。；)]+$/g, '')
    if (!ref || ref.startsWith('http://') || ref.startsWith('https://')) continue
    refs.push(ref)
  }
  return dedupe(refs)
}

export function extractEvidenceFiles(evidenceRefs: string[]): string[] {
  return dedupe(evidenceRefs.filter((ref) => !ref.startsWith('task:')).map((ref) => ref.split(':', 1)[0]!))
}

export function summarizeExploration(text: string, limit = 500): string {
  const summary = String(text || '').trim().split(/\s+/).join(' ')
  return summary.length <= limit ? summary : `${summary.slice(0, limit - 3).trimEnd()}...`
}

function missingPlanContract(args: Record<string, unknown>): string[] {
  return PLAN_CONTRACT_FIELDS.filter((field) => !String(args[field] ?? '').trim())
}

function asOptional(value: unknown): string {
  return String(value ?? '').trim()
}

function terminalTaskResult(record: TaskRecord | null | undefined, agentType: string): string {
  if (!record) return ''
  if (record.status === TaskStatus.CANCELLED) {
    const reason = String(record.progress.reason ?? 'cancelled')
    return `Error: subagent '${agentType}' task cancelled: ${reason}`
  }
  if (record.status === TaskStatus.COMPLETED || record.status === TaskStatus.FAILED) {
    return `Error: subagent '${agentType}' task already ${record.status}; result ignored.`
  }
  return ''
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
