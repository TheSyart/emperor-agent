import type { SubagentSupervisor } from '../subagents/supervisor'
import { Tool, type ToolExecutionContext } from './base'
import { S, toolParamsSchema, type ParamSchema } from './schema'

type SubagentTaskAction = 'wait' | 'read_output' | 'cancel' | 'resume'

export class SubagentTaskControlTool extends Tool {
  override name = 'manage_subagent'
  override exclusive = false
  override requiresRuntimeContext = true
  override concurrencySafe = true
  override evidencePolicy = 'forbidden' as const

  constructor(private readonly supervisor: SubagentSupervisor) {
    super()
  }

  override get description(): string {
    return (
      '控制 dispatch_subagent 返回的后台 Task。' +
      'wait 用于非阻塞或限时等待，read_output 按 cursor 增量读取输出，' +
      'cancel 取消任务，resume 仅恢复本次应用运行中被取消、失败或中断的任务。' +
      '只能控制当前 session 拥有的 Task。'
    )
  }

  override get parameters() {
    return toolParamsSchema(
      {
        action: {
          ...S('控制动作'),
          enum: ['wait', 'read_output', 'cancel', 'resume'],
        } as ParamSchema,
        task_id: S('dispatch_subagent 返回的 Task ID'),
        timeout_ms: {
          type: ['integer', 'null'],
          description: 'wait 最长等待毫秒数；默认 0 表示只轮询一次',
          minimum: 0,
          maximum: 60_000,
        } as ParamSchema,
        cursor: {
          ...S('read_output 上一次返回的 nextCursor'),
          nullable: true,
        } as ParamSchema,
        reason: {
          ...S('cancel 原因'),
          nullable: true,
        } as ParamSchema,
        mode: {
          ...S('resume 后使用 foreground 或 background'),
          enum: ['foreground', 'background'],
          nullable: true,
        } as ParamSchema,
        ttl_ms: {
          type: ['integer', 'null'],
          description: 'resume 后的新运行时限',
          minimum: 1,
          maximum: 1_800_000,
        } as ParamSchema,
      },
      ['action', 'task_id'],
    )
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    const action = String(args.action ?? '')
    return action === 'wait' || action === 'read_output'
  }

  override isDestructive(args: Record<string, unknown>): boolean {
    return !this.isReadOnly(args)
  }

  override async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const action = String(args.action ?? '') as SubagentTaskAction
    const taskId = String(args.task_id ?? '').trim()
    const ownerSessionId = String(ctx?.sessionId ?? '').trim() || null
    this.supervisor.assertOwner(taskId, ownerSessionId)

    if (action === 'wait') {
      const timeoutMs = optionalInteger(args.timeout_ms) ?? 0
      const terminal = await this.supervisor.wait(taskId, { timeoutMs })
      if (!terminal) return JSON.stringify({ taskId, status: 'running' })
      return JSON.stringify({
        taskId,
        status: terminal.status,
        ...(terminal.reason ? { reason: terminal.reason } : {}),
        ...(terminal.error ? { error: terminal.error } : {}),
      })
    }
    if (action === 'read_output') {
      const output = await this.supervisor.readOutput(
        taskId,
        optionalText(args.cursor),
      )
      return JSON.stringify({
        taskId,
        content: output.content,
        nextCursor: output.nextCursor,
        eof: output.eof,
        truncated: output.truncated,
        truncation: output.truncation,
      })
    }
    if (action === 'cancel') {
      const task = await this.supervisor.cancel(
        taskId,
        optionalText(args.reason) || 'cancelled by agent',
      )
      return JSON.stringify({ taskId, status: task.status })
    }
    if (action === 'resume') {
      const mode = String(args.mode ?? '')
      const ttlMs = optionalInteger(args.ttl_ms)
      const launched = await this.supervisor.resume(taskId, {
        ...(mode === 'foreground' || mode === 'background' ? { mode } : {}),
        ...(ttlMs !== null ? { ttlMs } : {}),
      })
      return JSON.stringify({
        taskId: launched.task.id,
        status: launched.task.status,
        mode: launched.mode,
        resumedFromTaskId: taskId,
      })
    }
    throw new Error(`unsupported subagent task action: ${action}`)
  }
}

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  return text || undefined
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.trunc(parsed))
}
