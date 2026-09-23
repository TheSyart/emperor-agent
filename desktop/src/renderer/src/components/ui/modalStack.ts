/**
 * Escape stack shared by every modal layer (ui/Modal, SettingsModal).
 *
 * Layers push themselves while open; one document keydown listener (bubble
 * phase) hands Escape to the topmost layer only, marks it handled
 * (preventDefault + stopPropagation) and leaves the layers underneath open.
 * A nested dialog therefore closes by itself, never together with the
 * settings modal it was opened from, whatever order the listeners were
 * registered in. Escape already claimed by an inner control (ui/Menu stops
 * it, SearchField / Select prevent it) is ignored, so those close first.
 */
import { onScopeDispose, watch, type Ref } from 'vue'

export interface ModalLayer {
  /** Called on Escape while this layer is the top of the stack. */
  onEscape: () => void
}

const layers: ModalLayer[] = []
const changeListeners = new Set<() => void>()

function notifyChange(): void {
  for (const listener of [...changeListeners]) listener()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const top = layers[layers.length - 1]
  if (!top) return
  event.preventDefault()
  event.stopPropagation()
  top.onEscape()
}

/** Push a layer; the returned function removes it (idempotent). */
export function pushModalLayer(layer: ModalLayer): () => void {
  if (typeof document === 'undefined') return () => {}
  if (layers.length === 0) document.addEventListener('keydown', onKeydown)
  layers.push(layer)
  notifyChange()
  return () => {
    const index = layers.indexOf(layer)
    if (index < 0) return
    layers.splice(index, 1)
    if (layers.length === 0) document.removeEventListener('keydown', onKeydown)
    notifyChange()
  }
}

/** Keep a layer on the stack while `open` is true (scope-bound). */
export function useModalLayer(open: Ref<boolean>, onEscape: () => void): void {
  let pop: (() => void) | null = null
  const release = () => {
    pop?.()
    pop = null
  }
  watch(
    open,
    (value) => {
      if (value && !pop) pop = pushModalLayer({ onEscape: () => onEscape() })
      else if (!value) release()
    },
    { immediate: true },
  )
  onScopeDispose(release)
}

/** Number of open layers. */
export function modalLayerCount(): number {
  return layers.length
}

/**
 * Call `listener` whenever a layer opens or closes (the embedded browser
 * hides its native view under modals). Returns the unsubscribe function.
 */
export function onModalLayersChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}
