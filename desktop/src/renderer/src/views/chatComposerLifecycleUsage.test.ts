import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'ChatView.vue'), 'utf8')

describe('ChatView Composer lifecycle integration', () => {
  it('keeps the Goal bar visible above Ask or Plan and wires replacement through App context', () => {
    expect(source).toContain('<GoalStatusBar')
    expect(source.indexOf('<GoalStatusBar')).toBeLessThan(
      source.indexOf('<ActiveAskPanel'),
    )
    expect(source).toContain('@edit="replaceGoal"')
    expect(source).toContain('ctx.replaceGoal')
  })

  it('passes full control and Provider metadata to Composer', () => {
    expect(source).toContain(':control="ctx.boot.value?.control || null"')
    expect(source).toContain(':provider-options="providerOptions"')
    expect(source).toContain(':goal="activeGoal"')
    expect(source).toContain('@set-permission="ctx.setPermissionMode"')
  })

  it('preserves a failed replacement Outcome after the old Goal becomes terminal', () => {
    expect(source).toContain('goalReplacementDraft.value = outcome')
    expect(source).toContain('goal-replacement-recovery')
    expect(source).toContain('@submit.prevent="retryGoalReplacement"')
    expect(source).toContain('await ctx.startGoal(outcome)')
  })
})
