export type ContextMode = 'chat' | 'build'

export type ContextPlanItemKind =
  | 'bootstrap'
  | 'tool_instructions'
  | 'user_profile'
  | 'persona'
  | 'identity'
  | 'global_memory'
  | 'project_memory'
  | 'project_index'
  | 'project_path'
  | 'session_history'
  | 'skills'
  | 'runtime'
  | string

export interface ContextPolicy {
  id: ContextMode
  includeKinds: ContextPlanItemKind[]
  excludeKinds: ContextPlanItemKind[]
  includeReasons: Record<string, string>
  omitReasons: Record<string, string>
}

export const CONTEXT_POLICIES: Record<ContextMode, ContextPolicy> = {
  chat: {
    id: 'chat',
    includeKinds: ['bootstrap', 'tool_instructions', 'user_profile', 'global_memory', 'project_index', 'session_history'],
    excludeKinds: ['project_memory', 'project_path'],
    includeReasons: {
      global_memory: 'chat policy includes global long-term memory',
      project_index: 'chat policy includes project index summary, not project memory',
      session_history: 'chat policy includes active session transcript',
    },
    omitReasons: {
      project_memory: 'chat mode has no active bound project memory',
      project_path: 'chat mode has no active bound project path',
    },
  },
  build: {
    id: 'build',
    includeKinds: ['bootstrap', 'tool_instructions', 'user_profile', 'project_memory', 'project_path', 'session_history'],
    excludeKinds: ['global_memory'],
    includeReasons: {
      project_memory: 'build policy includes bound project memory',
      project_path: 'build policy includes bound project path',
      session_history: 'build policy includes active session transcript',
    },
    omitReasons: {
      global_memory: 'build mode intentionally does not inject global MEMORY',
    },
  },
}

export class ContextPolicyRegistry {
  policyForMode(mode: string | null | undefined): ContextPolicy {
    return contextPolicyForMode(mode)
  }

  includes(policy: ContextPolicy, kind: ContextPlanItemKind): boolean {
    return policy.includeKinds.includes(kind) && !policy.excludeKinds.includes(kind)
  }

  excludes(policy: ContextPolicy, kind: ContextPlanItemKind): boolean {
    return policy.excludeKinds.includes(kind)
  }
}

export function contextPolicyForMode(mode: string | null | undefined): ContextPolicy {
  return mode === 'build' ? CONTEXT_POLICIES.build : CONTEXT_POLICIES.chat
}
