import { createHash } from 'node:crypto'
import { todayUtc8 } from '../memory/time-utc8'
import type { PromptContextPlan } from '../prompts/manifest'
import type { ContextSection } from '../agent/context-builder'
import { contextPolicyForMode, type ContextMode, type ContextPlanItemKind, type ContextPolicy } from './policy'

export interface ContextPlannerInput {
  mode: ContextMode
  sections: ContextSection[]
  projectId?: string | null
  memoryFile?: string | null
  userFile?: string | null
  projectMemoryFile?: string | null
  episodeFile?: string | null
  policy?: ContextPolicy | null
  compactionOmittedRanges?: Array<{
    fromSeq: number
    toSeq: number
    compactionId?: string | null
    targetScopes?: string[]
  }>
}

export class ContextPlanner {
  plan(input: ContextPlannerInput): PromptContextPlan {
    const policy = input.policy ?? contextPolicyForMode(input.mode)
    return {
      version: 1,
      mode: input.mode,
      policyId: policy.id,
      activeMemoryBinding: {
        profile: {
          scope: { kind: 'user_profile' },
          readable: true,
          writable: true,
          path: input.userFile ?? null,
        },
        longTerm: input.mode === 'build'
          ? {
            scope: { kind: 'project', projectId: input.projectId || '(unknown)' },
            readable: Boolean(input.projectId),
            writable: Boolean(input.projectId),
            path: input.projectMemoryFile ?? (input.projectId ? `projects/${input.projectId}/AGENTS.local.md` : null),
          }
          : {
            scope: { kind: 'global' },
            readable: true,
            writable: true,
            path: input.memoryFile ?? null,
          },
        episode: {
          scope: { kind: 'episode', date: todayUtc8() },
          readable: false,
          writable: true,
          path: input.episodeFile ?? null,
        },
      },
      items: [
        ...input.sections.map((section) => {
          const kind = contextKind(section)
          const excluded = policy.excludeKinds.includes(kind)
          return {
            id: `section:${section.name}`,
            kind,
            source: section.source,
            action: excluded ? 'omit' as const : 'include' as const,
            reason: excluded ? (policy.omitReasons[kind] ?? 'omitted_by_context_policy') : includeReason(kind, section.name, policy),
            priority: section.priority,
            hash: hashContent(section.content),
            charCount: section.content.length,
            tokenEstimate: estimateTokens(section.content),
          }
        }),
        ...dynamicItems(policy),
      ],
      omitted: omittedItems(input, policy),
    }
  }
}

function dynamicItems(policy: ContextPolicy): PromptContextPlan['items'] {
  if (!policy.includeKinds.includes('session_history') || policy.excludeKinds.includes('session_history')) return []
  return [{
    id: 'dynamic:session_history',
    kind: 'session_history',
    source: 'session/history.jsonl',
    action: 'include',
    reason: policy.includeReasons.session_history ?? 'included_by_context_policy',
    priority: 0,
    hash: hashContent(''),
    charCount: 0,
    tokenEstimate: 0,
  }]
}

function contextKind(section: ContextSection): ContextPlanItemKind {
  if (section.name === 'long_term_memory') return 'global_memory'
  if (section.name === 'project_agents') return 'project_memory'
  if (section.name === 'project_index_summary') return 'project_index'
  if (section.name === 'bootstrap') return 'bootstrap'
  if (section.name === 'user_profile') return 'user_profile'
  if (section.name === 'persona') return 'persona'
  if (section.name === 'active_skills' || section.name === 'skills_summary') return 'skills'
  if (section.name === 'identity') return 'tool_instructions'
  return section.name
}

function includeReason(kind: string, sectionName: string, policy: ContextPolicy): string {
  return policy.includeReasons[kind] ?? legacyIncludeReason(sectionName)
}

function legacyIncludeReason(sectionName: string): string {
  if (sectionName === 'long_term_memory') return 'chat policy includes global long-term memory'
  if (sectionName === 'project_agents') return 'build policy includes bound project memory'
  if (sectionName === 'project_index_summary') return 'chat policy includes project index summary, not project memory'
  return 'included_by_context_policy'
}

function omittedSource(kind: string, input: ContextPlannerInput): string {
  if (kind === 'global_memory') return String(input.memoryFile || 'memory/MEMORY.local.md')
  if (kind === 'project_memory') return input.projectId ? `projects/${input.projectId}/AGENTS.local.md` : 'projects/<project-id>/AGENTS.local.md'
  if (kind === 'project_path') return input.projectId ? `project:${input.projectId}` : 'project:<unbound>'
  return 'context-policy'
}

function hashContent(text: string): string {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4))
}

function omittedItems(input: ContextPlannerInput, policy: ContextPolicy): PromptContextPlan['omitted'] {
  const out: PromptContextPlan['omitted'] = []
  const seen = new Set<string>()
  for (const section of input.sections) {
    const kind = contextKind(section)
    if (!policy.excludeKinds.includes(kind)) continue
    const item = { kind, source: section.source, reason: policy.omitReasons[kind] ?? 'omitted_by_context_policy' }
    const key = `${item.kind}\0${item.source}\0${item.reason}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  for (const kind of policy.excludeKinds) {
    const item = { kind, source: omittedSource(kind, input), reason: policy.omitReasons[kind] ?? 'omitted_by_context_policy' }
    const key = `${item.kind}\0${item.source}\0${item.reason}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  for (const range of input.compactionOmittedRanges ?? []) {
    const fromSeq = Math.max(1, Math.trunc(Number(range.fromSeq) || 0))
    const toSeq = Math.max(fromSeq, Math.trunc(Number(range.toSeq) || 0))
    const item = {
      kind: 'session_history',
      source: `session/history.jsonl#seq-${fromSeq}-${toSeq}`,
      reason: 'semantic_compaction_applied',
      fromSeq,
      toSeq,
      compactionId: range.compactionId ?? null,
      targetScopes: [...new Set((range.targetScopes ?? []).map((scope) => String(scope)).filter(Boolean))],
    }
    const key = `${item.kind}\0${item.source}\0${item.reason}\0${item.compactionId ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  return out
}
