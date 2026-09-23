/**
 * In-app notifications (the sidebar bell). Renderer only: nothing reaches
 * Core or the OS. Three layers, all pure:
 *
 * 1. `runtimeNoticeFromEvent` — which live runtime events are worth a
 *    notice (scheduler run done / failed, a question / approval / plan
 *    waiting, a finished turn, a finished git operation).
 * 2. `notificationFromNotice` — the attention policy against what the user
 *    is looking at: a waiting question or a finished turn in the session on
 *    screen is dropped (the conversation already shows it); a scheduler run
 *    or git receipt is kept but lands already read.
 * 3. `reduceNotifications` — the list (newest first, deduped by `key`,
 *    capped at {@link MAX_NOTIFICATIONS}).
 *
 * composables/useNotifications.ts owns the singleton + localStorage.
 */
import type { WsEvent } from '../types'
import {
  gitOperationSummary,
  isGitOperationCompletedEvent,
} from './handlers/git'

export const MAX_NOTIFICATIONS = 50

export type NotificationKind = 'scheduler' | 'pending' | 'turn' | 'git'
export type NotificationTone = 'info' | 'success' | 'warning' | 'error'

/** Where clicking the notification goes. */
export type NotificationTarget =
  | { type: 'session'; sessionId: string }
  | { type: 'scheduler' }
  /** The session's conversation with the workspace 「审查」 pane open. */
  | { type: 'review'; sessionId: string }

export interface AppNotification {
  /** Identity and dedupe key (one real occurrence ⇒ one key). */
  key: string
  kind: NotificationKind
  tone: NotificationTone
  title: string
  detail: string
  /** Epoch ms. */
  createdAt: number
  read: boolean
  target: NotificationTarget
}

export interface NotificationsState {
  /** Newest first. */
  items: AppNotification[]
}

export type NotificationInput = Omit<AppNotification, 'read' | 'createdAt'> & {
  createdAt?: number
  read?: boolean
}

export type NotificationAction =
  | { type: 'add'; notification: NotificationInput; now: number }
  | { type: 'markRead'; keys: readonly string[] }
  | { type: 'markAllRead' }
  | { type: 'clear' }

export function createNotificationsState(): NotificationsState {
  return { items: [] }
}

/**
 * Apply one action. Returns the same state object when nothing changed
 * (callers skip persistence on identity).
 */
export function reduceNotifications(
  state: NotificationsState,
  action: NotificationAction,
): NotificationsState {
  switch (action.type) {
    case 'add': {
      const input = action.notification
      if (!input.key || state.items.some((item) => item.key === input.key))
        return state
      const item: AppNotification = {
        key: input.key,
        kind: input.kind,
        tone: input.tone,
        title: input.title,
        detail: input.detail,
        target: input.target,
        createdAt: input.createdAt ?? action.now,
        read: input.read ?? false,
      }
      return { items: [item, ...state.items].slice(0, MAX_NOTIFICATIONS) }
    }
    case 'markRead': {
      const keys = new Set(action.keys)
      if (!state.items.some((item) => !item.read && keys.has(item.key)))
        return state
      return {
        items: state.items.map((item) =>
          !item.read && keys.has(item.key) ? { ...item, read: true } : item,
        ),
      }
    }
    case 'markAllRead':
      if (!state.items.some((item) => !item.read)) return state
      return {
        items: state.items.map((item) =>
          item.read ? item : { ...item, read: true },
        ),
      }
    case 'clear':
      return state.items.length ? createNotificationsState() : state
  }
}

export function unreadNotificationCount(state: NotificationsState): number {
  return state.items.filter((item) => !item.read).length
}

/** Session a notification points at ('' for scheduler notifications). */
export function notificationSessionId(item: AppNotification): string {
  return item.target.type === 'scheduler' ? '' : item.target.sessionId
}

// ── persistence shape ───────────────────────────────────────────────────

const KINDS = new Set<NotificationKind>(['scheduler', 'pending', 'turn', 'git'])
const TONES = new Set<NotificationTone>(['info', 'success', 'warning', 'error'])

function normalizeTarget(value: unknown): NotificationTarget | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { type?: unknown; sessionId?: unknown }
  if (raw.type === 'scheduler') return { type: 'scheduler' }
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
  if (!sessionId) return null
  if (raw.type === 'session') return { type: 'session', sessionId }
  if (raw.type === 'review') return { type: 'review', sessionId }
  return null
}

function normalizeItem(value: unknown): AppNotification | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const target = normalizeTarget(raw.target)
  const createdAt = Number(raw.createdAt)
  if (
    typeof raw.key !== 'string' ||
    !raw.key ||
    !KINDS.has(raw.kind as NotificationKind) ||
    typeof raw.title !== 'string' ||
    !target ||
    !Number.isFinite(createdAt)
  )
    return null
  return {
    key: raw.key,
    kind: raw.kind as NotificationKind,
    tone: TONES.has(raw.tone as NotificationTone)
      ? (raw.tone as NotificationTone)
      : 'info',
    title: raw.title,
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    createdAt,
    read: raw.read === true,
    target,
  }
}

/** Parse a stored list; malformed entries and duplicates are dropped. */
export function normalizeNotificationsState(
  value: unknown,
): NotificationsState {
  const list =
    value && typeof value === 'object'
      ? (value as { items?: unknown }).items
      : undefined
  if (!Array.isArray(list)) return createNotificationsState()
  const seen = new Set<string>()
  const items: AppNotification[] = []
  for (const entry of list) {
    const item = normalizeItem(entry)
    if (!item || seen.has(item.key)) continue
    seen.add(item.key)
    items.push(item)
    if (items.length >= MAX_NOTIFICATIONS) break
  }
  return { items }
}

