/**
 * SkinHost (BRD-05, D8): the chosen skin on the page. Always loaded, so it
 * stays small: the skin's tokens go on the root element as inline styles
 * (no stylesheet), the heading font as `--font-heading`, a one-look skin
 * holds the theme (useTheme's lock), and exempt zones read the base
 * theme's values back with useSkinExempt().
 *
 * The choice and the last view main checked are kept per Mac in
 * localStorage (like the theme), so a start-up paints the skin at once;
 * main is asked again right after, and a skin whose folder is gone falls
 * back to 御书房 with a toast. Outside the desktop window (no bridge, the
 * visual harness) there is no skin: no tokens and no decorations.
 *
 * Decorations go through SkinSlot.vue, which asks skinSlotUrl(); the
 * 「显示吉祥物」 switch (BRD-04) hides them all with
 * setSkinDecorationsShown(false).
 */
import { computed, ref, shallowRef } from 'vue'
import type { SkinGetResult } from '../../../shared/ipc-contract'
import {
  DEFAULT_SKIN_ID,
  sanitizeSkinView,
  SKIN_ID_PATTERN,
  type SkinFont,
  type SkinSlotName,
  type SkinView,
} from '../../../shared/skin-contract'
import { pushToast } from '../components/ui/toasts'
import { lockTheme, useTheme } from '../composables/useTheme'

export const SKIN_STORAGE_KEY = 'emperor.skin.v1'

/** The font stacks behind skin.json's `fonts.heading`. */
const HEADING_FONTS: Record<Exclude<SkinFont, 'system'>, string> = {
  songti: "'Songti SC', 'STSong', 'Noto Serif CJK SC', serif",
  kaiti: "'Kaiti SC', 'STKaiti', 'KaiTi', serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'PingFang SC', sans-serif",
}

interface SkinBridge {
  skinGet?: (id: string) => Promise<SkinGetResult>
}

function bridge(): SkinBridge | null {
  const emperor = (globalThis as { window?: { emperor?: SkinBridge } }).window
    ?.emperor
  return emperor?.skinGet ? emperor : null
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const active = shallowRef<SkinView | null>(null)
const decorations = ref(true)
/** Allows so far; SkinStamp shows the seal on each new one. */
export const approvals = ref(0)
let applied: string[] = []
let started = false
/** Bumped on every change of skin: a slower answer never undoes a newer one. */
let generation = 0

function readStored(): { id: string; view: SkinView | null } {
  try {
    const raw = JSON.parse(storage()?.getItem(SKIN_STORAGE_KEY) ?? 'null')
    const id =
      typeof raw?.id === 'string' && SKIN_ID_PATTERN.test(raw.id)
        ? raw.id
        : DEFAULT_SKIN_ID
    const view = sanitizeSkinView(raw?.view)
    return { id, view: view?.id === id ? view : null }
  } catch {
    return { id: DEFAULT_SKIN_ID, view: null }
  }
}

function store(view: SkinView): void {
  try {
    storage()?.setItem(SKIN_STORAGE_KEY, JSON.stringify({ id: view.id, view }))
  } catch {
    // The skin still applies for this window.
  }
}

/** Puts the view's tokens on the root and holds the theme it needs. */
function paint(view: SkinView | null): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const name of applied) root.style.removeProperty(name)
  applied = []
  const tokens: Record<string, string> = { ...(view?.tokens ?? {}) }
  const heading = view?.fonts.heading ?? 'system'
  if (heading !== 'system') tokens['--font-heading'] = HEADING_FONTS[heading]
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value)
    applied.push(name)
  }
  if (!root.getAttribute('style')) root.removeAttribute('style')
  if (view) root.dataset.skin = view.id
  else delete root.dataset.skin
  lockTheme(
    view && view.base !== 'auto'
      ? {
          theme: view.base,
          message: `皮肤「${view.name}」只有${view.base === 'light' ? '浅色' : '深色'}，换个皮肤才能用${view.base === 'light' ? '深色' : '浅色'}`,
        }
      : null,
  )
}

function show(view: SkinView | null): void {
  generation += 1
  active.value = view
  paint(view)
}

async function fetchView(id: string): Promise<SkinView | 'missing' | null> {
  const api = bridge()
  if (!api?.skinGet) return null
  const result = await api.skinGet(id)
  if (result.ok) return sanitizeSkinView(result.skin)
  if ('missing' in result) return 'missing'
  throw new Error(result.error)
}

/** Asks main for the shown skin again; a missing one falls back to 御书房. */
export async function verifySkin(): Promise<void> {
  const current = active.value ?? readStored().view
  const id = current?.id ?? readStored().id
  const asked = generation
  let view: SkinView | 'missing' | null
  try {
    view = await fetchView(id)
  } catch {
    return
  }
  if (asked !== generation) return
  if (view && view !== 'missing') {
    show(view)
    store(view)
    return
  }
  if (view !== 'missing' || id === DEFAULT_SKIN_ID) return
  const fallback = await fetchView(DEFAULT_SKIN_ID).catch(() => null)
  if (asked !== generation) return
  const usable = fallback && fallback !== 'missing' ? fallback : null
  show(usable)
  if (usable) store(usable)
  else storage()?.removeItem(SKIN_STORAGE_KEY)
  pushToast(
    `找不到皮肤「${current?.name ?? id}」，已换回「${usable?.name ?? '御书房'}」`,
  )
}

/**
 * Start-up (main.ts, after initTheme): paint the cached skin at once, then
 * ask main. Idempotent.
 */
export function initSkin(): void {
  if (started) return
  started = true
  if (!bridge()) return
  const { view } = readStored()
  if (view) show(view)
  void verifySkin()
}

/** 设置 › 皮肤 › 使用: checked by main, painted, remembered. */
export async function selectSkin(id: string): Promise<SkinView | null> {
  // A choice outranks a check still on its way.
  const asked = ++generation
  const view = await fetchView(id)
  if (view === 'missing') throw new Error(`找不到皮肤「${id}」`)
  if (!view || asked !== generation) return null
  show(view)
  store(view)
  return view
}

export function useSkin() {
  return { skin: active, decorations }
}

/** A slot's picture, or null (no skin, no such slot, decorations off). */
export function skinSlotUrl(name: SkinSlotName): string | null {
  if (!decorations.value) return null
  return active.value?.slots[name] ?? null
}

/** 「显示吉祥物」 (BRD-04): every decoration on or off. */
export function setSkinDecorationsShown(on: boolean): void {
  decorations.value = on
}

/** The user allowed an action (ApprovalPanel): the skin may stamp it. */
export function markApproved(): void {
  approvals.value += 1
}

const exempt = computed<Record<string, string>>(() => {
  const view = active.value
  if (!view || !Object.keys(view.tokens).length) return {}
  return view.reset[useTheme().theme.value] ?? {}
})

/**
 * For an exempt zone's root (`:style="exempt"`): every token the skin
 * changed, back at the base theme's value. Empty without a skin.
 */
export function useSkinExempt() {
  return exempt
}

/** Test seam: no skin, nothing on the root, a fresh start. */
export function resetSkinForTests(): void {
  started = false
  show(null)
  decorations.value = true
  approvals.value = 0
}
