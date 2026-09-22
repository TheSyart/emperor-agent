import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'ConversationView.vue'), 'utf8')

describe('ConversationView composer seat integration', () => {
  it('replaces the composer with the takeover card and keeps the goal bar visible', () => {
    expect(source).toContain('activeTakeover(pendingInteraction.value)')
    expect(source).toContain('<TakeoverSeat v-if="takeover"')
    expect(source).toContain('v-show="!takeover"')
    expect(source).toContain('<GoalBar')
    expect(source).toContain('@action="runGoalStatusAction"')
    expect(source).toContain(
      ':interaction-blocked="Boolean(pendingInteraction)"',
    )
  })

  it('docks the queue above the composer card and enforces the single slot', () => {
    expect(source).toContain('<QueueDock')
    expect(source).toContain(
      ':queue-occupied="Boolean(ctx.queuedPrompts.value.length)"',
    )
  })

  it('restores a queue submission rejected by the Core single-slot guard', () => {
    expect(source).toContain('ctx.queueDraftRecovery.value')
    expect(source).toContain('composer.value?.restoreDraft(recovery.payload)')
    expect(source).toContain('ctx.clearQueueDraftRecovery(recovery.sessionId)')
  })

  it('passes full control and Provider metadata to the composer', () => {
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

  it('opens the profile interview returned by activating the first usable model', () => {
    expect(source).toContain('payload.profileOnboarding?.started')
    expect(source).toContain('ctx.openProfileInterviewSession')
    expect(source).toContain('payload.profileOnboarding.state.sessionId')
  })

  it('routes review and file requests to the details column', () => {
    expect(source).toContain("requestDetails({ tab: 'git', paths")
    expect(source).toContain("tab: 'files'")
  })

  it('shows the read-only composer for child sessions', () => {
    expect(source).toContain('<ReadOnlyComposer')
    expect(source).toContain('fetchSessionLineage')
  })
})
