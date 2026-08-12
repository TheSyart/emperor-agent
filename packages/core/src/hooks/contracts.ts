export type HookRuntimeEmitter = (
  event: Record<string, unknown>,
) => void | Promise<void>

export interface HookRuntimeRunOptions {
  sessionId: string
  cwd: string
  projectRoot?: string | null
  stateRoot?: string | null
  source?: string | null
  toolName?: string | null
  toolInput?: Record<string, unknown> | null
  toolResult?: unknown
  permission?: Record<string, unknown> | null
  prompt?: string | null
  signal?: AbortSignal | null
  [key: string]: unknown
}
