import type { AssistantMessage, ToolArtifactRef, ToolSegment, ToolStatus } from '../types'

export interface ToolResultUpdate {
  summary?: string
  output?: string
  outputTruncated?: boolean
  artifacts?: ToolArtifactRef[]
  metadata?: Record<string, unknown>
  todos?: ToolSegment['todos']
  isError?: boolean
  endedAt?: number
}

export interface ToolRunUpdate {
  status: Extract<ToolStatus, 'done' | 'error' | 'error_aborted'>
  summary?: string
  output?: string
  outputTruncated?: boolean
  artifacts?: ToolArtifactRef[]
  metadata?: Record<string, unknown>
  endedAt?: number
}

export function applyToolResultToSegment(segment: ToolSegment, update: ToolResultUpdate) {
  finishTimedTool(segment, update.endedAt)
  segment.status = update.isError ? 'error' : 'done'
  segment.summary = textOrEmpty(update.summary) || (update.isError ? '工具执行出错' : '已完成')
  applyOutput(segment, update.output, update.outputTruncated)
  const artifacts = artifactList(update.artifacts)
  if (artifacts) segment.artifacts = artifacts
  const metadata = plainObject(update.metadata)
  if (metadata) segment.metadata = metadata
  const todos = todoList(update.todos)
  if (todos) segment.todos = todos
}

export function applyToolRunUpdateToSegment(segment: ToolSegment, update: ToolRunUpdate) {
  finishTimedTool(segment, update.endedAt)
  segment.status = update.status
  const summary = textOrEmpty(update.summary)
  if (summary) segment.summary = summary
  applyOutput(segment, update.output, update.outputTruncated)
  const artifacts = artifactList(update.artifacts)
  if (artifacts) segment.artifacts = artifacts
  const metadata = plainObject(update.metadata)
  if (metadata) segment.metadata = metadata
}

export function settleRunningToolSegments(
  assistant: AssistantMessage,
  options: { endedAt?: number; summary?: string; status?: Extract<ToolStatus, 'error_aborted' | 'error'> } = {},
) {
  const endedAt = options.endedAt ?? Date.now()
  let settled = 0
  for (const segment of assistant.segments) {
    if (segment.type !== 'tool' || (segment.status !== 'running' && segment.status !== 'queued')) continue
    finishTimedTool(segment, endedAt)
    segment.status = options.status || 'error_aborted'
    segment.summary = options.summary || segment.summary || '工具未返回结束事件'
    settled += 1
  }
  return settled
}

function finishTimedTool(segment: ToolSegment, endedAt = Date.now()) {
  segment.endedAt = endedAt
  if (segment.startedAt) segment.durationMs = Math.max(0, endedAt - segment.startedAt)
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function applyOutput(segment: ToolSegment, output: unknown, outputTruncated: unknown) {
  if (typeof output === 'string') {
    segment.output = output
    segment.outputMissing = false
    segment.outputTruncated = Boolean(outputTruncated)
    return
  }
  if (!segment.output && segment.summary) {
    segment.outputMissing = true
  }
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function artifactList(value: unknown): ToolArtifactRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).path === 'string'))
    .map((item) => {
      const artifact: ToolArtifactRef = { path: String(item.path) }
      if (typeof item.kind === 'string') artifact.kind = item.kind
      if (typeof item.bytes === 'number' && Number.isFinite(item.bytes)) artifact.bytes = item.bytes
      const media = plainObject(item.media)
      if (
        media &&
        typeof media.id === 'string' &&
        typeof media.kind === 'string' &&
        typeof media.mime === 'string' &&
        typeof media.name === 'string' &&
        typeof media.relPath === 'string' &&
        typeof media.originalPath === 'string'
      ) {
        artifact.media = {
          id: media.id,
          kind: media.kind,
          mime: media.mime,
          name: media.name,
          relPath: media.relPath,
          originalPath: media.originalPath,
        }
      }
      const metadata = plainObject(item.metadata)
      if (metadata) artifact.metadata = metadata
      return artifact
    })
  return out.length ? out : undefined
}

function todoList(value: unknown): ToolSegment['todos'] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => ({
      id: typeof item.id === 'number' || typeof item.id === 'string' ? item.id : '',
      content: typeof item.content === 'string' ? item.content : '',
      status: typeof item.status === 'string' ? item.status : 'pending',
      plan_step_id: typeof item.plan_step_id === 'string' || item.plan_step_id === null ? item.plan_step_id : undefined,
      blocked_reason: typeof item.blocked_reason === 'string' || item.blocked_reason === null ? item.blocked_reason : undefined,
    }))
    .filter((item) => item.id !== '' || item.content)
  return out.length ? out : undefined
}
