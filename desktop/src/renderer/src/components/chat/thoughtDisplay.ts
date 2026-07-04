import type { ThoughtSegment } from '../../types'

export type ThoughtPresentation =
  | { kind: 'summary'; summary: string }
  | { kind: 'status'; label: string }

export function thoughtPresentation(segment: ThoughtSegment, executionDurationMs?: number): ThoughtPresentation {
  const summary = segment.summary?.trim()
  if (summary) {
    return { kind: 'summary', summary }
  }

  return { kind: 'status', label: thoughtStatusLabel(segment, executionDurationMs) }
}

function thoughtStatusLabel(segment: ThoughtSegment, executionDurationMs?: number) {
  const phase = segment.label || '思考'
  if (segment.status === 'error' || segment.status === 'error_aborted') {
    if (typeof executionDurationMs === 'number') return `执行已中断 · ${durationLabel(executionDurationMs)}`
    return `${phase}已中断`
  }
  if (typeof executionDurationMs === 'number') return `执行 ${durationLabel(executionDurationMs)}`
  if (segment.status === 'running') return phase
  return `${phase} · ${durationLabel(segment.durationMs)}`
}

// 注意：与 toolDisplay.durationLabel 不同——缺失时长时显示 '0ms' 而非空串（思考标签需要占位）
function durationLabel(ms?: number) {
  if (!ms && ms !== 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
