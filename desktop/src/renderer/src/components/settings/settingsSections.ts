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
 *
 * UI-S07: nine sections in four nav groups (SETTINGS_NAV_GROUPS). Hooks and
 * 诊断 became sub pages of 高级 and 桌宠 a switch in 常规; their old keys
 * still open (settingsAlias, redirected by the same guard).
 */
export const SETTINGS_SECTIONS = [
  { key: 'general', label: '常规' },
  { key: 'model', label: '模型' },
  { key: 'executors', label: '子智能体' },
  { key: 'memory', label: '记忆' },
  { key: 'computer', label: '电脑操作' },
  { key: 'browser', label: '浏览器' },
  { key: 'voice', label: '语音' },
  { key: 'tokens', label: '用量' },
  { key: 'advanced', label: '高级' },
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

/**
 * The nav (UI-S07): 常规 on its own, then 智能, 操控 and 系统 under their
 * labels — four groups, nine sections, in SETTINGS_SECTIONS order.
 */
export const SETTINGS_NAV_GROUPS: readonly {
  label: string | null
  sections: readonly SettingsModalSection[]
}[] = [
  { label: null, sections: ['general'] },
  { label: '智能', sections: ['model', 'executors', 'memory'] },
  { label: '操控', sections: ['computer', 'browser', 'voice'] },
  { label: '系统', sections: ['tokens', 'advanced'] },
]

/** Where a section that was folded into another one lives now. */
export interface SettingsAlias {
  section: SettingsModalSection
  /** Its sub page there, or null for the section's main page. */
  page: string | null
}

/**
 * Folded and retired section names. Hooks and 诊断 are sub pages of 高级;
 * 桌宠 is a switch in 常规 › 外观; 已归档对话 a sub page of 常规; 配置
 * (USER.local.md) is edited in 记忆 › 用户档案.
 */
const SECTION_ALIASES: Record<string, SettingsAlias> = {
  hooks: { section: 'advanced', page: 'hooks' },
  diagnostics: { section: 'advanced', page: 'diagnostics' },
  pet: { section: 'general', page: null },
  appearance: { section: 'general', page: null },
  archived: { section: 'general', page: 'archived' },
  configs: { section: 'memory', page: null },
}

/** Where a folded or retired `?settings=` value opens now, else null. */
export function settingsAlias(value: unknown): SettingsAlias | null {
  const raw = Array.isArray(value) ? value[0] : value
  const text = typeof raw === 'string' ? raw.trim() : ''
  return Object.hasOwn(SECTION_ALIASES, text)
    ? { ...SECTION_ALIASES[text]! }
    : null
}

const KEYS = new Set<string>(SETTINGS_SECTIONS.map((section) => section.key))
const PAGE_KEYS = new Set<string>(SETTINGS_PAGE_SECTIONS)

/** Legacy section names that became a page. */
const LEGACY_PAGE_ALIASES: Record<string, SettingsPageSection> = {
  integrations: 'mcp',
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
 * section or a page section (the router redirects those); a folded section
 * names the one it lives in now (settingsAlias also gives its sub page);
 * unknown values fall back to general.
 */
export function normalizeSettingsSection(value: unknown): SettingsSectionKey {
  const raw = Array.isArray(value) ? value[0] : value
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (isSettingsSection(text) || isSettingsPageSection(text)) return text
  return (
    settingsAlias(text)?.section ??
    LEGACY_PAGE_ALIASES[text] ??
    DEFAULT_SETTINGS_SECTION
  )
}

/** The section the modal shows for a query value (page sections → general). */
export function modalSettingsSection(value: unknown): SettingsModalSection {
  const section = normalizeSettingsSection(value)
  return isSettingsSection(section) ? section : DEFAULT_SETTINGS_SECTION
}
