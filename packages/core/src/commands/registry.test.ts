import { describe, expect, it } from 'vitest'
import { CommandRegistry } from './registry'
import { builtinCommandDescriptors } from './builtins'
import {
  resolveSkillCommandCatalog,
  skillCommandDescriptors,
} from './skill-adapter'
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
  it('protects builtin names by leaving a colliding Skill unregistered', () => {
    const registry = new CommandRegistry()
    registry.registerMany(builtinCommandDescriptors())
    const catalog = resolveSkillCommandCatalog(
      [skill('new')],
      registry.reservedNames(),
    )
    registry.registerMany(catalog.descriptors)

    expect(registry.resolveName('new')?.id).toBe('builtin.new')
    expect(
      registry.list().filter((item) => item.kind === 'agent_prompt'),
    ).toEqual([])
    expect(catalog.conflicts).toEqual([
      {
        token: 'new',
        skillName: 'new',
        source: 'user',
        reason: 'builtin_collision',
        winnerSkillName: null,
        winnerSource: 'builtin',
      },
    ])
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

  it('normalizes a Skill name into its direct kebab-case command', () => {
    const [descriptor] = skillCommandDescriptors([skill('Agent Reach')])

    expect(descriptor).toMatchObject({
      id: 'skill.user.Agent Reach',
      name: 'agent-reach',
      aliases: [],
    })
    expect(descriptor).not.toHaveProperty('hiddenAliases')
  })

  it('keeps only the highest-precedence Skill when command tokens collide', () => {
    const project = { ...skill('audit-project'), source: 'project' as const }
    const user = { ...skill('audit-user'), source: 'user' as const }
    const command = {
      userInvocable: true,
      name: 'audit',
      aliases: [],
      argumentHint: '[task]',
      arguments: [],
      context: 'inline' as const,
      agent: null,
      allowedTools: [],
      effort: null,
      invocationSources: ['desktop' as const],
      sensitiveArguments: [],
    }

    const catalog = resolveSkillCommandCatalog([
      { ...user, command },
      { ...project, command },
    ])
    const descriptors = catalog.descriptors

    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]).toMatchObject({
      id: 'skill.project.audit-project',
      name: 'audit',
      source: 'project_skill',
    })
    expect(catalog.conflicts).toEqual([
      expect.objectContaining({
        token: 'audit',
        skillName: 'audit-user',
        reason: 'skill_collision',
        winnerSkillName: 'audit-project',
        winnerSource: 'project',
      }),
    ])
  })
})
