/**
 * Key names (`Enter`, `Meta+A`, `Control+Shift+Tab`) → CDP
 * `Input.dispatchKeyEvent` parameters. Modifiers use CDP's bit mask
 * (Alt 1, Control 2, Meta 4, Shift 8).
 */

export interface KeyStroke {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  /** Printable text for keyDown (absent for named keys and chords). */
  readonly text?: string
  readonly modifiers: number
  /** Modifier keys to press around the stroke, in order. */
  readonly modifierKeys: readonly KeyStroke[]
}

const MODIFIERS: Record<
  string,
  { bit: number; key: string; code: string; vk: number }
> = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  option: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  command: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vk: 16 },
}

const NAMED: Record<
  string,
  { key: string; code: string; vk: number; text?: string }
> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}

function single(name: string): {
  key: string
  code: string
  vk: number
  text?: string
} {
  const lower = name.toLowerCase()
  const named = NAMED[lower]
  if (named !== undefined) return named
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (fn !== null) {
    const n = Number(fn[1])
    return { key: `F${n}`, code: `F${n}`, vk: 111 + n }
  }
  if ([...name].length === 1) {
    const upper = name.toUpperCase()
    if (/^[a-z]$/i.test(name))
      return {
        key: name,
        code: `Key${upper}`,
        vk: upper.charCodeAt(0),
        text: name,
      }
    if (/^[0-9]$/.test(name))
      return {
        key: name,
        code: `Digit${name}`,
        vk: name.charCodeAt(0),
        text: name,
      }
    return { key: name, code: '', vk: 0, text: name }
  }
  throw new Error(`unknown key "${name}"`)
}

/** Parse `Control+Shift+Tab`-style input; throws on unknown names. */
export function parseKey(input: string): KeyStroke {
  const parts = input.split('+').map((part) => part.trim())
  // "Control++" means the plus key.
  if (input.endsWith('++')) parts.splice(parts.length - 2, 2, '+')
  if (parts.some((part) => part === ''))
    throw new Error(`invalid key "${input}"`)
  const main = parts.pop()!
  let modifiers = 0
  const modifierKeys: KeyStroke[] = []
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (modifier === undefined) throw new Error(`unknown modifier "${part}"`)
    if ((modifiers & modifier.bit) !== 0) continue
    modifiers |= modifier.bit
    modifierKeys.push({
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.vk,
      modifiers,
      modifierKeys: [],
    })
  }
  const base = single(main)
  // Chords with Control / Meta / Alt produce no text.
  const chord = (modifiers & (1 | 2 | 4)) !== 0
  const shifted =
    (modifiers & 8) !== 0 &&
    base.text !== undefined &&
    /^[a-z]$/.test(base.text)
  const text = chord
    ? undefined
    : shifted
      ? base.text!.toUpperCase()
      : base.text
  return {
    key: shifted ? base.key.toUpperCase() : base.key,
    code: base.code,
    windowsVirtualKeyCode: base.vk,
    ...(text === undefined ? {} : { text }),
    modifiers,
    modifierKeys,
  }
}
