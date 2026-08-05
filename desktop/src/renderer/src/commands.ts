import type { CommandDescriptor } from '@emperor/core'

export interface SlashPaletteItem {
  id: string
  commandId: string
  kind: 'command' | 'skill'
  name: string
  usage: string
  completion: string
  description: string
  aliases?: string[]
  category: string
  source: CommandDescriptor['source']
  available: boolean
  unavailableReason?: string
  dangerous?: boolean
  argumentHint?: string
  recent?: boolean
  skillName?: string
  tags?: string
  requiresArguments?: boolean
}

export interface ResolvedSlashInvocation {
  raw: string
  token: string
  name: string
  rawArgs: string
  descriptor: CommandDescriptor | null
}

export function buildSlashPaletteItems(
  descriptors: CommandDescriptor[] = [],
  recentCommandIds: string[] = [],
): SlashPaletteItem[] {
  const recentRank = new Map(
    recentCommandIds.map((id, index) => [id, index] as const),
  )
  return descriptors
    .map((descriptor) => ({
      ...descriptorToPaletteItem(descriptor),
      recent: recentRank.has(descriptor.id),
    }))
    .sort((left, right) => {
      const a = recentRank.get(left.commandId)
      const b = recentRank.get(right.commandId)
      if (a !== undefined || b !== undefined)
        return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER)
      return left.name.localeCompare(right.name)
    })
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
    usage: argumentHint ? `${name} ${argumentHint}` : name,
    completion: argumentHint ? `${name} ` : name,
    description: descriptor.description,
    aliases: descriptor.aliases.map((alias) => `/${alias}`),
    category: descriptor.category,
    source: descriptor.source,
    available: descriptor.available,
    unavailableReason: descriptor.unavailableReason,
    dangerous: descriptor.dangerous,
    argumentHint,
    skillName: descriptor.skill?.name,
    tags:
      descriptor.source === 'project_skill'
        ? 'Project Skill'
        : descriptor.source === 'user_skill'
          ? 'User Skill'
          : descriptor.source === 'verified_plugin'
            ? 'Plugin Skill'
            : descriptor.kind === 'agent_prompt'
              ? 'Built-in Skill'
              : undefined,
    requiresArguments: descriptor.argumentSchema.some(
      (argument) => argument.required,
    ),
  }
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
    `${name} ${aliases.join(' ')} ${item.description}`.toLowerCase()
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
