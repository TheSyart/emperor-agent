import type { RuntimeStatus, WsEvent } from '../types'
import type {
  ActionEffectDescriptor,
  ActionEffectTaskResult,
} from './actionEffect'

export interface SessionRuntimeProjection {
  running: boolean
  attention: boolean
  lastSeq: number
}

export interface SessionProjectionState {
  activeSessionId: string
  activeLastSeq: number
  transport: RuntimeStatus
  generation: number
  connectEffectId: string | null
  sessions: Record<string, SessionRuntimeProjection>
}

export interface SessionEffect extends ActionEffectDescriptor {
  domain: 'session'
  type: 'subscribe_core_events'
  sessionId: string
  generation: number
  replace: boolean
}

export interface SessionEffectOutput {
  generation: number
  connected: boolean
  reused: boolean
}

export type SessionProjectionAction =
  | { type: 'session_connect_requested' }
  | { type: 'session_switched'; sessionId: string }
  | {
      type: 'session_draft_materialized'
      draftId: string
      sessionId: string
    }
  | { type: 'session_attention_cleared'; sessionId: string }
  | { type: 'session_running_cleared' }
  | { type: 'session_settled'; sessionId: string; attention: boolean }
  | { type: 'session_bootstrap_tasks'; sessionIds: string[] }
  | { type: 'session_replay_completed'; state: SessionProjectionState }
  | { type: 'session_cursor_advanced'; seq: number }
  | {
      type: 'runtime_event_received'
      origin: 'live' | 'replay'
      event: WsEvent
    }
  | {
      type: 'session_effect_result'
      result: ActionEffectTaskResult<SessionEffect, SessionEffectOutput>
    }

export interface SessionProjectionMeta {
  accepted: boolean
  foreign: boolean
  duplicate: boolean
  serverRestarted: boolean
}

export interface SessionProjectionTransition {
  state: SessionProjectionState
  effects: SessionEffect[]
  meta: SessionProjectionMeta
}

const DEFAULT_META: SessionProjectionMeta = {
  accepted: true,
  foreign: false,
  duplicate: false,
  serverRestarted: false,
}

const RUNNING_EVENTS = new Set<string>([
  'prompt_dequeued',
  'prompt_interjected',
  'user_message',
  'message_delta',
  'agent_thought',
  'plan_draft_delta',
  'tool_call',
  'tool_run_queued',
  'tool_run_started',
  'tool_result',
  'tool_run_completed',
  'tool_run_failed',
  'hook_run_started',
  'hook_run_progress',
])

const TERMINAL_EVENTS = new Set<string>([
  'assistant_done',
  'turn_paused',
  'runtime_task_cancelled',
  'error',
])

export function createSessionProjectionState(
  activeSessionId = '',
): SessionProjectionState {
  return {
    activeSessionId,
    activeLastSeq: 0,
    transport: 'connecting',
    generation: 0,
    connectEffectId: null,
    sessions: {},
  }
}

export function reduceSessionProjection(
  state: SessionProjectionState,
  action: SessionProjectionAction,
): SessionProjectionTransition {
  if (action.type === 'session_connect_requested')
    return connectTransition(state, state.activeSessionId, false)

  if (action.type === 'session_switched') {
    const sessionId = action.sessionId.trim()
    const sessions = cloneSessions(state.sessions)
    if (sessionId && sessions[sessionId])
      sessions[sessionId] = { ...sessions[sessionId]!, attention: false }
    return connectTransition(
      {
        ...state,
        activeSessionId: sessionId,
        activeLastSeq: 0,
        sessions,
      },
      sessionId,
      true,
    )
  }

  if (action.type === 'session_draft_materialized') {
    const draftId = action.draftId.trim()
    const sessionId = action.sessionId.trim()
    if (!sessionId || state.activeSessionId !== draftId)
      return transition(state)
    const previous = state.sessions[draftId] ?? emptySessionRuntime()
    const sessions = { ...state.sessions }
    delete sessions[draftId]
    sessions[sessionId] = {
      ...(sessions[sessionId] ?? emptySessionRuntime()),
      running: previous.running,
      attention: false,
      lastSeq: Math.max(
        previous.lastSeq,
        sessions[sessionId]?.lastSeq ?? 0,
      ),
    }
    return transition({
      ...state,
      activeSessionId: sessionId,
      activeLastSeq: sessions[sessionId]!.lastSeq,
      sessions,
    })
  }

  if (action.type === 'session_attention_cleared') {
    const current = state.sessions[action.sessionId]
    if (!current?.attention) return transition(state)
    return transition({
      ...state,
      sessions: {
        ...state.sessions,
        [action.sessionId]: { ...current, attention: false },
      },
    })
  }

  if (action.type === 'session_running_cleared') {
    const sessions = Object.fromEntries(
      Object.entries(state.sessions).map(([id, value]) => [
        id,
        { ...value, running: false },
      ]),
    )
    return transition({ ...state, sessions })
  }

  if (action.type === 'session_settled') {
    const sessionId = action.sessionId.trim()
    if (!sessionId) return transition(state)
    const current = state.sessions[sessionId] ?? emptySessionRuntime()
    return transition({
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...current,
          running: false,
          attention:
            sessionId === state.activeSessionId ? false : action.attention,
        },
      },
    })
  }

  if (action.type === 'session_bootstrap_tasks') {
    const sessions = cloneSessions(state.sessions)
    for (const sessionId of action.sessionIds) {
      const id = sessionId.trim()
      if (!id) continue
      sessions[id] = {
        ...(sessions[id] ?? emptySessionRuntime()),
        running: true,
      }
    }
    return transition({ ...state, sessions })
  }

  if (action.type === 'session_replay_completed')
    return transition({
      ...action.state,
      transport: state.transport,
      generation: state.generation,
      connectEffectId: state.connectEffectId,
    })

  if (action.type === 'session_cursor_advanced')
    return transition({
      ...state,
      activeLastSeq: Math.max(
        state.activeLastSeq,
        Math.max(0, Number(action.seq || 0)),
      ),
    })

  if (action.type === 'session_effect_result') {
    if (
      action.result.effect.id !== state.connectEffectId ||
      action.result.effect.generation !== state.generation
    )
      return transition(state)
    return transition({
      ...state,
      transport:
        action.result.status === 'success' && action.result.output?.connected
          ? 'ready'
          : 'error',
    })
  }

  return reduceRuntimeEvent(state, action.event)
}

