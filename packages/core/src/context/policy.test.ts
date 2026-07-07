import { describe, expect, it } from 'vitest'
import { CONTEXT_POLICIES, contextPolicyForMode } from './policy'

describe('ContextPolicyRegistry', () => {
  it('encodes chat mode as user profile plus global memory without bound project memory', () => {
    const policy = contextPolicyForMode('chat')

    expect(policy).toBe(CONTEXT_POLICIES.chat)
    expect(policy.id).toBe('chat')
    expect(policy.includeKinds).toEqual(expect.arrayContaining(['bootstrap', 'user_profile', 'global_memory', 'project_index', 'session_history']))
    expect(policy.excludeKinds).toEqual(expect.arrayContaining(['project_memory', 'project_path']))
  })

  it('encodes build mode as user profile plus project memory without global memory', () => {
    const policy = contextPolicyForMode('build')

    expect(policy).toBe(CONTEXT_POLICIES.build)
    expect(policy.id).toBe('build')
    expect(policy.includeKinds).toEqual(expect.arrayContaining(['bootstrap', 'user_profile', 'project_memory', 'project_path', 'session_history']))
    expect(policy.excludeKinds).toEqual(expect.arrayContaining(['global_memory']))
  })
})
