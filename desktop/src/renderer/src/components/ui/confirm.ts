/**
 * confirm() — the app's confirmation dialog (DS-05), in place of the
 * native `window.confirm`. Every irreversible action asks through it:
 *
 *   if (!(await confirm({ title: '删除这个凭据？', body: '删除后无法恢复。',
 *     confirmLabel: '删除', tone: 'danger' }))) return
 *
 * Requests queue; ConfirmHost (mounted once in App.vue) shows the oldest.
 * Cancel, Escape and a mask click resolve false; the confirm button true.
 */
import { computed, shallowRef } from 'vue'

export interface ConfirmOptions {
  title: string
  body?: string
  /** Default 「确定」. */
  confirmLabel?: string
  /** Default 「取消」. */
  cancelLabel?: string
  /** `danger` paints the confirm button red and focuses 取消 first. */
  tone?: 'default' | 'danger'
}

export interface ConfirmRequest extends Required<ConfirmOptions> {
  id: number
}

interface Pending extends ConfirmRequest {
  resolve: (confirmed: boolean) => void
}

type Responder = (options: ConfirmOptions) => boolean | Promise<boolean>

const queue = shallowRef<Pending[]>([])
let nextId = 1
let responder: Responder | null = null

/** The request ConfirmHost shows now. */
export const activeConfirm = computed<ConfirmRequest | null>(
  () => queue.value[0] ?? null,
)

export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (responder) return Promise.resolve(responder(options))
  return new Promise((resolve) => {
    queue.value = [
      ...queue.value,
      {
        id: nextId++,
        title: options.title,
        body: options.body ?? '',
        confirmLabel: options.confirmLabel ?? '确定',
        cancelLabel: options.cancelLabel ?? '取消',
        tone: options.tone ?? 'default',
        resolve,
      },
    ]
  })
}

/** Answer request `id` (ConfirmHost). */
export function settleConfirm(id: number, confirmed: boolean): void {
  const pending = queue.value.find((item) => item.id === id)
  if (!pending) return
  queue.value = queue.value.filter((item) => item !== pending)
  pending.resolve(confirmed)
}

export function pendingConfirmCount(): number {
  return queue.value.length
}

/**
 * Tests: answer every confirm() with `answer` instead of queueing (null
 * restores the dialog). Pending requests are refused when it is set.
 */
export function answerConfirmsForTest(answer: Responder | null): void {
  responder = answer
  for (const pending of queue.value) pending.resolve(false)
  queue.value = []
}
