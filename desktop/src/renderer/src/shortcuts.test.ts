import { describe, expect, it } from 'vitest'
import {
  matchShortcut,
  normalizeShortcutKey,
  SHORTCUTS,
  shortcutKeys,
  shortcutLabel,
  type ShortcutAction,
  type ShortcutContext,
  type ShortcutKeyEvent,
} from './shortcuts'

function key(
  keyValue: string,
  mods: Partial<Omit<ShortcutKeyEvent, 'key'>> = {},
): ShortcutKeyEvent {
  return {
    key: keyValue,
    code: mods.code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  }
}

const MAC: ShortcutContext = { platform: 'mac' }
const WIN: ShortcutContext = { platform: 'other' }

describe('matchShortcut on macOS', () => {
  it.each<[string, ShortcutKeyEvent, ShortcutAction]>([
    ['⌃⇧G', key('G', { ctrlKey: true, shiftKey: true }), 'workspace.review'],
    ['⌃`', key('`', { ctrlKey: true }), 'workspace.terminal'],
    ['⌘P', key('p', { metaKey: true }), 'workspace.files'],
    ['⌘T', key('t', { metaKey: true }), 'workspace.browser'],
    // ⌥ rewrites the character (∫ / ´): the physical key decides.
    [
      '⌥⌘B',
      key('∫', { metaKey: true, altKey: true, code: 'KeyB' }),
      'workspace.toggle',
    ],
    [
      '⌥⌘E',
      key('Dead', { metaKey: true, altKey: true, code: 'KeyE' }),
      'envCard.toggle',
    ],
    ['⌘B', key('b', { metaKey: true }), 'sidebar.toggle'],
    ['⌘N', key('n', { metaKey: true }), 'session.new'],
    ['⌘K', key('k', { metaKey: true }), 'search'],
    ['⌘[', key('[', { metaKey: true }), 'nav.back'],
    ['⌘]', key(']', { metaKey: true }), 'nav.forward'],
  ])('%s', (_label, event, action) => {
    expect(matchShortcut(event, MAC)).toBe(action)
  })

  it('requires the exact modifier set', () => {
    // ⌃P / ⌘⇧P / ⌃⌘B are not bindings.
    expect(matchShortcut(key('p', { ctrlKey: true }), MAC)).toBeNull()
    expect(
      matchShortcut(key('P', { metaKey: true, shiftKey: true }), MAC),
    ).toBeNull()
    expect(
      matchShortcut(key('b', { metaKey: true, ctrlKey: true }), MAC),
    ).toBeNull()
    // ⌘G is not ⌃⇧G.
    expect(
      matchShortcut(key('G', { metaKey: true, shiftKey: true }), MAC),
    ).toBeNull()
  })

  it('leaves Electron default-menu accelerators alone', () => {
    for (const letter of ['r', 'w', 'm', 'h', 'q', '0', '=', '-'])
      expect(matchShortcut(key(letter, { metaKey: true }), MAC)).toBeNull()
    expect(
      matchShortcut(
        key('ˆ', { metaKey: true, altKey: true, code: 'KeyI' }),
        MAC,
      ),
    ).toBeNull()
    expect(
      matchShortcut(key('f', { metaKey: true, ctrlKey: true }), MAC),
    ).toBeNull()
    expect(
      matchShortcut(key('R', { metaKey: true, shiftKey: true }), MAC),
    ).toBeNull()
  })

  it('keeps table combos inside editable fields', () => {
    const editing = { ...MAC, inEditable: true }
    expect(matchShortcut(key('p', { metaKey: true }), editing)).toBe(
      'workspace.files',
    )
    expect(
      matchShortcut(
        key('∫', { metaKey: true, altKey: true, code: 'KeyB' }),
        editing,
      ),
    ).toBe('workspace.toggle')
  })
})

