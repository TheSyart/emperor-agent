/**
 * First-run profile interview on the harness kernel. The interview is one
 * hidden turn in a chat session: the model asks through
 * `ask_user_question` (which blocks inside the turn until the user answers
 * from the control panel) and saves the profile with `memory_edit`
 * (target `user`). The coordinator's latch decides whether it may start.
 */

import {
  ProfileOnboardingCoordinator,
  profileOnboardingAgentPrompt,
  type ProfileOnboardingActionResult,
  type ProfileOnboardingPayload,
} from '../../sessions/onboarding'
import type { SessionEntry } from '../../sessions/store'

export interface OnboardingServiceDeps {
  stateRoot: string
  templatesDir: string
  userFile: string
  enabled: boolean
  readUserProfile(): string
  modelAvailable(): boolean
  anyBusy(): boolean
  hasPending(sessionId: string): boolean
  /** Pending interaction id of a session, if any. */
  pendingInteractionId(sessionId: string): string | null
  onPendingChange(listener: (sessionId: string) => void): () => void
  sessions: {
    list(opts?: { includeArchived?: boolean }): SessionEntry[]
    create(title: string, opts: { mode: string }): SessionEntry
  }
  submitHidden(sessionId: string, content: string): Promise<unknown>
  cancelInteraction(interactionId: string): void
  emit(event: Record<string, unknown>): void
}

export class OnboardingService {
  readonly coordinator: ProfileOnboardingCoordinator
  private readonly unsubscribe: () => void

  constructor(private readonly deps: OnboardingServiceDeps) {
    this.coordinator = new ProfileOnboardingCoordinator({
      stateRoot: deps.stateRoot,
      templatesDir: deps.templatesDir,
      userFile: deps.userFile,
    })
    // Interviews do not survive restarts: the blocked turn is repaired away.
    this.coordinator.reconcilePendingInteraction(null)
    this.unsubscribe = deps.onPendingChange((sessionId) => {
      const state = this.coordinator.payload()
      if (state.status !== 'in_progress' || state.sessionId !== sessionId)
        return
      const pendingId = deps.pendingInteractionId(sessionId)
      if (pendingId !== null && pendingId !== state.interactionId) {
        this.coordinator.attachInteraction(pendingId)
        this.emitStatus('awaiting_answers')
      }
    })
  }

  payload(): ProfileOnboardingPayload {
    return this.coordinator.reconcileProfile()
  }

  /** Called after the profile file may have changed (config saves). */
  reconcile(): ProfileOnboardingPayload {
    const before = this.coordinator.payload().status
    const state = this.coordinator.reconcileProfile()
    if (before !== state.status) this.emitStatus('profile_saved')
    return state
  }

  isInterviewInteraction(interactionId: string): boolean {
    const state = this.coordinator.payload()
    return (
      state.status === 'in_progress' && state.interactionId === interactionId
    )
  }

  start(opts: { manual?: boolean } = {}): ProfileOnboardingActionResult {
    const manual = opts.manual === true
    const reconciled = this.coordinator.reconcileProfile()
    if (reconciled.status === 'completed')
      return { started: false, state: reconciled }
    if (!manual && !this.deps.enabled)
      return { started: false, state: reconciled }
    if (!this.deps.modelAvailable() || this.deps.anyBusy())
      return { started: false, state: reconciled }
    const session = this.interviewSession()
    if (this.deps.hasPending(session.id))
      return { started: false, state: reconciled }
    const attempt = this.coordinator.beginAttempt(session.id, { manual })
    if (!attempt.started) return attempt
    this.emitStatus('started')
    const prompt = profileOnboardingAgentPrompt(
      this.coordinator.seedContent,
      this.deps.readUserProfile(),
    )
    void this.deps.submitHidden(session.id, prompt).then(
      () => {
        this.settle(null)
      },
      (error: unknown) => {
        this.settle(error)
      },
    )
    return { started: true, state: this.coordinator.payload() }
  }

  skip(): ProfileOnboardingActionResult {
    const state = this.coordinator.payload()
    if (
      state.interactionId !== null &&
      this.isInterviewInteraction(state.interactionId)
    ) {
      this.deps.cancelInteraction(state.interactionId)
    }
    const skipped = this.coordinator.skip()
    this.emitStatus('skipped')
    return { started: false, state: skipped }
  }

  dispose(): void {
    this.unsubscribe()
  }

  private settle(error: unknown): void {
    const before = this.coordinator.payload()
    if (before.status !== 'in_progress') return
    const state = this.coordinator.reconcileProfile()
    if (state.status === 'completed') {
      this.emitStatus('completed')
      return
    }
    this.coordinator.fail(
      error ?? 'profile interview ended before the profile was saved',
    )
    this.emitStatus('failed')
  }

  private interviewSession(): SessionEntry {
    const sessions = this.deps.sessions.list({ includeArchived: false })
    return (
      sessions.find(
        (session) => session.mode === 'chat' && session.title === 'Default',
      ) ??
      sessions.find((session) => session.mode === 'chat') ??
      this.deps.sessions.create('Default', { mode: 'chat' })
    )
  }

  private emitStatus(reason: string): void {
    try {
      this.deps.emit({
        event: 'profile_onboarding_status_changed',
        profile_onboarding: { ...this.coordinator.payload() },
        reason,
      })
    } catch {
      // observability never alters onboarding state
    }
  }
}
