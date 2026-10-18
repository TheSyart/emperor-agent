import { shallowRef } from 'vue'

/**
 * Per-Mac interface preferences that never reach Core: what the
 * conversation shows and which optional network lookups the renderer may
 * make. One versioned localStorage record; every field is validated on its
 * own, so a junk value only resets that field.
 */
export const UI_PREFERENCES_STORAGE_KEY = 'emperor.ui.prefs.v1'

export type ProcessDisplay = 'collapse-when-done' | 'expanded' | 'collapsed'

export interface UiPreferences {
  /** Show the 轨迹 tab and per-tool Inspect (developer surface). */
  showTrajectory: boolean
  /** List context injections and hook runs inside a turn's process. */
  showSystemSteps: boolean
  /** How a turn's tool steps are shown once it finishes. */
  processDisplay: ProcessDisplay
  /** Fetch real site icons for web links (contacts those sites). */
  siteIcons: boolean
}

export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({
  showTrajectory: false,
  showSystemSteps: false,
  processDisplay: 'collapse-when-done',
  siteIcons: false,
})

const PROCESS_DISPLAYS: readonly ProcessDisplay[] = [
  'collapse-when-done',
  'expanded',
  'collapsed',
]

export function parseUiPreferences(raw: unknown): UiPreferences {
  const value =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const flag = (key: keyof UiPreferences): boolean =>
    typeof value[key] === 'boolean'
      ? (value[key] as boolean)
      : (DEFAULT_UI_PREFERENCES[key] as boolean)
  return {
    showTrajectory: flag('showTrajectory'),
    showSystemSteps: flag('showSystemSteps'),
    processDisplay: PROCESS_DISPLAYS.includes(
      value.processDisplay as ProcessDisplay,
    )
      ? (value.processDisplay as ProcessDisplay)
      : DEFAULT_UI_PREFERENCES.processDisplay,
    siteIcons: flag('siteIcons'),
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readStored(): UiPreferences {
  try {
    const raw = storage()?.getItem(UI_PREFERENCES_STORAGE_KEY)
    return parseUiPreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_UI_PREFERENCES }
  }
}

const state = shallowRef<UiPreferences>(readStored())

/** Synchronous read for code outside components (route guards, loaders). */
export function uiPreferences(): UiPreferences {
  return state.value
}

export function setUiPreference<K extends keyof UiPreferences>(
  key: K,
  value: UiPreferences[K],
): void {
  const next = parseUiPreferences({ ...state.value, [key]: value })
  state.value = next
  try {
    storage()?.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage may be unavailable; the choice still applies for this window.
  }
}

/** Test seam: re-read storage (or reset to defaults when it is empty). */
export function reloadUiPreferences(): void {
  state.value = readStored()
}

export function useUiPreferences() {
  return { preferences: state, setUiPreference }
}
