import { randomUUID } from 'node:crypto'
import { nowTs } from '../util/time'

export const TEAM_SCHEMA_VERSION = 1
export const LEAD_ACTOR = 'lead'
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const RESERVED_NAMES = new Set([
  LEAD_ACTOR,
  'config',
  'inbox',
  'threads',
  'checkpoints',
  'cursors',
])

export enum TeamStatus {
  IDLE = 'idle',
  WORKING = 'working',
  OFFLINE = 'offline',
  SHUTDOWN = 'shutdown',
  ERROR = 'error',
}

export interface TeamMemberPayload {
  name: string
  role: string
  agent_type: string
  status: TeamStatus
  created_at: number
  updated_at: number
  last_error: string | null
  [key: string]: unknown
}

export interface TeamMessagePayload {
  id: string
  type: string
  from: string
  to: string
  content: string
  timestamp: number
  task_id: string | null
  in_reply_to: string | null
  meta: Record<string, unknown>
  [key: string]: unknown
}

export function newTeamId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function validateMemberName(name: string): string {
  const safe = String(name || '').trim()
  if (!NAME_RE.test(safe))
    throw new Error('member name must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}')
  if (RESERVED_NAMES.has(safe))
    throw new Error(`member name ${JSON.stringify(safe)} is reserved`)
  return safe
}

export function validateActorName(name: string): string {
  const actor = String(name || '').trim()
  return actor === LEAD_ACTOR ? actor : validateMemberName(actor)
}

export class TeamMember {
  name: string
  role: string
  agent_type: string
  status: TeamStatus
  created_at: number
  updated_at: number
  last_error: string | null

  constructor(opts: {
    name: string
    role: string
    agent_type: string
    status?: TeamStatus | string
    created_at?: number
    updated_at?: number
    last_error?: string | null
  }) {
    this.name = validateMemberName(opts.name)
    this.role = opts.role
    this.agent_type = opts.agent_type
    this.status = normalizeStatus(opts.status)
    this.created_at = opts.created_at ?? nowTs()
    this.updated_at = opts.updated_at ?? nowTs()
    this.last_error = opts.last_error ?? null
  }

  static fromDict(raw: Record<string, unknown>): TeamMember {
    return new TeamMember({
      name: String(raw.name ?? ''),
      role: String(raw.role ?? ''),
      agent_type: String(raw.agent_type ?? raw.agentType ?? ''),
      status: String(raw.status ?? TeamStatus.IDLE),
      created_at: Number(raw.created_at ?? raw.createdAt ?? nowTs()),
      updated_at: Number(raw.updated_at ?? raw.updatedAt ?? nowTs()),
      last_error:
        raw.last_error || raw.lastError
          ? String(raw.last_error ?? raw.lastError)
          : null,
    })
  }

  toDict(): TeamMemberPayload {
    return {
      name: this.name,
      role: this.role,
      agent_type: this.agent_type,
      status: this.status,
      created_at: this.created_at,
      updated_at: this.updated_at,
      last_error: this.last_error,
    }
  }

  touch(
    opts: {
      status?: TeamStatus | string | null
      last_error?: string | null
    } = {},
  ): TeamMember {
    return new TeamMember({
      name: this.name,
      role: this.role,
      agent_type: this.agent_type,
      status: opts.status ?? this.status,
      created_at: this.created_at,
      updated_at: nowTs(),
      last_error: opts.last_error ?? null,
    })
  }
}

export class TeamMessage {
  id: string
  type: string
  from_actor: string
  to: string
  content: string
  timestamp: number
  task_id: string | null
  in_reply_to: string | null
  meta: Record<string, unknown>

  constructor(opts: {
    id: string
    type: string
    from_actor: string
    to: string
    content: string
    timestamp?: number
    task_id?: string | null
    in_reply_to?: string | null
    meta?: Record<string, unknown>
  }) {
    this.id = opts.id || newTeamId('msg')
    this.type = opts.type || 'message'
    this.from_actor = validateActorName(opts.from_actor)
    this.to = validateActorName(opts.to)
    this.content = String(opts.content || '')
    this.timestamp = opts.timestamp ?? nowTs()
    this.task_id = opts.task_id ?? null
    this.in_reply_to = opts.in_reply_to ?? null
    this.meta = opts.meta ?? {}
  }

  static create(opts: {
    from_actor: string
    to: string
    content: string
    type?: string
    task_id?: string | null
    in_reply_to?: string | null
    meta?: Record<string, unknown> | null
  }): TeamMessage {
    return new TeamMessage({
      id: newTeamId('msg'),
      type: opts.type ?? 'message',
      from_actor: opts.from_actor,
      to: opts.to,
      content: opts.content,
      task_id: opts.task_id ?? null,
      in_reply_to: opts.in_reply_to ?? null,
      meta: opts.meta ?? {},
    })
  }

  static fromDict(raw: Record<string, unknown>): TeamMessage {
    return new TeamMessage({
      id: String(raw.id ?? newTeamId('msg')),
      type: String(raw.type ?? 'message'),
      from_actor: String(raw.from ?? raw.from_actor ?? ''),
      to: String(raw.to ?? ''),
      content: String(raw.content ?? ''),
      timestamp: Number(raw.timestamp ?? nowTs()),
      task_id: raw.task_id ? String(raw.task_id) : null,
      in_reply_to: raw.in_reply_to ? String(raw.in_reply_to) : null,
      meta:
        raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)
          ? (raw.meta as Record<string, unknown>)
          : {},
    })
  }

  toDict(): TeamMessagePayload {
    return {
      id: this.id,
      type: this.type,
      from: this.from_actor,
      to: this.to,
      content: this.content,
      timestamp: this.timestamp,
      task_id: this.task_id,
      in_reply_to: this.in_reply_to,
      meta: this.meta,
    }
  }
}

function normalizeStatus(value: unknown): TeamStatus {
  return Object.values(TeamStatus).includes(value as TeamStatus)
    ? (value as TeamStatus)
    : TeamStatus.IDLE
}
