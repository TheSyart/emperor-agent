/**
 * Which surface a control sits on. A card-style SettingsGroup provides
 * 'card', so the rows, empty states and selects in it take the card look
 * (16px side padding, inset hairlines, no framed empty box, a control fill
 * that stands out from the card). SettingsCard and Modal provide 'panel'
 * again for whatever they contain, so a card inside a card or a dialog
 * opened from a card stays flat.
 */
import {
  computed,
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
} from 'vue'

export type Surface = 'panel' | 'card'

const SURFACE: InjectionKey<ComputedRef<Surface>> = Symbol('surface')

export function provideSurface(surface: () => Surface): void {
  provide(SURFACE, computed(surface))
}

export function useSurface(): ComputedRef<Surface> {
  return inject(
    SURFACE,
    computed<Surface>(() => 'panel'),
    true,
  )
}
