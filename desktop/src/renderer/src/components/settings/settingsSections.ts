/**
 * Settings modal sections (M4a/M8). The modal is opened by the `settings`
 * query on any /chat route (`/chat/:id?settings=model`); legacy standalone
 * routes (/settings/:section, /plugins/:tab, /skills/:name, /tools, ...)
 * redirect here so deep links keep working.
 */
export const SETTINGS_SECTIONS = [
  { key: 'general', label: '常规' },
  { key: 'model', label: '模型' },
  { key: 'plugins', label: '插件' },
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'tools', label: '工具' },
  { key: 'scheduler', label: 'Scheduler' },
  { key: 'memory', label: '记忆' },
  { key: 'tokens', label: '用量' },
  { key: 'pet', label: '桌宠' },
  { key: 'configs', label: '配置' },
  { key: 'diagnostics', label: '诊断' },
] as const

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]['key']

export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = 'general'

const KEYS = new Set<string>(SETTINGS_SECTIONS.map((section) => section.key))

/** Legacy section names from the retired standalone settings page. */
const LEGACY_ALIASES: Record<string, SettingsSectionKey> = {
  appearance: 'general',
  archived: 'general',
  integrations: 'mcp',
}

export function isSettingsSection(value: unknown): value is SettingsSectionKey {
  return typeof value === 'string' && KEYS.has(value)
}

/** Normalize any (legacy) section name; unknown values fall back to general. */
export function normalizeSettingsSection(value: unknown): SettingsSectionKey {
  const raw = Array.isArray(value) ? value[0] : value
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (isSettingsSection(text)) return text
  return LEGACY_ALIASES[text] ?? DEFAULT_SETTINGS_SECTION
}
