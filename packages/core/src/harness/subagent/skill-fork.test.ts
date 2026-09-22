import { describe, expect, it, vi } from 'vitest'
import type { ResolvedSkill } from '../../skills/file-loader'
import type { Agent } from '../agent/agent'
import { createTestHarness, testRoute } from '../testing'
import { defineTool } from '../tools/definition'
import { z } from 'zod'
import type { SubagentManager } from './manager'
import { routeEffort, SkillForkError, startSkillFork } from './skill-fork'

const skill: ResolvedSkill = {
  name: 'review',
  root: '/skills/review',
  skillFile: '/skills/review/SKILL.md',
  content: 'REVIEW-BODY',
  description: 'Review code',
  source: 'user',
  readOnly: false,
  status: 'active',
  frontmatter: {},
  warnings: [],
  flat: false,
  sourceDir: '/skills',
}

function tool(name: string) {
  return defineTool({
    name,
    description: name,
    input: z.object({}),
    async execute() {
      return { content: 'ok' }
    },
  })
}

describe('skill fork', () => {
  it('maps skill effort onto the route vocabulary', () => {
    const pi = testRoute({ reasoningEfforts: ['off', 'low', 'high'] })
    expect(routeEffort(pi, 'high')).toBe('high')
    expect(routeEffort(pi, 'none')).toBe('off')
    expect(routeEffort(pi, 'xhigh')).toBeUndefined()
    const deepseek = testRoute({
      adapter: 'deepseek',
      reasoningEfforts: ['off', 'low', 'high', 'max'],
    })
    expect(routeEffort(deepseek, 'medium')).toBe('high')
    expect(routeEffort(testRoute(), 'high')).toBeUndefined()
  })

  it('starts a background fork narrowed by allowed tools and effort', () => {
    const h = createTestHarness({
      route: { reasoningEfforts: ['low', 'high'] },
    })
    h.tools.register(tool('read'))
    h.tools.register(tool('bash'))
    const start = vi.fn(
      (_parent: Agent, _request: unknown) =>
        ({ id: 'sub-1' }) as unknown as Agent,
    )
    const subagents = { start } as unknown as SubagentManager
    const parent = h.agent('root')
    startSkillFork({ subagents, llm: h.llm, tools: h.tools }, parent, {
      skill,
      task: 'the diff',
      allowedTools: ['read'],
      effort: 'high',
    })
    const request = start.mock.calls[0]![1] as unknown as {
      mode: string
      background: boolean
      prompt: string
      agentOptions: {
        toolFilter: { allow: string[] }
        callConfig: () => Record<string, unknown>
      }
    }
    expect(request.mode).toBe('fork')
    expect(request.background).toBe(true)
    expect(request.prompt).toContain('REVIEW-BODY')
    expect(request.prompt).toContain('Task: the diff')
    expect(request.agentOptions.toolFilter).toEqual({ allow: ['read'] })
    expect(request.agentOptions.callConfig()).toMatchObject({
      provider: 'test-route',
      reasoningEffort: 'high',
    })
  })

  it('rejects allowed tools that are not registered', () => {
    const h = createTestHarness()
    const subagents = { start: vi.fn() } as unknown as SubagentManager
    expect(() =>
      startSkillFork({ subagents, llm: h.llm, tools: h.tools }, h.agent(), {
        skill,
        task: '',
        allowedTools: ['Bash(git:*)'],
        effort: null,
      }),
    ).toThrow(SkillForkError)
  })
})
