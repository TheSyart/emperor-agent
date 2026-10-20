/**
 * Main-session writes waiting for a subagent's workspace (AGT-06): Core
 * says so with `workspace_wait` after 10 seconds and again when the wait
 * ends. Keyed by the waiting tool call; the tool row shows
 * 「正在等待子智能体释放工作区 · 停止它」 while an entry exists.
 */
import { computed, shallowReactive, type ComputedRef } from 'vue'
import { onCoreEvent } from '../../../api/backend'

export interface WorkspaceWait {
  readonly callId: string
  readonly delegationId: string
  readonly runId: string
  /** The conversation that owns the subagent (delegation operations name it). */
  readonly sessionId: string
  readonly backend?: string
  readonly title?: string
}

const waits = shallowReactive(new Map<string, WorkspaceWait>())
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  onCoreEvent((input) => {
    if (!input || typeof input !== 'object') return
    const event = input as Record<string, unknown>
    if (event.event !== 'workspace_wait' || typeof event.call_id !== 'string')
      return
    if (event.waiting !== true) {
      waits.delete(event.call_id)
      return
    }
    if (typeof event.delegation_id !== 'string') return
    waits.set(event.call_id, {
      callId: event.call_id,
      delegationId: event.delegation_id,
      runId: typeof event.run_id === 'string' ? event.run_id : '',
      sessionId: String(event.owner_session_id ?? event.session_id ?? ''),
      ...(typeof event.backend === 'string' ? { backend: event.backend } : {}),
      ...(typeof event.title === 'string' ? { title: event.title } : {}),
    })
  })
}

/** The wait of one tool call, if it is waiting. */
export function workspaceWaitFor(
  callId: string,
): ComputedRef<WorkspaceWait | undefined> {
  listen()
  return computed(() => waits.get(callId))
}
