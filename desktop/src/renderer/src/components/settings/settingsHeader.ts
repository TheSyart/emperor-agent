/**
 * Settings header actions: the one place a section's refresh / primary /
 * secondary commands render. SettingsModal owns the 54px header and
 * `provideSettingsHeader()`; a section calls `useSettingsHeader({ actions })`
 * in its setup and the shell draws the actions (SettingsHeaderBar) right of
 * the section title, before the close button. Registrations are dropped when
 * the registering component unmounts, so switching sections clears them.
 *
 * Actions are data, not markup, so every section gets the same controls:
 * - kind 'refresh'   28px ghost icon button with the refresh glyph (spins
 *                    while its onClick promise is pending); label defaults
 *                    to 「刷新」.
 * - kind 'icon'      28px ghost icon button with `icon` (label = a11y name).
 * - kind 'secondary' (default) 28px outline capsule, optional leading icon.
 * - kind 'primary'   28px ink-filled capsule, optional leading icon.
 * An action with `menu` opens a dropdown (ui/Menu) of those items instead
 * of calling onClick; capsules then show a trailing chevron.
 *
 * onClick may return a promise: the action is disabled (and a refresh glyph
 * spins) until it settles. Rejections are swallowed here — report failures
 * from the section (ctx.runSafely / toast / inline error).
 */
import {
  computed,
  getCurrentScope,
  inject,
  onScopeDispose,
  provide,
  shallowRef,
  toValue,
  type Component,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
} from 'vue'

export type SettingsHeaderActionKind =
  'refresh' | 'icon' | 'secondary' | 'primary'

export interface SettingsHeaderMenuItem {
  /** Stable key (also `data-menu-item` on the rendered row). */
  id: string
  label: string
  /** 12/18 secondary line under the label. */
  description?: string
  /** 16px leading glyph component. */
  icon?: Component
  danger?: boolean
  disabled?: boolean
  onSelect: () => unknown
}

export interface SettingsHeaderAction {
  /** Stable key (also `data-action` on the rendered control). */
  id: string
  /** Visible text for capsules; accessible name + tooltip for icon kinds. */
  label: string
  kind?: SettingsHeaderActionKind
  /** 16px glyph component (required look for 'icon', optional for capsules). */
  icon?: Component
  onClick?: () => unknown
  disabled?: boolean
  /** Externally driven busy state (in addition to a pending onClick). */
  busy?: boolean
  /** Tooltip override (defaults to `label`). */
  title?: string
  /** Turn the action into a dropdown trigger. */
  menu?: readonly SettingsHeaderMenuItem[]
}

export interface SettingsHeaderOptions {
  /** Array, ref or getter; re-evaluated reactively. */
  actions: MaybeRefOrGetter<readonly SettingsHeaderAction[]>
}

export interface SettingsHeaderHost {
  /** Every registered action in registration order. */
  actions: ComputedRef<SettingsHeaderAction[]>
  /** Register an action source; returns the unregister function. */
  register: (source: () => readonly SettingsHeaderAction[]) => () => void
}

export const SETTINGS_HEADER_KEY: InjectionKey<SettingsHeaderHost> =
  Symbol('settings-header')

/** A header host without providing it (tests, galleries). */
export function createSettingsHeader(): SettingsHeaderHost {
  const sources = shallowRef<
    { id: number; get: () => readonly SettingsHeaderAction[] }[]
  >([])
  let seq = 0
  const actions = computed(() =>
    sources.value.flatMap((source) => [...source.get()]),
  )
  function register(get: () => readonly SettingsHeaderAction[]) {
    const id = ++seq
    sources.value = [...sources.value, { id, get }]
    return () => {
      sources.value = sources.value.filter((source) => source.id !== id)
    }
  }
  return { actions, register }
}

/** Shell side: create the host and provide it to the section subtree. */
export function provideSettingsHeader(): SettingsHeaderHost {
  const host = createSettingsHeader()
  provide(SETTINGS_HEADER_KEY, host)
  return host
}

/**
 * Section side: publish header actions for as long as the calling
 * component lives. No-op outside a settings shell (e.g. a unit test).
 */
export function useSettingsHeader(options: SettingsHeaderOptions): void {
  const host = inject(SETTINGS_HEADER_KEY, null)
  if (!host) return
  const unregister = host.register(() => toValue(options.actions))
  if (getCurrentScope()) onScopeDispose(unregister)
}

/** The standard refresh action (`kind: 'refresh'`, label 「刷新」). */
export function refreshAction(
  onClick: () => unknown,
  overrides: Partial<Omit<SettingsHeaderAction, 'onClick'>> = {},
): SettingsHeaderAction {
  return {
    id: 'refresh',
    label: '刷新',
    kind: 'refresh',
    onClick,
    ...overrides,
  }
}
