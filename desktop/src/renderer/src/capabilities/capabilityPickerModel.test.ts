import { describe, expect, it } from 'vitest'

import type { SlashPaletteItem } from '../commands'
import type { ToolInfo } from '../types'
import { buildCapabilityPickerGroups } from './capabilityPickerModel'

const commands: SlashPaletteItem[] = [
  {
    id: 'command:/plan',
    kind: 'command',
    name: '/plan',
    usage: '/plan on|off|status',
    completion: '/plan ',
    description: '开启 Plan',
  },
  {
    id: 'command:/goal',
    kind: 'command',
    name: '/goal',
    usage: '/goal <outcome>|status|pause|resume|cancel',
    completion: '/goal ',
    description: '开启 Goal',
  },
  {
    id: 'command:/skills',
    kind: 'command',
    name: '/skills',
    usage: '/skills',
    completion: '/skills',
    description: '输出可用 Skill 摘要',
  },
  {
    id: 'skill:clawhub',
    kind: 'skill',
    name: '/clawhub',
    usage: '/clawhub',
    completion: '/clawhub ',
    description: 'Search and install agent skills.',
    skillName: 'clawhub',
  },
]

const tools: ToolInfo[] = [
  {
    name: 'read_file',
    description: '读取文件',
    source: 'builtin',
    read_only: true,
  },
  {
    name: 'mcp_github_get_issue',
    description: '读取 GitHub issue',
    source: 'mcp',
    server: 'github',
    read_only: true,
  },
]

describe('capability picker model', () => {
  it('does not expose builtin tools in the composer picker', () => {
    const groups = buildCapabilityPickerGroups({
      commands,
      tools,
      mcpContent: '',
    })
    const labels = groups.flatMap((group) =>
      group.items.map((item) => item.label),
    )
    const groupLabels = groups.map((group) => group.label)

    expect(groupLabels).not.toContain('内建工具')
    expect(labels).not.toContain('read_file')
  })

  it('turns skill and MCP selections into inline placeholder tokens', () => {
    const groups = buildCapabilityPickerGroups({
      commands,
      tools,
      mcpContent: JSON.stringify({
        servers: { gitlab: { transport: 'stdio', enabled: true } },
      }),
    })
    const skill = groups
      .flatMap((group) => group.items)
      .find((item) => item.id === 'skill:clawhub')
    const github = groups
      .flatMap((group) => group.items)
      .find((item) => item.id === 'mcp:github')
    const gitlab = groups
      .flatMap((group) => group.items)
      .find((item) => item.id === 'mcp:gitlab')

    expect(skill?.completion).toBe('@skill(clawhub)')
    expect(github?.completion).toBe('@mcp(github)')
    expect(gitlab?.completion).toBe('@mcp(gitlab)')
  })

  it('turns Plan and Goal selections into lifecycle activations', () => {
    const items = buildCapabilityPickerGroups({
      commands,
      tools,
      mcpContent: '',
    }).flatMap((group) => group.items)

    expect(items.find((item) => item.id === 'command:/plan')?.action).toBe(
      'activate_plan',
    )
    expect(items.find((item) => item.id === 'command:/goal')?.action).toBe(
      'activate_goal',
    )
  })
})
