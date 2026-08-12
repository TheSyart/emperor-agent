import { describe, expect, it } from 'vitest'
import type { CommandDescriptor } from '@emperor/core/api'
import {
  buildSlashPaletteItems,
  buildSlashPaletteGroups,
  isPathLikeSlashToken,
  rankSlashPaletteItems,
  resolveSlashInvocation,
} from './commands'

function command(
  name: string,
  overrides: Partial<CommandDescriptor> = {},
): CommandDescriptor {
  return {
    id: `builtin.${name}`,
    name,
    aliases: [],
    category: '内置命令',
    description: `${name} command`,
    kind: 'local_ui',
    source: 'builtin',
    busyPolicy: 'immediate',
    argumentSchema: [],
    userInvocable: true,
    invocationSources: ['desktop'],
    available: true,
    ...overrides,
  }
}

describe('Core-owned slash palette projection', () => {
  it('projects descriptors without maintaining a renderer command catalog', () => {
    const items = buildSlashPaletteItems([
      command('model', {
        description: 'Choose the model for this chat',
      }),
      command('audit', {
        id: 'skill.user.audit',
        source: 'user_skill',
        kind: 'agent_prompt',
        category: '用户 Skill',
        argumentHint: '[task]',
      }),
    ])
    expect(items).toMatchObject([
      {
        commandId: 'builtin.model',
        name: '/model',
        title: 'Model',
        kind: 'command',
      },
      {
        commandId: 'skill.user.audit',
        name: '/audit',
        title: 'Audit',
        sourceLabel: 'Personal',
        kind: 'skill',
      },
    ])
  })

  it('keeps product order and exposes only Commands and Skills groups', () => {
    const items = buildSlashPaletteItems([
      command('continue'),
      command('stop'),
      command('goal'),
      command('new'),
      command('compact'),
      command('model'),
      command('reasoning'),
      command('permissions'),
      command('plan'),
      command('zeta', {
        id: 'skill.user.zeta',
        kind: 'agent_prompt',
        source: 'user_skill',
      }),
      command('alpha', {
        id: 'skill.project.alpha',
        kind: 'agent_prompt',
        source: 'project_skill',
      }),
    ])

    expect(items.map((item) => item.name)).toEqual([
      '/new',
      '/compact',
      '/model',
      '/reasoning',
      '/permissions',
      '/plan',
      '/goal',
      '/stop',
      '/continue',
      '/alpha',
      '/zeta',
    ])
    expect(
      buildSlashPaletteGroups(items, { busy: false, canContinue: false }).map(
        (group) => ({
          label: group.label,
          names: group.items.map((item) => item.name),
        }),
      ),
    ).toEqual([
      {
        label: 'Commands',
        names: [
          '/new',
          '/compact',
          '/model',
          '/reasoning',
          '/permissions',
          '/plan',
          '/goal',
        ],
      },
      { label: 'Skills', names: ['/alpha', '/zeta'] },
    ])
  })

  it('shows Stop only while busy and Continue only when work can resume', () => {
    const items = buildSlashPaletteItems([
      command('new'),
      command('stop'),
      command('continue'),
    ])

    expect(
      buildSlashPaletteGroups(items, {
        busy: true,
        canContinue: false,
      })[0]?.items.map((item) => item.name),
    ).toEqual(['/new', '/stop'])
    expect(
      buildSlashPaletteGroups(items, {
        busy: false,
        canContinue: true,
      })[0]?.items.map((item) => item.name),
    ).toEqual(['/new', '/continue'])
  })

  it('resolves aliases but does not treat absolute paths as commands', () => {
    const descriptors = [command('model')]
    expect(resolveSlashInvocation('/model', descriptors)?.descriptor?.id).toBe(
      'builtin.model',
    )
    expect(
      resolveSlashInvocation('/missing', descriptors)?.descriptor,
    ).toBeNull()
    expect(
      resolveSlashInvocation('/Users/anhuike/project', descriptors),
    ).toBeNull()
    expect(isPathLikeSlashToken('/Users/anhuike/project')).toBe(true)
  })

  it('ranks exact name, alias, prefix and fuzzy description in that order', () => {
    const items = buildSlashPaletteItems([
      command('model'),
      command('reasoning', { description: 'Choose thinking depth' }),
      command('permissions', { description: 'Choose what Emperor may do' }),
    ])
    expect(rankSlashPaletteItems(items, 'model')[0]?.name).toBe('/model')
    expect(rankSlashPaletteItems(items, 'rea')[0]?.name).toBe('/reasoning')
    expect(rankSlashPaletteItems(items, 'Emperor')[0]?.name).toBe(
      '/permissions',
    )
  })
})
