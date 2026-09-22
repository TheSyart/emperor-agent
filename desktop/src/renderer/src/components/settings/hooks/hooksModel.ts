import type { HooksConfigPayload } from '../../../types'

export interface HookEventCountRow {
  eventName: string
  count: number
}

/** Runnable command hooks per supported event (zero counts included). */
export function hookEventCountRows(
  payload: HooksConfigPayload | null | undefined,
): HookEventCountRow[] {
  const events = payload?.events ?? {}
  const names = [
    ...(payload?.supportedEvents ?? []),
    ...Object.keys(events).filter(
      (name) => !(payload?.supportedEvents ?? []).includes(name as never),
    ),
  ]
  return names.map((eventName) => ({
    eventName,
    count: Math.max(0, Number(events[eventName] ?? 0)),
  }))
}

export function totalHookCount(
  payload: HooksConfigPayload | null | undefined,
): number {
  return Object.values(payload?.events ?? {}).reduce(
    (sum, count) => sum + Math.max(0, Number(count || 0)),
    0,
  )
}

/** Editor seed: the saved file, or an empty Claude Code hooks document. */
export function hooksEditorSeed(
  payload: HooksConfigPayload | null | undefined,
): string {
  const content = String(payload?.content ?? '')
  return content.trim() ? content : '{\n  "hooks": {}\n}\n'
}

/** The query field a Claude Code event matches against (tool / source / agent type). */
export function hookMatchQueryLabel(
  matcher: string | null | undefined,
): string {
  if (matcher === 'tool_name')
    return '工具名（例如 bash、write、mcp_docs_search）'
  if (matcher === 'source')
    return 'SessionStart 来源（startup / resume / clear）'
  if (matcher === 'agent_type') return '子代理类型（例如 general-purpose）'
  return '该事件不使用 matcher'
}

export function auditQuery(filters: {
  eventName?: string
  outcome?: string
  cursor?: string | null
  limit?: number
}): Record<string, unknown> {
  const query: Record<string, unknown> = { limit: filters.limit ?? 50 }
  if (filters.eventName) query.eventName = filters.eventName
  if (filters.outcome) query.outcome = filters.outcome
  if (filters.cursor) query.cursor = filters.cursor
  return query
}

export type HookTone = 'ok' | 'warn' | 'error' | 'neutral'

/** Audit outcomes the filter offers (plus 「全部结果」 = ''). */
export const HOOK_AUDIT_OUTCOMES = ['allow', 'deny', 'block', 'none'] as const

/** Badge tone for an audit outcome / test-run decision. */
export function hookOutcomeTone(outcome: string | null | undefined): HookTone {
  const value = String(outcome || '').toLowerCase()
  if (value === 'allow' || value === 'approve') return 'ok'
  if (value === 'deny' || value === 'block') return 'error'
  if (value === 'ask') return 'warn'
  return 'neutral'
}

/** Badge tone for a finished command (exit code 0 = ok, 2 = blocking). */
export function hookExitTone(exitCode: number | null | undefined): HookTone {
  if (exitCode === 0) return 'ok'
  if (exitCode === null || exitCode === undefined) return 'neutral'
  return exitCode === 2 ? 'error' : 'warn'
}
