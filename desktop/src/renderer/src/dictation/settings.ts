/**
 * Editor dictation preferences (VO-02): the microphone, the language and
 * the in-window shortcut. They are this Mac's preferences for the Emperor
 * window, so they live in localStorage like the theme, validated field by
 * field on every read; whatever cannot be trusted falls back to the default.
 * 设置 › 语音 and the chat editor share one copy per window.
 */
import { shallowRef, type ShallowRef } from 'vue'
import { parseAccelerator } from './model'

export const DICTATION_SETTINGS_KEY = 'emperor.dictation.settings'
/** ⇧⌘D, free in Emperor and in macOS; in the shortcut editor's order. */
export const DEFAULT_DICTATION_SHORTCUT = 'Shift+Command+D'

export interface DictationSettings {
  /** null: follow the system language. */
  locale: string | null
  /** CoreAudio device UID; null: the system default microphone. */
  device: string | null
  /** The device's name when chosen, shown while it is unplugged. */
  deviceName: string | null
  /** Electron-style accelerator, e.g. `Shift+Command+D`. */
  shortcut: string
}

export function defaultDictationSettings(): DictationSettings {
  return {
    locale: null,
    device: null,
    deviceName: null,
    shortcut: DEFAULT_DICTATION_SHORTCUT,
  }
}

const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/

function parse(raw: string | null): DictationSettings {
  const settings = defaultDictationSettings()
  if (!raw) return settings
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return settings
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return settings
  const body = value as Record<string, unknown>
  if (
    typeof body.locale === 'string' &&
    body.locale.length <= 35 &&
    LOCALE.test(body.locale)
  )
    settings.locale = body.locale
  if (
    typeof body.device === 'string' &&
    body.device.length > 0 &&
    body.device.length <= 256
  ) {
    settings.device = body.device
    if (typeof body.deviceName === 'string' && body.deviceName.length <= 256)
      settings.deviceName = body.deviceName
  }
  if (typeof body.shortcut === 'string' && parseAccelerator(body.shortcut))
    settings.shortcut = body.shortcut
  return settings
}

export function readDictationSettings(): DictationSettings {
  try {
    return parse(
      globalThis.localStorage?.getItem(DICTATION_SETTINGS_KEY) ?? null,
    )
  } catch {
    return defaultDictationSettings()
  }
}

function write(settings: DictationSettings): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) return false
    storage.setItem(DICTATION_SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

let shared: ShallowRef<DictationSettings> | undefined

/**
 * This window's dictation settings. `update` applies at once and answers
 * whether they were also saved for the next start.
 */
export function useDictationSettings(): {
  settings: ShallowRef<DictationSettings>
  update(patch: Partial<DictationSettings>): boolean
} {
  shared ??= shallowRef(readDictationSettings())
  const settings = shared
  return {
    settings,
    update(patch) {
      const next = { ...settings.value, ...patch }
      settings.value = next
      return write(next)
    },
  }
}

/** Tests: forget the shared copy, as a new window would. */
export function resetDictationSettingsForTest(): void {
  shared = undefined
}
