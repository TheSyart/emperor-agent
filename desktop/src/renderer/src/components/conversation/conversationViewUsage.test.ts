import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'ConversationView.vue'), 'utf8')

describe('ConversationView composer seat integration', () => {
  it('replaces the composer with the takeover card and keeps the goal bar visible', () => {
    expect(source).toContain('activeTakeover(pendingInteraction.value)')
    expect(source).toContain('<TakeoverSeat v-if="takeover"')
    expect(source).toContain('v-show="!takeoverOpen"')
    expect(source).toContain('<GoalBar')
    expect(source).toContain('@action="runGoalStatusAction"')
    expect(source).toContain(
      ':interaction-blocked="Boolean(pendingInteraction)"',
    )
  })

  it('FIX-14 F1: 「没有找到这个会话」 disables the composer; the docks of the session behind go', () => {
    expect(source).toContain(':unavailable-reason="composerUnavailableReason"')
    expect(source).toMatch(/<GoalBar\s+v-if="activeGoal && !unknownSession"/)
    expect(source).toMatch(
      /<QueueDock\s+v-if="!takeoverOpen && !unknownSession"/,
    )
    expect(source).toMatch(
      /unknownSession\.value\s*\?\s*null\s*:\s*activeTakeover\(pendingInteraction\.value\)/,
    )
  })

  it('docks the queue above the composer card and enforces the single slot', () => {
    expect(source).toContain('<QueueDock')
    expect(source).toContain(
      ':queue-occupied="Boolean(ctx.queuedPrompts.value.length)"',
    )
  })

  it('sends a held prompt (待发送) from the queue dock', () => {
    expect(source).toContain('@send="sendQueuedPrompt"')
    expect(source).toContain("ctx.manageQueuedPrompt(item.id, 'send')")
  })

  it('UI-S04: edits a goal with /goal edit from the goal bar', () => {
    expect(source).toContain('@edit="editGoal"')
    expect(source).toContain('setDraft(`/goal edit ${goal.objective}`)')
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
    // FIX-13 D3: a draft that became its session is the same chat.
    expect(source).toContain('isDraftPromotion(previous, next)')
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

  it('applies a model switch to the bootstrap state and starts no interview (UI-S17)', () => {
    expect(source).toContain(
      'applyModelConfig(ctx.boot.value, await activateModelEntry(entryId))',
    )
    expect(source).not.toContain('openProfileInterviewSession')
    expect(source).not.toContain('profileOnboarding?.started')
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

  it('UI-S16: floats the environment card over one scrolling region', () => {
    expect(source).toContain('v-if="envCardShown"')
    expect(source).toContain("phase.value !== 'hero'")
    expect(source).toContain('@reveal="revealRow"')
    expect(source).toContain('@close="closeEnvCard"')
    // No column reserved for the card: the scroller spans the region.
    expect(source).not.toContain(
      'padding-inline-end: calc(var(--env-card-width)',
    )
    expect(source).toContain(
      '--env-card-width: min(340px, 100cqi - 2 * var(--space-4))',
    )
    // The chat and the composer move left of a card only from 1152px
    // (748 + 340 + 2 × 32); narrower the card floats over the chat.
    expect(source).toContain('@container conversation (min-width: 1152px)')
    expect(source).toContain('--chat-shift: max(')
    expect(source).toContain('padding-inline-end: calc(2 * var(--chat-shift')
    expect(source).toContain(':data-env-overlay="envCardOverlay || undefined"')
    expect(source).toMatch(/const FLOAT_BESIDE_MIN = 1152\b/)
  })

  it('UI-S16: the scroller and the computer-use preview use the same 1152px rule', () => {
    const timeline = readFileSync(join(__dirname, 'ChatTimeline.vue'), 'utf8')
    expect(timeline).toContain(
      'padding-inline-end: calc(var(--space-8) + 2 * var(--chat-shift, 0px))',
    )
    const preview = readFileSync(
      join(__dirname, 'computer-use/ComputerUsePreviewStack.vue'),
      'utf8',
    )
    expect(preview).toMatch(/const BESIDE_MIN = 1152\b/)
  })

  it('docks the changes pill and seats the async turn scrubber', () => {
    expect(source).toContain('<ChangesPill')
    expect(source).toContain("import('./TurnScrubber.vue')")
    expect(source).toContain('ticks.length >= SCRUBBER_MIN_TURNS')
    expect(source).toContain('timeline.value?.scrollToKey(key)')
    expect(source).toContain('@first-visible="firstVisibleKey = $event"')
  })

  it('6 · 7 · a child session writes to the child and answers its own questions (AGT-10)', () => {
    expect(source).toContain('<ChildComposer')
    expect(source).toContain("core('agents.send', { sessionId: id, text })")
    expect(source).toContain(
      'ctx.pendingInteractionsBySession[viewingId.value]',
    )
    expect(source).toContain(
      '<TakeoverSeat v-if="childInteraction" :interaction="childInteraction" />',
    )
    expect(source).not.toContain('ReadOnlyComposer')
    // 5 · the child's page is the same ChatTimeline as the main one, keyed
    // by the viewed session and rooted at its main conversation.
    expect(source).toContain(':session-id="viewingId"')
    expect(source).toContain(
      ':root-session-id="lineage?.chain[0]?.sessionId ?? viewingId"',
    )
    expect(source).toContain('fetchSessionLineage')
  })
})