// ── runtime events → notices ────────────────────────────────────────────

export type RuntimeNotice =
  | {
      kind: 'scheduler'
      key: string
      status: 'done' | 'error'
      jobName: string
      error: string
      at: number
    }
  | {
      kind: 'pending'
      key: string
      sessionId: string
      label: string
      summary: string
      at: number
    }
  | {
      kind: 'turn'
      key: string
      sessionId: string
      outcome: 'completed' | 'error'
      at: number
    }
  | {
      kind: 'git'
      key: string
      sessionId: string
      summary: string
      at: number
    }

function eventTime(event: WsEvent, now: number): number {
  const ts = Number(event.ts)
  return Number.isFinite(ts) && ts > 0 ? ts : now
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The notice a live runtime event deserves (null: none). `owner` is the
 * event's session (eventOwnerSessionId, falling back to the selected one).
 */
export function runtimeNoticeFromEvent(
  event: WsEvent,
  owner: string,
  now: number,
): RuntimeNotice | null {
  const at = eventTime(event, now)
  const seq = Number(event.seq || 0)
  switch (event.event) {
    case 'scheduler_run_done':
    case 'scheduler_run_error': {
      const job = event.job
      const jobId = text(job?.id)
      const run = text(event.run_id) || text(event.task_id) || `${jobId}:${at}`
      const status = event.event === 'scheduler_run_done' ? 'done' : 'error'
      return {
        kind: 'scheduler',
        key: `scheduler:${run}:${status}`,
        status,
        jobName: text(job?.name) || jobId || '定时任务',
        error:
          event.event === 'scheduler_run_error'
            ? text(event.error) || text(job?.state?.lastError)
            : '',
        at,
      }
    }
    case 'ask_request':
    case 'plan_draft': {
      const interaction = event.interaction
      if (!owner || !interaction?.id) return null
      if (interaction.status && interaction.status !== 'waiting') return null
      const label =
        event.event === 'plan_draft' || interaction.kind === 'plan'
          ? '计划待确认'
          : interaction.id.startsWith('approval_')
            ? '需要你审批'
            : '等待你回答'
      return {
        kind: 'pending',
        key: `pending:${owner}:${interaction.id}`,
        sessionId: owner,
        label,
        summary: text(interaction.title) || text(interaction.context),
        at,
      }
    }
    case 'assistant_done': {
      if (!owner) return null
      const reason = text(event.stop_reason)
      // A stopped or crash-closed turn is not news; everything else is.
      if (reason === 'aborted' || reason === 'interrupted') return null
      const turn = seq > 0 ? String(seq) : text(event.turn_id) || String(at)
      return {
        kind: 'turn',
        key: `turn:${owner}:${turn}`,
        sessionId: owner,
        outcome: reason === 'error' ? 'error' : 'completed',
        at,
      }
    }
    default:
      break
  }
  if (isGitOperationCompletedEvent(event)) {
    if (!owner) return null
    const completedAt = Number(event.completedAt) || at
    return {
      kind: 'git',
      key: `git:${owner}:${event.action}:${completedAt}`,
      sessionId: owner,
      summary: gitOperationSummary(event),
      at: completedAt,
    }
  }
  return null
}

export interface NotificationContext {
  /** Sidebar title of a session ('' when unknown). */
  sessionTitle: (sessionId: string) => string
  /** Session shown in the center column ('' on full pages). */
  viewedSessionId: string
  /** The 定时任务 page is on screen. */
  schedulerPageOpen: boolean
}

function clip(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Apply the attention policy; null when the notice should be dropped. */
export function notificationFromNotice(
  notice: RuntimeNotice,
  context: NotificationContext,
): NotificationInput | null {
  if (notice.kind === 'scheduler')
    return {
      key: notice.key,
      kind: 'scheduler',
      tone: notice.status === 'error' ? 'error' : 'success',
      title: notice.jobName,
      detail:
        notice.status === 'error'
          ? clip(`定时任务失败${notice.error ? `：${notice.error}` : ''}`)
          : '定时任务已完成',
      createdAt: notice.at,
      read: context.schedulerPageOpen,
      target: { type: 'scheduler' },
    }
  const viewed = notice.sessionId === context.viewedSessionId
  const title = context.sessionTitle(notice.sessionId) || '新会话'
  if (notice.kind === 'pending') {
    if (viewed) return null
    return {
      key: notice.key,
      kind: 'pending',
      tone: 'warning',
      title,
      detail: clip(
        notice.summary ? `${notice.label} · ${notice.summary}` : notice.label,
      ),
      createdAt: notice.at,
      target: { type: 'session', sessionId: notice.sessionId },
    }
  }
  if (notice.kind === 'turn') {
    if (viewed) return null
    return {
      key: notice.key,
      kind: 'turn',
      tone: notice.outcome === 'error' ? 'error' : 'success',
      title,
      detail: notice.outcome === 'error' ? '回合出错' : '回合已完成',
      createdAt: notice.at,
      target: { type: 'session', sessionId: notice.sessionId },
    }
  }
  return {
    key: notice.key,
    kind: 'git',
    tone: 'success',
    title,
    detail: notice.summary,
    createdAt: notice.at,
    read: viewed,
    target: { type: 'review', sessionId: notice.sessionId },
  }
}

/** 刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 2026-01-02. */
export function notificationRelativeTime(
  at: number,
  now: number = Date.now(),
): string {
  if (!Number.isFinite(at)) return ''
  const diff = Math.max(0, now - at)
  const minute = 60 * 1000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute)
    return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 30 * 24 * 60 * minute)
    return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
