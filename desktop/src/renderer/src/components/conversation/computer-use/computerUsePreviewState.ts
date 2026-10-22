/**
 * Shared state of the conversation's computer-use preview:
 * - which targets it currently shows (tool rows offer 「查看画面」 only for
 *   those),
 * - requests to bring one to the front and enlarge it (from a tool row),
 * - the span it takes above the bottom of the view area, so the
 *   environment card above it stops short.
 */
import { reactive, shallowRef } from 'vue'

export interface PreviewFocusRequest {
  readonly targetId: string
  readonly nonce: number
}

let nonce = 0
const focusRequest = shallowRef<PreviewFocusRequest | null>(null)
const shown = shallowRef<ReadonlySet<string>>(new Set())

export const previewLayout = reactive({
  /** px from the preview's top (plus a gap) to the view area's bottom. */
  reservedHeight: 0,
})

export function previewFocusRequest() {
  return focusRequest
}

export function requestPreviewFocus(targetId: string): void {
  focusRequest.value = { targetId, nonce: ++nonce }
}

/** Mark a request handled (only if it is still the latest one). */
export function consumePreviewFocus(request: PreviewFocusRequest): void {
  if (focusRequest.value?.nonce === request.nonce) focusRequest.value = null
}

export function previewShownTargets() {
  return shown
}

export function setPreviewShownTargets(targetIds: readonly string[]): void {
  const next = new Set(targetIds)
  const current = shown.value
  if (
    next.size === current.size &&
    [...next].every((targetId) => current.has(targetId))
  )
    return
  shown.value = next
}
