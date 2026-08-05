import type { ThoughtSegment } from '../../types'
import { durationLabel as toolDurationLabel } from './toolDisplay'

export type ThoughtPresentation =
  { kind: 'summary'; summary: string } | { kind: 'status'; label: string }

export function thoughtPresentation(
  segment: ThoughtSegment,
  executionDurationMs?: number,
): ThoughtPresentation {
  const summary = segment.summary?.trim()
  if (summary) {
    return { kind: 'summary', summary }
  }

  return {
    kind: 'status',
    label: thoughtStatusLabel(segment, executionDurationMs),
  }
}

export function thoughtStatusLabel(
  segment: ThoughtSegment,
  executionDurationMs?: number,
) {
  const phase = segment.label || '思考'
  if (segment.status === 'error' || segment.status === 'error_aborted') {
    if (typeof executionDurationMs === 'number')
      return `执行已中断 · ${durationLabel(executionDurationMs)}`
    return `${phase}已中断`
  }
  if (typeof executionDurationMs === 'number')
    return `思考了 ${durationLabel(executionDurationMs)}`
  if (segment.status === 'running') return phase
  // 无自定义阶段名的终态统一为「思考了 Ns」;有阶段名保留「阶段 · Ns」。
  if (!segment.label) return `思考了 ${durationLabel(segment.durationMs)}`
  return `${phase} · ${durationLabel(segment.durationMs)}`
}

// 复用 toolDisplay.durationLabel(分钟级),仅补占位语义:缺失时长显示 '0ms' 而非空串
function durationLabel(ms?: number) {
  return toolDurationLabel(ms) || '0ms'
}
