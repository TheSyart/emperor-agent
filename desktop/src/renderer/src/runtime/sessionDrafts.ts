import type { SessionControlPending, SessionInfo, WsEvent } from '../types'

import { DRAFT_SESSION_PREFIX } from '@emperor/core'

export { DRAFT_SESSION_PREFIX }

export interface DraftSessionOptions {
  title?: string
  mode?: SessionInfo['mode']
  projectId?: string
  projectPath?: string
  projectName?: string
}

function nowStamp() {
  return new Date().toISOString()
}

function randomId() {
  const value = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${DRAFT_SESSION_PREFIX}${value}`
}

export function isDraftSessionId(id: string | undefined | null) {
  return String(id || '').startsWith(DRAFT_SESSION_PREFIX)
}

export function createDraftSession(options: DraftSessionOptions = {}): SessionInfo {
  const now = nowStamp()
  const mode = options.mode === 'build' ? 'build' : 'chat'
  return {
    id: randomId(),
    title: (options.title || '').trim() || '新会话',
    created_at: now,
    updated_at: now,
    preview: '发送第一条消息后创建',
    mode,
    project_id: options.projectId || null,
    project_path: options.projectPath || null,
    project_name: options.projectName || null,
    message_count: 0,
    title_status: 'draft',
    control_pending: null,
    version: 1,
    draft: true,
  }
}

export function applySessionCreated(
  sessions: SessionInfo[],
  event: Extract<WsEvent, { event: 'session_created' }>,
) {
  const incoming = normalizeBackendSession(event.session)
  if (!incoming) return sessions
  const draftId = event.client_draft_id || ''
  const index = sessions.findIndex((session) => session.id === draftId || session.id === incoming.id)
  if (index < 0) return [incoming, ...sessions]
  const next = sessions.slice()
  next[index] = { ...sessions[index], ...incoming, draft: undefined }
  return dedupeSessions(next)
}

export function applySessionTitleUpdated(
  sessions: SessionInfo[],
  event: Extract<WsEvent, { event: 'session_title_updated' }>,
) {
  const incoming = normalizeBackendSession(event.session)
  if (!incoming) return sessions
  return sessions.map((session) =>
    session.id === incoming.id
      ? { ...session, ...incoming, draft: undefined }
      : session,
  )
}

function normalizeBackendSession(value: unknown): SessionInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<SessionInfo>
  if (!raw.id || !raw.title) return null
  return {
    id: String(raw.id),
    title: String(raw.title),
    created_at: String(raw.created_at || nowStamp()),
    updated_at: String(raw.updated_at || nowStamp()),
    preview: String(raw.preview || ''),
    mode: raw.mode === 'build' ? 'build' : 'chat',
    project_id: raw.project_id ? String(raw.project_id) : null,
    project_path: raw.project_path ? String(raw.project_path) : null,
    project_name: raw.project_name ? String(raw.project_name) : null,
    message_count: Number(raw.message_count || 0),
    title_status: String(raw.title_status || 'manual'),
    control_pending: normalizeControlPending(raw.control_pending),
    version: Number(raw.version || 1),
  }
}

function normalizeControlPending(value: unknown): SessionControlPending | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<SessionControlPending> & { interactionId?: unknown; updatedAt?: unknown }
  const kind = raw.kind === 'plan' ? 'plan' : raw.kind === 'ask' ? 'ask' : ''
  const interactionId = String(raw.interaction_id ?? raw.interactionId ?? '').trim()
  if (!kind || !interactionId) return null
  return {
    kind,
    label: String(raw.label || (kind === 'plan' ? '计划需要用户确认' : '需要用户输入')).slice(0, 40),
    tone: kind === 'plan' ? 'green' : 'blue',
    interaction_id: interactionId,
    updated_at: Number(raw.updated_at ?? raw.updatedAt ?? Date.now()) || Date.now(),
  }
}

function dedupeSessions(items: SessionInfo[]) {
  const seen = new Set<string>()
  const out: SessionInfo[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}
