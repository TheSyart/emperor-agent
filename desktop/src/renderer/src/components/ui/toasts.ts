/**
 * Toast queue (DS-05). At most TOAST_VISIBLE toasts are on screen, newest
 * last; the rest wait in order. A toast's TOAST_DURATION_MS starts when it
 * reaches the screen, not when it is queued. Error toasts stay until
 * closed and carry an error id and a detail text for 「复制详情」.
 * A repeat of a toast already shown or waiting (same tone and message)
 * restarts that toast instead of stacking a copy.
 *
 * App.vue mounts ToastStack once; components reach the queue through the
 * app context (`showToast`, `showError`).
 */
import { computed, shallowRef } from 'vue'

export type ToastTone = 'info' | 'ok' | 'warn' | 'error'

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  sticky: boolean
  /** Error toasts: the id the main-process log records, or a local one. */
  errorId?: string
  /** Error toasts: what 「复制详情」 copies. */
  detail?: string
}

export interface ToastOptions {
  tone?: ToastTone
  /** Stay until closed (errors always do). */
  sticky?: boolean
  detail?: string
  errorId?: string
}

export const TOAST_VISIBLE = 3
export const TOAST_DURATION_MS = 4000

const items = shallowRef<ToastItem[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 1

export const visibleToasts = computed(() => items.value.slice(0, TOAST_VISIBLE))
export const queuedToastCount = computed(() =>
  Math.max(0, items.value.length - TOAST_VISIBLE),
)

function startTimer(item: ToastItem): void {
  if (item.sticky || timers.has(item.id)) return
  timers.set(
    item.id,
    setTimeout(() => dismissToast(item.id), TOAST_DURATION_MS),
  )
}

/** Start the clock of every toast that has reached the screen. */
function promote(): void {
  for (const item of visibleToasts.value) startTimer(item)
}

/** Queue a toast; returns its id (0 for an empty message). */
export function pushToast(message: string, options: ToastOptions = {}): number {
  const text = message.trim()
  if (!text) return 0
  const tone = options.tone ?? 'info'
  const repeat = items.value.find(
    (item) => item.message === text && item.tone === tone,
  )
  if (repeat) {
    const timer = timers.get(repeat.id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(repeat.id)
    }
    promote()
    return repeat.id
  }
  const item: ToastItem = {
    id: nextId++,
    message: text,
    tone,
    sticky: tone === 'error' || Boolean(options.sticky),
    errorId: options.errorId,
    detail: options.detail,
  }
  items.value = [...items.value, item]
  promote()
  return item.id
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  const next = items.value.filter((item) => item.id !== id)
  if (next.length === items.value.length) return
  items.value = next
  promote()
}

function localErrorId(): string {
  const random = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0')
  return `ui_${Date.now().toString(36)}${random}`
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: unknown }).message)
  return String(error)
}

/**
 * Show `error` as a sticky error toast. `context` names what failed
 * (「保存记忆失败」) and leads the message. Errors from Core keep the
 * `errorId` the main process logged them under.
 */
export function showErrorToast(error: unknown, context?: string): number {
  const message = messageOf(error) || '未知错误'
  const carried =
    error && typeof error === 'object' && 'errorId' in error
      ? String((error as { errorId?: unknown }).errorId || '')
      : ''
  const errorId = carried || localErrorId()
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : ''
  const detail = [
    context ? `${context}：${message}` : message,
    code ? `code: ${code}` : '',
    `errorId: ${errorId}`,
    `time: ${new Date().toISOString()}`,
    error instanceof Error && error.stack ? `\n${error.stack}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return pushToast(context ? `${context}：${message}` : message, {
    tone: 'error',
    errorId,
    detail,
  })
}

export function resetToastsForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  items.value = []
}
