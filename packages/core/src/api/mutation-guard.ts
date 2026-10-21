import { EmperorError } from '../errors'

/**
 * A write the caller may not make now (403) or that conflicts with the
 * session's state (409). It is an EmperorError, so its code and message
 * cross IPC: the interface says why instead of 「发生内部错误」 (FIX-10).
 */
export class CoreMutationGuardError extends EmperorError {
  readonly status: 403 | 409

  constructor(status: 403 | 409, message: string, code?: string) {
    super(
      message,
      code ?? (status === 403 ? 'mutation_forbidden' : 'mutation_conflict'),
    )
    this.status = status
  }
}

/**
 * A write that belongs to one chat (a subagent's message or result, a
 * process changing owner) waits while that chat has a question or plan
 * pending, and is refused in plan mode. Settings are global and never pass
 * here (FIX-10).
 */
export function assertCoreMutationAllowed(
  control: Record<string, unknown>,
  opts: { area: string; action: string },
): void {
  const pending = isRecord(control.pending) ? control.pending : null
  if (pending) {
    throw new CoreMutationGuardError(
      409,
      `这个对话有等你回复的提问或计划审批，先处理它再试（${opts.area} · ${opts.action}）。`,
      'mutation_blocked_pending',
    )
  }
  if (String(control.mode || '') === 'plan') {
    throw new CoreMutationGuardError(
      403,
      `这个对话处于计划模式，先批准计划或退出计划模式再试（${opts.area} · ${opts.action}）。`,
      'mutation_blocked_plan',
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