export function eventOwnerSessionId(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const payload = data as Record<string, unknown>
  const direct = String(payload.session_id ?? payload.sessionId ?? '').trim()
  if (direct) return direct
  const owner = payload.owner
  if (owner && typeof owner === 'object' && !Array.isArray(owner))
    return String(
      (owner as Record<string, unknown>).session_id ??
        (owner as Record<string, unknown>).sessionId ??
        '',
    ).trim()
  return ''
}

function connectTransition(
  state: SessionProjectionState,
  sessionId: string,
  replace: boolean,
): SessionProjectionTransition {
  const generation = state.generation + 1
  const effect: SessionEffect = {
    id: `session:subscribe:${generation}:${sessionId || 'none'}`,
    key: 'session:core-events',
    domain: 'session',
    type: 'subscribe_core_events',
    sessionId,
    generation,
    replace,
    timeoutMs: 2_000,
  }
  return {
    state: {
      ...state,
      transport: 'connecting',
      generation,
      connectEffectId: effect.id,
    },
    effects: [effect],
    meta: DEFAULT_META,
  }
}

function reduceRuntimeEvent(
  state: SessionProjectionState,
  event: WsEvent,
): SessionProjectionTransition {
  if (event.event === 'ready') {
    const latestSeq = Math.max(0, Number(event.latest_seq || 0))
    const serverRestarted =
      state.activeLastSeq > 0 && latestSeq < state.activeLastSeq
    return {
      state: {
        ...state,
        transport: 'ready',
        activeLastSeq: serverRestarted ? latestSeq : state.activeLastSeq,
      },
      effects: [],
      meta: { ...DEFAULT_META, serverRestarted },
    }
  }

  const owner = eventOwnerSessionId(event)
  const active = state.activeSessionId
  const draftMaterialization = Boolean(
    event.event === 'session_created' &&
      active.startsWith('draft:') &&
      event.client_draft_id === active &&
      event.session?.id,
  )
  const foreign = Boolean(
    owner &&
      active &&
      !draftMaterialization &&
      (active.startsWith('draft:') || owner !== active),
  )
  const sessionKey = owner || active
  const seq = Math.max(0, Number(event.seq || 0))
  const current = sessionKey
    ? state.sessions[sessionKey] ?? emptySessionRuntime()
    : null
  const cursor = current?.lastSeq ?? state.activeLastSeq
  if (seq > 0 && seq <= cursor)
    return {
      state,
      effects: [],
      meta: { accepted: false, foreign, duplicate: true, serverRestarted: false },
    }

  let sessions = state.sessions
  if (sessionKey) {
    const next = {
      ...(current ?? emptySessionRuntime()),
      lastSeq: seq > 0 ? Math.max(current?.lastSeq ?? 0, seq) : current?.lastSeq ?? 0,
    }
    if (RUNNING_EVENTS.has(event.event)) next.running = true
    if (TERMINAL_EVENTS.has(event.event)) {
      next.running = false
      next.attention = foreign
    }
    sessions = { ...state.sessions, [sessionKey]: next }
  }

  return {
    state: {
      ...state,
      sessions,
      activeLastSeq:
        !foreign && seq > 0 ? Math.max(state.activeLastSeq, seq) : state.activeLastSeq,
    },
    effects: [],
    meta: {
      accepted: !foreign,
      foreign,
      duplicate: false,
      serverRestarted: false,
    },
  }
}

function transition(
  state: SessionProjectionState,
  effects: SessionEffect[] = [],
): SessionProjectionTransition {
  return { state, effects, meta: DEFAULT_META }
}

function emptySessionRuntime(): SessionRuntimeProjection {
  return { running: false, attention: false, lastSeq: 0 }
}

function cloneSessions(
  sessions: Record<string, SessionRuntimeProjection>,
): Record<string, SessionRuntimeProjection> {
  return Object.fromEntries(
    Object.entries(sessions).map(([id, value]) => [id, { ...value }]),
  )
}
