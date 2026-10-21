import type { CommandDescriptor } from '@emperor/core/api'

export interface SlashPaletteItem {
  id: string
  commandId: string
  kind: 'command' | 'skill'
  name: string
  title: string
  completion: string
  description: string
  aliases?: string[]
  category: string
  source: CommandDescriptor['source']
  sourceLabel: string
  available: boolean
  unavailableReason?: string
  skillName?: string
  tags?: string
  requiresArguments?: boolean
}

export interface SlashPaletteGroup {
  label: '命令' | 'Skills'
  items: SlashPaletteItem[]
}

const BUILTIN_ORDER = [
  'new',
  'compact',
  'model',
  'reasoning',
  'permissions',
  'plan',
  'goal',
  'stop',
  'continue',
] as const

const BUILTIN_TITLES = new Map<string, string>([
  ['new', '新对话'],
  ['compact', '压缩上下文'],
  ['model', '模型'],
  ['reasoning', '思考强度'],
  ['permissions', '执行权限'],
  ['plan', '计划模式'],
  ['goal', '目标'],
  ['stop', '停止'],
  ['continue', '继续'],
])

export interface ResolvedSlashInvocation {
  raw: string
  token: string
  name: string
  rawArgs: string
  descriptor: CommandDescriptor | null
}

export function buildSlashPaletteItems(
  descriptors: CommandDescriptor[] = [],
): SlashPaletteItem[] {
  return descriptors.map(descriptorToPaletteItem).sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'command' ? -1 : 1
    if (left.kind === 'skill') return left.title.localeCompare(right.title)
    return builtinOrder(left.name) - builtinOrder(right.name)
  })
}

export function buildSlashPaletteGroups(
  items: SlashPaletteItem[],
  state: { busy: boolean; canContinue: boolean },
): SlashPaletteGroup[] {
  const visible = items.filter((item) => {
    if (item.kind !== 'command') return true
    if (item.name === '/stop') return state.busy
    if (item.name === '/continue') return !state.busy && state.canContinue
    return true
  })
  const commands = visible.filter((item) => item.kind === 'command')
  const skills = visible.filter((item) => item.kind === 'skill')
  return [
    ...(commands.length ? [{ label: '命令' as const, items: commands }] : []),
    ...(skills.length ? [{ label: 'Skills' as const, items: skills }] : []),
  ]
}

export function resolveSlashInvocation(
  input: string,
  descriptors: CommandDescriptor[],
): ResolvedSlashInvocation | null {
  const raw = String(input ?? '').trim()
  if (!raw.startsWith('/')) return null
  const token = raw.match(/^\/\S+/)?.[0] ?? ''
  if (!token || isPathLikeSlashToken(token)) return null
  const name = token.slice(1).toLowerCase()
  const descriptor =
    descriptors.find(
      (item) =>
        item.name.toLowerCase() === name ||
        item.aliases.some((alias) => alias.toLowerCase() === name) ||
        (item.hiddenAliases ?? []).some(
          (alias) => alias.toLowerCase() === name,
        ),
    ) ?? null
  return {
    raw,
    token,
    name,
    rawArgs: raw.slice(token.length).trimStart(),
    descriptor,
  }
}

export function rankSlashPaletteItems(
  items: SlashPaletteItem[],
  query: string,
): SlashPaletteItem[] {
  const normalized = query.trim().replace(/^\//, '').toLowerCase()
  if (!normalized) return [...items]
  return items
    .map((item) => ({ item, score: scoreItem(item, normalized) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.item.name.localeCompare(right.item.name),
    )
    .map((entry) => entry.item)
}

/** The name a skill item is referenced by (`/name`, the kernel's gesture). */
export function skillIdOf(item: SlashPaletteItem): string {
  return item.skillName || item.name.replace(/^\//, '')
}

export function isPathLikeSlashToken(token: string): boolean {
  const text = token.trim()
  if (!text.startsWith('/') || text === '/') return false
  return text.slice(1).includes('/')
}

function descriptorToPaletteItem(
  descriptor: CommandDescriptor,
): SlashPaletteItem {
  const name = `/${descriptor.name}`
  const argumentHint = descriptor.argumentHint?.trim() || ''
  return {
    id: `command:${descriptor.id}`,
    commandId: descriptor.id,
    kind: descriptor.kind === 'agent_prompt' ? 'skill' : 'command',
    name,
    title:
      descriptor.kind === 'agent_prompt'
        ? displaySkillName(descriptor.skill?.name || descriptor.name)
        : BUILTIN_TITLES.get(descriptor.name) ||
          displaySkillName(descriptor.name),
    completion: argumentHint ? `${name} ` : name,
    description: descriptor.description,
    aliases: descriptor.aliases.map((alias) => `/${alias}`),
    category: descriptor.category,
    source: descriptor.source,
    sourceLabel: sourceLabel(descriptor.source),
    available: descriptor.available,
    unavailableReason: descriptor.unavailableReason,
    skillName: descriptor.skill?.name,
    tags:
      descriptor.source === 'project_skill'
        ? '项目 Skill'
        : descriptor.source === 'user_skill'
          ? '个人 Skill'
          : descriptor.source === 'plugin' ||
              descriptor.source === 'verified_plugin'
            ? '插件 Skill'
            : descriptor.kind === 'agent_prompt'
              ? '内置 Skill'
              : undefined,
    requiresArguments: descriptor.argumentSchema.some(
      (argument) => argument.required,
    ),
  }
}

function builtinOrder(name: string): number {
  const index = BUILTIN_ORDER.indexOf(
    name.replace(/^\//, '') as (typeof BUILTIN_ORDER)[number],
  )
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

function sourceLabel(source: CommandDescriptor['source']): string {
  if (source === 'project_skill') return '项目'
  if (source === 'user_skill') return '个人'
  if (source === 'plugin' || source === 'verified_plugin') return '插件'
  if (source === 'builtin_skill') return '内置'
  return ''
}

function displaySkillName(value: string): string {
  const acronyms = new Set(['ai', 'api', 'mcp', 'pdf', 'ui', 'ux'])
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) =>
      acronyms.has(part.toLowerCase())
        ? part.toUpperCase()
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(' ')
}

function scoreItem(item: SlashPaletteItem, query: string): number {
  const name = item.name.slice(1).toLowerCase()
  const aliases = (item.aliases ?? []).map((alias) =>
    alias.replace(/^\//, '').toLowerCase(),
  )
  if (name === query) return 0
  if (aliases.includes(query)) return 1
  if (name.startsWith(query)) return 2
  if (aliases.some((alias) => alias.startsWith(query))) return 3
  if (name.split(/[-_:]/).some((part) => part.startsWith(query))) return 4
  const haystack =
    `${name} ${item.title} ${aliases.join(' ')} ${item.description} ${item.sourceLabel}`.toLowerCase()
  if (subsequence(query, haystack)) return 5
  return Number.POSITIVE_INFINITY
}

function subsequence(needle: string, haystack: string): boolean {
  let cursor = 0
  for (const character of haystack) {
    if (character === needle[cursor]) cursor += 1
    if (cursor === needle.length) return true
  }
  return false
}
