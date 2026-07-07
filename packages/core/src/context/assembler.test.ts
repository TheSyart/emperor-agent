import { describe, expect, it } from 'vitest'
import { ContextAssembler } from './assembler'
import type { ContextSection } from '../agent/context-builder'

describe('ContextAssembler', () => {
  it('renders included ContextPlan items in plan order and audits omitted sections', () => {
    const sections: ContextSection[] = [
      section('project_agents', '# Project State\n\n- project-only fact'),
      section('long_term_memory', '# Global Memory\n\n- durable preference'),
      section('bootstrap', '# Bootstrap'),
    ]
    const contextPlan = {
      version: 1,
      mode: 'chat',
      policyId: 'chat',
      activeMemoryBinding: { longTerm: { kind: 'global' } },
      items: [
        item('section:bootstrap', 'bootstrap', 'include', 'include bootstrap'),
        item('section:long_term_memory', 'global_memory', 'include', 'include global memory'),
        item('dynamic:session_history', 'session_history', 'include', 'chat policy includes active session transcript'),
        item('section:project_agents', 'project_memory', 'omit', 'chat mode has no active bound project memory'),
      ],
      omitted: [{
        kind: 'project_memory',
        source: 'projects/project_1/AGENTS.local.md',
        reason: 'chat mode has no active bound project memory',
      }],
    } as any

    const assembled = new ContextAssembler().assemble({ sections, contextPlan })

    expect(assembled.prompt).toContain('# Bootstrap')
    expect(assembled.prompt).toContain('# Global Memory')
    expect(assembled.prompt).not.toContain('project-only fact')
    expect(assembled.prompt).not.toContain('session/history.jsonl')
    expect(assembled.prompt.indexOf('# Bootstrap')).toBeLessThan(assembled.prompt.indexOf('# Global Memory'))
    expect(assembled.rendered.map((entry) => entry.id)).toEqual(['section:bootstrap', 'section:long_term_memory', 'dynamic:session_history'])
    expect(assembled.omitted.some((entry) => entry.id === 'dynamic:session_history')).toBe(false)
    expect(assembled.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'section:project_agents',
        kind: 'project_memory',
        reason: 'chat mode has no active bound project memory',
      }),
    ]))
  })
})

function section(name: string, content: string): ContextSection {
  return {
    name,
    content,
    source: `${name}.md`,
    priority: 0,
    budgetChars: null,
    version: null,
    scope: null,
  }
}

function item(id: string, kind: string, action: 'include' | 'omit', reason: string): Record<string, unknown> {
  return {
    id,
    kind,
    source: `${id}.md`,
    action,
    reason,
    priority: 0,
    hash: `${id}-hash`,
    charCount: 1,
    tokenEstimate: 1,
  }
}
