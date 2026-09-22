import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  isSettingsSection,
  normalizeSettingsSection,
} from './settingsSections'
import { SETTINGS_SECTION_ICONS } from './settingsIcons'
import { settingsQuery } from './useSettingsRoute'

describe('settings sections', () => {
  it('lists every section once, each with a nav icon', () => {
    const keys = SETTINGS_SECTIONS.map((section) => section.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys[0]).toBe(DEFAULT_SETTINGS_SECTION)
    for (const key of keys) expect(SETTINGS_SECTION_ICONS[key]).toBeTruthy()
  })

  it('does not expose Team as a settings section', () => {
    const keys: string[] = SETTINGS_SECTIONS.map((section) => section.key)
    expect(keys).not.toContain('team')
    expect(isSettingsSection('team')).toBe(false)
  })

  it('normalizes known sections, arrays and whitespace', () => {
    expect(normalizeSettingsSection('model')).toBe('model')
    expect(normalizeSettingsSection(' skills ')).toBe('skills')
    expect(normalizeSettingsSection(['mcp', 'model'])).toBe('mcp')
  })

  it('maps legacy standalone-page section names', () => {
    expect(normalizeSettingsSection('appearance')).toBe('general')
    expect(normalizeSettingsSection('archived')).toBe('general')
    expect(normalizeSettingsSection('integrations')).toBe('mcp')
  })

  it('falls back to general for unknown or missing values', () => {
    expect(normalizeSettingsSection('team')).toBe('general')
    expect(normalizeSettingsSection('')).toBe('general')
    expect(normalizeSettingsSection(undefined)).toBe('general')
    expect(normalizeSettingsSection(null)).toBe('general')
    expect(normalizeSettingsSection(42)).toBe('general')
  })
})

describe('settingsQuery', () => {
  it('opens a section while keeping unrelated query keys', () => {
    expect(settingsQuery({ foo: 'bar' }, 'model')).toEqual({
      foo: 'bar',
      settings: 'model',
    })
  })

  it('replaces the section and drops a stale skill', () => {
    expect(
      settingsQuery({ settings: 'skills', skill: 'old' }, 'tools'),
    ).toEqual({ settings: 'tools' })
  })

  it('carries extra keys such as the selected skill', () => {
    expect(
      settingsQuery({ settings: 'skills' }, 'skills', {
        skill: 'writer',
        ignored: undefined,
      }),
    ).toEqual({ settings: 'skills', skill: 'writer' })
  })

  it('closing removes settings, skill and any extra keys', () => {
    expect(
      settingsQuery({ settings: 'skills', skill: 'x', foo: 'bar' }, null, {
        skill: 'y',
      }),
    ).toEqual({ foo: 'bar' })
  })
})
