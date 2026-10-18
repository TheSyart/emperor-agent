import { expect, it } from 'vitest'
import { buildDelegationBrief } from './context'
it('carries explicit task, sourced constraints, goal and base without copying private parent fields', () => {
  const input = {
    prompt: 'Implement parser',
    description: 'Parser',
    context: 'brief' as const,
    instructions: [
      {
        absolutePath: '/repo/AGENTS.md',
        displayPath: 'AGENTS.md',
        content: 'Preserve public API.',
      },
    ],
    goal: 'Ship parser',
    workspace: {
      cwd: '/repo',
      base: 'snapshot',
      commit: 'abc',
      manifestDigest: 'digest',
      excluded: [{ path: '.env', reason: 'ignored' }],
    },
    parentSystem: 'PRIVATE_SYSTEM',
    hiddenReasoning: 'PRIVATE_REASONING',
    credential: 'PRIVATE_KEY',
  }
  const text = buildDelegationBrief(input)
  expect(text).toContain('Implement parser')
  expect(text).toContain('AGENTS.md')
  expect(text).toContain('Preserve public API.')
  expect(text).toContain('Ship parser')
  expect(text).toContain('abc')
  expect(text).toContain('.env')
  expect(text).not.toContain('PRIVATE_')
})
it('rejects an oversized brief or constraints without truncating a byte', () => {
  expect(() =>
    buildDelegationBrief({
      prompt: 'x'.repeat(32768),
      description: 'Task',
      context: 'isolated',
    }),
  ).toThrow('BRIEF_LIMIT')
  expect(() =>
    buildDelegationBrief({
      prompt: 'do work',
      description: 'Task',
      context: 'brief',
      instructions: [
        {
          absolutePath: '/repo/AGENTS.md',
          displayPath: 'AGENTS.md',
          content: '硬约束'.repeat(10000),
        },
      ],
    }),
  ).toThrow('BRIEF_LIMIT')
})
