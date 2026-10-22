import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_NAV_GROUPS,
  SETTINGS_PAGE_SECTIONS,
  SETTINGS_SECTIONS,
  isSettingsPageSection,
  isSettingsSection,
  modalSettingsSection,
  normalizeSettingsSection,
  settingsAlias,
} from './settingsSections'
import { settingsPageKey, settingsQuery } from './useSettingsRoute'

describe('settings sections', () => {
  it('lists every section once, general first', () => {
    const keys = SETTINGS_SECTIONS.map((section) => section.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys[0]).toBe(DEFAULT_SETTINGS_SECTION)
  })

  it('lists nine sections in four groups (UI-S07)', () => {
    const keys: string[] = SETTINGS_SECTIONS.map((section) => section.key)
    expect(keys).toEqual([
      'general',
      'model',
      'executors',
      'memory',
      'computer',
      'browser',
      'voice',
      'tokens',
      'advanced',
    ])
    expect(
      SETTINGS_NAV_GROUPS.map((group) => [group.label, group.sections]),
    ).toEqual([
      [null, ['general']],
      ['智能', ['model', 'executors', 'memory']],
      ['操控', ['computer', 'browser', 'voice']],
      ['系统', ['tokens', 'advanced']],
    ])
    expect(SETTINGS_NAV_GROUPS.flatMap((group) => group.sections)).toEqual(keys)
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

  it('sends the folded sections to where they live now', () => {
    expect(settingsAlias('hooks')).toEqual({
      section: 'advanced',
      page: 'hooks',
    })
    expect(settingsAlias(' diagnostics ')).toEqual({
      section: 'advanced',
      page: 'diagnostics',
    })
    expect(settingsAlias('pet')).toEqual({ section: 'general', page: null })
    expect(settingsAlias('archived')).toEqual({
      section: 'general',
      page: 'archived',
    })
    expect(settingsAlias('model')).toBeNull()
    expect(settingsAlias('nope')).toBeNull()
    for (const folded of ['hooks', 'diagnostics', 'pet'])
      expect(isSettingsSection(folded)).toBe(false)
    expect(modalSettingsSection('hooks')).toBe('advanced')
    expect(modalSettingsSection(['diagnostics'])).toBe('advanced')
    expect(modalSettingsSection('pet')).toBe('general')
  })

  it('keeps the executors deep link under the unified label', () => {
    expect(
      SETTINGS_SECTIONS.find((section) => section.key === 'executors')?.label,
    ).toBe('子智能体')
    expect(modalSettingsSection('executors')).toBe('executors')
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
    expect(normalizeSettingsSection(' hooks ')).toBe('advanced')
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
    expect(modalSettingsSection(['advanced'])).toBe('advanced')
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

  it('carries a sub page with its section and drops it otherwise', () => {
    expect(settingsQuery({ foo: 'bar' }, 'computer', 'chrome')).toEqual({
      foo: 'bar',
      settings: 'computer',
      page: 'chrome',
    })
    expect(
      settingsQuery({ settings: 'computer', page: 'chrome' }, 'browser'),
    ).toEqual({ settings: 'browser' })
    expect(
      settingsQuery({ settings: 'computer', page: 'chrome', foo: 'bar' }, null),
    ).toEqual({ foo: 'bar' })
  })
})

describe('settingsPageKey', () => {
  it('accepts a short lower-case key only', () => {
    expect(settingsPageKey('chrome')).toBe('chrome')
    expect(settingsPageKey(['apps', 'other'])).toBe('apps')
    expect(settingsPageKey('download-history')).toBe('download-history')
    for (const value of [
      undefined,
      null,
      '',
      'Chrome',
      '1abc',
      'a'.repeat(33),
      '../x',
      'a b',
    ])
      expect(settingsPageKey(value)).toBeNull()
  })
})
