import type { RequestedSkill, SkillInfo } from './types'

export interface SlashCommand {
  name: string
  usage: string
  description: string
  aliases?: string[]
}

export interface SlashPaletteItem {
  id: string
  kind: 'command' | 'skill'
  name: string
  usage: string
  completion: string
  description: string
  aliases?: string[]
  tags?: string
  always?: boolean
  skillName?: string
}

export const slashCommands: SlashCommand[] = [
  { name: '/help', usage: '/help', description: '显示可用斜杠命令', aliases: ['/commands'] },
  { name: '/status', usage: '/status', description: '查看运行状态、模型、Token 与资源计数' },
  { name: '/model', usage: '/model', description: '输出当前模型与 Provider 配置信息' },
  { name: '/tokens', usage: '/tokens', description: '输出 Token 消耗统计', aliases: ['/token'] },
  { name: '/tools', usage: '/tools', description: '输出可用工具摘要' },
  { name: '/skills', usage: '/skills', description: '输出可用 Skill 摘要' },
  { name: '/config', usage: '/config', description: '查看并编辑用户配置文件 (USER.local.md)', aliases: ['/configs'] },
  { name: '/memory', usage: '/memory', description: '输出记忆状态摘要' },
  { name: '/plan', usage: '/plan on|off|status', description: '查看或切换 Plan 模式' },
  { name: '/compact', usage: '/compact', description: '触发未归档会话压缩，写入 MEMORY/情景记忆' },
  { name: '/clear', usage: '/clear', description: '清空当前屏幕，不删除运行期记忆' },
  { name: '/reload', usage: '/reload', description: '刷新 bootstrap、模型、skills、tools、memory' },
]

export function buildSlashPaletteItems(skills: SkillInfo[] = []): SlashPaletteItem[] {
  const commandItems = slashCommands.map((command) => ({
    id: `command:${command.name}`,
    kind: 'command' as const,
    name: command.name,
    usage: command.usage,
    completion: command.usage,
    description: command.description,
    aliases: command.aliases,
  }))
  const skillItems = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      name: `/${skill.name}`,
      usage: `/${skill.name}`,
      completion: `/${skill.name} `,
      description: skill.description || skill.path,
      aliases: [`/${skill.name}-skill`],
      tags: skill.tags,
      always: skill.always,
      skillName: skill.name,
    }))
  return [...commandItems, ...skillItems]
}

export function parseSlashCommand(input: string) {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const [name, ...args] = trimmed.split(/\s+/)
  const normalized = name.toLowerCase()
  const command = slashCommands.find((item) => item.name === normalized || item.aliases?.includes(normalized))
  return { raw: trimmed, name: normalized, command, args }
}

export function parseSkillSlashCommand(input: string, skills: SkillInfo[] = []) {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const [token, ...rest] = trimmed.split(/\s+/)
  const normalized = token.slice(1).toLowerCase()
  const exact = skills.find((skill) => skill.name.toLowerCase() === normalized)
  const alias = !exact && normalized.endsWith('-skill')
    ? skills.find((skill) => skill.name.toLowerCase() === normalized.slice(0, -'-skill'.length))
    : undefined
  const skill = exact || alias
  if (!skill) return null
  const requestedSkill: RequestedSkill = { name: skill.name, source: 'slash' }
  return {
    raw: trimmed,
    name: skill.name,
    token,
    task: rest.join(' ').trim(),
    requestedSkill,
  }
}
