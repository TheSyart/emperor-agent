import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'ChatView.vue'), 'utf8')

describe('ChatView Composer lifecycle integration', () => {
  it('keeps the Goal bar visible and renders Ask or Plan inside the timeline', () => {
    expect(source).toContain('<GoalStatusBar')
    expect(source).not.toContain('<ActiveAskPanel')
    expect(source).not.toContain('<ActivePlanDecisionPanel')
    expect(source).not.toContain('<PendingBar')
    expect(source).toContain(
      ':interaction-blocked="Boolean(pendingInteraction)"',
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

  it('wires lifecycle activation and Goal capture through App context', () => {
    expect(source).toContain(':goal-capture-status="goalCaptureStatus"')
    expect(source).toContain(':lifecycle-mode="composerLifecycleMode"')
    expect(source).toContain('@activate-plan="activatePlan"')
    expect(source).toContain('@activate-goal="activateGoalCapture"')
    expect(source).toContain('@dismiss-lifecycle="dismissLifecycle"')
    expect(source).toContain('@start-goal="startGoalWithLifecycle"')
  })

  it('preserves a failed replacement Outcome after the old Goal becomes terminal', () => {
    expect(source).toContain('goalReplacementDraft.value = outcome')
    expect(source).toContain('goal-replacement-recovery')
    expect(source).toContain('@submit.prevent="retryGoalReplacement"')
    expect(source).toContain('await ctx.startGoal(outcome)')
  })
})
