import { describe, expect, it } from 'vitest'
import { ContextPlanner } from './planner'
import type { ContextSection } from '../agent/context-builder'

describe('ContextPlanner', () => {
  const planner = new ContextPlanner()

  it('builds a chat ContextPlan with section hashes and policy omissions', () => {
    const sections: ContextSection[] = [
      section('bootstrap', '# Bootstrap', 'templates/SOUL.md', 100, 'user_profile'),
      section('long_term_memory', '# Memory\n\n- prefers Chinese', 'memory/MEMORY.local.md', 80, 'global'),
    ]

    const plan = planner.plan({
      mode: 'chat',
      sections,
      memoryFile: 'memory/MEMORY.local.md',
      userFile: 'memory/profile/USER.local.md',
    })

    expect(plan).toMatchObject({
      version: 1,
      mode: 'chat',
      policyId: 'chat',
      activeMemoryBinding: {
        profile: {
          scope: { kind: 'user_profile' },
          readable: true,
          writable: true,
          path: 'memory/profile/USER.local.md',
        },
        longTerm: {
          scope: { kind: 'global' },
          readable: true,
          writable: true,
          path: 'memory/MEMORY.local.md',
        },
      },
    })
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'section:long_term_memory',
        kind: 'global_memory',
        reason: 'chat policy includes global long-term memory',
        charCount: '# Memory\n\n- prefers Chinese'.length,
      }),
      expect.objectContaining({
        id: 'dynamic:session_history',
        kind: 'session_history',
        action: 'include',
        source: 'session/history.jsonl',
        reason: 'chat policy includes active session transcript',
      }),
    ]))
    expect(plan.items[0]!.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'project_memory',
        reason: 'chat mode has no active bound project memory',
      }),
    ]))
  })

  it('builds a build ContextPlan with bound project memory and omitted global memory', () => {
    const sections: ContextSection[] = [
      section('bootstrap', '# Bootstrap', 'templates/SOUL.md', 100, 'user_profile'),
      section('project_agents', '# Project State\n\n- fact', 'projects/project_1/AGENTS.local.md', 85, 'project'),
    ]

    const plan = planner.plan({
      mode: 'build',
      projectId: 'project_1',
      sections,
      memoryFile: 'memory/MEMORY.local.md',
      userFile: 'memory/profile/USER.local.md',
      projectMemoryFile: 'projects/project_1/AGENTS.local.md',
    })

    expect(plan).toMatchObject({
      version: 1,
      mode: 'build',
      policyId: 'build',
      activeMemoryBinding: {
        profile: {
          scope: { kind: 'user_profile' },
          readable: true,
          writable: true,
          path: 'memory/profile/USER.local.md',
        },
        longTerm: {
          scope: { kind: 'project', projectId: 'project_1' },
          readable: true,
          writable: true,
          path: 'projects/project_1/AGENTS.local.md',
        },
      },
    })
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'section:project_agents',
        kind: 'project_memory',
        reason: 'build policy includes bound project memory',
      }),
      expect.objectContaining({
        id: 'dynamic:session_history',
        kind: 'session_history',
        action: 'include',
        source: 'session/history.jsonl',
        reason: 'build policy includes active session transcript',
      }),
    ]))
    expect(plan.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'global_memory',
        source: 'memory/MEMORY.local.md',
        reason: 'build mode intentionally does not inject global MEMORY',
      }),
    ]))
  })

  it('records semantic compaction omitted session history ranges without reinjecting old rows', () => {
    const plan = planner.plan({
      mode: 'chat',
      sections: [
        section('bootstrap', '# Bootstrap', 'templates/SOUL.md', 100, 'user_profile'),
      ],
      memoryFile: 'memory/MEMORY.local.md',
      userFile: 'memory/profile/USER.local.md',
      compactionOmittedRanges: [{
        fromSeq: 1,
        toSeq: 8,
        compactionId: 'compact_1',
        targetScopes: ['global', 'episode:2026-07-07'],
      }],
    })

    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'dynamic:session_history',
        kind: 'session_history',
        action: 'include',
      }),
    ]))
    expect(plan.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'session_history',
        source: 'session/history.jsonl#seq-1-8',
        reason: 'semantic_compaction_applied',
        fromSeq: 1,
        toSeq: 8,
        compactionId: 'compact_1',
        targetScopes: ['global', 'episode:2026-07-07'],
      }),
    ]))
  })

  it('keeps prompt persona separate from the actual user profile section', () => {
    const plan = planner.plan({
      mode: 'chat',
      sections: [
        section('persona', '# Prompt Profile: technical', 'prompt-profile:technical', 95, 'prompt'),
        section('user_profile', '# User\n\n- Prefers concise answers', 'memory/profile/USER.local.md', 94, 'user_profile'),
      ],
      userFile: 'memory/profile/USER.local.md',
    })

    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'section:persona',
        kind: 'persona',
        source: 'prompt-profile:technical',
      }),
      expect.objectContaining({
        id: 'section:user_profile',
        kind: 'user_profile',
        source: 'memory/profile/USER.local.md',
      }),
    ]))
  })
})

function section(name: string, content: string, source: string, priority: number, scope: string): ContextSection {
  return {
    name,
    content,
    source,
    priority,
    budgetChars: null,
    version: null,
    scope,
  }
}
