import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'ConversationView.vue'), 'utf8')

describe('ConversationView composer seat integration', () => {
  it('replaces the composer with the takeover card and keeps the goal in the status bar', () => {
    expect(source).toContain('activeTakeover(pendingInteraction.value)')
    expect(source).toContain('<TakeoverSeat v-if="takeover"')
    expect(source).toContain('v-show="!takeoverOpen"')
    expect(source).toContain(':takeover="takeoverOpen"')
    expect(source).toContain('@goal-action="runGoalStatusAction"')
    expect(source).toContain(
      ':interaction-blocked="Boolean(pendingInteraction)"',
    )
  })

  it('UI-S04: one status bar above the composer instead of four docks', () => {
    expect(source).toContain('<ComposerStatusBar')
    for (const dock of ['<ChangesPill', '<TodoDock', '<GoalBar', '<QueueDock'])
      expect(source).not.toContain(dock)
    expect(source).toContain(':queue="ctx.queuedPrompts.value"')
    expect(source).toContain(':todos="latestTodos"')
    expect(source).toContain(
      ':queue-occupied="Boolean(ctx.queuedPrompts.value.length)"',
    )
    // 编辑 a goal: clear it and describe it again in the composer.
    expect(source).toContain('@goal-edit="editGoal"')
    expect(source).toContain("'user_edit_goal'")
    expect(source).toContain('ctx.activateGoalCapture()')
  })

  it('sends a held prompt (待发送) from the status bar', () => {
    expect(source).toContain('@send="sendQueuedPrompt"')
    expect(source).toContain("ctx.manageQueuedPrompt(item.id, 'send')")
  })

  it('UI-S04: offers the profile interview only on the hero', () => {
    expect(source).not.toContain('notice-dock')
    expect(source).not.toContain('showProfileOnboardingPrompt')
    expect(source).toMatch(/<HeroProfilePrompt\s+v-if="phase === 'hero'/)
  })

  it('returns the send outcome to the composer, which restores a refused draft', () => {
    expect(source).toContain('@send="sendFromComposer"')
    expect(source).toContain('return ctx.submitFromComposer(payload)')
    expect(source).toContain("ctx.showToast('正在切换会话，稍后再发送')")
  })

  it('keeps one unsent draft per chat', () => {
    expect(source).toContain(
      'saveComposerDraft(previous, handle.takeSnapshot())',
    )
    expect(source).toContain('handle.applySnapshot(takeComposerDraft(next))')
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

  it('checks reply file links against Core and opens folders in the tree', () => {
    expect(source).toContain('provide(LINK_STATUS_KEY, linkStatus)')
    expect(source).toContain(
      'linkStatus.record(detail.href, reference, detail.sourceMessageId)',
    )
    expect(source).toContain('directory: reference.relativePath')
    // Background deliverables also refresh links after delegation changes.
    expect(source).toContain("event.event === 'delegation_run_changed'")
    expect(source).toContain("event.event === 'delegation_receipt'")
    expect(source.match(/linkStatus\.refresh\(\)/g)).toHaveLength(3)
  })

  it('sends tool-row Inspect to the trajectory inspector column', () => {
    expect(source).toContain('frameActions.openInspector(frame)')
    expect(source).toContain("sessionLocation(viewingId.value, 'trajectory')")
    expect(source).toContain('query: { call: callId }')
    expect(source).toContain('@inspect-applied="clearFocusCall"')
    expect(source).not.toContain('selectCall')
  })

  it('UI-S09: shows the trajectory only while 显示轨迹 is on', () => {
    expect(source).toContain(
      "route.name === 'trajectory' && trajectoryShown.value ? 'trajectory' : 'chat'",
    )
    expect(source).toContain(':trajectory="trajectoryShown"')
    expect(source).toContain(
      'if (!trajectoryShown.value || !viewingId.value || !callId) return',
    )
    // A trajectory link turned back by the gate: toast, then the call.
    expect(source).toContain('takeTrajectoryNotice(id)')
    expect(source).toContain("ctx.showToast('轨迹视图已关闭'")
    expect(source).toContain("settingsRoute.openSettings('general')")
    expect(source).toContain('list.revealCall(callId)')
  })

  it('keeps the header toggles on the hero phase and seats the environment card', () => {
    expect(source).toContain(':slim="phase === \'hero\'"')
    expect(source).toContain('@toggle-workspace="toggleWorkspace"')
    expect(source).toContain('@toggle-env-card="toggleEnvCard"')
    expect(source).toContain("import('./environment/EnvironmentCard.vue')")
    expect(source).toContain('container: conversation / inline-size')
  })

  it('seats the environment card beside chat with reserved space at every opened width', () => {
    expect(source).toContain('v-if="envCardShown"')
    expect(source).toContain("phase.value !== 'hero'")
    expect(source).toContain('@reveal="revealRow"')
    expect(source).toContain('@close="closeEnvCard"')
    expect(source).toContain('@container conversation (min-width: 1120px)')
    expect(source).toContain('padding-inline-end: calc(var(--env-card-width)')
  })

  it('seats the async turn scrubber', () => {
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
