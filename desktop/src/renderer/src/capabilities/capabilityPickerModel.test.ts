import { describe, expect, it } from 'vitest'

import type { SlashPaletteItem } from '../commands'
import { buildCapabilityPickerGroups } from './capabilityPickerModel'
import type { PluginChoice } from './pluginChoices'

const commands: SlashPaletteItem[] = [
  {
    id: 'command:/plan',
    commandId: 'builtin.plan',
    kind: 'command',
    name: '/plan',
    title: 'Plan mode',
    completion: '/plan ',
    description: '开启 Plan',
    category: '执行控制',
    source: 'builtin',
    sourceLabel: '',
    available: true,
  },
  {
    id: 'command:/goal',
    commandId: 'builtin.goal',
    kind: 'command',
    name: '/goal',
    title: 'Goal',
    completion: '/goal ',
    description: '开启 Goal',
    category: '执行控制',
    source: 'builtin',
    sourceLabel: '',
    available: true,
  },
  {
    id: 'command:/model',
    commandId: 'builtin.model',
    kind: 'command',
    name: '/model',
    title: 'Model',
    completion: '/model',
    description: 'Choose the model for this chat',
    category: 'Chat',
    source: 'builtin',
    sourceLabel: '',
    available: true,
  },
  {
    id: 'skill:clawhub',
    commandId: 'skill.builtin.clawhub',
    kind: 'skill',
    name: '/clawhub',
    title: 'Clawhub',
    completion: '/clawhub ',
    description: 'Search and install agent skills.',
    skillName: 'clawhub',
    category: '内置 Skill',
    source: 'builtin_skill',
    sourceLabel: 'Built-in',
    available: true,
  },
]

describe('capability picker model', () => {
  it('does not expose builtin tools or MCP servers in the composer picker', () => {
    const groups = buildCapabilityPickerGroups({ commands, plugins: [] })
    const labels = groups.flatMap((group) =>
      group.items.map((item) => item.label),
    )
    const groupLabels = groups.map((group) => group.label)

    expect(groupLabels).not.toContain('内建工具')
    expect(groupLabels).not.toContain('MCP')
    expect(labels).not.toContain('read_file')
    expect(labels).not.toContain('github')
  })

  it('UI-S04: offers Skills as chips and plugins, nothing else', () => {
    const groups = buildCapabilityPickerGroups({
      commands,
      plugins: [
        {
          id: 'github',
          label: 'GitHub',
          description: 'Issues and pull requests',
          logo: null,
          scope: 'managed',
          unavailable: null,
        },
      ] as PluginChoice[],
    })
    expect(groups.map((group) => group.label)).toEqual(['Skills', '插件'])
    const skill = groups[0]!.items[0]!
    expect(skill).toMatchObject({
      id: 'skill:clawhub',
      action: 'insert_reference',
      reference: { kind: 'skill', id: 'clawhub', label: 'Clawhub' },
    })
    // Plan, Goal and the other commands start with `/`; Plan is in the
    // permission menu.
    const items = groups.flatMap((group) => group.items)
    expect(items.some((item) => item.action === 'activate_plan')).toBe(false)
    expect(items.some((item) => item.action === 'activate_goal')).toBe(false)
  })
})
