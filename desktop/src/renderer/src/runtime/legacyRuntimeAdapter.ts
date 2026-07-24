import type { RuntimeEventEnvelope, WsEvent } from '../types'

interface LegacyContinuationEvent extends RuntimeEventEnvelope {
  event: 'turn_continuation_evaluated'
  decision?: 'continue' | 'finalize' | 'pause'
  grantedIterations?: number
  summary?: string
  nextActions?: string[]
}

/**
 * Runtime compatibility belongs at the replay boundary, not in the current
 * Core event contract. Old continuation-budget events are normalized to one
 * generic historical activity before any current projection consumes them.
 */
export function adaptLegacyRuntimeEvent(
  raw: RuntimeEventEnvelope | WsEvent,
): WsEvent {
  if (raw.event !== 'turn_continuation_evaluated') return raw as WsEvent
  const legacy = raw as LegacyContinuationEvent
  const decision =
    legacy.decision === 'continue' || legacy.decision === 'finalize'
      ? legacy.decision
      : 'pause'
  const granted = Math.max(0, Number(legacy.grantedIterations || 0))
  return {
    ...legacy,
    event: 'historical_runtime_activity',
    label:
      decision === 'continue'
        ? `历史记录：评估后继续执行${granted ? ` · 追加 ${granted} 次迭代` : ''}`
        : decision === 'finalize'
          ? '历史记录：执行完成，正在整理交付'
          : '历史记录：执行已暂停',
    detail: String(legacy.summary || '').trim(),
    tone:
      decision === 'continue'
        ? 'running'
        : decision === 'finalize'
          ? 'success'
          : 'error',
    running: decision !== 'pause',
    action: decision === 'pause' ? 'continue' : undefined,
    nextActions: Array.isArray(legacy.nextActions)
      ? legacy.nextActions.map(String)
      : [],
  } as unknown as WsEvent
}

export function adaptLegacyRuntimeEvents(
  events: RuntimeEventEnvelope[],
): WsEvent[] {
  return events.map(adaptLegacyRuntimeEvent)
}
