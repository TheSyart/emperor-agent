/**
 * Pure helpers for the Inspect tab: locate the selected tool call in a chat
 * snapshot and shape its input / output / meta / timing for display.
 */
import type { ChatSnapshot, ToolChatData } from '../../conversation/types'
import {
  metaOf,
  parseToolArgs,
  resultValue,
  toolRowState,
  type ToolRowState,
} from '../conversation/tools/toolModel'

/** The tool call `callId` of a snapshot (visible or hidden nodes). */
export function findToolCall(
  snapshot: ChatSnapshot | null | undefined,
  callId: string,
): ToolChatData | null {
  if (!snapshot || !callId) return null
  for (const node of snapshot.nodes.values())
    if (node.kind === 'tool' && node.data.callId === callId) return node.data
  return null
}

export interface InspectFact {
  label: string
  value: string
}

export interface InspectView {
  state: ToolRowState
  stateLabel: string
  /** Parsed arguments, or the raw argument text when it is not JSON. */
  input: unknown
  inputTruncated: boolean
  /** Result value (JSON when the text is JSON); undefined while running. */
  output: unknown
  outputTruncated: boolean
  isError: boolean
  meta: Record<string, unknown> | undefined
  timing: InspectFact[]
  ids: InspectFact[]
}

const STATE_LABEL: Record<ToolRowState, string> = {
  running: '运行中',
  ok: '已完成',
  error: '失败',
  stopped: '已中断',
}

function clock(time: number): string {
  const date = new Date(time)
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** Human duration: 820ms / 3.4s / 2m 05s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function inspectView(data: ToolChatData): InspectView {
  const state = toolRowState(data)
  const parsed = parseToolArgs(data.argsRaw)
  const result = data.result
  const timing: InspectFact[] = [{ label: '调用', value: clock(data.time) }]
  if (result !== undefined) {
    timing.push({ label: '结果', value: clock(result.time) })
    timing.push({
      label: '耗时',
      value: formatDuration(result.time - data.time),
    })
  }
  const ids: InspectFact[] = [
    { label: 'Call', value: data.callId },
    { label: 'Turn · Step', value: `${data.turn} · ${data.step}` },
  ]
  if (result !== undefined)
    ids.push({ label: 'Result seq', value: String(result.seq) })
  if (result?.error !== undefined)
    ids.push({
      label: 'Error',
      value: `${result.error.name} (${result.error.code})`,
    })
  if (data.job !== undefined)
    ids.push({ label: 'Job', value: `${data.job.jobId} · ${data.job.status}` })
  if (data.subagent !== undefined)
    ids.push({ label: 'Subagent', value: data.subagent.subagentId })
  return {
    state,
    stateLabel: STATE_LABEL[state],
    input: parsed ?? data.argsRaw,
    inputTruncated: data.argsTruncated === true,
    output: result === undefined ? undefined : resultValue(data),
    outputTruncated: result?.truncated === true,
    isError: state === 'error',
    meta: metaOf(data),
    timing,
    ids,
  }
}
