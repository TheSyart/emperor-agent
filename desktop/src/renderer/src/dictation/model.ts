/**
 * Editor dictation, pure parts shared by 设置 › 语音 and the chat editor:
 * which on-device language serves a request (the helper's own rule), what
 * the editor asks for when a saved microphone or language went away, and
 * the in-window shortcut (parsing, matching a key press, conflicts).
 */
import type { DictationLocale, DictationStatus } from '../api/dictation'
import {
  acceleratorFromKey,
  type KeyLike,
} from '../components/settings/computer/shortcut'
import { SHORTCUTS, type ShortcutBinding } from '../shortcuts'
import type { DictationSettings } from './settings'

interface Tag {
  language: string
  script: string | null
  region: string | null
}

/** `zh_CN`, `zh-CN` and `zh-Hans-CN` alike; extensions (`-u-…`) ignored. */
function tag(raw: string): Tag {
  const pieces = raw.replace(/_/g, '-').split('-').filter(Boolean)
  let script: string | null = null
  let region: string | null = null
  for (const piece of pieces.slice(1)) {
    if (piece.length === 1) break
    if (piece.length === 4)
      script = piece[0]!.toUpperCase() + piece.slice(1).toLowerCase()
    else if ((piece.length === 2 || piece.length === 3) && region === null)
      region = piece.toUpperCase()
  }
  return { language: (pieces[0] ?? '').toLowerCase(), script, region }
}

function sameLocale(a: Tag, b: Tag): boolean {
  if (a.language !== b.language || a.region !== b.region) return false
  return a.script === null || b.script === null || a.script === b.script
}

/**
 * The on-device locale that serves `requested`, or the system language
 * when null — the same rule as the helper's DictationLocaleMatch: a chosen
 * locale with a region is never swapped for another; otherwise the first
 * locale of the same language serves. null: this Mac cannot recognize it.
 */
export function resolveDictationLocale(
  requested: string | null,
  systemLocale: string,
  available: readonly DictationLocale[],
): DictationLocale | null {
  const wanted = tag(requested ?? systemLocale)
  if (!wanted.language) return null
  const exact = available.find((locale) => sameLocale(tag(locale.id), wanted))
  if (exact) return exact
  if (requested !== null && wanted.region !== null) return null
  return (
    available.find((locale) => tag(locale.id).language === wanted.language) ??
    null
  )
}

/**
 * What the editor asks for: the saved microphone and language while this
 * Mac still offers them, else the system default microphone and the system
 * language. The settings keep the choice, so it returns with the device.
 */
export function dictationRequest(
  settings: DictationSettings,
  status: Pick<DictationStatus, 'devices' | 'locales'>,
): { device: string | null; locale: string | null } {
  return {
    device:
      settings.device !== null &&
      status.devices.some((device) => device.id === settings.device)
        ? settings.device
        : null,
    locale:
      settings.locale !== null &&
      status.locales.some((locale) => locale.id === settings.locale)
        ? settings.locale
        : null,
  }
}

export interface Chord {
  control: boolean
  alt: boolean
  shift: boolean
  command: boolean
  key: string
}

const MODIFIERS: Readonly<Record<string, keyof Omit<Chord, 'key'>>> = {
  Control: 'control',
  Ctrl: 'control',
  Alt: 'alt',
  Option: 'alt',
  Shift: 'shift',
  Command: 'command',
  Cmd: 'command',
  Super: 'command',
}

/** An Electron-style accelerator with ⌃, ⌥ or ⌘, or null. */
export function parseAccelerator(accelerator: string): Chord | null {
  const parts = accelerator.split('+')
  if (parts.length < 2 || parts.some((part) => part === '')) return null
  const chord: Chord = {
    control: false,
    alt: false,
    shift: false,
    command: false,
    key: '',
  }
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part]
    if (!modifier || chord[modifier]) return null
    chord[modifier] = true
  }
  const key = parts.at(-1)!
  if (MODIFIERS[key] || key.length > 12) return null
  if (!chord.control && !chord.alt && !chord.command) return null
  chord.key = key.length === 1 ? key.toUpperCase() : key
  return chord
}

function sameChord(a: Chord, b: Chord): boolean {
  return (
    a.control === b.control &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.command === b.command &&
    a.key === b.key
  )
}

/** Whether a key press is `accelerator`, by physical key. */
export function acceleratorMatches(
  event: KeyLike,
  accelerator: string,
  mac: boolean,
): boolean {
  const pressed = acceleratorFromKey(event, mac)
  const want = parseAccelerator(accelerator)
  const got = pressed === null ? null : parseAccelerator(pressed)
  return want !== null && got !== null && sameChord(want, got)
}

function bindingChord(binding: ShortcutBinding, mac: boolean): Chord {
  return {
    control: Boolean(binding.ctrl) || (!mac && Boolean(binding.mod)),
    alt: Boolean(binding.alt),
    shift: Boolean(binding.shift),
    command: mac && Boolean(binding.mod),
    key: binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
  }
}

/** macOS and Emperor's menu keep these; a dictation shortcut must not. */
const MAC_RESERVED: ReadonlyArray<readonly [string, string]> = [
  ['Command+Q', '退出 Emperor'],
  ['Command+,', '偏好设置'],
  ['Command+W', '关闭窗口'],
  ['Command+H', '隐藏 Emperor'],
  ['Alt+Command+H', '隐藏其他应用'],
  ['Command+M', '最小化'],
  ['Command+R', '重新载入'],
  ['Shift+Command+R', '强制重新载入'],
  ['Command+0', '实际大小'],
  ['Command+=', '放大'],
  ['Command+-', '缩小'],
  ['Alt+Command+I', '开发者工具'],
  ['Control+Command+F', '全屏'],
  ['Command+Z', '撤销'],
  ['Shift+Command+Z', '重做'],
  ['Command+X', '剪切'],
  ['Command+C', '拷贝'],
  ['Command+V', '粘贴'],
  ['Alt+Shift+Command+V', '粘贴并匹配样式'],
  ['Command+A', '全选'],
  ['Command+Space', '聚焦搜索'],
  ['Alt+Command+Space', '访达搜索'],
  ['Control+Space', '切换输入法'],
  ['Control+Alt+Space', '切换输入法'],
  ['Control+Command+Space', '表情与符号'],
  ['Command+Tab', '切换应用'],
  ['Command+`', '切换窗口'],
  ['Control+Command+Q', '锁定屏幕'],
  ['Shift+Command+3', '截屏'],
  ['Shift+Command+4', '截屏'],
  ['Shift+Command+5', '截屏'],
  ['Alt+Command+D', '隐藏程序坞'],
  ['Alt+Command+Escape', '强制退出'],
]

/**
 * Why `accelerator` cannot be the dictation shortcut, or null: it needs ⌃,
 * ⌥ or ⌘, and must not be an Emperor shortcut or one that macOS or the app
 * menu keeps.
 */
export function shortcutConflict(
  accelerator: string,
  context: { mac: boolean },
): string | null {
  const chord = parseAccelerator(accelerator)
  if (!chord) return '快捷键要包含 ⌃、⌥ 或 ⌘'
  for (const binding of SHORTCUTS)
    if (sameChord(bindingChord(binding, context.mac), chord))
      return `与 Emperor 的「${binding.label}」快捷键相同`
  if (context.mac)
    for (const [reserved, label] of MAC_RESERVED) {
      const taken = parseAccelerator(reserved)
      if (taken && sameChord(taken, chord))
        return `与系统的「${label}」快捷键相同`
    }
  return null
}
