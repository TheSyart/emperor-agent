import type { ProjectProcessService } from '../workspace/project-processes'
import { Tool, type ToolExecutionContext } from './base'
import { I, S, toolParamsSchema, type ParamSchema } from './schema'

type ProjectProcessAction =
  'list_candidates' | 'start' | 'status' | 'logs' | 'stop' | 'restart'

export class ManageProjectProcessTool extends Tool {
  override readonly name = 'manage_project_process'
  override readonly description =
    '探测并管理当前 Build session 的受控项目进程。' +
    '只能使用 list_candidates 返回的 candidateId 或已有 processId；' +
    '不能提供命令、argv、cwd 或环境变量。启动成功且 loopback 健康检查通过后会生成 Website 预览。'
  override readonly parameters = toolParamsSchema(
    {
      action: {
        ...S('list_candidates、start、status、logs、stop 或 restart'),
        enum: ['list_candidates', 'start', 'status', 'logs', 'stop', 'restart'],
      } as ParamSchema,
      candidate_id: {
        ...S('list_candidates 返回的候选 ID'),
        nullable: true,
      } as ParamSchema,
      process_id: { ...S('项目进程 ID'), nullable: true } as ParamSchema,
      after_seq: {
        ...I('logs 上一次返回的 nextSeq；首次为 0'),
        minimum: 0,
        maximum: 2_147_483_647,
        nullable: true,
      } as ParamSchema,
      invocation_id: S('本次动作的稳定幂等 ID'),
    },
    ['action', 'invocation_id'],
  )
  override readonly requiresRuntimeContext = true
  override readonly exclusive = true
  override readonly domainStateMutation = true
  override readonly evidencePolicy = 'context_only' as const

  constructor(private readonly service: ProjectProcessService) {
    super()
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return ['list_candidates', 'status', 'logs'].includes(
      String(args.action ?? ''),
    )
  }

  override async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const sessionId = String(ctx?.sessionId ?? '').trim()
    if (!sessionId) throw new Error('manage_project_process requires session')
    const action = String(args.action ?? '') as ProjectProcessAction
    const invocationId = required(args.invocation_id, 'invocation_id')
    if (action === 'list_candidates')
      return JSON.stringify({
        candidates: await this.service.candidates(sessionId),
      })
    if (action === 'start')
      return JSON.stringify(
        await this.service.start({
          sessionId,
          candidateId: required(args.candidate_id, 'candidate_id'),
          invocationId,
        }),
      )
    if (action === 'status') {
      const processId = optional(args.process_id)
      return JSON.stringify(
        processId
          ? this.service.get(processId, sessionId)
          : { processes: this.service.list(sessionId) },
      )
    }
    if (action === 'logs')
      return JSON.stringify(
        this.service.readOutput({
          sessionId,
          processId: required(args.process_id, 'process_id'),
          afterSeq: Math.max(0, Math.trunc(Number(args.after_seq ?? 0))),
        }),
      )
    const processId = required(args.process_id, 'process_id')
    const current = this.service.get(processId, sessionId)
    if (action === 'stop')
      return JSON.stringify(
        await this.service.stop({
          sessionId,
          processId,
          expectedRevision: current.revision,
        }),
      )
    if (action === 'restart')
      return JSON.stringify(
        await this.service.restart({
          sessionId,
          processId,
          expectedRevision: current.revision,
          invocationId,
        }),
      )
    throw new Error(`unsupported project process action: ${action}`)
  }
}

function optional(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}

function required(value: unknown, label: string): string {
  const text = optional(value)
  if (!text) throw new Error(`${label} is required`)
  return text
}
