import type { SlashPaletteItem } from '../commands'
import { actionIcons, navIcon, toolIcon } from '../icons'
import type { ToolInfo } from '../types'
import type {
  CapabilityPickerGroup,
  CapabilityPickerItem,
} from './capabilityPicker'

export interface CapabilityPickerModelInput {
  commands: SlashPaletteItem[]
  tools: ToolInfo[]
  mcpContent?: string
}

export function buildCapabilityPickerGroups(
  input: CapabilityPickerModelInput,
): CapabilityPickerGroup[] {
  const commandItems = prioritizedCommands(input.commands)
  const skillItems = input.commands
    .filter((item) => item.kind === 'skill')
    .slice(0, 8)
    .map(skillPickerItem)
  const mcpItems = mcpServerNames(input.tools, input.mcpContent).map(
    mcpPickerItem,
  )

  return [
    {
      label: '附件',
      items: [
        {
          id: 'files',
          action: 'files' as const,
          label: '文件与图片',
          description: '上传 PDF、图片、文档或数据文件',
          meta: '本轮上下文',
          icon: actionIcons.attach,
          tone: 'red' as const,
        },
      ],
    },
    {
      label: 'Skills',
      items: skillItems,
    },
    {
      label: 'MCP',
      items: mcpItems,
    },
    {
      label: '命令',
      items: commandItems,
    },
  ].filter((group) => group.items.length)
}

function prioritizedCommands(
  commands: SlashPaletteItem[],
): CapabilityPickerItem[] {
  const priority = ['/plan', '/goal', '/tools', '/skills', '/mode', '/status']
  return priority
    .map((name) =>
      commands.find((item) => item.kind === 'command' && item.name === name),
    )
    .filter((item): item is SlashPaletteItem => Boolean(item))
    .map((item) => ({
      id: item.id,
      action:
        item.name === '/plan'
          ? ('activate_plan' as const)
          : item.name === '/goal'
            ? ('activate_goal' as const)
            : ('insert_command' as const),
      label: item.name,
      description: item.description,
      meta: item.usage,
      completion: item.completion,
      icon: commandIcon(item.name),
      tone: 'slate' as const,
    }))
}

function skillPickerItem(item: SlashPaletteItem): CapabilityPickerItem {
  const name = item.skillName || item.name.replace(/^\//, '')
  return {
    id: item.id,
    action: 'insert_capability_token',
    label: item.name,
    description: item.description,
    meta: item.tags || 'Skill',
    completion: `@skill(${name})`,
    icon: toolIcon('skill'),
    tone: 'cyan',
  }
}

function mcpPickerItem(name: string): CapabilityPickerItem {
  return {
    id: `mcp:${name}`,
    action: 'insert_capability_token',
    label: name,
    description: '引用这个 MCP 连接作为本轮外部能力上下文',
    meta: 'MCP',
    completion: `@mcp(${name})`,
    icon: navIcon('mcp'),
    tone: 'slate',
  }
}

function mcpServerNames(tools: ToolInfo[], mcpContent?: string): string[] {
  const names = new Set<string>()
  for (const tool of tools) {
    if (tool.source === 'mcp' && tool.server) names.add(tool.server)
  }
  for (const name of mcpServerNamesFromConfig(mcpContent)) {
    names.add(name)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

function mcpServerNamesFromConfig(mcpContent?: string): string[] {
  if (!mcpContent?.trim()) return []
  try {
    const parsed = JSON.parse(mcpContent) as { servers?: unknown }
    if (!parsed.servers || typeof parsed.servers !== 'object') return []
    return Object.keys(parsed.servers as Record<string, unknown>)
  } catch {
    return []
  }
}

function commandIcon(name: string) {
  if (name === '/plan') return actionIcons.modePlan
  if (name === '/mode') return actionIcons.modeAskBeforeEdit
  if (name === '/tools') return toolIcon('default')
  if (name === '/skills') return toolIcon('skill')
  if (name === '/status') return actionIcons.statusOnline
  return toolIcon('shell')
}
