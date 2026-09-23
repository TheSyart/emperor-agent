/**
 * Settings modal sections (M4a/M8). The modal is opened by the `settings`
 * query on any /chat route (`/chat/:id?settings=model`); legacy standalone
 * routes (/settings/:section, /tools, /model, ...) redirect here so deep
 * links keep working.
 *
 * 定时任务 and the 能力 tabs (插件, Skills, MCP, 工具) left the modal for full
 * pages (/scheduler, /capabilities/:tab). Their keys stay valid `?settings=` values
 * (SETTINGS_PAGE_SECTIONS): the router guard (router.ts
 * `settingsPageRedirect`) sends such a link to its page, and the modal
 * itself never shows them.
 */
export const SETTINGS_SECTIONS = [
  { key: 'general', label: '常规' },
  { key: 'model', label: '模型' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'memory', label: '记忆' },
  { key: 'tokens', label: '用量' },
  { key: 'pet', label: '桌宠' },
  { key: 'diagnostics', label: '诊断' },
] as const

/** A section the settings modal shows. */
export type SettingsModalSection = (typeof SETTINGS_SECTIONS)[number]['key']

/** Former sections that are full pages now (redirected by the router). */
export const SETTINGS_PAGE_SECTIONS = [
  'scheduler',
  'plugins',
  'skills',
  'mcp',
  'tools',
] as const

export type SettingsPageSection = (typeof SETTINGS_PAGE_SECTIONS)[number]

/** Any `?settings=` value: a modal section, or one that opens its page. */
export type SettingsSectionKey = SettingsModalSection | SettingsPageSection

export const DEFAULT_SETTINGS_SECTION: SettingsModalSection = 'general'

const KEYS = new Set<string>(SETTINGS_SECTIONS.map((section) => section.key))
const PAGE_KEYS = new Set<string>(SETTINGS_PAGE_SECTIONS)

/** Legacy section names from the retired standalone settings page. */
const LEGACY_ALIASES: Record<string, SettingsSectionKey> = {
  appearance: 'general',
  archived: 'general',
  integrations: 'mcp',
  // 配置 edited USER.local.md, now edited in 记忆 › 用户档案.
  configs: 'memory',
}

/** A section of the settings modal (not one that moved to a page). */
export function isSettingsSection(
  value: unknown,
): value is SettingsModalSection {
  return typeof value === 'string' && KEYS.has(value)
}

export function isSettingsPageSection(
  value: unknown,
): value is SettingsPageSection {
  return typeof value === 'string' && PAGE_KEYS.has(value)
}

/**
 * Normalize any (legacy) `?settings=` / `/settings/:section` value: a modal
 * section or a page section (the router redirects those); unknown values
 * fall back to general.
 */
export function normalizeSettingsSection(value: unknown): SettingsSectionKey {
  const raw = Array.isArray(value) ? value[0] : value
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (isSettingsSection(text) || isSettingsPageSection(text)) return text
  return LEGACY_ALIASES[text] ?? DEFAULT_SETTINGS_SECTION
}

/** The section the modal shows for a query value (page sections → general). */
export function modalSettingsSection(value: unknown): SettingsModalSection {
  const section = normalizeSettingsSection(value)
  return isSettingsSection(section) ? section : DEFAULT_SETTINGS_SECTION
}