describe('matchShortcut on Windows / Linux', () => {
  it.each<[string, ShortcutKeyEvent, ShortcutAction]>([
    [
      'Ctrl+Shift+G',
      key('G', { ctrlKey: true, shiftKey: true }),
      'workspace.review',
    ],
    ['Ctrl+`', key('`', { ctrlKey: true }), 'workspace.terminal'],
    ['Ctrl+P', key('p', { ctrlKey: true }), 'workspace.files'],
    [
      'Ctrl+Alt+B',
      key('b', { ctrlKey: true, altKey: true }),
      'workspace.toggle',
    ],
    ['Ctrl+B', key('b', { ctrlKey: true }), 'sidebar.toggle'],
    ['Ctrl+[', key('[', { ctrlKey: true }), 'nav.back'],
  ])('%s', (_label, event, action) => {
    expect(matchShortcut(event, WIN)).toBe(action)
  })

  it('never treats the Windows / Super key as ⌘', () => {
    expect(matchShortcut(key('p', { metaKey: true }), WIN)).toBeNull()
    expect(
      matchShortcut(key('p', { metaKey: true, ctrlKey: true }), WIN),
    ).toBeNull()
  })

  it('skips Ctrl+Alt (AltGr) chords while typing', () => {
    const editing = { ...WIN, inEditable: true }
    expect(
      matchShortcut(key('e', { ctrlKey: true, altKey: true }), editing),
    ).toBeNull()
    expect(matchShortcut(key('p', { ctrlKey: true }), editing)).toBe(
      'workspace.files',
    )
    expect(
      matchShortcut(
        key('€', {
          ctrlKey: true,
          altKey: true,
          code: 'KeyE',
          getModifierState: (name) => name === 'AltGraph',
        }),
        WIN,
      ),
    ).toBeNull()
  })
})

describe('matchShortcut guards', () => {
  it('does nothing while a modal is open', () => {
    expect(
      matchShortcut(key('p', { metaKey: true }), { ...MAC, modalOpen: true }),
    ).toBeNull()
    expect(
      matchShortcut(key('b', { ctrlKey: true }), { ...WIN, modalOpen: true }),
    ).toBeNull()
  })

  it('ignores unmodified keys, repeats and IME composition', () => {
    expect(matchShortcut(key('p'), MAC)).toBeNull()
    expect(matchShortcut(key('P', { shiftKey: true }), MAC)).toBeNull()
    expect(matchShortcut(key('b', { altKey: true }), MAC)).toBeNull()
    expect(
      matchShortcut(key('p', { metaKey: true, repeat: true }), MAC),
    ).toBeNull()
    expect(
      matchShortcut(key('p', { metaKey: true, isComposing: true }), MAC),
    ).toBeNull()
  })

  it('binds every action exactly once, always with ⌘ or ⌃', () => {
    const actions = SHORTCUTS.map((binding) => binding.action)
    expect(new Set(actions).size).toBe(actions.length)
    for (const binding of SHORTCUTS)
      expect(Boolean(binding.mod || binding.ctrl)).toBe(true)
  })
})

describe('shortcut labels', () => {
  it('normalizes keys through the physical code when needed', () => {
    expect(normalizeShortcutKey(key('G'))).toBe('g')
    expect(normalizeShortcutKey(key('∫', { code: 'KeyB' }))).toBe('b')
    expect(normalizeShortcutKey(key('{', { code: 'BracketLeft' }))).toBe('[')
  })

  it('renders kbd caps per platform', () => {
    expect(shortcutKeys('workspace.review', 'mac')).toEqual(['⌃', '⇧', 'G'])
    expect(shortcutKeys('workspace.toggle', 'mac')).toEqual(['⌥', '⌘', 'B'])
    expect(shortcutKeys('workspace.terminal', 'other')).toEqual(['Ctrl', '`'])
    expect(shortcutLabel('workspace.toggle', 'mac')).toBe('⌥⌘B')
    expect(shortcutLabel('workspace.toggle', 'other')).toBe('Ctrl+Alt+B')
    expect(shortcutLabel('workspace.files', 'other')).toBe('Ctrl+P')
  })
})
