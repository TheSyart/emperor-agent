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
 *
 * Sub pages: a section declares its second-level pages with
 * `useSettingsPages({ chrome: 'Chrome 和 Edge' })` and shows the one open
 * (`?settings=<section>&page=<key>`). The header then reads 「分区 › 标题」;
 * the section name is a button back to the main page. A key the section did
 * not declare means its main page.
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

/** Sub page titles a section declares, by key. */
export type SettingsPageTitles = Readonly<Record<string, string>>

/** Where the open sub page lives (the route, or memory in tests). */
export interface SettingsPageNavigation {
  /** The requested sub page key, not yet checked against the section. */
  page: () => string | null
  /** Show a sub page of the open section, or its main page (null). */
  go: (page: string | null) => void
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
  /** The open sub page: the requested key when the section declared it. */
  page: ComputedRef<string | null>
  /** The open sub page's title (the header reads 「分区 › 标题」), or null. */
  trail: ComputedRef<string | null>
  /** Declare sub pages; returns the undeclare function. */
  registerPages: (source: () => SettingsPageTitles) => () => void
  openPage: (page: string) => void
  /** Back to the section's main page. */
  back: () => void
}

export const SETTINGS_HEADER_KEY: InjectionKey<SettingsHeaderHost> =
  Symbol('settings-header')

/** Ordered sources that come and go with the components registering them. */
function registry<T>() {
  const sources = shallowRef<{ id: number; get: () => T }[]>([])
  let seq = 0
  function add(get: () => T) {
    const id = ++seq
    sources.value = [...sources.value, { id, get }]
    return () => {
      sources.value = sources.value.filter((source) => source.id !== id)
    }
  }
  return { sources, add }
}

/**
 * A header host without providing it (tests, galleries). Without
 * `navigation` the open sub page is kept in memory.
 */
export function createSettingsHeader(
  navigation?: SettingsPageNavigation,
): SettingsHeaderHost {
  const actionSources = registry<readonly SettingsHeaderAction[]>()
  const pageSources = registry<SettingsPageTitles>()
  const local = shallowRef<string | null>(null)
  const nav = navigation ?? {
    page: () => local.value,
    go: (page: string | null) => {
      local.value = page
    },
  }
  const actions = computed(() =>
    actionSources.sources.value.flatMap((source) => [...source.get()]),
  )
  const titles = computed<SettingsPageTitles>(() =>
    Object.assign(
      {},
      ...pageSources.sources.value.map((source) => source.get()),
    ),
  )
  const page = computed(() => {
    const key = nav.page()
    return key !== null && Object.hasOwn(titles.value, key) ? key : null
  })
  const trail = computed(() =>
    page.value === null ? null : (titles.value[page.value] ?? null),
  )
  return {
    actions,
    register: actionSources.add,
    page,
    trail,
    registerPages: pageSources.add,
    openPage: (key: string) => nav.go(key),
    back: () => nav.go(null),
  }
}

/** Shell side: create the host and provide it to the section subtree. */
export function provideSettingsHeader(
  navigation?: SettingsPageNavigation,
): SettingsHeaderHost {
  const host = createSettingsHeader(navigation)
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

export interface SettingsPages {
  /** The open sub page, or null on the section's main page. */
  page: ComputedRef<string | null>
  open: (page: string) => void
  back: () => void
}

/**
 * Section side: declare the section's sub pages (key → title) for as long
 * as the calling component lives, and follow the open one. Outside a
 * settings shell (a unit test) the page is kept in memory.
 */
export function useSettingsPages(
  titles: MaybeRefOrGetter<SettingsPageTitles>,
): SettingsPages {
  const host = inject(SETTINGS_HEADER_KEY, null) ?? createSettingsHeader()
  const unregister = host.registerPages(() => toValue(titles))
  if (getCurrentScope()) onScopeDispose(unregister)
  return { page: host.page, open: host.openPage, back: host.back }
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
