/**
 * Pure view model of 能力 › 插件: grouping and search for the list, and the
 * member groups, state badges, tools and facts of one plugin's detail.
 */
import type { ToolInfo } from '../../../types'
import type { SettingsSectionKey } from '../settingsSections'
import type { DefinitionItem } from '../ui'
import {
  scopeLabel,
  shortDigest,
  sourceLabel,
  type PluginDetail,
  type PluginSummary,
  type PluginTone,
} from './pluginInstall'

type Component = PluginDetail['components'][number]
type ComponentState = Component['state']

export function pluginKey(
  plugin: Pick<PluginSummary, 'pluginId' | 'scope'>,
): string {
  return `${plugin.pluginId}\u0000${plugin.scope}`
}

/** What the user installed, and what ships with Emperor (预装). */
export function groupPlugins(list: readonly PluginSummary[]): {
  installed: PluginSummary[]
  preinstalled: PluginSummary[]
} {
  return {
    installed: list.filter((plugin) => plugin.scope !== 'managed'),
    preinstalled: list.filter((plugin) => plugin.scope === 'managed'),
  }
}

export function filterPlugins(
  list: readonly PluginSummary[],
  query: string,
): PluginSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...list]
  return list.filter((plugin) =>
    [
      plugin.displayName,
      plugin.pluginId,
      plugin.description,
      plugin.developerName,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
}

export function pluginSourceTag(plugin: Pick<PluginSummary, 'source'>): string {
  switch (plugin.source.kind) {
    case 'managed':
      return '随 Emperor 提供'
    case 'local':
      return '本地'
    case 'url':
      return '网址'
    default:
      return '市场'
  }
}

const MONOGRAM_TONES = ['brand', 'accent', 'ok', 'warn', 'cyan'] as const
export type PluginMonogramTone = (typeof MONOGRAM_TONES)[number]

/** The fallback icon: the first letter on a tone picked from the name, stable across runs. */
export function pluginMonogram(name: string): {
  letter: string
  tone: PluginMonogramTone
} {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?'
  let hash = 0
  for (const character of name)
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return { letter, tone: MONOGRAM_TONES[hash % MONOGRAM_TONES.length]! }
}

export function componentStateBadge(state: ComponentState): {
  label: string
  tone: PluginTone
} {
  switch (state) {
    case 'available':
      return { label: '可用', tone: 'ok' }
    case 'running':
      return { label: '运行中', tone: 'ok' }
    case 'starting':
      return { label: '连接中', tone: 'neutral' }
    case 'needs_connection':
      return { label: '需要连接', tone: 'warn' }
    case 'disabled':
      return { label: '已停用', tone: 'neutral' }
    case 'unsupported':
      return { label: '不支持', tone: 'neutral' }
    default:
      return { label: '失败', tone: 'error' }
  }
}

export interface PluginMemberGroup {
  key: 'skill' | 'mcp' | 'app' | 'hook' | 'unsupported'
  title: string
  items: Component[]
}

const GROUPS: ReadonlyArray<{
  key: PluginMemberGroup['key']
  title: string
  kinds: readonly Component['kind'][]
}> = [
  { key: 'skill', title: 'Skills', kinds: ['skill'] },
  { key: 'mcp', title: 'MCP', kinds: ['mcp'] },
  { key: 'app', title: '应用连接', kinds: ['app'] },
  { key: 'hook', title: 'Hooks', kinds: ['hook'] },
  {
    key: 'unsupported',
    title: '不支持的成员',
    kinds: ['agent', 'command', 'lsp'],
  },
]

/** Real members grouped by kind, in a fixed order; empty groups are left out. */
export function memberGroups(
  detail: Pick<PluginDetail, 'components'>,
): PluginMemberGroup[] {
  return GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    items: detail.components.filter((component) =>
      group.kinds.includes(component.kind),
    ),
  })).filter((group) => group.items.length > 0)
}

const FORMAT_LABELS: Record<NonNullable<PluginDetail['format']>, string> = {
  portable: '可移植插件',
  'codex-compat': 'Codex 插件',
  'emperor-v1': 'Emperor 旧格式',
}

/** The 信息 group: source, scope, format, version, permissions, then what the package states. */
export function pluginFacts(detail: PluginDetail): DefinitionItem[] {
  const permissions = [
    detail.permissions.runsCommands ? '会运行本机命令' : '',
    detail.permissions.network ? '会联网' : '',
  ].filter(Boolean)
  const items: Array<DefinitionItem | null> = [
    { term: '来源', value: sourceLabel(detail.source) },
    { term: '范围', value: scopeLabel(detail.scope) },
    detail.format
      ? { term: '格式', value: FORMAT_LABELS[detail.format] }
      : null,
    { term: '版本', value: detail.version ?? '未提供', mono: true },
    { term: '权限', value: permissions.join('，') || '无' },
    detail.category ? { term: '类别', value: detail.category } : null,
    detail.homepage ? { term: '主页', value: detail.homepage } : null,
    detail.license ? { term: '许可证', value: detail.license } : null,
    detail.installedAt
      ? {
          term: '安装时间',
          value: new Date(detail.installedAt).toLocaleString(),
        }
      : null,
    detail.digest
      ? { term: 'Digest', value: shortDigest(detail.digest), mono: true }
      : null,
  ]
  return items.filter((item): item is DefinitionItem => item !== null)
}

export function isComputerUsePlugin(
  detail: Pick<PluginDetail, 'pluginId' | 'scope'>,
): boolean {
  return detail.pluginId === 'computer-use' && detail.scope === 'managed'
}

/** Where a Computer Use driver is set up: a 设置 section and its sub page. */
export interface DriverSettings {
  section: SettingsSectionKey
  page: string | null
  /** The destination, for the link's name. */
  label: string
}

const DRIVER_SETTINGS: Record<string, DriverSettings> = {
  'embedded-browser': {
    section: 'browser',
    page: null,
    label: '设置 › 浏览器',
  },
  'external-browser': {
    section: 'computer',
    page: 'chrome',
    label: '设置 › 电脑操作 › Chrome 和 Edge',
  },
  // 任意应用 lives on the 电脑操作 page itself (2026-10-01).
  desktop: {
    section: 'computer',
    page: null,
    label: '设置 › 电脑操作',
  },
}

export interface PluginToolGroupView {
  id: string
  title: string
  /** Why the group lists no tools now (its server does not run). */
  note: string | null
  /** Rows as 能力 › 工具 draws them (ToolRow). */
  tools: ToolInfo[]
  /** A Computer Use driver's settings page; `null` for the others. */
  settings: DriverSettings | null
}

/** The detail's 工具: one group per member, rows ready for ToolRow. */
export function pluginToolGroups(
  detail: Pick<PluginDetail, 'pluginId' | 'tools'>,
): PluginToolGroupView[] {
  return detail.tools.groups.map((group) => ({
    id: group.id,
    title: group.title,
    note: group.note,
    tools: group.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.parameters },
      read_only: tool.readOnly,
      source: group.kind === 'mcp' ? 'mcp' : 'builtin',
      plugin_id: detail.pluginId,
    })),
    settings:
      group.kind === 'computer-use'
        ? (DRIVER_SETTINGS[group.id] ?? null)
        : null,
  }))
}
