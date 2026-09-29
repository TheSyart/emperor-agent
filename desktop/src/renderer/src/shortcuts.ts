/**
 * App keyboard shortcuts: one pure binding table + matcher (unit-tested).
 * `composables/useShortcuts.ts` installs the single window listener; the
 * workspace launcher renders its kbd chips from the same table.
 *
 * Rules:
 * - Every binding carries ⌘ (`mod`, Ctrl off macOS) or a literal ⌃ (`ctrl`);
 *   unmodified keys are never bound.
 * - Electron's default menu keeps its accelerators: ⌘R / ⌘W / ⌘M / ⌘H / ⌘Q /
 *   ⌘0 / ⌘+ / ⌘- / ⌥⌘I / ⌃⌘F / ⇧⌘R are never bound here.
 * - Nothing fires while a modal layer (ui/modalStack) is open.
 * - Inside an editable field, Ctrl+Alt combos are skipped off macOS: on many
 *   layouts that chord is AltGr and types characters (€, ę, …).
 */

export type ShortcutAction =
  | 'workspace.review'
  | 'workspace.terminal'
  | 'workspace.files'
  | 'workspace.browser'
  | 'workspace.desktop'
  | 'workspace.toggle'
  | 'envCard.toggle'
  | 'sidebar.toggle'
  | 'session.new'
  | 'search'
  | 'nav.back'
  | 'nav.forward'

export type ShortcutPlatform = 'mac' | 'other'

export interface ShortcutBinding {
  action: ShortcutAction
  /** Normalized key: a lowercase letter, digit, '`', '[' or ']'. */
  key: string
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean
  /** Literal Control (⌃) on every platform. */
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  /** What the shortcut does (中文, for tooltips / menus). */
  label: string
}

export const SHORTCUTS: readonly ShortcutBinding[] = [
  {
    action: 'workspace.review',
    key: 'g',
    ctrl: true,
    shift: true,
    label: '审查',
  },
  { action: 'workspace.terminal', key: '`', ctrl: true, label: '终端' },
  { action: 'workspace.files', key: 'p', mod: true, label: '文件' },
  { action: 'workspace.browser', key: 't', mod: true, label: '浏览器' },
  {
    action: 'workspace.desktop',
    key: 'd',
    ctrl: true,
    shift: true,
    label: '电脑',
  },
  {
    action: 'workspace.toggle',
    key: 'b',
    mod: true,
    alt: true,
    label: '开关工作台',
  },
  {
    action: 'envCard.toggle',
    key: 'e',
    mod: true,
    alt: true,
    label: '开关环境信息',
  },
  { action: 'sidebar.toggle', key: 'b', mod: true, label: '开关侧栏' },
  { action: 'session.new', key: 'n', mod: true, label: '新对话' },
  { action: 'search', key: 'k', mod: true, label: '搜索' },
  { action: 'nav.back', key: '[', mod: true, label: '后退' },
  { action: 'nav.forward', key: ']', mod: true, label: '前进' },
]

/** Physical-key fallback when `key` is not the plain character (⌥ chords). */
const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
}

/** The KeyboardEvent fields the matcher reads (tests pass plain objects). */
export interface ShortcutKeyEvent {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  getModifierState?: (key: string) => boolean
}

export interface ShortcutContext {
  platform: ShortcutPlatform
  /** A modal layer is open (ui/modalStack): nothing matches. */
  modalOpen?: boolean
  /** Focus is in an input / textarea / contenteditable. */
  inEditable?: boolean
}

/** Normalize the pressed key to the table's vocabulary. */
export function normalizeShortcutKey(event: ShortcutKeyEvent): string {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  if (/^[a-z0-9`[\]]$/.test(key)) return key
  const code = event.code ?? ''
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!.toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  return CODE_KEYS[code] ?? key.toLowerCase()
}

function modifiersMatch(
  binding: ShortcutBinding,
  event: ShortcutKeyEvent,
  platform: ShortcutPlatform,
): boolean {
  if (event.altKey !== Boolean(binding.alt)) return false
  if (event.shiftKey !== Boolean(binding.shift)) return false
  if (platform === 'mac')
    return (
      event.metaKey === Boolean(binding.mod) &&
      event.ctrlKey === Boolean(binding.ctrl)
    )
  // Off macOS ⌘ and ⌃ both mean Ctrl; the Windows / Super key never counts.
  return (
    !event.metaKey && event.ctrlKey === Boolean(binding.mod || binding.ctrl)
  )
}

/** The action bound to `event`, or null. Pure. */
export function matchShortcut(
  event: ShortcutKeyEvent,
  context: ShortcutContext,
  bindings: readonly ShortcutBinding[] = SHORTCUTS,
): ShortcutAction | null {
  if (context.modalOpen || event.isComposing || event.repeat) return null
  // Never react to unmodified (or Shift-only) keys.
  if (!event.metaKey && !event.ctrlKey) return null
  if (event.getModifierState?.('AltGraph')) return null
  const key = normalizeShortcutKey(event)
  for (const binding of bindings) {
    if (binding.key !== key) continue
    if (!binding.mod && !binding.ctrl) continue
    if (!modifiersMatch(binding, event, context.platform)) continue
    if (context.inEditable && context.platform !== 'mac' && binding.alt)
      continue
    return binding.action
  }
  return null
}

export function shortcutFor(
  action: ShortcutAction,
  bindings: readonly ShortcutBinding[] = SHORTCUTS,
): ShortcutBinding | undefined {
  return bindings.find((binding) => binding.action === action)
}

function keyCap(key: string): string {
  return /^[a-z]$/.test(key) ? key.toUpperCase() : key
}

/**
 * Key caps of an action for kbd chips, in platform order: macOS
 * ⌃ ⌥ ⇧ ⌘ + key; elsewhere Ctrl, Alt, Shift + key.
 */
export function shortcutKeys(
  action: ShortcutAction,
  platform: ShortcutPlatform,
  bindings: readonly ShortcutBinding[] = SHORTCUTS,
): string[] {
  const binding = shortcutFor(action, bindings)
  if (!binding) return []
  const caps: string[] = []
  if (platform === 'mac') {
    if (binding.ctrl) caps.push('⌃')
    if (binding.alt) caps.push('⌥')
    if (binding.shift) caps.push('⇧')
    if (binding.mod) caps.push('⌘')
  } else {
    if (binding.mod || binding.ctrl) caps.push('Ctrl')
    if (binding.alt) caps.push('Alt')
    if (binding.shift) caps.push('Shift')
  }
  caps.push(keyCap(binding.key))
  return caps
}

/** One-string form for tooltips: `⌥⌘B` / `Ctrl+Alt+B`. */
export function shortcutLabel(
  action: ShortcutAction,
  platform: ShortcutPlatform,
  bindings: readonly ShortcutBinding[] = SHORTCUTS,
): string {
  const caps = shortcutKeys(action, platform, bindings)
  return platform === 'mac' ? caps.join('') : caps.join('+')
}

/** Best-effort platform detection (renderer only). */
export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'other'
  const hint =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent
  return /mac|iphone|ipad/i.test(hint) ? 'mac' : 'other'
}
