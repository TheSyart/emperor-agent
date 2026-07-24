import type {
  AskSegment,
  AssistantMessage,
  AssistantSegment,
  MediaArtifactRef,
  PlanSegment,
  PlanActivitySegment,
  ThoughtSegment,
  TodoItem,
  ToolSegment,
  ToolStatus,
} from '../../types'
import { toolTitle } from './toolDisplay'
import { toolBatchTitle } from './toolGroupModel'

export type AssistantFlowBlock =
  | {
      kind: 'thought'
      id: string
      segment: ThoughtSegment
      executionDurationMs?: number
    }
  | { kind: 'text'; id: string; content: string; streaming: boolean }
  | {
      kind: 'tool_group'
      id: string
      title: string
      status: ToolStatus
      tools: ToolSegment[]
      durationMs?: number
    }
  | { kind: 'media'; id: string; items: MediaArtifactRef[] }
  | { kind: 'control'; id: string; segment: AskSegment | PlanSegment }
  | { kind: 'plan_activity'; id: string; segment: PlanActivitySegment }
  | { kind: 'todos'; id: string; todos: TodoItem[] }

export interface ProjectAssistantFlowOptions {
  now?: number
}

const THOUGHT_MIN_DURATION_MS = 120
const ABSORBED_TOOL_NAMES = new Set([
  'ask_user',
  'propose_plan',
  'update_todos',
  'complete_plan_step',
])
const MIN_VISIBLE_TODO_ITEMS = 3

export function projectAssistantFlow(
  message: AssistantMessage,
  options: ProjectAssistantFlowOptions = {},
): AssistantFlowBlock[] {
  const visible = message.segments.filter(visibleSegment)
  const blocks: AssistantFlowBlock[] = []
  const executionDurationMs = assistantExecutionDuration(
    message,
    options.now ?? Date.now(),
  )
  let executionSummaryAssigned = false

  for (let index = 0; index < visible.length;) {
    const segment = visible[index]
    if (!segment) {
      index += 1
      continue
    }

    if (segment.type === 'thought') {
      const useExecutionSummary =
        !executionSummaryAssigned && executionDurationMs !== undefined
      blocks.push({
        kind: 'thought',
        id: segment.id,
        segment,
        executionDurationMs: useExecutionSummary
          ? executionDurationMs
          : undefined,
      })
      if (useExecutionSummary) executionSummaryAssigned = true
      index += 1
      continue
    }

    if (segment.type === 'text') {
      const group: (typeof segment)[] = []
      let cursor = index
      while (visible[cursor]?.type === 'text') {
        group.push(visible[cursor] as typeof segment)
        cursor += 1
      }
      blocks.push({
        kind: 'text',
        id: `text-${group.map((item) => item.id).join('-')}`,
        content: group
          .map((item) => item.content)
          .filter(Boolean)
          .join('\n\n'),
        streaming: Boolean(message.streaming && cursor === visible.length),
      })
      index = cursor
      continue
    }

    if (segment.type === 'tool') {
      const group = [segment]
      let cursor = index + 1
      while (
        visible[cursor]?.type === 'tool' &&
        belongsToSameToolBatch(segment, visible[cursor] as ToolSegment)
      ) {
        group.push(visible[cursor] as ToolSegment)
        cursor += 1
      }
      const batchIdentity =
        segment.batchId || group.map((item) => item.toolId || item.id).join('-')
      const timelineTools = group.filter(
        (tool) => !ABSORBED_TOOL_NAMES.has(tool.name),
      )
      if (timelineTools.length) {
        blocks.push({
          kind: 'tool_group',
          id: `tool-group-${batchIdentity}`,
          title: toolGroupTitle(timelineTools),
          status: toolGroupStatus(timelineTools),
          tools: timelineTools,
          durationMs: toolGroupDuration(timelineTools),
        })
      }
      const media = mediaArtifacts(timelineTools)
      if (media.length) {
        blocks.push({
          kind: 'media',
          id: `media-${group.map((item) => item.toolId || item.id).join('-')}`,
          items: media,
        })
      }
      const todos = latestToolTodos(group)
      const visibleTodos = independentTodos(todos?.todos)
      if (visibleTodos.length >= MIN_VISIBLE_TODO_ITEMS) {
        blocks.push({
          kind: 'todos',
          id: `todos-${todos?.id || batchIdentity}`,
          todos: visibleTodos,
        })
      }
      index = cursor
      continue
    }

    if (segment.type === 'ask' || segment.type === 'plan') {
      blocks.push({ kind: 'control', id: segment.id, segment })
      index += 1
      continue
    }

    if (segment.type === 'plan_activity') {
      blocks.push({ kind: 'plan_activity', id: segment.id, segment })
      index += 1
      continue
    }

    index += 1
  }

  const fallbackTodos = independentTodos(message.todos)
  if (
    fallbackTodos.length >= MIN_VISIBLE_TODO_ITEMS &&
    !blocks.some((block) => block.kind === 'todos')
  ) {
    blocks.push({ kind: 'todos', id: 'todos-fallback', todos: fallbackTodos })
  }

  return blocks
}

