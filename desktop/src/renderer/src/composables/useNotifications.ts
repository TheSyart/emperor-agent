/**
 * App-wide notification list (the sidebar bell): one module singleton over
 * the pure reducer in runtime/notifications.ts, persisted to localStorage
 * (`emperor.notifications.v1`). Storage is best-effort: a private window or
 * blocked storage keeps the list in memory only.
 */
import { computed, shallowRef } from 'vue'
import {
  createNotificationsState,
  normalizeNotificationsState,
  notificationSessionId,
  reduceNotifications,
  unreadNotificationCount,
  type NotificationAction,
  type NotificationInput,
  type NotificationsState,
} from '../runtime/notifications'

export const NOTIFICATIONS_STORAGE_KEY = 'emperor.notifications.v1'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readStored(): NotificationsState {
  try {
    const raw = storage()?.getItem(NOTIFICATIONS_STORAGE_KEY)
    return raw
      ? normalizeNotificationsState(JSON.parse(raw))
      : createNotificationsState()
  } catch {
    return createNotificationsState()
  }
}

function persist(next: NotificationsState): void {
  try {
    const store = storage()
    if (!store) return
    if (next.items.length)
      store.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(next))
    else store.removeItem(NOTIFICATIONS_STORAGE_KEY)
  } catch {
    // Best-effort: the in-memory list stays authoritative.
  }
}

const state = shallowRef<NotificationsState>(readStored())
const items = computed(() => state.value.items)
const unreadCount = computed(() => unreadNotificationCount(state.value))

function dispatch(action: NotificationAction): void {
  const next = reduceNotifications(state.value, action)
  if (next === state.value) return
  state.value = next
  persist(next)
}

function add(notification: NotificationInput): void {
  dispatch({ type: 'add', notification, now: Date.now() })
}

function markRead(keys: readonly string[]): void {
  dispatch({ type: 'markRead', keys })
}

/** Mark everything that points at `sessionId` read (the user opened it). */
function markSessionRead(sessionId: string): void {
  if (!sessionId) return
  markRead(
    state.value.items
      .filter((item) => !item.read && notificationSessionId(item) === sessionId)
      .map((item) => item.key),
  )
}

function markAllRead(): void {
  dispatch({ type: 'markAllRead' })
}

function clear(): void {
  dispatch({ type: 'clear' })
}

export function useNotifications() {
  return {
    items,
    unreadCount,
    add,
    markRead,
    markSessionRead,
    markAllRead,
    clear,
  }
}
