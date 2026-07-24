import { describe, expect, it } from 'vitest'
import { PromptPolicy, type PromptPolicySection } from './policy'

function section(
  name: string,
  content: string,
  opts: Partial<PromptPolicySection> = {},
): PromptPolicySection {
  return {
    name,
    content,
    source: `${name}.md`,
    priority: 0,
    budgetChars: null,
    version: 'v1',
    ...opts,
  }
}

describe('PromptPolicy', () => {
  it('orders sections by explicit authority instead of append order', () => {
    const result = new PromptPolicy().resolve([
      section('project_context', 'project', { owner: 'project' }),
      section('mode_contract', 'plan mode', { owner: 'mode' }),
      section('core_identity', 'core', { owner: 'core' }),
      section('execution_contract', 'default', { owner: 'default' }),
    ])

    expect(result.active.map((item) => item.name)).toEqual([
      'core_identity',
      'mode_contract',
      'project_context',
      'execution_contract',
    ])
  })

  it('keeps only the highest-authority owner for a duplicated rule id', () => {
    const result = new PromptPolicy().resolve([
      section('execution_contract', 'default todo rule', {
        owner: 'default',
        ruleIds: ['todo.activation'],
      }),
      section('mode_contract', 'plan-specific todo rule', {
        owner: 'mode',
        ruleIds: ['todo.activation'],
      }),
    ])

    expect(result.active).toHaveLength(1)
    expect(result.active[0]).toMatchObject({
      name: 'mode_contract',
      owner: 'mode',
    })
    expect(result.replaced).toEqual([
      expect.objectContaining({
        name: 'execution_contract',
        replacedBy: 'mode_contract',
        conflictingRuleIds: ['todo.activation'],
      }),
    ])
  })

  it('rejects duplicate active rule ownership at the same authority', () => {
    expect(() =>
      new PromptPolicy().resolve([
        section('mode_a', 'one', {
          owner: 'mode',
          ruleIds: ['plan.execution'],
        }),
        section('mode_b', 'two', {
          owner: 'mode',
          ruleIds: ['plan.execution'],
        }),
      ]),
    ).toThrow(/duplicate active prompt rule/i)
  })
})
