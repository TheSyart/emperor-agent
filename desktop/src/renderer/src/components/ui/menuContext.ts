import type { InjectionKey } from 'vue'

/** Menu → MenuItem channel: items close their menu after activation. */
export interface MenuContext {
  close: () => void
  dense: boolean
}

export const MENU_CONTEXT: InjectionKey<MenuContext> = Symbol('ds-menu')
