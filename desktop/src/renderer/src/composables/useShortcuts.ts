/**
 * The app's single keyboard-shortcut listener (installed once from App.vue):
 * a capture-phase window keydown handler that maps events through
 * shortcuts.ts `matchShortcut` and runs the handler registered for the
 * matched action. Skipped while a modal layer is open (ui/modalStack); a
 * handled key is prevented and stopped so panes (xterm, inputs) never see it.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { modalLayerCount } from '../components/ui/modalStack'
import {
  detectShortcutPlatform,
  matchShortcut,
  type ShortcutAction,
} from '../shortcuts'

export type ShortcutHandlers = Partial<Record<ShortcutAction, () => unknown>>

/** Whether keyboard focus is in a text-entry control. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement))
    return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function useShortcuts(handlers: ShortcutHandlers): void {
  const platform = detectShortcutPlatform()

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return
    const action = matchShortcut(event, {
      platform,
      modalOpen: modalLayerCount() > 0,
      inEditable: isEditableTarget(event.target),
    })
    const handler = action ? handlers[action] : undefined
    if (!handler) return
    event.preventDefault()
    event.stopPropagation()
    void handler()
  }

  onMounted(() => window.addEventListener('keydown', onKeydown, true))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
}
