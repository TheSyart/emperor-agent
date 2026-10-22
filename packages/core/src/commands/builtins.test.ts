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
    expect(
      commands
        .filter((command) => command.hiddenAliases?.length)
        .map((command) => [command.name, command.hiddenAliases]),
    ).toEqual([['permissions', ['permission']]])
  })

  it('offers the three harness permission presets', () => {
    const permissions = builtinCommandDescriptors().find(
      (command) => command.name === 'permissions',
    )
    expect(permissions?.argumentSchema[0]?.values).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
      'status',
    ])
  })

  it('uses plain Chinese product copy instead of developer categories', () => {
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
        category: '命令',
        description: '在这个工作区开一个新对话',
      },
      {
        name: 'compact',
        category: '命令',
        description: '压缩上下文，保留一份摘要',
      },
      {
        name: 'model',
        category: '命令',
        description: '选择这个对话用的模型',
      },
      {
        name: 'reasoning',
        category: '命令',
        description: '选择模型思考的深度',
      },
      {
        name: 'permissions',
        category: '命令',
        description: '选择 Emperor 能做什么',
      },
      {
        name: 'plan',
        category: '命令',
        description: '先做计划，再动手改',
      },
      {
        name: 'goal',
        category: '命令',
        description: '朝一个目标持续工作',
      },
      {
        name: 'stop',
        category: '命令',
        description: '停止当前任务',
      },
      {
        name: 'continue',
        category: '命令',
        description: '继续已暂停的任务',
      },
    ])
  })

  it('FIX-09 · 3 · descriptions and the category are Chinese: the / palette shows them', () => {
    for (const command of builtinCommandDescriptors()) {
      const english = `${command.category} ${command.description}`
        .replace(/Emperor/g, '')
        .match(/[A-Za-z]{2,}/g)
      expect(english, command.name).toBeNull()
    }
  })
})
