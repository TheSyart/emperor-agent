import { describe, expect, it } from 'vitest'
import { routeBuildDecision, routeChatDecision, type CompactionMemoryDecision } from './compaction-routing'
import { memoryContentHash } from './patch'

describe('compaction memory routing', () => {
  it('routes build project facts to project memory patches', () => {
    const projectMemory = '# Project Memory\n\n## Build Commands\n'
    const decision: CompactionMemoryDecision = {
      kind: 'project_fact',
      section: 'Build Commands',
      content: '- npm test --workspace @emperor/core',
      confidence: 'high',
      rationale: 'durable build command',
    }

    const routed = routeBuildDecision(decision, {
      projectId: 'project_1',
      projectMemory,
      globalMemory: '# Global Long-Term Memory\n\n## Cross-Project Decisions\n',
    })

    expect(routed.discarded).toHaveLength(0)
    expect(routed.patches).toHaveLength(1)
    expect(routed.patches[0]).toMatchObject({
      target: { kind: 'project', projectId: 'project_1' },
      baseHash: memoryContentHash(projectMemory),
      operations: [{ op: 'append_section_item', section: 'Build Commands', item: '- npm test --workspace @emperor/core' }],
    })
  })

  it('requires medium/high cross-project learning before build writes global memory', () => {
    const globalMemory = '# Global Long-Term Memory\n\n## Cross-Project Decisions\n'
    const localDecision: CompactionMemoryDecision = {
      kind: 'global_fact',
      section: 'Cross-Project Decisions',
      content: '- local repo command',
      confidence: 'high',
      rationale: 'not cross-project',
    }
    const weakCrossProject: CompactionMemoryDecision = {
      ...localDecision,
      crossProjectLearning: true,
      confidence: 'low',
      content: '- weak cross-project hunch',
    }
    const durableCrossProject: CompactionMemoryDecision = {
      ...localDecision,
      crossProjectLearning: true,
      confidence: 'medium',
      content: '- durable cross-project decision',
    }

    const local = routeBuildDecision(localDecision, { projectId: 'project_1', projectMemory: '# Project Memory\n', globalMemory })
    const weak = routeBuildDecision(weakCrossProject, { projectId: 'project_1', projectMemory: '# Project Memory\n', globalMemory })
    const durable = routeBuildDecision(durableCrossProject, { projectId: 'project_1', projectMemory: '# Project Memory\n', globalMemory })

    expect(local.discarded[0]?.reason).toBe('build_global_write_requires_cross_project_learning')
    expect(weak.discarded[0]?.reason).toBe('build_global_write_requires_medium_confidence')
    expect(durable.patches[0]).toMatchObject({ target: { kind: 'global' } })
  })

  it('does not let chat write project memory without an explicit project binding', () => {
    const decision: CompactionMemoryDecision = {
      kind: 'project_fact',
      section: 'Architecture Notes',
      content: '- project note',
      confidence: 'high',
      rationale: 'chat mentioned a project',
    }

    const withoutProject = routeChatDecision(decision, {
      globalMemory: '# Global Long-Term Memory\n\n## Open Questions\n',
      userProfile: '# User Profile\n\n## Stable Preferences\n',
    })
    const withProject = routeChatDecision(decision, {
      projectId: 'project_1',
      projectMemory: '# Project Memory\n\n## Architecture Notes\n',
      globalMemory: '# Global Long-Term Memory\n\n## Open Questions\n',
      userProfile: '# User Profile\n\n## Stable Preferences\n',
    })

    expect(withoutProject.discarded[0]?.reason).toBe('chat_project_write_requires_binding')
    expect(withProject.patches[0]).toMatchObject({ target: { kind: 'project', projectId: 'project_1' } })
  })

  it('routes stable user preferences from chat to user profile', () => {
    const userProfile = '# User Profile\n\n## Stable Preferences\n'
    const decision: CompactionMemoryDecision = {
      kind: 'user_preference',
      section: 'Stable Preferences',
      content: '- prefers concise Chinese summaries',
      confidence: 'high',
      rationale: 'explicit user preference',
    }

    const routed = routeChatDecision(decision, {
      userProfile,
      globalMemory: '# Global Long-Term Memory\n',
    })

    expect(routed.patches[0]).toMatchObject({
      target: { kind: 'user_profile' },
      baseHash: memoryContentHash(userProfile),
    })
  })
})
