/**
 * CG-00: the group coordinates itself through a structured, one-shot model
 * call. The model proposes; this module is the Core boundary that resolves
 * names and rejects anything the current speaking queue cannot safely run.
 * It has no contact id, member session, tools or permission to write the log.
 */
import { randomUUID } from 'node:crypto'
import type { ContactId, GroupMember, GroupTask } from './types'

export type CoordinatorReason = 'plan' | 'fallback' | 'intervene' | 'summary'

export type CoordinatorResult =
  | { kind: 'relay'; speakers: ContactId[]; note?: string }
  | { kind: 'independent'; speakers: ContactId[]; note?: string }
  | { kind: 'tasks'; tasks: GroupTask[] }
  | { kind: 'answer' | 'clarify' | 'close'; text: string }

export interface CoordinatorRequest {
  groupId: string
  turnId: string
  reason: CoordinatorReason
  /** The user message or guard event that caused this call. */
  source: string
  note?: string
  signal: AbortSignal
}

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoordinatorError'
  }
}

const ACCESSES = new Set(['group_files', 'readonly', 'isolated_worktree'])
const MAX_TASKS = 6
const MAX_SPEAKERS = 12

function required(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CoordinatorError(`${label}不能为空`)
  const text = value.trim()
  if (text.length > limit)
    throw new CoordinatorError(`${label}不能超过 ${limit} 字`)
  return text
}

function speaker(id: unknown, roster: readonly GroupMember[]): ContactId {
  if (typeof id !== 'string')
    throw new CoordinatorError('发言成员必须是名字或 id')
  const member = roster.find((item) => item.id === id || item.name === id)
  if (!member) throw new CoordinatorError(`发言成员「${id}」不在群里`)
  return member.id
}

function speakers(value: unknown, roster: readonly GroupMember[]): ContactId[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SPEAKERS)
    throw new CoordinatorError('协调计划需要 1–12 位发言成员')
  const ids = value.map((id) => speaker(id, roster))
  if (new Set(ids).size !== ids.length)
    throw new CoordinatorError('协调计划不能重复安排同一位成员')
  return ids
}

function validateTask(task: GroupTask, roster: readonly GroupMember[]): void {
  if (!task || typeof task !== 'object')
    throw new CoordinatorError('任务格式不正确')
  required(task.taskId, '任务 id', 128)
  speaker(task.to, roster)
  required(task.title, '任务标题', 200)
  required(task.deliverable, '任务交付物', 1000)
  if (task.basis !== undefined) required(task.basis, '任务依据', 2000)
  if (!ACCESSES.has(task.access)) throw new CoordinatorError('任务权限不合法')
  if (task.state !== 'queued')
    throw new CoordinatorError('新任务必须处于 queued')
  if (task.confirmed === true)
    throw new CoordinatorError('协调模型不能自行确认任务权限')
  if (
    task.hold !== undefined ||
    (task.chain !== undefined && task.chain.length)
  )
    throw new CoordinatorError('简单协调任务不能带交办链或暂停状态')
  for (const key of ['dependsOn', 'acceptance', 'artifacts', 'checks'])
    if (key in task)
      throw new CoordinatorError(
        'CG-00 只支持简单顺序任务，不支持工程依赖或成果字段',
      )
}

/** Validate an injected/model result again at the scheduler boundary. */
export function validateCoordinatorResult(
  result: CoordinatorResult,
  roster: readonly GroupMember[],
): CoordinatorResult {
  if (!result || typeof result !== 'object')
    throw new CoordinatorError('协调结果必须是对象')
  switch (result.kind) {
    case 'relay':
    case 'independent':
      speakers(result.speakers, roster)
      if (result.note !== undefined) required(result.note, '安排说明', 300)
      return result
    case 'tasks': {
      if (
        !Array.isArray(result.tasks) ||
        !result.tasks.length ||
        result.tasks.length > MAX_TASKS
      )
        throw new CoordinatorError('简单计划需要 1–6 项任务')
      const ids = new Set<string>()
      for (const task of result.tasks) {
        validateTask(task, roster)
        if (ids.has(task.taskId)) throw new CoordinatorError('任务 id 不能重复')
        ids.add(task.taskId)
      }
      return result
    }
    case 'answer':
    case 'clarify':
    case 'close':
      required(result.text, '协调说明', 4000)
      return result
    default:
      throw new CoordinatorError('未知的协调结果')
  }
}

function firstObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new CoordinatorError('协调结果不是 JSON')
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new CoordinatorError('协调结果必须是 JSON 对象')
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof CoordinatorError) throw error
    throw new CoordinatorError('协调结果不是有效 JSON')
  }
}

function note(value: unknown): string | undefined {
  return value === undefined || value === ''
    ? undefined
    : required(value, '安排说明', 300)
}

/** Parse model JSON. Ids and state are issued here, never accepted from it. */
export function parseCoordinatorResult(
  text: string,
  roster: readonly GroupMember[],
): CoordinatorResult {
  const value = firstObject(text)
  let result: CoordinatorResult
  switch (value.kind) {
    case 'relay':
    case 'independent':
      result = {
        kind: value.kind,
        speakers: speakers(value.speakers, roster),
        ...(note(value.note) ? { note: note(value.note) } : {}),
      }
      break
    case 'tasks': {
      if (!Array.isArray(value.tasks))
        throw new CoordinatorError('任务计划必须是数组')
      result = {
        kind: 'tasks',
        tasks: value.tasks.map((raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new CoordinatorError('任务格式不正确')
          const input = raw as Record<string, unknown>
          return {
            taskId: `gt_${randomUUID()}`,
            to: speaker(input.to, roster),
            title: required(input.title, '任务标题', 200),
            deliverable: required(input.deliverable, '任务交付物', 1000),
            ...(input.basis
              ? { basis: required(input.basis, '任务依据', 2000) }
              : {}),
            access: input.access,
            state: 'queued',
            chain: [],
            confirmed: false,
          } as GroupTask
        }),
      }
      break
    }
    case 'answer':
    case 'clarify':
    case 'close':
      result = {
        kind: value.kind,
        text: required(value.text, '协调说明', 4000),
      }
      break
    default:
      throw new CoordinatorError('未知的协调结果')
  }
  return validateCoordinatorResult(result, roster)
}
