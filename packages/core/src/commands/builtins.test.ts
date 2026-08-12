import { describe, expect, it } from 'vitest'
import { builtinCommandDescriptors } from './builtins'

describe('builtin slash command catalog', () => {
  it('exposes only the nine everyday commands in product order', () => {
    const commands = builtinCommandDescriptors()

    expect(commands.map((command) => command.name)).toEqual([
      'new',
      'compact',
      'model',
      'reasoning',
      'permissions',
      'plan',
      'goal',
      'stop',
      'continue',
    ])
    expect(commands.map((command) => command.id)).toEqual([
      'builtin.new',
      'builtin.compact',
      'builtin.model',
      'builtin.reasoning',
      'builtin.permissions',
      'builtin.plan',
      'builtin.goal',
      'builtin.stop',
      'builtin.continue',
    ])
    expect(commands.every((command) => command.aliases.length === 0)).toBe(true)
    expect(commands.every((command) => !command.hiddenAliases?.length)).toBe(
      true,
    )
  })

  it('uses plain English product copy instead of developer categories', () => {
    const commands = builtinCommandDescriptors()

    expect(
      commands.map(({ name, category, description }) => ({
        name,
        category,
        description,
      })),
    ).toEqual([
      {
        name: 'new',
        category: 'Commands',
        description: 'Start a blank chat in this workspace',
      },
      {
        name: 'compact',
        category: 'Commands',
        description: 'Free up context while keeping a summary',
      },
      {
        name: 'model',
        category: 'Commands',
        description: 'Choose the model for this chat',
      },
      {
        name: 'reasoning',
        category: 'Commands',
        description: 'Choose how deeply the model thinks',
      },
      {
        name: 'permissions',
        category: 'Commands',
        description: 'Choose what Emperor may do',
      },
      {
        name: 'plan',
        category: 'Commands',
        description: 'Plan before making changes',
      },
      {
        name: 'goal',
        category: 'Commands',
        description: 'Keep working toward an outcome',
      },
      {
        name: 'stop',
        category: 'Commands',
        description: 'Stop the current task',
      },
      {
        name: 'continue',
        category: 'Commands',
        description: 'Resume the paused task',
      },
    ])
  })
})