function independentTodos(todos: TodoItem[] | null | undefined): TodoItem[] {
  return (todos || []).filter((todo) => !String(todo.plan_step_id ?? '').trim())
}

function mediaArtifacts(tools: ToolSegment[]): MediaArtifactRef[] {
  const out: MediaArtifactRef[] = []
  const seen = new Set<string>()
  for (const tool of tools) {
    for (const artifact of tool.artifacts || []) {
      const media = artifact.media
      if (!media || media.kind !== 'image' || seen.has(media.id)) continue
      seen.add(media.id)
      out.push(media)
    }
  }
  return out
}

function latestToolTodos(tools: ToolSegment[]) {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]
    if (tool?.todos?.length)
      return { id: tool.toolId || tool.id, todos: tool.todos }
  }
  return undefined
}

function assistantExecutionDuration(message: AssistantMessage, now: number) {
  if (typeof message.durationMs === 'number')
    return Math.max(0, message.durationMs)
  if (
    typeof message.startedAt === 'number' &&
    typeof message.endedAt === 'number'
  ) {
    return Math.max(0, message.endedAt - message.startedAt)
  }
  if (message.streaming && typeof message.startedAt === 'number') {
    return Math.max(0, now - message.startedAt)
  }
  const started: number[] = []
  const ended: number[] = []
  for (const segment of message.segments) {
    if (
      (segment.type === 'thought' || segment.type === 'tool') &&
      typeof segment.startedAt === 'number'
    ) {
      started.push(segment.startedAt)
    }
    if (
      (segment.type === 'thought' || segment.type === 'tool') &&
      typeof segment.endedAt === 'number'
    ) {
      ended.push(segment.endedAt)
    }
  }
  if (message.streaming && started.length)
    return Math.max(0, now - Math.min(...started))
  if (started.length && ended.length)
    return Math.max(0, Math.max(...ended) - Math.min(...started))
  return undefined
}

function visibleSegment(segment: AssistantSegment) {
  if (segment.type !== 'thought') return true
  if (visibleThoughtSummary(segment)) return true
  if (segment.status === 'running') return true
  return (segment.durationMs || 0) >= THOUGHT_MIN_DURATION_MS
}

function visibleThoughtSummary(segment: ThoughtSegment) {
  const summary = segment.summary?.trim()
  if (!summary) return false
  if (
    segment.stage === 'tool_intent' &&
    segment.source === 'audit' &&
    segment.toolIds?.length
  )
    return false
  if (segment.stage !== 'tool_result_summary') return true
  return /失败|出错|中断|未返回|识别到|图片|media|artifact/i.test(summary)
}

function toolGroupStatus(tools: ToolSegment[]): ToolStatus {
  if (tools.some((tool) => tool.status === 'error')) return 'error'
  if (tools.some((tool) => tool.status === 'error_aborted'))
    return 'error_aborted'
  if (tools.some((tool) => tool.status === 'running')) return 'running'
  if (tools.some((tool) => tool.status === 'queued')) return 'queued'
  return 'done'
}

function toolGroupTitle(tools: ToolSegment[]) {
  return tools.length === 1 ? toolTitle(tools[0]) : toolBatchTitle(tools)
}

function belongsToSameToolBatch(first: ToolSegment, next: ToolSegment) {
  if (first.batchId || next.batchId)
    return Boolean(first.batchId && first.batchId === next.batchId)
  return true
}

function toolGroupDuration(tools: ToolSegment[]) {
  const started = tools
    .map((tool) => tool.startedAt)
    .filter((value): value is number => typeof value === 'number')
  const ended = tools
    .map((tool) => tool.endedAt)
    .filter((value): value is number => typeof value === 'number')
  if (started.length && ended.length) {
    return Math.max(0, Math.max(...ended) - Math.min(...started))
  }

  const total = tools.reduce(
    (sum, tool) => sum + Math.max(0, Number(tool.durationMs || 0)),
    0,
  )
  return total || undefined
}
