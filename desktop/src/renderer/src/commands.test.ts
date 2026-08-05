import { describe, expect, it } from 'vitest'
import type { CommandDescriptor } from '@emperor/core'
import {
  buildSlashPaletteItems,
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
      command('help', { aliases: ['commands'] }),
      command('audit', {
        id: 'skill.user.audit',
        source: 'user_skill',
        kind: 'agent_prompt',
        category: '用户 Skill',
        argumentHint: '[task]',
      }),
    ])
    expect(items).toMatchObject([
      { commandId: 'skill.user.audit', name: '/audit', kind: 'skill' },
      {
        commandId: 'builtin.help',
        name: '/help',
        aliases: ['/commands'],
        kind: 'command',
      },
    ])
  })

  it('resolves aliases but does not treat absolute paths as commands', () => {
    const descriptors = [
      command('cost', { aliases: ['tokens'] }),
      command('memory', { hiddenAliases: ['memory-log'] }),
    ]
    expect(resolveSlashInvocation('/tokens', descriptors)?.descriptor?.id).toBe(
      'builtin.cost',
    )
    expect(
      resolveSlashInvocation('/missing', descriptors)?.descriptor,
    ).toBeNull()
    expect(
      resolveSlashInvocation('/memory-log', descriptors)?.descriptor?.id,
    ).toBe('builtin.memory')
    expect(
      resolveSlashInvocation('/Users/anhuike/project', descriptors),
    ).toBeNull()
    expect(isPathLikeSlashToken('/Users/anhuike/project')).toBe(true)
  })

  it('ranks exact name, alias, prefix and fuzzy description in that order', () => {
    const items = buildSlashPaletteItems([
      command('status'),
      command('cost', { aliases: ['tokens'], description: 'Token 成本账本' }),
      command('context', { description: '上下文占用' }),
    ])
    expect(rankSlashPaletteItems(items, 'tokens')[0]?.name).toBe('/cost')
    expect(rankSlashPaletteItems(items, 'sta')[0]?.name).toBe('/status')
    expect(rankSlashPaletteItems(items, '上下文')[0]?.name).toBe('/context')
  })
})
