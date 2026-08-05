import { describe, expect, it } from 'vitest'
import { CommandRegistry } from './registry'
import { builtinCommandDescriptors } from './builtins'
import { skillCommandDescriptors } from './skill-adapter'
import type { SkillInfoPayload } from '../api/services/skill-service'

function skill(
  name: string,
  command: SkillInfoPayload['command'] = null,
): SkillInfoPayload {
  return {
    name,
    description: `${name} description`,
    path: `skills/${name}/SKILL.md`,
    tags: '',
    always: false,
    source: 'user',
    status: 'active',
    readOnly: false,
    requirements: { bins: [], runtimes: [], env: [] },
    command,
  }
}

describe('CommandRegistry', () => {
  it('protects builtin names and moves a colliding Skill under skill:<name>', () => {
    const registry = new CommandRegistry()
    registry.registerMany(builtinCommandDescriptors())
    registry.registerMany(skillCommandDescriptors([skill('help')]))

    expect(registry.resolveName('help')?.id).toBe('builtin.help')
    expect(registry.resolveName('skill:help')?.id).toBe('skill.user.help')
    expect(registry.resolveName('help-skill')?.id).toBe('skill.user.help')
  })

  it('keeps blocked and invalid Skills out of the callable registry', () => {
    const registry = new CommandRegistry()
    registry.registerMany(
      skillCommandDescriptors([
        { ...skill('blocked'), status: 'blocked' },
        { ...skill('invalid'), status: 'invalid' },
      ]),
    )
    expect(registry.list()).toEqual([])
  })

  it('does not publish malformed command names from Skill metadata', () => {
    const descriptors = skillCommandDescriptors([
      skill('audit', {
        userInvocable: true,
        name: '../escape',
        aliases: ['valid-alias'],
        argumentHint: '[task]',
        arguments: [],
        context: 'inline',
        agent: null,
        allowedTools: [],
        effort: null,
        invocationSources: ['desktop'],
        sensitiveArguments: [],
      }),
    ])
    expect(descriptors).toEqual([])
  })

  it('honors Skill command metadata without trusting a renderer supplied path', () => {
    const [descriptor] = skillCommandDescriptors([
      skill('audit', {
        userInvocable: true,
        name: 'review-code',
        aliases: ['audit-now'],
        argumentHint: '[scope]',
        arguments: [],
        context: 'fork',
        agent: 'reviewer',
        allowedTools: ['read_file', 'grep'],
        effort: 'high',
        invocationSources: ['desktop'],
        sensitiveArguments: [],
      }),
    ])
    expect(descriptor).toMatchObject({
      id: 'skill.user.audit',
      name: 'review-code',
      aliases: ['audit-now'],
      hiddenAliases: ['audit-skill'],
      kind: 'agent_prompt',
      source: 'user_skill',
      skill: {
        name: 'audit',
        context: 'fork',
        agent: 'reviewer',
        allowedTools: ['read_file', 'grep'],
      },
    })
    expect(descriptor).not.toHaveProperty('path')
  })
})
