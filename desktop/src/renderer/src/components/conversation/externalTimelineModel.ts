import type { ExternalHistoryEntry } from './externalHistoryFeed'

export type ExternalTimelineRow =
  | ExternalHistoryEntry
  | { id: string; runId: string; type: 'run' | 'tool-detail'; text: string }

const MAX_ROW_TEXT = 32768

/** Presentation only: durable entries and history cursors remain untouched. */
export function externalTimelineRows(
  entries: readonly ExternalHistoryEntry[],
  runIds: readonly string[],
): ExternalTimelineRow[] {
  const result: ExternalTimelineRow[] = []
  const tools = new Map<string, ExternalHistoryEntry>()
  let previousRun = ''
  let previousType: ExternalHistoryEntry['type'] | undefined
  for (const entry of entries) {
    const adjacentText = previousType === 'text'
    previousType = entry.type
    if (entry.runId !== previousRun) {
      result.push({
        id: entry.runId + ':heading',
        runId: entry.runId,
        type: 'run',
        text: `第 ${Math.max(1, runIds.indexOf(entry.runId) + 1)} 轮`,
      })
      previousRun = entry.runId
    }
    if (entry.type === 'tool' && entry.toolId?.trim()) {
      // Tuple encoding prevents collisions and stays stable when older paging
      // supplies a start that was absent from the initial finish-only window.
      const id = `tool:${JSON.stringify([entry.runId, entry.toolId])}`
      const existing = tools.get(id)
      if (existing) {
        if (entry.name?.trim()) existing.name = entry.name
        if (entry.status?.trim()) existing.status = entry.status
        if (entry.text)
          existing.text = existing.text
            ? `${existing.text}\n\n${entry.text}`
            : entry.text
      } else {
        const row = { ...entry, id }
        tools.set(id, row)
        result.push(row)
      }
      continue
    }
    const last = result.at(-1)
    if (
      adjacentText &&
      entry.type === 'text' &&
      last?.type === 'text' &&
      last.runId === entry.runId &&
      (last.text?.length ?? 0) + (entry.text?.length ?? 0) <= MAX_ROW_TEXT
    )
      last.text = (last.text ?? '') + (entry.text ?? '')
    else result.push({ ...entry })
  }
  return result.flatMap((row) => {
    if (row.type !== 'tool' || (row.text?.length ?? 0) <= MAX_ROW_TEXT)
      return [row]
    // Large public details retain bounded virtual units without repeating the
    // activity header or exposing a second, stale running status.
    const parts: ExternalTimelineRow[] = [
      { ...row, text: row.text!.slice(0, MAX_ROW_TEXT) },
    ]
    for (
      let offset = MAX_ROW_TEXT;
      offset < row.text!.length;
      offset += MAX_ROW_TEXT
    )
      parts.push({
        id: `${row.id}:detail:${offset / MAX_ROW_TEXT}`,
        runId: row.runId,
        type: 'tool-detail',
        text: row.text!.slice(offset, offset + MAX_ROW_TEXT),
      })
    return parts
  })
}

const toolStatuses: Record<string, string> = {
  queued: '等待调度',
  preparing: '正在准备',
  running: '运行中',
  waiting_input: '等待回答',
  cancelling: '正在停止',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  denied: '已拒绝',
  outcome_unknown: '结果待确认',
}

export function externalToolStatusLabel(status: string | undefined): string {
  if (!status) return '状态未记录'
  return Object.hasOwn(toolStatuses, status)
    ? toolStatuses[status]!
    : `状态：${status}`
}
