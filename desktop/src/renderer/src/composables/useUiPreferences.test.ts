import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_STORAGE_KEY,
  parseUiPreferences,
  reloadUiPreferences,
  setUiPreference,
  uiPreferences,
} from './useUiPreferences'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  reloadUiPreferences()
})

describe('ui preferences', () => {
  it('defaults keep developer surfaces off and site icons on (BUG-01)', () => {
    expect(uiPreferences()).toEqual(DEFAULT_UI_PREFERENCES)
    expect(uiPreferences().showTrajectory).toBe(false)
    expect(uiPreferences().siteIconService).toBe(true)
  })

  it('BUG-01: the old opt-in key no longer turns site icons off', () => {
    store.set(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ showTrajectory: true, siteIcons: false }),
    )
    reloadUiPreferences()
    expect(uiPreferences().siteIconService).toBe(true)
    expect(uiPreferences().showTrajectory).toBe(true)
  })

  it('resets only the junk field', () => {
    expect(
      parseUiPreferences({
        showTrajectory: true,
        processDisplay: 'nope',
        siteIconService: 'yes',
      }),
    ).toEqual({ ...DEFAULT_UI_PREFERENCES, showTrajectory: true })
  })

  it('UI-S09 · 8: a junk 显示轨迹 reads as off, the other fields stay', () => {
    for (const junk of ['true', 1, null, {}])
      expect(parseUiPreferences({ showTrajectory: junk }).showTrajectory).toBe(
        false,
      )
    store.set(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ showTrajectory: 'yes', showSystemSteps: true }),
    )
    reloadUiPreferences()
    expect(uiPreferences()).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      showSystemSteps: true,
    })
  })

  it('survives unreadable storage content', () => {
    store.set(UI_PREFERENCES_STORAGE_KEY, '{broken')
    reloadUiPreferences()
    expect(uiPreferences()).toEqual(DEFAULT_UI_PREFERENCES)
  })

  it('persists a change and reads it back', () => {
    setUiPreference('siteIconService', false)
    expect(JSON.parse(store.get(UI_PREFERENCES_STORAGE_KEY)!)).toMatchObject({
      siteIconService: false,
    })
    reloadUiPreferences()
    expect(uiPreferences().siteIconService).toBe(false)
  })
})
