import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_PAGE_SECTIONS,
  SETTINGS_SECTIONS,
  isSettingsPageSection,
  isSettingsSection,
  modalSettingsSection,
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
    expect(Object.keys(SETTINGS_SECTION_ICONS).sort()).toEqual([...keys].sort())
  })

  it('keeps Hooks but moved the page sections out of the modal', () => {
    const keys: string[] = SETTINGS_SECTIONS.map((section) => section.key)
    expect(keys).toEqual([
      'general',
      'model',
      'hooks',
      'computer',
      'memory',
      'tokens',
      'pet',
      'diagnostics',
    ])
    for (const key of SETTINGS_PAGE_SECTIONS) {
      expect(keys).not.toContain(key)
      expect(isSettingsSection(key)).toBe(false)
      expect(isSettingsPageSection(key)).toBe(true)
    }
    expect([...SETTINGS_PAGE_SECTIONS].sort()).toEqual([
      'mcp',
      'plugins',
      'scheduler',
      'skills',
      'tools',
    ])
  })

  it('opens the retired 配置 section as 记忆', () => {
    expect(normalizeSettingsSection('configs')).toBe('memory')
    expect(modalSettingsSection('configs')).toBe('memory')
  })

  it('does not expose Team as a settings section', () => {
    const keys: string[] = SETTINGS_SECTIONS.map((section) => section.key)
    expect(keys).not.toContain('team')
    expect(isSettingsSection('team')).toBe(false)
    expect(isSettingsPageSection('team')).toBe(false)
  })

  it('normalizes known sections, arrays and whitespace', () => {
    expect(normalizeSettingsSection('model')).toBe('model')
    expect(normalizeSettingsSection(' hooks ')).toBe('hooks')
    expect(normalizeSettingsSection(['tools', 'model'])).toBe('tools')
  })

  it('keeps page sections as values the router redirects to their page', () => {
    expect(normalizeSettingsSection(' skills ')).toBe('skills')
    expect(normalizeSettingsSection(['mcp', 'model'])).toBe('mcp')
    expect(normalizeSettingsSection('scheduler')).toBe('scheduler')
    expect(normalizeSettingsSection('plugins')).toBe('plugins')
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

  it('shows general in the modal for a page section or unknown value', () => {
    expect(modalSettingsSection('tokens')).toBe('tokens')
    expect(modalSettingsSection(['diagnostics'])).toBe('diagnostics')
    for (const value of ['skills', 'mcp', 'integrations', 'nope', undefined])
      expect(modalSettingsSection(value)).toBe('general')
  })
})

describe('settingsQuery', () => {
  it('opens a section while keeping unrelated query keys', () => {
    expect(settingsQuery({ foo: 'bar' }, 'model')).toEqual({
      foo: 'bar',
      settings: 'model',
    })
  })

  it('replaces the section', () => {
    expect(settingsQuery({ settings: 'hooks', foo: 'bar' }, 'tools')).toEqual({
      settings: 'tools',
      foo: 'bar',
    })
  })

  it('closing removes only the settings key', () => {
    expect(settingsQuery({ settings: 'tools', foo: 'bar' }, null)).toEqual({
      foo: 'bar',
    })
  })
})
