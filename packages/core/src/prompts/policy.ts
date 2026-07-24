import type {
  PromptSectionInput,
  PromptSectionOwner,
} from './manifest'

export interface PromptPolicySection extends PromptSectionInput {
  owner?: PromptSectionOwner
  ruleIds?: string[]
}

export interface ReplacedPromptSection extends PromptPolicySection {
  replacedBy: string
  conflictingRuleIds: string[]
}

export interface PromptPolicyResolution {
  active: PromptPolicySection[]
  replaced: ReplacedPromptSection[]
}

const OWNER_PRIORITY: Record<PromptSectionOwner, number> = {
  core: 1_000,
  agent_role: 900,
  mode: 800,
  plan: 760,
  goal: 750,
  project: 700,
  memory: 600,
  default: 500,
  tool: 400,
  user_append: 300,
}

/**
 * Resolves prompt sections before provider projection.
 *
 * Natural-language append order is never treated as authority. Every section
 * has one owner; duplicated rule ids are owned by the highest-authority
 * section, while equal-authority duplicates fail closed because their intended
 * precedence is ambiguous.
 */
export class PromptPolicy {
  resolve(input: PromptPolicySection[]): PromptPolicyResolution {
    const sections = input
      .map((section, index) => normalizeSection(section, index))
      .sort(compareSections)
    const active: PromptPolicySection[] = []
    const replaced: ReplacedPromptSection[] = []
    const claimedRules = new Map<
      string,
      { section: PromptPolicySection; authority: number }
    >()

    for (const section of sections) {
      const ruleIds = normalizedRuleIds(section.ruleIds)
      const conflicts = ruleIds
        .map((ruleId) => ({ ruleId, claim: claimedRules.get(ruleId) }))
        .filter(
          (
            item,
          ): item is {
            ruleId: string
            claim: {
              section: PromptPolicySection
              authority: number
            }
          } => item.claim !== undefined,
        )
      if (conflicts.length) {
        const owner = ownerFor(section)
        const authority = OWNER_PRIORITY[owner]
        const equal = conflicts.find(
          (item) => item.claim.authority === authority,
        )
        if (equal) {
          throw new Error(
            `Duplicate active prompt rule '${equal.ruleId}' is owned by equal-authority sections '${equal.claim.section.name}' and '${section.name}'.`,
          )
        }
        replaced.push({
          ...section,
          replacedBy: conflicts[0]!.claim.section.name,
          conflictingRuleIds: conflicts.map((item) => item.ruleId),
        })
        continue
      }
      active.push(section)
      const authority = OWNER_PRIORITY[ownerFor(section)]
      for (const ruleId of ruleIds)
        claimedRules.set(ruleId, { section, authority })
    }

    return { active, replaced }
  }

  render(resolution: PromptPolicyResolution): string {
    return resolution.active
      .map((section) => String(section.content ?? '').trim())
      .filter(Boolean)
      .join('\n\n---\n\n')
  }
}

function normalizeSection(
  section: PromptPolicySection,
  inputIndex: number,
): PromptPolicySection & { inputIndex: number } {
  return {
    ...section,
    owner: ownerFor(section),
    ruleIds: normalizedRuleIds(section.ruleIds),
    inputIndex,
  }
}

function compareSections(
  left: PromptPolicySection & { inputIndex: number },
  right: PromptPolicySection & { inputIndex: number },
): number {
  const authority =
    OWNER_PRIORITY[ownerFor(right)] - OWNER_PRIORITY[ownerFor(left)]
  if (authority !== 0) return authority
  const explicit = Number(right.priority ?? 0) - Number(left.priority ?? 0)
  if (explicit !== 0) return explicit
  return left.inputIndex - right.inputIndex
}

function normalizedRuleIds(value: string[] | undefined): string[] {
  return [
    ...new Set(
      (value ?? [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean),
    ),
  ]
}

function ownerFor(section: PromptPolicySection): PromptSectionOwner {
  if (section.owner) return section.owner
  const name = String(section.name ?? '')
  if (name === 'control' || name === 'clarification') return 'mode'
  if (name === 'plan') return 'plan'
  if (name === 'goal') return 'goal'
  if (
    name === 'project_agents' ||
    name === 'project_context' ||
    name === 'project_index_summary'
  )
    return 'project'
  if (name === 'long_term_memory' || name === 'user_profile') return 'memory'
  if (name === 'active_skills' || name === 'skills_summary') return 'tool'
  if (name === 'bootstrap') return 'core'
  if (name === 'persona') return 'agent_role'
  if (name === 'identity' || name === 'system') return 'default'
  return 'default'
}
