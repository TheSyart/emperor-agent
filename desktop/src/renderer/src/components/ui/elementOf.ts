import type { ComponentPublicInstance } from 'vue'

/**
 * The element behind a template ref that may be a component (Button,
 * IconButton) or a plain element: menus and popovers anchor to elements.
 */
export function elementOf(value: unknown): HTMLElement | null {
  const el =
    value && typeof value === 'object' && '$el' in value
      ? (value as ComponentPublicInstance).$el
      : value
  return el instanceof HTMLElement ? el : null
}
