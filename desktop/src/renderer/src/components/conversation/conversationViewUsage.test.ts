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

  it('routes file references to the right workspace', () => {
    expect(source).toContain('requestWorkspace({')
    expect(source).toContain("pane: 'files'")
    expect(source).not.toContain('requestDetails')
    // The retired command event had no dispatcher.
    expect(source).not.toContain('emperor:open-workspace')
  })

  it('sends tool-row Inspect to the trajectory inspector column', () => {
    expect(source).toContain('frameActions.openInspector(frame)')
    expect(source).toContain("sessionLocation(viewingId.value, 'trajectory')")
    expect(source).toContain('query: { call: callId }')
    expect(source).toContain('@inspect-applied="clearFocusCall"')
    expect(source).not.toContain('selectCall')
  })

  it('keeps the header toggles on the hero phase and seats the environment card', () => {
    expect(source).toContain(':slim="phase === \'hero\'"')
    expect(source).toContain('@toggle-workspace="toggleWorkspace"')
    expect(source).toContain('@toggle-env-card="toggleEnvCard"')
    expect(source).toContain("import('./environment/EnvironmentCard.vue')")
    expect(source).toContain('container: conversation / inline-size')
  })

  it('seats the environment card beside a wide chat and over a narrow one', () => {
    expect(source).toContain('v-if="envCardShown"')
    expect(source).toContain("phase.value !== 'hero'")
    expect(source).toContain('@reveal="revealRow"')
    expect(source).toContain('@close="closeEnvCard"')
    expect(source).toContain('@container conversation (min-width: 1120px)')
    expect(source).toContain('padding-inline-end: calc(var(--env-card-width)')
  })

  it('docks the changes pill and seats the async turn scrubber', () => {
    expect(source).toContain('<ChangesPill')
    expect(source).toContain("import('./TurnScrubber.vue')")
    expect(source).toContain('ticks.length >= SCRUBBER_MIN_TURNS')
    expect(source).toContain('timeline.value?.scrollToKey(key)')
    expect(source).toContain('@first-visible="firstVisibleKey = $event"')
  })

  it('shows the read-only composer for child sessions', () => {
    expect(source).toContain('<ReadOnlyComposer')
    expect(source).toContain('fetchSessionLineage')
  })
})
