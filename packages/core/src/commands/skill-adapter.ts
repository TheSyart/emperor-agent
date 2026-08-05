import type { SkillInfoPayload } from '../api/services/skill-service'
import type { CommandDescriptor } from './types'

export function skillCommandDescriptors(
  skills: SkillInfoPayload[],
  reservedNames: Set<string> = builtinReservedNames(),
): CommandDescriptor[] {
  const descriptors: CommandDescriptor[] = []
  for (const skill of skills) {
    if (skill.status !== 'active') continue
    const metadata = skill.command
    if (metadata && !metadata.userInvocable) continue
    const requestedName = normalize(metadata?.name || skill.name)
    if (!isCommandName(requestedName)) continue
    const collides = reservedNames.has(requestedName)
    const name = collides ? `skill:${skill.name}` : requestedName
    const aliases = (metadata?.aliases ?? [])
      .map(normalize)
      .filter(
        (value) =>
          isCommandName(value) && !reservedNames.has(value) && value !== name,
      )
    descriptors.push({
      id: `skill.${skill.source}.${skill.name}`,
      name,
      aliases: [...new Set(aliases)],
      hiddenAliases: [`${skill.name}-skill`],
      category:
        skill.source === 'project'
          ? '项目 Skill'
          : skill.source === 'user'
            ? '用户 Skill'
            : '内置 Skill',
      description: skill.description || skill.name,
      kind: 'agent_prompt',
      source:
        skill.source === 'project'
          ? 'project_skill'
          : skill.source === 'user'
            ? 'user_skill'
            : 'builtin_skill',
      busyPolicy: 'after_turn',
      argumentSchema: metadata?.arguments?.length
        ? metadata.arguments
        : [
            {
              name: 'task',
              type: 'string',
              positional: true,
              variadic: true,
            },
          ],
      argumentHint: metadata?.argumentHint || '[task]',
      userInvocable: true,
      invocationSources: metadata?.invocationSources ?? ['desktop'],
      available: true,
      sensitiveArguments: metadata?.sensitiveArguments ?? [],
      skill: {
        name: skill.name,
        context: metadata?.context ?? 'inline',
        agent: metadata?.agent ?? null,
        allowedTools: metadata?.allowedTools ?? [],
        effort: metadata?.effort ?? null,
      },
    })
  }
  return descriptors
}

function builtinReservedNames(): Set<string> {
  return new Set([
    'help',
    'commands',
    'status',
    'doctor',
    'context',
    'cost',
    'tokens',
    'token',
    'usage',
    'config',
    'configs',
    'theme',
    'reload',
    'clear',
    'reset',
    'new',
    'compact',
    'resume',
    'rename',
    'export',
    'copy',
    'model',
    'effort',
    'permissions',
    'allowed-tools',
    'mode',
    'plan',
    'goal',
    'goals',
    'stop',
    'continue',
    'memory',
    'skills',
    'tools',
    'mcp',
    'hooks',
    'agents',
    'tasks',
    'diff',
    'files',
    'terminal',
    'review',
    'git',
    'scheduler',
    'plugins',
  ])
}

function normalize(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase()
}

function isCommandName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_.:-]{0,96}$/.test(value)
}
