/**
 * Electron accelerator → the label users read: `⌃⌥⌘.` on macOS,
 * `Ctrl+Alt+Shift+.` elsewhere.
 */
const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Command: '⌘',
  Cmd: '⌘',
  Shift: '⇧',
}

export function acceleratorLabel(
  accelerator: string,
  platformMac?: boolean,
): string {
  const parts = accelerator.split('+').filter(Boolean)
  if (parts.length === 0) return ''
  const mac =
    platformMac ?? parts.some((part) => part === 'Command' || part === 'Cmd')
  if (!mac)
    return parts.map((part) => (part === 'Control' ? 'Ctrl' : part)).join('+')
  return parts.map((part) => MAC_SYMBOLS[part] ?? part).join('')
}

export interface KeyLike {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
}

const PUNCTUATION: Readonly<Record<string, string>> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Equal: '=',
  Minus: '-',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
}

const NAMED: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Enter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
}

function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return PUNCTUATION[code] ?? NAMED[code] ?? null
}

/**
 * A key press in the shortcut editor → an Electron accelerator, by physical
 * key (layout independent). Needs Control, Alt or Command so an ordinary
 * key never becomes a global shortcut; `null` while only modifiers are down.
 */
export function acceleratorFromKey(
  event: KeyLike,
  mac: boolean,
): string | null {
  const key = keyName(event.code)
  if (key === null) return null
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return null
  return [
    event.ctrlKey ? 'Control' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? (mac ? 'Command' : 'Super') : '',
    key,
  ]
    .filter(Boolean)
    .join('+')
}

/** The platform default (spec 00 §6.6, decision D6); mirrors main's kill switch. */
export function defaultKillSwitchAccelerator(mac: boolean): string {
  return mac ? 'Control+Alt+Command+.' : 'Control+Alt+Shift+.'
}
