/**
 * A request to open the add-model dialog from outside Settings (MOD-04):
 * the composer's model menu sets it and opens 设置 › 模型; ModelSection
 * takes it when it mounts (or while open) and opens the dialog.
 */
import { ref } from 'vue'

const pending = ref(false)

export function requestAddModel(): void {
  pending.value = true
}

/** True once per request. */
export function takeAddModelRequest(): boolean {
  if (!pending.value) return false
  pending.value = false
  return true
}

/** For watchers: whether a request is waiting. */
export const addModelRequested = pending
