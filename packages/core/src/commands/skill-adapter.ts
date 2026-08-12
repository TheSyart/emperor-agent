import type { SkillInfoPayload } from '../api/services/skill-service'
import type { CommandDescriptor } from './types'

export interface SkillCommandConflict {
  token: string
  skillName: string
  source: SkillInfoPayload['source']
  reason: 'builtin_collision' | 'skill_collision' | 'alias_collision'
  winnerSkillName: string | null
  winnerSource: SkillInfoPayload['source'] | 'builtin'
}

export interface SkillCommandCatalog {
  descriptors: CommandDescriptor[]
  conflicts: SkillCommandConflict[]
}

export function skillCommandDescriptors(
  skills: SkillInfoPayload[],
  reservedNames: Set<string> = builtinReservedNames(),
): CommandDescriptor[] {
  return resolveSkillCommandCatalog(skills, reservedNames).descriptors
}

export function resolveSkillCommandCatalog(
  skills: SkillInfoPayload[],
  reservedNames: Set<string> = builtinReservedNames(),
): SkillCommandCatalog {
  const descriptors: CommandDescriptor[] = []
  const conflicts: SkillCommandConflict[] = []
  const claims = new Map<
    string,
    {
      skillName: string | null
      source: SkillInfoPayload['source'] | 'builtin'
    }
  >()
  for (const name of reservedNames)
    claims.set(normalizeExplicitName(name), {
      skillName: null,
      source: 'builtin',
    })
  const orderedSkills = [...skills].sort(
    (left, right) =>
      sourcePriority(left.source) - sourcePriority(right.source) ||
      left.name.localeCompare(right.name),
  )
  for (const skill of orderedSkills) {
    if (skill.status !== 'active') continue
    const metadata = skill.command
    if (metadata && !metadata.userInvocable) continue
    const requestedName = metadata?.name
      ? normalizeExplicitName(metadata.name)
      : normalizeSkillName(skill.name)
    if (!isCommandName(requestedName)) continue
    const winner = claims.get(requestedName)
    if (winner) {
      conflicts.push({
        token: requestedName,
        skillName: skill.name,
        source: skill.source,
        reason:
          winner.source === 'builtin' ? 'builtin_collision' : 'skill_collision',
        winnerSkillName: winner.skillName,
        winnerSource: winner.source,
      })
      continue
    }
    const uniqueAliases: string[] = []
    for (const alias of [
      ...new Set((metadata?.aliases ?? []).map(normalizeExplicitName)),
    ]) {
      if (!isCommandName(alias) || alias === requestedName) continue
      const aliasWinner = claims.get(alias)
      if (aliasWinner) {
        conflicts.push({
          token: alias,
          skillName: skill.name,
          source: skill.source,
          reason: 'alias_collision',
          winnerSkillName: aliasWinner.skillName,
          winnerSource: aliasWinner.source,
        })
        continue
      }
      uniqueAliases.push(alias)
    }
    const claim = { skillName: skill.name, source: skill.source }
    claims.set(requestedName, claim)
    for (const alias of uniqueAliases) claims.set(alias, claim)
    descriptors.push({
      id: `skill.${skill.source}.${skill.name}`,
      name: requestedName,
      aliases: uniqueAliases,
      category: 'Skills',
      description: skill.description || skill.name,
      kind: 'agent_prompt',
      source:
        skill.source === 'project'
          ? 'project_skill'
          : skill.source === 'user'
            ? 'user_skill'
            : skill.source === 'plugin'
              ? 'plugin'
              : skill.source === 'verified_plugin'
                ? 'verified_plugin'
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
  return { descriptors, conflicts }
}

function sourcePriority(source: SkillInfoPayload['source']): number {
  if (source === 'project') return 0
  if (source === 'user') return 1
  if (source === 'plugin' || source === 'verified_plugin') return 2
  return 3
}

function builtinReservedNames(): Set<string> {
  return new Set([
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
}

function normalizeExplicitName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase()
}

function normalizeSkillName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^\//, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function isCommandName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_.:-]{0,96}$/.test(value)
}
