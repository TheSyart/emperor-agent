import type { AttachmentRef, McpServerConfig, SkillInfo, ToolInfo } from '../types'

export type CapabilityKind = 'attachment' | 'skill' | 'tool' | 'mcp' | 'workspace'
export type CapabilityTone = 'red' | 'cyan' | 'blue' | 'slate' | 'gold' | 'green' | 'violet'

export interface CapabilityBadge {
  label: string
  tone?: CapabilityTone
}

export interface CapabilityDisplayItem {
  id: string
  kind: CapabilityKind
  title: string
  name: string
  description: string
  tone: CapabilityTone
  meta?: string
  badges: CapabilityBadge[]
  sourceName?: string
}

export interface ComposerCapabilityItem extends CapabilityDisplayItem {
  removable?: boolean
}

export function attachmentCapability(attachment: AttachmentRef): ComposerCapabilityItem {
  return {
    id: `attachment:${attachment.id}`,
    kind: 'attachment',
    title: attachmentTitle(attachment),
    name: attachment.name,
    description: attachment.hasText ? '已抽取文本' : attachment.kind,
    tone: attachment.kind === 'image' ? 'blue' : 'red',
    meta: `${formatBytes(attachment.size)} · ${attachment.kind}`,
    badges: attachment.hasText ? [{ label: '文本', tone: 'green' }] : [],
    removable: true,
  }
}

export function skillCapability(skill: SkillInfo): CapabilityDisplayItem {
  const badges = skillBadges(skill)
  return {
    id: `skill:${skill.name}`,
    kind: 'skill',
    title: titleizeCapabilityName(skill.name),
    name: skill.name,
    description: skill.description || skill.path || '本地 Skill 能力包',
    tone: 'cyan',
    meta: skill.path,
    badges,
    sourceName: 'Skill',
  }
}

export function toolCapability(tool: ToolInfo): CapabilityDisplayItem {
  const isMcp = tool.source === 'mcp'
  const badges: CapabilityBadge[] = [
    { label: tool.read_only ? '只读' : '可写', tone: tool.read_only ? 'green' : 'red' },
  ]
  if (tool.concurrency_safe) badges.push({ label: '并发', tone: 'green' })
  if (tool.exclusive) badges.push({ label: '独占', tone: 'gold' })
  if (isMcp && tool.server) badges.unshift({ label: tool.server, tone: 'blue' })

  return {
    id: `${isMcp ? 'mcp-tool' : 'tool'}:${tool.name}`,
    kind: isMcp ? 'mcp' : 'tool',
    title: tool.name,
    name: tool.name,
    description: tool.description || '无描述',
    tone: isMcp ? 'slate' : 'violet',
    meta: isMcp ? `MCP · ${tool.server || 'server'}` : `参数 ${paramCount(tool)} 个`,
    badges,
    sourceName: isMcp ? tool.server || 'MCP' : '内建工具',
  }
}

export function mcpServerCapability(
  name: string,
  config: McpServerConfig,
  toolCount = 0,
): CapabilityDisplayItem {
  const enabled = config.enabled !== false
  const transport = config.transport || (config.url ? 'sse' : 'stdio')
  const target = config.command || config.url || '未配置启动方式'
  return {
    id: `mcp-server:${name}`,
    kind: 'mcp',
    title: titleizeCapabilityName(name),
    name,
    description: `${transport} · ${target}`,
    tone: 'slate',
    meta: 'MCP server',
    badges: [
      { label: enabled ? '启用' : '停用', tone: enabled ? 'green' : 'gold' },
      { label: `${toolCount} 工具`, tone: 'blue' },
    ],
    sourceName: 'MCP',
  }
}

export function titleizeCapabilityName(name: string): string {
  return String(name || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === 'mcp') return 'MCP'
      if (lower === 'ui') return 'UI'
      if (lower === 'ux') return 'UX'
      if (lower === 'pdf') return 'PDF'
      if (lower === 'github') return 'GitHub'
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

function attachmentTitle(attachment: AttachmentRef): string {
  const lowerMime = attachment.mime.toLowerCase()
  const lowerName = attachment.name.toLowerCase()
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) return 'PDF'
  if (attachment.kind === 'image' || lowerMime.startsWith('image/')) return '图片'
  if (lowerName.endsWith('.md') || lowerMime.includes('markdown')) return 'Markdown'
  if (lowerName.endsWith('.json') || lowerMime.includes('json')) return 'JSON'
  if (lowerName.endsWith('.csv')) return 'CSV'
  return attachment.kind === 'text' ? '文本' : '文档'
}

function skillBadges(skill: SkillInfo): CapabilityBadge[] {
  const tags = (skill.tags || '').split(/[,;\s]+/).filter(Boolean)
  const badges = tags.slice(0, 4).map((label) => ({ label, tone: tagTone(label) }))
  if (skill.always) badges.unshift({ label: 'always', tone: 'gold' })
  return badges.slice(0, 5)
}

function tagTone(tag: string): CapabilityTone {
  const normalized = tag.toLowerCase()
  if (['github', 'gh'].includes(normalized)) return 'violet'
  if (['ui', 'ux', 'design', 'react'].includes(normalized)) return 'blue'
  if (['audit', 'review', 'always'].includes(normalized)) return 'gold'
  if (['image', 'vision', 'pdf'].includes(normalized)) return 'red'
  if (['search', 'web', 'mcp'].includes(normalized)) return 'cyan'
  return 'green'
}

function paramCount(tool: ToolInfo): number {
  const params = tool.parameters
  if (!params || typeof params !== 'object') return 0
  const properties = (params as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object') return 0
  return Object.keys(properties).length
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}
